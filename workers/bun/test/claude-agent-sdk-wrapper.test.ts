import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  CLAUDE_WRAPPER_MAX_FRAME_BYTES,
  decodeEvent,
} from "../src/harnesses/claude-agent-sdk/protocol.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const wrapper = resolve(
  import.meta.dir,
  "../profiles/qe-coding-execution-v2/files/home/.qe-profile/claude-wrapper.mjs",
);

class WrapperProcess {
  private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  private readonly frames: unknown[] = [];
  private readonly waiters: Array<(value: unknown) => void> = [];
  readonly exited: Promise<number>;

  constructor() {
    this.child = Bun.spawn(["node", wrapper], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: "/nonexistent",
        LANG: "C.UTF-8",
      },
    });
    this.exited = this.child.exited;
    void this.read();
    void new Response(this.child.stderr as ReadableStream<Uint8Array>).arrayBuffer();
  }

  send(value: unknown): void {
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
    this.child.stdin.flush();
  }

  raw(value: string): void {
    this.child.stdin.write(value);
    this.child.stdin.flush();
  }

  next(timeoutMs = 5_000): Promise<Record<string, unknown>> {
    const current = this.frames.shift();
    if (current) return Promise.resolve(current as Record<string, unknown>);
    return new Promise((resolveFrame, reject) => {
      const timer = setTimeout(
        () => reject(new Error("wrapper event timeout")),
        timeoutMs,
      );
      this.waiters.push((value) => {
        clearTimeout(timer);
        resolveFrame(value as Record<string, unknown>);
      });
    });
  }

  close(): void {
    this.child.stdin.end();
  }

  private async read(): Promise<void> {
    let buffered = "";
    const reader = this.child.stdout.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      buffered += new TextDecoder().decode(next.value);
      for (;;) {
        const index = buffered.indexOf("\n");
        if (index < 0) break;
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        if (!line) continue;
        const value = JSON.parse(line);
        const waiter = this.waiters.shift();
        if (waiter) waiter(value);
        else this.frames.push(value);
      }
    }
  }
}

async function fixture(input?: {
  authenticated?: boolean;
  turns?: Array<Array<Record<string, unknown>>>;
}) {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "claude-wrapper-"));
  roots.push(root);
  const workspace = join(root, "workspace");
  const config = join(root, "claude-config");
  const control = join(root, "control");
  await Promise.all([mkdir(workspace), mkdir(config), mkdir(control)]);
  await mkdir(join(config, ".tmp"));
  return {
    backend: "fake",
    wrapper_version: "1.0.0",
    sdk_version: "0.3.292",
    claude_code_version: "2.1.292",
    runtime_sha256: "a".repeat(64),
    claude_executable: "/opt/qe/claude",
    sdk_module: "/opt/qe/sdk.mjs",
    sdk_package_json: "/opt/qe/package.json",
    zod_module: "/opt/qe/zod.mjs",
    workspace,
    workspace_access: "read_write",
    config_dir: config,
    control_descriptor: join(control, "descriptor.json"),
    temp_dir: join(config, ".tmp"),
    model: "claude-test-exact",
    effort: "high",
    tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
    native_session_id: null,
    runtime_models: [{ id: "claude-test-exact", effort: ["high"] }],
    fake: {
      authenticated: input?.authenticated ?? true,
      models: [{ id: "claude-test-exact", effort: ["high"] }],
      turns: input?.turns ?? [],
    },
  };
}

function command(
  generation: string,
  type: string,
  requestId: string,
  extra: Record<string, unknown> = {},
) {
  return {
    protocol_version: 1,
    generation,
    type,
    request_id: requestId,
    ...extra,
  };
}

async function initialize(
  process: WrapperProcess,
  configuration: Awaited<ReturnType<typeof fixture>>,
  generation = "generation-a",
) {
  process.send(
    command(generation, "initialize", "initialize-a", { configuration }),
  );
  return process.next();
}

