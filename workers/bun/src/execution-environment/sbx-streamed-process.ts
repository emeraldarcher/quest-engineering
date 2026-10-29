import { randomUUID } from "node:crypto";
import type { SbxClient } from "./sbx-client.ts";
import type {
  StreamedProcessTransport,
  StreamedProcessTransportEvent,
  StreamedProcessTransportIdentity,
  StreamedProcessTransportIoSnapshot,
  StreamedProcessTransportSideEffect,
} from "./streamed-process.ts";
import { diagnosticWriteAccepted } from "./streamed-process.ts";
import {
  ioUnavailable,
  STREAMED_PROCESS_IO_TIMEOUT_MS,
  STREAMED_PROCESS_IO_UNAVAILABLE,
  safeIoSample,
} from "./streamed-process-io.ts";
import type {
  StreamedProcessCommand,
  StreamedProcessExit,
  StreamedProcessNegotiatedCapabilities,
} from "./types.ts";
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
const IO_SNAPSHOT = 14;
export const SBX_STREAMED_PROCESS_RELAY_PROTOCOL_VERSION = 2;
const WRITE = 20;
const CLOSE_STDIN = 21;
const CANCEL = 22;
const OBSERVE_IO = 23;
const TRY_WRITE_DIAGNOSTIC = 24;
const MAX_IO_SNAPSHOT_BYTES = 8_192;
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
    write(data: Uint8Array): number | Promise<number>;
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
  private diagnosticWriteAttempted = false;
  private negotiationRetired = false;
  private ioWaiter: {
    id: string;
    resolve(value: StreamedProcessTransportIoSnapshot): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private terminalIo: StreamedProcessTransportIoSnapshot | null = null;

  private constructor(
    private readonly child: RelayChild,
    private readonly frames: RelayFrameReader,
    identity: StreamedProcessTransportIdentity,
    private readonly acknowledgementTimeoutMs: number,
    private readonly processGeneration: string,
    private readonly expectedMarkerSha256: string,
    private readonly ioProtocolSupported: boolean,
    private readonly diagnosticWriteSupported: boolean,
    private readonly diagnosticNegotiationAvailable = true,
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
    processGeneration: string;
    command: StreamedProcessCommand;
    relaySource: string;
    markerPath: string;
    expectedMarkerSha256: string;
    acknowledgementTimeoutMs: number;
  }): Promise<SbxStreamedProcessTransport> {
    const environmentNames = Buffer.from(
      JSON.stringify(Object.keys(input.command.environment).sort()),
    ).toString("base64");
    const relayCommand = {
      executable: "/usr/bin/python3",
      args: [
        "-u",
        "-c",
        input.relaySource,
        input.markerPath,
        "--environment-names-base64",
        environmentNames,
        "--process-generation",
        input.processGeneration,
        "--",
        input.command.executable,
        ...input.command.args,
      ],
      cwd: input.command.cwd,
      environment: { ...input.command.environment },
    };
    let child: RelayChild;
    try {
      child = Bun.spawn(
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
    } catch {
      throw new EnvironmentBackendError(
        "streamed_process_spawn_failed",
        "SBX streamed process launcher was rejected before invocation.",
        "spawn_streamed",
        "not_submitted",
      );
    }
    const frames = new RelayFrameReader(child.stdout);
    try {
      const first = await withTimeout(
        frames.next(),
        input.acknowledgementTimeoutMs,
      );
      if (!first || first.type !== READY) {
        const relayErrorCode =
          first?.type === RELAY_ERROR
            ? optionalText(parseObject(first.payload).code)
            : null;
        const knownNotSubmitted = new Set([
          "invalid_argv",
          "invalid_environment",
          "executable_not_absolute",
          "spawn_not_started",
        ]).has(relayErrorCode ?? "");
        throw new EnvironmentBackendError(
          first?.type === RELAY_ERROR
            ? "streamed_process_spawn_failed"
            : "streamed_process_identity_mismatch",
          "SBX guest relay did not return an exact process identity.",
          "spawn_streamed",
          knownNotSubmitted ? "not_submitted" : "ambiguous",
        );
      }
      const ready = parseReady(first.payload);
      const backendProcessId = requiredText(ready.pid);
      const processStartIdentity = requiredText(ready.startIdentity);
      const observedExecutable = requiredText(ready.observedExecutable);
      const observedExecutableIdentity =
        typeof ready.observedExecutableIdentity === "string" &&
        /^[0-9]{1,20}:[0-9]{1,20}$/.test(ready.observedExecutableIdentity)
          ? ready.observedExecutableIdentity
          : undefined;
      if (
        requiredText(ready.environmentMarkerSha256) !==
        input.expectedMarkerSha256
      )
        throw new EnvironmentBackendError(
          "streamed_process_identity_mismatch",
          "SBX guest ownership marker changed at streamed process launch.",
          "spawn_streamed",
          "ambiguous",
        );
      return new SbxStreamedProcessTransport(
        child,
        frames,
        {
          backendProcessId,
          processStartIdentity,
          observedExecutable,
          ...(observedExecutableIdentity ? { observedExecutableIdentity } : {}),
        },
        input.acknowledgementTimeoutMs,
        input.processGeneration,
        input.expectedMarkerSha256,
        ready.protocolVersion === SBX_STREAMED_PROCESS_RELAY_PROTOCOL_VERSION,
        ready.protocolVersion === SBX_STREAMED_PROCESS_RELAY_PROTOCOL_VERSION &&
          ready.nonblockingDiagnosticWrite === true,
        (ready.nonblockingDiagnosticWrite === undefined ||
          typeof ready.nonblockingDiagnosticWrite === "boolean") &&
          (ready.protocolVersion === undefined ||
            (Number.isSafeInteger(ready.protocolVersion) &&
              (ready.protocolVersion as number) > 0)),
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
        "ambiguous",
      );
    }
  }

  async run(
    onEvent: (event: StreamedProcessTransportEvent) => Promise<void>,
  ): Promise<void> {
    if (this.runStarted)
      throw new Error("SBX streamed process transport can be consumed once.");
    this.runStarted = true;
    let stdoutEof = false;
    let stderrEof = false;
    try {
      while (!this.disconnected) {
        const frame = await this.frames.next();
        if (!frame) {
          this.negotiationRetired = true;
          break;
        }
        if (frame.type === STDOUT || frame.type === STDERR) {
          await onEvent({
            kind: "data",
            stream: frame.type === STDOUT ? "stdout" : "stderr",
            data: new Uint8Array(frame.payload),
          });
          continue;
        }
        if (frame.type === STDOUT_EOF || frame.type === STDERR_EOF) {
          const stream = frame.type === STDOUT_EOF ? "stdout" : "stderr";
          if (stream === "stdout") stdoutEof = true;
          else stderrEof = true;
          await onEvent({ kind: "eof", stream });
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
        if (frame.type === IO_SNAPSHOT) {
          this.receiveIo(frame.payload);
          continue; // Malformed/unavailable diagnostics never poison real process events.
        }
        if (frame.type === EXIT) {
          this.targetExited = true;
          await onEvent({ kind: "exit", exit: parseExit(frame.payload) });
          continue;
        }
        // The live attachment is already unusable. Revoke before publishing
        // through an async/backpressured observer, not only in finally.
        this.negotiationRetired = true;
        await onEvent({
          kind: "transport_error",
          errorCode:
            frame.type === RELAY_ERROR
              ? "streamed_process_spawn_failed"
              : "streamed_process_stream_unavailable",
        });
        break;
      }
      await this.child.exited;
      if (
        !this.disconnected &&
        (!this.targetExited || !stdoutEof || !stderrEof)
      )
        await onEvent({
          kind: "transport_error",
          errorCode: "streamed_process_stream_unavailable",
        });
    } catch {
      this.negotiationRetired = true;
      if (!this.disconnected)
        await onEvent({
          kind: "transport_error",
          errorCode: "streamed_process_stream_unavailable",
        });
    } finally {
      this.negotiationRetired = true;
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
    this.negotiationRetired = true;
    return this.request(this.pendingWrites, CLOSE_STDIN, writeId);
  }

  cancel(cancellationId: string): Promise<StreamedProcessTransportSideEffect> {
    this.negotiationRetired = true;
    return this.request(this.pendingCancellations, CANCEL, cancellationId);
  }

  negotiatedCapabilities(): Readonly<StreamedProcessNegotiatedCapabilities> {
    const unavailable =
      !this.diagnosticNegotiationAvailable ||
      !this.runStarted ||
      this.negotiationRetired ||
      this.disconnected ||
      this.hostExited ||
      this.targetExited ||
      !this.identity.observedExecutableIdentity;
    return Object.freeze({
      nonblockingDiagnosticWrite: unavailable
        ? "unavailable"
        : this.diagnosticWriteSupported
          ? "supported"
          : "unsupported",
    });
  }

  tryWriteDiagnostic(data: Uint8Array): boolean {
    if (this.diagnosticWriteAttempted) return false;
    this.diagnosticWriteAttempted = true;
    if (
      !this.diagnosticWriteSupported ||
      this.negotiationRetired ||
      !this.identity.observedExecutableIdentity ||
      !this.runStarted ||
      this.disconnected ||
      this.hostExited ||
      this.targetExited ||
      this.pendingWrites.size ||
      this.pendingCancellations.size ||
      data.byteLength === 0 ||
      data.byteLength > 512
    )
      return false;
    try {
      // No ACK waiter/timer and no ordinary WRITE: the guest uses one atomic
      // nonblocking pipe write, so it cannot wait ahead of physical CANCEL.
      const frame = encodeFrame(TRY_WRITE_DIAGNOSTIC, data);
      // FileSink owns the whole ordered chunk, but may return an async or
      // partial count under backpressure. Such outcomes remain unavailable;
      // contain rejection and initiate flushing without awaiting either.
      const written = this.child.stdin.write(frame);
      if (typeof written !== "number") diagnosticWriteAccepted(written);
      void Promise.resolve(this.child.stdin.flush()).catch(() => undefined);
      return written === frame.byteLength;
    } catch {
      return false;
    }
  }

  observeIo(): Promise<StreamedProcessTransportIoSnapshot> {
    if (!this.ioProtocolSupported || !this.identity.observedExecutableIdentity)
      return Promise.resolve(ioUnavailable("unsupported"));
    if (this.disconnected)
      return Promise.resolve(ioUnavailable("attachment_unavailable"));
    if (this.terminalIo)
      return Promise.resolve(structuredClone(this.terminalIo));
    if (this.hostExited || this.targetExited || !this.runStarted)
      return Promise.resolve(ioUnavailable("attachment_unavailable"));
    if (this.ioWaiter) return Promise.resolve(ioUnavailable("busy"));
    const id = randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => this.resolveIo(ioUnavailable("timed_out")),
        STREAMED_PROCESS_IO_TIMEOUT_MS,
      );
      timer.unref();
      this.ioWaiter = { id, resolve, timer };
      const payload = new TextEncoder().encode(
        JSON.stringify({
          protocolVersion: SBX_STREAMED_PROCESS_RELAY_PROTOCOL_VERSION,
          requestId: id,
          identity: this.ioIdentity(),
        }),
      );
      try {
        void Promise.resolve(
          this.child.stdin.write(encodeFrame(OBSERVE_IO, payload)),
        ).catch(() => this.resolveIo(ioUnavailable("observation_failed")));
        void Promise.resolve(this.child.stdin.flush()).catch(() =>
          this.resolveIo(ioUnavailable("observation_failed")),
        );
      } catch {
        this.resolveIo(ioUnavailable("observation_failed"));
      }
    });
  }

  private ioIdentity() {
    return {
      pid: this.identity.backendProcessId,
      startIdentity: this.identity.processStartIdentity,
      observedExecutable: this.identity.observedExecutable,
      observedExecutableIdentity: this.identity.observedExecutableIdentity,
      processGeneration: this.processGeneration,
      environmentMarkerSha256: this.expectedMarkerSha256,
    };
  }

  private receiveIo(payload: Uint8Array): void {
    try {
      if (payload.byteLength > MAX_IO_SNAPSHOT_BYTES) throw new Error();
      const frame = parseObject(payload);
      if (frame.protocolVersion !== SBX_STREAMED_PROCESS_RELAY_PROTOCOL_VERSION)
        throw new Error();
      if (frame.requestId !== null && frame.requestId !== this.ioWaiter?.id)
        return;
      const value = frame.observation as Record<string, unknown>;
      let result: StreamedProcessTransportIoSnapshot;
      if (value.status === "unavailable") {
        result = STREAMED_PROCESS_IO_UNAVAILABLE.includes(value.reason as never)
          ? ioUnavailable(value.reason as never)
          : ioUnavailable("malformed_observation");
      } else if (value.status === "available") {
        const identity = value.identity as Record<string, unknown>;
        if (
          Object.entries(this.ioIdentity()).some(
            ([key, expected]) => identity[key] !== expected,
          )
        ) {
          result = ioUnavailable("identity_mismatch");
        } else {
          const sample = relayIoSample(value.sample);
          const beforeCancellation =
            value.beforeCancellation === null
              ? null
              : relayIoSample(value.beforeCancellation);
          if (
            !sample ||
            (value.beforeCancellation !== null && !beforeCancellation) ||
            (beforeCancellation &&
              (beforeCancellation.terminal !== "not_observed" ||
                beforeCancellation.elapsedMs > sample.elapsedMs)) ||
            (frame.requestId === null && sample.terminal !== "observed")
          )
            throw new Error();
          result = {
            status: "available",
            identity: { ...this.identity },
            processGeneration: this.processGeneration,
            sample,
            beforeCancellation,
          };
        }
      } else throw new Error();
      if (frame.requestId === null) this.terminalIo = result;
      this.resolveIo(result);
    } catch {
      this.resolveIo(ioUnavailable("malformed_observation"));
    }
  }

  private resolveIo(result: StreamedProcessTransportIoSnapshot): void {
    const waiter = this.ioWaiter;
    if (!waiter) return;
    this.ioWaiter = null;
    clearTimeout(waiter.timer);
    waiter.resolve(result);
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
        void Promise.resolve(this.child.stdin.write(frame)).catch(() =>
          this.resolveWaiter(waiters, requestId, "ambiguous"),
        );
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
    this.resolveIo(ioUnavailable("attachment_unavailable"));
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
        // Drain native SBX diagnostics; exact target exit plus both EOF frames
        // remains complete process evidence.
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

function relayIoSample(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const sample = value as Record<string, unknown>;
  if (
    typeof sample.observedAt !== "number" ||
    !Number.isSafeInteger(sample.observedAt) ||
    sample.observedAt < 0
  )
    return null;
  return safeIoSample({
    ...sample,
    observedAt: new Date(sample.observedAt).toISOString(),
  });
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

/** READY-only ambiguity check, on bounded raw frame bytes before semantic use.
 * Strings are skipped as units (including escapes); only root member names
 * count. JSON.parse below remains the strict grammar validator, not authority
 * for duplicate resolution. No raw text escapes the launch error boundary. */
function parseReady(payload: Uint8Array): Record<string, unknown> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  const critical = new Set([
    "protocolVersion",
    "nonblockingDiagnosticWrite",
    "pid",
    "startIdentity",
    "observedExecutable",
    "observedExecutableIdentity",
    "environmentMarkerSha256",
  ]);
  const seen = new Set<string>();
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      const start = i++;
      for (; i < text.length; i++) {
        if (text[i] === "\\") i++;
        else if (text[i] === '"') break;
      }
      let next = i + 1;
      while (/[\t\n\r ]/.test(text[next] ?? "!")) next++;
      if (depth === 1 && text[next] === ":") {
        const key: string = JSON.parse(text.slice(start, i + 1));
        if (critical.has(key)) {
          if (seen.has(key)) throw new Error("SBX relay READY was ambiguous.");
          seen.add(key);
        }
      }
    } else if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") depth--;
  }
  return parseObject(payload);
}

function parseObject(payload: Uint8Array): Record<string, unknown> {
  const value: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(payload),
  );
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("SBX relay control record was malformed.");
  return value as Record<string, unknown>;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
