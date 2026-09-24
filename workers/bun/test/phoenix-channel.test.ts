import { expect, test } from "bun:test";
import { PhoenixWorkerChannel } from "../src/protocol/phoenix-channel.ts";
import type { WorkerCapabilities } from "../src/protocol/types.ts";

class FakeSocket {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    if (this.closed) throw new Error("socket closed");
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.();
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  remoteClose(): void {
    this.closed = true;
    this.onclose?.();
  }
}

const capabilities = {
  os: "darwin",
  arch: "arm64",
  max_concurrency: 1,
  tags: [],
  executors: [],
  workspace_bindings: [],
} satisfies WorkerCapabilities;

function fixture(options: { replyTimeoutMs?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const registered: Array<{
    response: Record<string, unknown>;
    generation: number;
  }> = [];
  const disconnected: Array<{ generation: number; message: string }> = [];
  const channel = new PhoenixWorkerChannel(
    "ws://127.0.0.1:4000/worker/websocket",
    "worker-1",
    "token",
    capabilities,
    {
      onProtocol: () => undefined,
      onRegistered: (response, generation) => {
        registered.push({ response, generation });
      },
      onDisconnected: (generation, error) => {
        disconnected.push({ generation, message: error.message });
      },
      onSuperseded: () => undefined,
    },
    {
      connectTimeoutMs: 100,
      replyTimeoutMs: options.replyTimeoutMs ?? 100,
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
    },
  );
  return { channel, sockets, registered, disconnected };
}

async function register(
  value: ReturnType<typeof fixture>,
  serverGeneration: number,
): Promise<FakeSocket> {
  const connecting = value.channel.connect();
  const socket = value.sockets.at(-1);
  if (!socket) throw new Error("socket was not created");
  socket.open();
  const [joinRef] = JSON.parse(socket.sent[0] ?? "[]") as unknown[];
  socket.receive([
    joinRef,
    joinRef,
    "worker:control",
    "phx_reply",
    {
      status: "ok",
      response: {
        type: "worker_welcome",
        connection_generation: serverGeneration,
      },
    },
  ]);
  await connecting;
  await Promise.resolve();
  return socket;
}

test("unmatched topic invalidates one generation and fences stale socket callbacks", async () => {
  const value = fixture();
  const first = await register(value, 41);
  expect(value.channel.currentGeneration()).toBe(1);
  expect(value.channel.currentServerGeneration()).toBe(41);

  const lost = value.channel.sendProtocol({ type: "worker_heartbeat" });
  const [joinRef, ref] = JSON.parse(first.sent.at(-1) ?? "[]") as unknown[];
  first.receive([
    joinRef,
    ref,
    "worker:control",
    "phx_reply",
    { status: "error", response: { reason: "unmatched topic" } },
  ]);

  await expect(lost).rejects.toThrow("membership was lost");
  expect(value.channel.isRegistered()).toBe(false);
  expect(first.closed).toBe(true);
  expect(value.disconnected).toEqual([
    { generation: 1, message: "Worker Phoenix channel membership was lost." },
  ]);

  const reconnecting = value.channel.connect();
  const duplicate = value.channel.connect();
  expect(duplicate).toBe(reconnecting);
  const second = value.sockets.at(-1);
  if (!second) throw new Error("replacement socket was not created");
  second.open();
  const [secondJoinRef] = JSON.parse(second.sent[0] ?? "[]") as unknown[];
  second.receive([
    secondJoinRef,
    secondJoinRef,
    "worker:control",
    "phx_reply",
    { status: "ok", response: { connection_generation: 42 } },
  ]);
  await reconnecting;

  first.remoteClose();
  expect(value.channel.isRegistered()).toBe(true);
  expect(value.channel.currentGeneration()).toBe(2);
  expect(value.registered.map((item) => item.generation)).toEqual([1, 2]);
});

test("topic error invalidates registration even when the WebSocket remains open", async () => {
  const value = fixture();
  const socket = await register(value, 1);
  const [joinRef] = JSON.parse(socket.sent[0] ?? "[]") as unknown[];

  socket.receive([joinRef, null, "worker:control", "phx_error", {}]);

  expect(value.channel.isRegistered()).toBe(false);
  expect(socket.closed).toBe(true);
  expect(value.disconnected[0]?.message).toContain("phx_error");
});

test("server generation errors force rejoin while semantic rejections stay on-channel", async () => {
  const value = fixture();
  const socket = await register(value, 1);

  const semantic = value.channel.sendProtocol({ type: "session_state" });
  let [joinRef, ref] = JSON.parse(socket.sent.at(-1) ?? "[]") as unknown[];
  socket.receive([
    joinRef,
    ref,
    "worker:control",
    "phx_reply",
    {
      status: "error",
      response: { type: "protocol_error", error: { code: "invalid_field" } },
    },
  ]);
  await expect(semantic).rejects.toThrow("message rejected");
  expect(value.channel.isRegistered()).toBe(true);

  const invalidated = value.channel.sendProtocol({ type: "step_completed" });
  [joinRef, ref] = JSON.parse(socket.sent.at(-1) ?? "[]") as unknown[];
  socket.receive([
    joinRef,
    ref,
    "worker:control",
    "phx_reply",
    {
      status: "error",
      response: {
        type: "protocol_error",
        error: { code: "internal_server_error" },
      },
    },
  ]);
  await expect(invalidated).rejects.toThrow("generation was invalidated");
  expect(value.channel.isRegistered()).toBe(false);
});

test("reply timeout invalidates the generation instead of accumulating failed pushes", async () => {
  const value = fixture({ replyTimeoutMs: 5 });
  const socket = await register(value, 1);

  const first = value.channel.sendProtocol({ type: "session_state" });
  const second = value.channel.sendProtocol({ type: "step_completed" });

  const results = await Promise.allSettled([first, second]);
  expect(results).toHaveLength(2);
  for (const result of results) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected")
      expect(String(result.reason)).toContain("reply timed out");
  }
  expect(value.channel.isRegistered()).toBe(false);
  expect(socket.closed).toBe(true);
  expect(value.disconnected).toHaveLength(1);
});
