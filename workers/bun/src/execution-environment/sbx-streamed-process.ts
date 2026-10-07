import type { SbxClient } from "./sbx-client.ts";
import type {
  StreamedProcessTransport,
  StreamedProcessTransportEvent,
  StreamedProcessTransportIdentity,
  StreamedProcessTransportSideEffect,
} from "./streamed-process.ts";
import type { StreamedProcessCommand, StreamedProcessExit } from "./types.ts";
import { EnvironmentBackendError } from "./types.ts";

const READY = 1;
const STDOUT = 2;
const STDERR = 3;
const STDOUT_EOF = 4;
const STDERR_EOF = 5;
const WRITE_ACK = 6;
const WRITE_REJECTED = 7;
const WRITE_AMBIGUOUS = 8;
const CANCEL_ACK = 9;
const CANCEL_REJECTED = 10;
const EXIT = 11;
const RELAY_ERROR = 12;
const CLOSE_ACK = 13;
const WRITE = 20;
const CLOSE_STDIN = 21;
const CANCEL = 22;
const MAX_RELAY_FRAME_BYTES = 1024 * 1024 + 64;

interface RelayFrame {
  type: number;
  payload: Uint8Array;
}

interface SideEffectWaiter {
  resolve(result: StreamedProcessTransportSideEffect): void;
  timer: ReturnType<typeof setTimeout>;
}

interface RelayChild {
  stdin: {
    write(data: Uint8Array): number;
    flush(): number | Promise<number>;
    end(): number | Promise<number>;
  };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

/** Native `sbx exec -i` attachment to the generic guest relay (never a PTY). */
export class SbxStreamedProcessTransport implements StreamedProcessTransport {
  readonly identity: StreamedProcessTransportIdentity;
  private readonly pendingWrites = new Map<string, SideEffectWaiter>();
  private readonly pendingCancellations = new Map<string, SideEffectWaiter>();
  private readonly stderrReader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly stderrDrain: Promise<void>;
  private hostExited = false;
  private targetExited = false;
  private disconnected = false;
  private runStarted = false;
  private transportStderrObserved = false;

  private constructor(
    private readonly child: RelayChild,
    private readonly frames: RelayFrameReader,
    identity: StreamedProcessTransportIdentity,
    private readonly acknowledgementTimeoutMs: number,
  ) {
    this.identity = identity;
    this.stderrReader = child.stderr.getReader();
    this.stderrDrain = this.drainTransportStderr();
    void child.exited.then(() => {
      this.hostExited = true;
    });
  }