test("real headless wrapper fake streams session, tools, usage, HumanAttention, completion, and settlement", async () => {
  const process = new WrapperProcess();
  const configuration = await fixture({
    turns: [
      [
        { type: "native_session", session_id: "session-a" },
        {
          type: "tool",
          name: "Read",
          input: { file_path: "README.md" },
        },
        {
          type: "usage",
          model_usage: {
            "claude-test-exact": {
              inputTokens: 11,
              outputTokens: 7,
              cacheReadInputTokens: 3,
              cacheCreationInputTokens: 2,
              thinkingTokens: 5,
            },
          },
          total_cost_usd: 0.012,
          result_count: 1,
        },
        {
          type: "attention",
          native_request_id: "native-request-a",
          category: "needs_confirmation",
          interaction: "confirmation",
          message: "Approve the exact safe action?",
        },
        { type: "complete", outputs: { result: { status: "ok" } } },
        { type: "settle" },
      ],
    ],
  });
  const ready = await initialize(process, configuration);
  expect(ready).toMatchObject({
    type: "ready",
    authentication: "authenticated",
    sdk_version: "0.3.292",
    claude_code_version: "2.1.292",
    streamed_process: "attached_only",
  });

  process.send(
    command("generation-a", "execute_turn", "execute-a", {
      turn_id: "turn-a",
      prompt: "deterministic fixture prompt",
      continuation: false,
    }),
  );
  const observed: string[] = [];
  for (;;) {
    const event = await process.next();
    observed.push(String(event.type));
    decodeEvent(JSON.stringify(event), "generation-a");
    if (event.type === "human_attention_request") {
      expect(event).toMatchObject({
        native_request_id: "native-request-a",
        category: "needs_confirmation",
        interaction: "confirmation",
      });
      process.send(
        command(
          "generation-a",
          "human_attention_response",
          "attention-response-a",
          {
            native_request_id: event.native_request_id,
            attention_id: event.attention_id,
            response: { approved: true, value: { confirmation: "approved" } },
          },
        ),
      );
    }
    if (event.type === "qe_complete_step") {
      expect(event.outputs).toEqual({ result: { status: "ok" } });
      process.send(
        command(
          "generation-a",
          "qe_complete_step_result",
          "completion-response-a",
          {
            tool_call_id: event.tool_call_id,
            accepted: true,
            error_code: null,
          },
        ),
      );
    }
    if (event.type === "usage") {
      expect(event.models).toEqual([
        {
          model: "claude-test-exact",
          input_tokens: 11,
          output_tokens: 7,
          cache_read_tokens: 3,
          cache_write_tokens: 2,
          reasoning_tokens: 5,
        },
      ]);
      expect(event.estimated_cost_usd).toBe(0.012);
    }
    if (event.type === "turn_settled") {
      expect(event).toMatchObject({
        observed_model: "claude-test-exact",
        effort_attestation: "high",
        completion_acknowledged: true,
      });
      break;
    }
  }
  expect(observed).toEqual(
    expect.arrayContaining([
      "native_session",
      "native_activity",
      "usage",
      "human_attention_request",
      "qe_complete_step",
      "turn_settled",
    ]),
  );
  process.send(command("generation-a", "shutdown", "shutdown-a"));
  expect(await process.next()).toMatchObject({ type: "shutdown", accepted: true });
  expect(await process.exited).toBe(0);
});

test("unauthenticated wrapper advertises setup but executes zero provider turns", async () => {
  const process = new WrapperProcess();
  const configuration = await fixture({ authenticated: false });
  let providerTurns = 0;
  const ready = await initialize(process, configuration);
  expect(ready).toMatchObject({
    type: "ready",
    authentication: "authentication_required",
    setup_available: true,
  });
  process.send(
    command("generation-a", "execute_turn", "execute-authless", {
      turn_id: "turn-authless",
      prompt: "must not run",
      continuation: false,
    }),
  );
  const fatal = await process.next();
  if (fatal.type === "native_activity") providerTurns += 1;
  expect(fatal).toMatchObject({
    type: "fatal_error",
    code: "authentication_required",
    side_effect_certainty: "not_submitted",
  });
  expect(providerTurns).toBe(0);
  expect(await process.exited).toBe(70);
});

