import type { WorkerCapabilities } from "./types.ts";
import { WORKER_PROTOCOL_VERSION } from "./types.ts";

interface PendingReply {
  generation: number;
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ChannelSocket {
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

interface ActiveConnection {
  generation: number;
  joinRef: string;
  socket: ChannelSocket;
  rejectConnect(error: Error): void;
  serverGeneration: number | null;
}

export interface ChannelHandlers {
  onProtocol(
    message: Record<string, unknown>,
    generation: number,
  ): void | Promise<void>;
  onRegistered(
    response: Record<string, unknown>,
    generation: number,
  ): void | Promise<void>;
  onDisconnected?(generation: number, error: Error): void;
  onSuperseded(): void;
}

export interface PhoenixWorkerChannelOptions {
  connectTimeoutMs?: number;
  replyTimeoutMs?: number;
  socketFactory?: (url: URL) => ChannelSocket;
}

/**
 * Owns exactly one Phoenix topic membership at a time.
 *
 * A WebSocket can remain open after its channel process has disappeared. Every
 * callback, reply, and timeout is therefore fenced by a local connection
 * generation rather than by socket identity or `readyState` alone.
 */
export class PhoenixWorkerChannel {
  private active: ActiveConnection | null = null;
  private connectOperation: Promise<void> | null = null;
  private ref = 0;
  private generation = 0;
  private registered = false;
  private readonly pending = new Map<string, PendingReply>();
  private readonly connectTimeoutMs: number;
  private readonly replyTimeoutMs: number;
  private readonly socketFactory: (url: URL) => ChannelSocket;

  constructor(
    private readonly url: string,
    private readonly workerId: string,
    private readonly token: string,
    private readonly capabilities: WorkerCapabilities,
    private readonly handlers: ChannelHandlers,
    options: PhoenixWorkerChannelOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.replyTimeoutMs = options.replyTimeoutMs ?? 30_000;
    this.socketFactory =
      options.socketFactory ??
      ((url) => new WebSocket(url) as unknown as ChannelSocket);
  }

  connect(): Promise<void> {
    if (this.active && this.registered) return Promise.resolve();
    if (this.connectOperation) return this.connectOperation;

    const generation = ++this.generation;
    const operation = this.open(generation).finally(() => {
      if (this.connectOperation === operation) this.connectOperation = null;
    });
    this.connectOperation = operation;
    return operation;
  }

  isRegistered(): boolean {
    return Boolean(this.active && this.registered);
  }

  isCurrentGeneration(generation: number): boolean {
    return Boolean(this.active?.generation === generation && this.registered);
  }

  currentGeneration(): number | null {
    return this.active && this.registered ? this.active.generation : null;
  }

  currentServerGeneration(): number | null {
    return this.active && this.registered ? this.active.serverGeneration : null;
  }

  async sendProtocol(
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const active = this.active;
    if (!active || !this.registered)
      throw new Error("Worker is not registered.");

    const ref = String(++this.ref);
    const key = pendingKey(active.generation, ref);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(key)) return;
        const error = new Error("Worker protocol reply timed out.");
        this.invalidate(active.generation, error, true);
      }, this.replyTimeoutMs);
      this.pending.set(key, {
        generation: active.generation,
        resolve,
        reject,
        timer,
      });
    });

    try {
      active.socket.send(
        JSON.stringify([
          active.joinRef,
          ref,
          "worker:control",
          "protocol",
          message,
        ]),
      );
    } catch (error) {
      this.invalidate(
        active.generation,
        asError(error, "Worker protocol send failed."),
        true,
      );
    }
    return response;
  }

  close(): void {
    const active = this.active;
    if (!active) return;
    this.invalidate(
      active.generation,
      new Error("Worker WebSocket disconnected."),
      true,
    );
  }

  private open(generation: number): Promise<void> {
    const url = new URL(this.url);
    url.searchParams.set("vsn", "2.0.0");
    url.searchParams.set("worker_token", this.token);

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const settleResolve = () => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        resolve();
      };
      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        reject(error);
      };

      let socket: ChannelSocket;
      try {
        socket = this.socketFactory(url);
      } catch (error) {
        settleReject(asError(error, "Worker WebSocket connection failed."));
        return;
      }

      const joinRef = String(++this.ref);
      const active: ActiveConnection = {
        generation,
        joinRef,
        socket,
        rejectConnect: settleReject,
        serverGeneration: null,
      };
      this.active = active;
      this.registered = false;

      timeout = setTimeout(() => {
        this.invalidate(
          generation,
          new Error("Worker WebSocket connection timed out."),
          true,
        );
      }, this.connectTimeoutMs);

      socket.onopen = () => {
        if (!this.current(active)) return;
        try {
          socket.send(
            JSON.stringify([
              joinRef,
              joinRef,
              "worker:control",
              "phx_join",
              {
                type: "worker_hello",
                protocol_version: WORKER_PROTOCOL_VERSION,
                worker_id: this.workerId,
                capabilities: this.capabilities,
              },
            ]),
          );
        } catch (error) {
          this.invalidate(
            generation,
            asError(error, "Worker registration send failed."),
            true,
          );
        }
      };
      socket.onerror = () => {
        this.invalidate(
          generation,
          new Error("Worker WebSocket connection failed."),
          true,
        );
      };
      socket.onclose = () => {
        this.invalidate(
          generation,
          new Error(
            this.registered
              ? "Worker WebSocket disconnected."
              : "Worker WebSocket closed before registration.",
          ),
          false,
        );
      };
      socket.onmessage = (event) => {
        if (!this.current(active)) return;
        try {
          this.handleFrame(
            JSON.parse(String(event.data)) as unknown,
            active,
            settleResolve,
          );
        } catch (error) {
          this.invalidate(
            generation,
            asError(error, "Worker WebSocket frame was invalid."),
            true,
          );
        }
      };
    });
  }

  private handleFrame(
    frame: unknown,
    active: ActiveConnection,
    connected: () => void,
  ): void {
    if (!this.current(active) || !Array.isArray(frame) || frame.length !== 5)
      return;
    const [joinRef, ref, topic, event, payload] = frame;
    if (topic !== "worker:control" || typeof event !== "string") return;

    if (
      event === "phx_reply" &&
      joinRef === active.joinRef &&
      ref === active.joinRef
    ) {
      const reply = record(payload);
      if (reply.status !== "ok") {
        this.invalidate(
          active.generation,
          new Error(
            `Worker registration rejected: ${JSON.stringify(reply.response ?? reply)}`,
          ),
          true,
        );
        return;
      }
      const response = record(reply.response);
      const serverGeneration = response.connection_generation;
      active.serverGeneration =
        typeof serverGeneration === "number" &&
        Number.isSafeInteger(serverGeneration) &&
        serverGeneration > 0
          ? serverGeneration
          : null;
      this.registered = true;
      connected();
      void Promise.resolve(
        this.handlers.onRegistered(response, active.generation),
      ).catch((error) => {
        this.invalidate(
          active.generation,
          asError(error, "Worker registration reconciliation failed."),
          true,
        );
      });
      return;
    }

    if (event === "phx_reply" && typeof ref === "string") {
      const key = pendingKey(active.generation, ref);
      const pending = this.pending.get(key);
      if (!pending) return;
      const reply = record(payload);
      if (reply.status !== "ok" && invalidatesGeneration(reply)) {
        this.invalidate(
          active.generation,
          new Error(
            unmatchedTopic(reply)
              ? "Worker Phoenix channel membership was lost."
              : "Worker control-plane generation was invalidated.",
          ),
          true,
        );
        return;
      }
      this.pending.delete(key);
      clearTimeout(pending.timer);
      if (reply.status === "ok") pending.resolve(record(reply.response));
      else
        pending.reject(
          new Error(
            `Worker protocol message rejected: ${JSON.stringify(reply.response ?? reply)}`,
          ),
        );
      return;
    }

    if (event === "phx_error" || event === "phx_close") {
      this.invalidate(
        active.generation,
        new Error(`Worker Phoenix channel closed (${event}).`),
        true,
      );
      return;
    }

    if (event === "protocol") {
      const message = record(payload);
      if (message.type === "connection_superseded") {
        this.handlers.onSuperseded();
        this.invalidate(
          active.generation,
          new Error("Worker connection was superseded."),
          true,
        );
      } else {
        void Promise.resolve(
          this.handlers.onProtocol(message, active.generation),
        ).catch((error) => {
          console.error(
            "Worker protocol handler failed",
            error instanceof Error ? error.message : String(error),
          );
        });
      }
    }
  }

  private invalidate(
    generation: number,
    error: Error,
    closeSocket: boolean,
  ): void {
    const active = this.active;
    if (!active || active.generation !== generation) return;

    this.active = null;
    this.registered = false;
    active.rejectConnect(error);
    this.rejectPending(generation, error);
    this.handlers.onDisconnected?.(generation, error);
    if (closeSocket) {
      try {
        active.socket.close();
      } catch {
        // The generation is already fenced; close failure cannot revive it.
      }
    }
  }

  private current(active: ActiveConnection): boolean {
    return (
      this.active?.generation === active.generation &&
      this.active.socket === active.socket
    );
  }

  private rejectPending(generation: number, error: Error): void {
    for (const [key, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      this.pending.delete(key);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

function pendingKey(generation: number, ref: string): string {
  return `${generation}:${ref}`;
}

function invalidatesGeneration(reply: Record<string, unknown>): boolean {
  if (unmatchedTopic(reply)) return true;
  const response = record(reply.response);
  const error = record(response.error);
  return [
    "internal_server_error",
    "stale_connection_generation",
    "worker_not_found",
  ].includes(String(error.code ?? ""));
}

function unmatchedTopic(reply: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(reply).toLowerCase().includes("unmatched topic");
  } catch {
    return false;
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