  static async open(input: {
    client: SbxClient;
    sandboxName: string;
    command: StreamedProcessCommand;
    relaySource: string;
    markerPath: string;
    expectedMarkerSha256: string;
    acknowledgementTimeoutMs: number;
  }): Promise<SbxStreamedProcessTransport> {
    const relayCommand = {
      executable: "/usr/bin/python3",
      args: [
        "-u",
        "-c",
        input.relaySource,
        input.markerPath,
        "--",
        input.command.executable,
        ...input.command.args,
      ],
      cwd: input.command.cwd,
      environment: { ...input.command.environment },
    };
    const child = Bun.spawn(
      [
        input.client.executable,
        ...input.client.streamLauncherArgs(input.sandboxName, relayCommand),
      ],
      {
        env: definedProcessEnvironment(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      },
    ) as unknown as RelayChild;
    const frames = new RelayFrameReader(child.stdout);
    try {
      const first = await withTimeout(
        frames.next(),
        input.acknowledgementTimeoutMs,
      );
      if (!first || first.type !== READY)
        throw new EnvironmentBackendError(
          first?.type === RELAY_ERROR
            ? "streamed_process_spawn_failed"
            : "streamed_process_identity_mismatch",
          "SBX guest relay did not return an exact process identity.",
          "spawn_streamed",
        );
      const ready = parseObject(first.payload);
      const backendProcessId = requiredText(ready.pid);
      const processStartIdentity = requiredText(ready.startIdentity);
      const observedExecutable = requiredText(ready.observedExecutable);
      if (
        requiredText(ready.environmentMarkerSha256) !==
        input.expectedMarkerSha256
      )
        throw new EnvironmentBackendError(
          "streamed_process_identity_mismatch",
          "SBX guest ownership marker changed at streamed process launch.",
          "spawn_streamed",
        );
      return new SbxStreamedProcessTransport(
        child,
        frames,
        {
          backendProcessId,
          processStartIdentity,
          observedExecutable,
        },
        input.acknowledgementTimeoutMs,
      );
    } catch (error) {
      await frames.cancel().catch(() => undefined);
      await Promise.resolve(child.stdin.end()).catch(() => undefined);
      child.kill("SIGTERM");
      if (error instanceof EnvironmentBackendError) throw error;
      throw new EnvironmentBackendError(
        "streamed_process_spawn_failed",
        "SBX streamed process relay did not become ready within the bounded handshake.",
        "spawn_streamed",
      );
    }
  }

  async run(
    onEvent: (event: StreamedProcessTransportEvent) => Promise<void>,
  ): Promise<void> {
    if (this.runStarted)
      throw new Error("SBX streamed process transport can be consumed once.");
    this.runStarted = true;
    try {
      while (!this.disconnected) {
        const frame = await this.frames.next();
        if (!frame) break;
        if (frame.type === STDOUT || frame.type === STDERR) {
          await onEvent({
            kind: "data",
            stream: frame.type === STDOUT ? "stdout" : "stderr",
            data: new Uint8Array(frame.payload),
          });
          continue;
        }
        if (frame.type === STDOUT_EOF || frame.type === STDERR_EOF) {
          await onEvent({
            kind: "eof",
            stream: frame.type === STDOUT_EOF ? "stdout" : "stderr",
          });
          continue;
        }
        if (
          frame.type === WRITE_ACK ||
          frame.type === WRITE_REJECTED ||
          frame.type === WRITE_AMBIGUOUS ||
          frame.type === CLOSE_ACK
        ) {
          this.resolveWaiter(
            this.pendingWrites,
            decodeId(frame.payload),
            frame.type === WRITE_ACK || frame.type === CLOSE_ACK
              ? "acknowledged"
              : frame.type === WRITE_REJECTED
                ? "rejected"
                : "ambiguous",
          );
          continue;
        }
        if (frame.type === CANCEL_ACK || frame.type === CANCEL_REJECTED) {
          this.resolveWaiter(
            this.pendingCancellations,
            decodeId(frame.payload),
            frame.type === CANCEL_ACK ? "acknowledged" : "rejected",
          );
          continue;
        }
        if (frame.type === EXIT) {
          this.targetExited = true;
          await onEvent({ kind: "exit", exit: parseExit(frame.payload) });
          continue;
        }
        await onEvent({
          kind: "transport_error",
          errorCode:
            frame.type === RELAY_ERROR
              ? "streamed_process_spawn_failed"
              : "streamed_process_stream_unavailable",
        });
        break;
      }
      const hostExitCode = await this.child.exited;
      if (
        !this.disconnected &&
        (!this.targetExited ||
          hostExitCode !== 0 ||
          this.transportStderrObserved)
      )
        await onEvent({
          kind: "transport_error",
          errorCode: "streamed_process_stream_unavailable",
        });
    } catch {
      if (!this.disconnected)
        await onEvent({
          kind: "transport_error",
          errorCode: "streamed_process_stream_unavailable",
        });
    } finally {
      this.resolveAllPending("ambiguous");
      await this.stderrDrain.catch(() => undefined);
    }
  }

  write(
    writeId: string,
    data: Uint8Array,
  ): Promise<StreamedProcessTransportSideEffect> {
    return this.request(this.pendingWrites, WRITE, writeId, data);
  }

  closeStdin(writeId: string): Promise<StreamedProcessTransportSideEffect> {
    return this.request(this.pendingWrites, CLOSE_STDIN, writeId);
  }

  cancel(cancellationId: string): Promise<StreamedProcessTransportSideEffect> {
    return this.request(this.pendingCancellations, CANCEL, cancellationId);
  }

  async disconnect(): Promise<void> {
    if (this.disconnected) return;
    this.disconnected = true;
    this.resolveAllPending("ambiguous");
    await Promise.resolve(this.child.stdin.end()).catch(() => undefined);
    this.child.kill("SIGTERM");
    await this.frames.cancel().catch(() => undefined);
    await this.stderrReader.cancel().catch(() => undefined);
    await withTimeout(
      this.child.exited.then(() => undefined),
      1_000,
    ).catch(() => undefined);
    await this.stderrDrain.catch(() => undefined);
  }

  private request(
    waiters: Map<string, SideEffectWaiter>,
    frameType: number,
    requestId: string,
    data: Uint8Array = new Uint8Array(),
  ): Promise<StreamedProcessTransportSideEffect> {
    if (this.disconnected || this.hostExited || this.targetExited)
      return Promise.resolve({ certainty: "rejected" });
    if (waiters.has(requestId))
      return Promise.resolve({ certainty: "rejected" });
    const id = new TextEncoder().encode(requestId);
    const payload = new Uint8Array(id.byteLength + data.byteLength);
    payload.set(id);
    payload.set(data, id.byteLength);
    const frame = encodeFrame(frameType, payload);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiters.delete(requestId);
        resolve({ certainty: "ambiguous" });
      }, this.acknowledgementTimeoutMs);
      timer.unref();
      waiters.set(requestId, { resolve, timer });
      try {
        this.child.stdin.write(frame);
        void Promise.resolve(this.child.stdin.flush()).catch(() =>
          this.resolveWaiter(waiters, requestId, "ambiguous"),
        );
      } catch {
        this.resolveWaiter(waiters, requestId, "ambiguous");
      }
    });
  }

  private resolveWaiter(
    waiters: Map<string, SideEffectWaiter>,
    requestId: string,
    certainty: StreamedProcessTransportSideEffect["certainty"],
  ): void {
    const waiter = waiters.get(requestId);
    if (!waiter) return;
    waiters.delete(requestId);
    clearTimeout(waiter.timer);
    waiter.resolve({ certainty });
  }

  private resolveAllPending(
    certainty: StreamedProcessTransportSideEffect["certainty"],
  ): void {
    for (const id of [...this.pendingWrites.keys()])
      this.resolveWaiter(this.pendingWrites, id, certainty);
    for (const id of [...this.pendingCancellations.keys()])
      this.resolveWaiter(this.pendingCancellations, id, certainty);
  }

  private async drainTransportStderr(): Promise<void> {
    try {
      while (true) {
        const next = await this.stderrReader.read();
        if (next.done) return;
        if (next.value.byteLength > 0) this.transportStderrObserved = true;
      }
    } finally {
      this.stderrReader.releaseLock();
    }
  }
}

class RelayFrameReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffered = new Uint8Array();
  private done = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async next(): Promise<RelayFrame | null> {
    const header = await this.read(5);
    if (!header) return null;
    const view = new DataView(
      header.buffer,
      header.byteOffset,
      header.byteLength,
    );
    const type = view.getUint8(0);
    const length = view.getUint32(1, false);
    if (length > MAX_RELAY_FRAME_BYTES)
      throw new Error("SBX streamed process relay frame exceeded its bound.");
    const payload = length === 0 ? new Uint8Array() : await this.read(length);
    if (!payload)
      throw new Error("SBX streamed process relay ended inside a frame.");
    return { type, payload };
  }

  async cancel(): Promise<void> {
    this.done = true;
    await this.reader.cancel();
  }

  private async read(length: number): Promise<Uint8Array | null> {
    while (this.buffered.byteLength < length && !this.done) {
      const next = await this.reader.read();
      if (next.done) {
        this.done = true;
        break;
      }
      const combined = new Uint8Array(
        this.buffered.byteLength + next.value.byteLength,
      );
      combined.set(this.buffered);
      combined.set(next.value, this.buffered.byteLength);
      this.buffered = combined;
    }
    if (this.buffered.byteLength < length) return null;
    const value = this.buffered.slice(0, length);
    this.buffered = this.buffered.slice(length);
    return value;
  }
}

function encodeFrame(type: number, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, type);
  view.setUint32(1, payload.byteLength, false);
  frame.set(payload, 5);
  return frame;
}

function decodeId(payload: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(payload);
}

function parseObject(payload: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(payload),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SBX relay control record was malformed.");
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error("SBX relay identity field was malformed.");
  return value;
}

function parseExit(payload: Uint8Array): StreamedProcessExit {
  const value = parseObject(payload);
  if (value.kind === "signaled" && typeof value.signal === "string")
    return { kind: "signaled", signal: value.signal };
  if (
    value.kind === "exited" &&
    typeof value.exitCode === "number" &&
    Number.isSafeInteger(value.exitCode) &&
    value.exitCode >= 0
  )
    return value.exitCode === 0
      ? { kind: "exited", exitCode: 0 }
      : { kind: "exited_nonzero", exitCode: value.exitCode };
  return { kind: "observation_unavailable", errorCode: "backend_incompatible" };
}

async function withTimeout<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("streamed process operation timed out")),
          milliseconds,
        );
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function definedProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
