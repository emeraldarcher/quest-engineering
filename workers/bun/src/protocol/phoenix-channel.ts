import type { WorkerCapabilities } from "./types.ts";
import { WORKER_PROTOCOL_VERSION } from "./types.ts";

interface PendingReply {
  resolve(value: Record<string, unknown>): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ChannelHandlers {
  onProtocol(message: Record<string, unknown>): void | Promise<void>;
  onRegistered(response: Record<string, unknown>): void | Promise<void>;
  onSuperseded(): void;
}

export class PhoenixWorkerChannel {
  private socket: WebSocket | null = null;
  private ref = 1;
  private readonly joinRef = "1";
  private readonly topic = "worker:control";
  private registered = false;
  private readonly pending = new Map<string, PendingReply>();

  constructor(
    private readonly url: string,
    private readonly workerId: string,
    private readonly token: string,
    private readonly capabilities: WorkerCapabilities,
    private readonly handlers: ChannelHandlers,
  ) {}

  async connect(): Promise<void> {
    if (this.socket) return;
    const url = new URL(this.url);
    url.searchParams.set("vsn", "2.0.0");
    url.searchParams.set("worker_token", this.token);
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error("Worker WebSocket connection timed out."));
      }, 10_000);
      socket.onopen = () => {
        const payload = {
          type: "worker_hello",
          protocol_version: WORKER_PROTOCOL_VERSION,
          worker_id: this.workerId,
          capabilities: this.capabilities,
        };
        socket.send(
          JSON.stringify([
            this.joinRef,
            this.joinRef,
            this.topic,
            "phx_join",
            payload,
          ]),
        );
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("Worker WebSocket connection failed."));
      };
      socket.onclose = () => {
        clearTimeout(timeout);
        if (!this.registered)
          reject(new Error("Worker WebSocket closed before registration."));
        this.registered = false;
        this.socket = null;
        this.rejectPending(new Error("Worker WebSocket disconnected."));
      };
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(String(event.data)) as unknown;
          this.handleFrame(
            frame,
            () => {
              clearTimeout(timeout);
              resolve();
            },
            reject,
          );
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
    });
  }

  isRegistered(): boolean {
    return this.registered;
  }

  async sendProtocol(
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this.socket || !this.registered)
      throw new Error("Worker is not registered.");
    const ref = String(++this.ref);
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(ref);
        reject(new Error("Worker protocol reply timed out."));
      }, 30_000);
      this.pending.set(ref, { resolve, reject, timer });
    });
    this.socket.send(
      JSON.stringify([this.joinRef, ref, this.topic, "protocol", message]),
    );
    return response;
  }

  close(): void {
    this.socket?.close();
    this.socket = null;
    this.registered = false;
  }

  private handleFrame(
    frame: unknown,
    connected: () => void,
    rejected: (error: Error) => void,
  ): void {
    if (!Array.isArray(frame) || frame.length !== 5) return;
    const [joinRef, ref, topic, event, payload] = frame;
    if (topic !== this.topic || typeof event !== "string") return;
    if (event === "phx_reply" && ref === this.joinRef) {
      const reply = record(payload);
      if (reply.status !== "ok") {
        rejected(
          new Error(
            `Worker registration rejected: ${JSON.stringify(reply.response ?? reply)}`,
          ),
        );
        this.close();
        return;
      }
      this.registered = true;
      connected();
      void Promise.resolve(
        this.handlers.onRegistered(record(reply.response)),
      ).catch((error) => {
        console.error(
          "Worker registration reconciliation failed",
          error instanceof Error ? error.message : String(error),
        );
        this.close();
      });
      return;
    }
    if (event === "phx_reply" && typeof ref === "string") {
      const pending = this.pending.get(ref);
      if (!pending) return;
      this.pending.delete(ref);
      clearTimeout(pending.timer);
      const reply = record(payload);
      if (reply.status === "ok") pending.resolve(record(reply.response));
      else
        pending.reject(
          new Error(
            `Worker protocol message rejected: ${JSON.stringify(reply.response ?? reply)}`,
          ),
        );
      return;
    }
    if (event === "protocol") {
      const message = record(payload);
      if (message.type === "connection_superseded") {
        this.handlers.onSuperseded();
        this.close();
      } else {
        void Promise.resolve(this.handlers.onProtocol(message)).catch(
          (error) => {
            console.error(
              "Worker protocol handler failed",
              error instanceof Error ? error.message : String(error),
            );
          },
        );
      }
    }
    void joinRef;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
