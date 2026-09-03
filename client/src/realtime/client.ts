import { type Channel, Socket } from "phoenix";
import type { RunProjection } from "../api/contracts";

export type RealtimeStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";
export interface RealtimeHandlers {
  onStatus(status: RealtimeStatus): void;
  onJoined(run: RunProjection): void;
  onInvalidated(runId: string): void;
  onUnavailable(runId: string): void;
  onProductInvalidated(resources: string[]): void;
}

export class RealtimeClient {
  private socket: Socket | null = null;
  private runChannels = new Map<string, Channel>();
  private watchedRunIds = new Set<string>();
  private productChannel: Channel | null = null;
  private selectedRunId: string | null = null;

  constructor(
    private readonly socketUrl: string,
    private readonly handlers: RealtimeHandlers,
  ) {}

  start(): void {
    this.connect();
  }

  selectRun(runId: string): void {
    if (this.selectedRunId === runId && this.runChannels.has(runId)) return;
    const previous = this.selectedRunId;
    this.selectedRunId = runId;
    if (previous && !this.watchedRunIds.has(previous)) this.leaveRun(previous);
    this.connect();
    this.join(runId);
  }

  watchRun(runId: string): () => void {
    this.watchedRunIds.add(runId);
    this.connect();
    this.join(runId);
    return () => {
      this.watchedRunIds.delete(runId);
      if (this.selectedRunId !== runId) this.leaveRun(runId);
    };
  }

  disconnect(): void {
    for (const channel of this.runChannels.values()) channel.leave();
    this.productChannel?.leave();
    this.runChannels.clear();
    this.productChannel = null;
    this.selectedRunId = null;
    this.socket?.disconnect();
    this.socket = null;
    this.handlers.onStatus("disconnected");
  }

  private connect(): void {
    if (this.socket) return;
    this.handlers.onStatus("connecting");
    const socket = new Socket(this.socketUrl);
    socket.onOpen(() => {
      this.handlers.onStatus("connected");
      for (const runId of this.interestedRunIds())
        this.handlers.onInvalidated(runId);
      this.joinProduct();
    });
    socket.onError(() => this.handlers.onStatus("reconnecting"));
    socket.onClose(() => this.handlers.onStatus("reconnecting"));
    socket.connect();
    this.socket = socket;
  }

  private joinProduct(): void {
    if (!this.socket || this.productChannel) return;
    const channel = this.socket.channel("product:all");
    channel.on("product_changed", (payload: { resources?: unknown }) => {
      const resources = Array.isArray(payload.resources)
        ? payload.resources.filter(
            (item): item is string => typeof item === "string",
          )
        : [];
      this.handlers.onProductInvalidated(resources);
    });
    channel.join();
    this.productChannel = channel;
  }

  private interestedRunIds(): string[] {
    return [
      ...new Set([
        ...this.watchedRunIds,
        ...(this.selectedRunId ? [this.selectedRunId] : []),
      ]),
    ].sort();
  }

  private leaveRun(runId: string): void {
    this.runChannels.get(runId)?.leave();
    this.runChannels.delete(runId);
  }

  private join(runId: string): void {
    if (!this.socket || this.runChannels.has(runId)) return;
    const channel = this.socket.channel(`run:${runId}`);
    channel.on("run_changed", (payload: { run_id?: unknown }) => {
      if (payload.run_id === runId) this.handlers.onInvalidated(runId);
    });
    channel
      .join()
      .receive("ok", (payload: { run?: RunProjection }) => {
        if (this.selectedRunId === runId && payload.run)
          this.handlers.onJoined(payload.run);
      })
      .receive("error", () => {
        if (this.selectedRunId === runId) this.handlers.onUnavailable(runId);
      });
    this.runChannels.set(runId, channel);
  }
}