test("wrapper fails closed on forbidden tools and exact model or effort mismatch", async () => {
  for (const action of [
    { type: "tool", name: "WebFetch", input: {} },
    { type: "model", model: "claude-wrong" },
    { type: "effort", effort: "low" },
  ]) {
    const process = new WrapperProcess();
    const configuration = await fixture({ turns: [[action]] });
    await initialize(process, configuration);
    process.send(
      command("generation-a", "execute_turn", "execute-a", {
        turn_id: "turn-a",
        prompt: "fixture",
        continuation: false,
      }),
    );
    let fatal: Record<string, unknown> | null = null;
    while (!fatal) {
      const event = await process.next();
      if (event.type === "fatal_error") fatal = event;
    }
    expect(fatal.code).toBe(
      action.type === "tool"
        ? "tool_policy_violation"
        : action.type === "model"
          ? "model_unavailable"
          : "effort_unavailable",
    );
    expect(fatal.side_effect_certainty).toBe("native_accepted");
    expect(await process.exited).toBe(70);
  }
});

test("wrapper cancellation correlates the active request and closes pending HumanAttention", async () => {
  const process = new WrapperProcess();
  const configuration = await fixture({
    turns: [
      [
        {
          type: "attention",
          native_request_id: "native-cancel",
          interaction: "text",
          message: "Waiting",
        },
        { type: "complete", outputs: { result: true } },
      ],
    ],
  });
  await initialize(process, configuration);
  process.send(
    command("generation-a", "execute_turn", "execute-cancel", {
      turn_id: "turn-cancel",
      prompt: "fixture",
      continuation: false,
    }),
  );
  for (;;) {
    const event = await process.next();
    if (event.type !== "human_attention_request") continue;
    process.send(
      command("generation-a", "cancel_turn", "cancel-a", {
        turn_id: "turn-cancel",
      }),
    );
    break;
  }
  const settled = await process.next();
  expect(settled).toMatchObject({
    type: "turn_settled",
    request_id: "execute-cancel",
    turn_id: "turn-cancel",
    outcome: "cancelled",
  });
  process.send(command("generation-a", "shutdown", "shutdown-a"));
  expect(await process.next()).toMatchObject({ type: "shutdown" });
  expect(await process.exited).toBe(0);
});

test("wrapper rejects duplicate, stale, malformed, and oversized protocol frames", async () => {
  const duplicate = new WrapperProcess();
  const configuration = await fixture();
  const initialization = command("generation-a", "initialize", "duplicate-a", {
    configuration,
  });
  duplicate.send(initialization);
  expect(await duplicate.next()).toMatchObject({ type: "ready" });
  duplicate.send(initialization);
  expect(await duplicate.next()).toMatchObject({
    type: "fatal_error",
    code: "duplicate_request",
  });
  expect(await duplicate.exited).toBe(70);

  const stale = new WrapperProcess();
  await initialize(stale, await fixture());
  stale.send(command("generation-stale", "shutdown", "stale-a"));
  expect(await stale.next()).toMatchObject({
    type: "fatal_error",
    code: "stale_generation",
  });
  expect(await stale.exited).toBe(70);

  const malformed = new WrapperProcess();
  malformed.raw("{not-json}\n");
  expect(await malformed.next()).toMatchObject({
    type: "fatal_error",
    code: "malformed_frame",
  });
  expect(await malformed.exited).toBe(70);

  const oversized = new WrapperProcess();
  oversized.raw(`${"x".repeat(CLAUDE_WRAPPER_MAX_FRAME_BYTES + 1)}\n`);
  expect(await oversized.next()).toMatchObject({
    type: "fatal_error",
    code: "oversized_frame",
  });
  expect(await oversized.exited).toBe(70);
});
