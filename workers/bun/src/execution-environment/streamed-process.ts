import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  EnvironmentBackendErrorCode,
  EnvironmentBackendOperation,
  EnvironmentPathMap,
  EnvironmentRef,
  StreamedProcess,
  StreamedProcessCommand,
  StreamedProcessExit,
  StreamedProcessHandle,
  StreamedProcessInfrastructureEvent,
  StreamedProcessOptions,
  StreamedProcessReconciliation,
  StreamedProcessStreamEvent,
} from "./types.ts";
import { EnvironmentBackendError } from "./types.ts";

export const DEFAULT_STREAM_BUFFER_BYTES = 64 * 1024;
export const MAX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024;
export const MAX_STREAMED_STDIN_WRITE_BYTES = 1024 * 1024;
export const MAX_STREAMED_ENVIRONMENT_BYTES = 64 * 1024;
export const MAX_STREAMED_ENVIRONMENT_ENTRIES = 128;
export const MAX_STREAMED_ARGV_BYTES = 256 * 1024;
export const MAX_STREAMED_ARGV_ENTRIES = 4_096;
export const MAX_ATTACHED_STREAMED_PROCESSES = 128;
const MAX_BUFFERED_STREAM_EVENTS = 1_024;

export interface StreamedProcessTransportIdentity {
  backendProcessId: string;
  processStartIdentity: string;
  observedExecutable?: string;
}

export type StreamedProcessTransportSideEffect =
  | { certainty: "acknowledged" }
  | { certainty: "rejected" }
  | { certainty: "ambiguous" };

export type StreamedProcessTransportEvent =
  | { kind: "data"; stream: "stdout" | "stderr"; data: Uint8Array }
  | { kind: "eof"; stream: "stdout" | "stderr" }
  | { kind: "exit"; exit: StreamedProcessExit }
  | {
      kind: "transport_error";
      errorCode: EnvironmentBackendErrorCode;
    };

/** Backend attachment normalized by the generic bounded stream owner. */
export interface StreamedProcessTransport {
  readonly identity: StreamedProcessTransportIdentity;
  run(
    onEvent: (event: StreamedProcessTransportEvent) => Promise<void>,
  ): Promise<void>;
  write(
    writeId: string,
    data: Uint8Array,
  ): Promise<StreamedProcessTransportSideEffect>;
  closeStdin(writeId: string): Promise<StreamedProcessTransportSideEffect>;
  cancel(cancellationId: string): Promise<StreamedProcessTransportSideEffect>;
  disconnect(): Promise<void>;
}

export interface StreamedProcessSpawnContext {
  ref: EnvironmentRef;
  command: StreamedProcessCommand;
  processGeneration: string;
  acknowledgementTimeoutMs: number;
}

export interface StreamedProcessManagerOptions {
  backendKind: string;
  validate(
    ref: EnvironmentRef,
    operation: EnvironmentBackendOperation,
  ): void | Promise<void>;
  inspectDetached?(
    handle: StreamedProcessHandle,
  ): Promise<StreamedProcessReconciliation>;
  onEvent?: (event: StreamedProcessInfrastructureEvent) => void;
  now?: () => Date;
}

interface ManagedProcessState {
  handle: StreamedProcessHandle;
  transport: StreamedProcessTransport;
  stdout: BoundedProcessStream;
  stderr: BoundedProcessStream;
  exit: Deferred<StreamedProcessExit>;
  terminal: StreamedProcessExit | null;
  disconnected: boolean;
  writeClosed: boolean;
  cancelPromise: Promise<{
    certainty: "acknowledged";
    cancellationId: string;
  }> | null;
  writeTail: Promise<void>;
  runTask: Promise<void>;
}

/**
 * Run/environment-owned attachment registry. It provides bounded streams,
 * side-effect certainty, exact-handle fencing, and deterministic retirement;
 * it contains no harness or provider semantics.
 */
export class StreamedProcessManager {
  private readonly processes = new Map<string, ManagedProcessState>();
  private readonly now: () => Date;
  private pendingSpawns = 0;

  constructor(private readonly options: StreamedProcessManagerOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async spawn(
    ref: EnvironmentRef,
    paths: EnvironmentPathMap,
    command: StreamedProcessCommand,
    processOptions: StreamedProcessOptions,
    open: (
      context: StreamedProcessSpawnContext,
    ) => Promise<StreamedProcessTransport>,
  ): Promise<StreamedProcess> {
    const request = validateStreamedProcessCommand(paths, command);
    const settings = validateOptions(processOptions);
    if (
      this.processes.size + this.pendingSpawns >=
      MAX_ATTACHED_STREAMED_PROCESSES
    )
      throw new EnvironmentBackendError(
        "streamed_process_spawn_failed",
        `Backend attachment limit ${MAX_ATTACHED_STREAMED_PROCESSES} is exhausted.`,
        "spawn_streamed",
      );
    this.pendingSpawns += 1;
    const processGeneration = randomUUID();
    let transport: StreamedProcessTransport | null = null;
    try {
      await this.options.validate(ref, "spawn_streamed");
      this.emit(ref, "streamed_process_spawn_requested", {
        processGeneration,
      });
      transport = await open({
        ref: structuredClone(ref),
        command: request,
        processGeneration,
        acknowledgementTimeoutMs: settings.acknowledgementTimeoutMs,
      });
      validateTransportIdentity(transport.identity);
      // Fence a replacement that raced the physical spawn. The transport still
      // addresses the old attachment and is closed without issuing a new lookup.
      await this.options.validate(ref, "spawn_streamed");
    } catch (error) {
      this.pendingSpawns -= 1;
      await transport?.disconnect().catch(() => undefined);
      if (error instanceof EnvironmentBackendError) throw error;
      throw new EnvironmentBackendError(
        "streamed_process_spawn_failed",
        errorMessage(error),
        "spawn_streamed",
      );
    }
    this.pendingSpawns -= 1;

    const handle: StreamedProcessHandle = {
      contractVersion: 1,
      backendKind: this.options.backendKind,
      environment: structuredClone(ref),
      backendProcessId: transport.identity.backendProcessId,
      processStartIdentity: transport.identity.processStartIdentity,
      processGeneration,
      executable: request.executable,
      ...(transport.identity.observedExecutable
        ? { observedExecutable: transport.identity.observedExecutable }
        : {}),
    };
    const exit = deferred<StreamedProcessExit>();
    const state = {} as ManagedProcessState;
    const disconnect = () => this.disconnectState(state);
    Object.assign(state, {
      handle,
      transport,
      stdout: new BoundedProcessStream(settings.bufferBytes, disconnect),
      stderr: new BoundedProcessStream(settings.bufferBytes, disconnect),
      exit,
      terminal: null,
      disconnected: false,
      writeClosed: false,
      cancelPromise: null,
      writeTail: Promise.resolve(),
      runTask: Promise.resolve(),
    } satisfies ManagedProcessState);
    this.processes.set(processGeneration, state);
    state.runTask = this.run(state);

    this.emit(ref, "streamed_process_spawned", {
      processGeneration,
      backendProcessId: handle.backendProcessId,
    });
    this.emit(ref, "stream_connected", {
      processGeneration,
      backendProcessId: handle.backendProcessId,
    });

    return {
      handle: structuredClone(handle),
      stdout: state.stdout,
      stderr: state.stderr,
      exit: exit.promise,
      write: (data) => this.write(state, data, false),
      closeStdin: () => this.write(state, new Uint8Array(), true),
      cancel: () => this.cancel(state),
      inspect: () => this.reconcileState(state),
      disconnect,
    };
  }

  async reconcile(
    handle: StreamedProcessHandle,
  ): Promise<StreamedProcessReconciliation> {
    validateHandle(this.options.backendKind, handle);
    await this.options.validate(handle.environment, "inspect_streamed");
    const active = this.processes.get(handle.processGeneration);
    if (active) {
      assertSameHandle(active.handle, handle, "inspect_streamed");
      return this.project(active);
    }
    if (!this.options.inspectDetached)
      return {
        handle: structuredClone(handle),
        process: "unavailable",
        streamAttachment: "unavailable",
        streamRecovery: "not_recoverable",
      };
    return this.options.inspectDetached(structuredClone(handle));
  }

  async retire(ref: EnvironmentRef): Promise<void> {
    await this.options.validate(ref, "retire_streamed");
    const owned = [...this.processes.values()].filter((state) =>
      sameRef(state.handle.environment, ref),
    );
    await Promise.all(
      owned.map(async (state) => {
        if (!state.terminal) await this.cancel(state).catch(() => undefined);
        await this.disconnectState(state);
      }),
    );
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.processes.values()].map((state) => this.disconnectState(state)),
    );
  }

  private async run(state: ManagedProcessState): Promise<void> {
    try {
      await state.transport.run(async (event) => {
        if (state.disconnected) return;
        if (event.kind === "data") {
          const stream =
            event.stream === "stdout" ? state.stdout : state.stderr;
          await stream.pushData(event.data);
          return;
        }
        if (event.kind === "eof") {
          const stream =
            event.stream === "stdout" ? state.stdout : state.stderr;
          await stream.pushEof();
          return;
        }
        if (event.kind === "transport_error") {
          await Promise.all([
            state.stdout.pushTransportError(event.errorCode),
            state.stderr.pushTransportError(event.errorCode),
          ]);
          this.emit(state.handle.environment, "stream_transport_unavailable", {
            processGeneration: state.handle.processGeneration,
            backendProcessId: state.handle.backendProcessId,
            errorCode: event.errorCode,
          });
          this.settleExit(state, {
            kind: "observation_unavailable",
            errorCode: event.errorCode,
          });
          return;
        }
        this.settleExit(state, event.exit);
      });
    } catch {
      if (!state.disconnected) {
        await Promise.all([
          state.stdout.pushTransportError(
            "streamed_process_stream_unavailable",
          ),
          state.stderr.pushTransportError(
            "streamed_process_stream_unavailable",
          ),
        ]);
        this.emit(state.handle.environment, "stream_transport_unavailable", {
          processGeneration: state.handle.processGeneration,
          backendProcessId: state.handle.backendProcessId,
          errorCode: "streamed_process_stream_unavailable",
        });
      }
    } finally {
      if (!state.terminal)
        this.settleExit(state, {
          kind: "observation_unavailable",
          errorCode: "streamed_process_stream_unavailable",
        });
      state.stdout.finish();
      state.stderr.finish();
      if (this.processes.get(state.handle.processGeneration) === state)
        this.processes.delete(state.handle.processGeneration);
    }
  }

  private write(
    state: ManagedProcessState,
    data: Uint8Array,
    close: boolean,
  ): Promise<{
    certainty: "acknowledged";
    writeId: string;
    byteLength: number;
  }> {
    if (
      !(data instanceof Uint8Array) ||
      data.byteLength > MAX_STREAMED_STDIN_WRITE_BYTES
    )
      return Promise.reject(
        new EnvironmentBackendError(
          "streamed_process_write_rejected",
          `Streamed stdin writes must be bytes no larger than ${MAX_STREAMED_STDIN_WRITE_BYTES}.`,
          "write_streamed",
        ),
      );
    if (!close && data.byteLength === 0)
      return Promise.reject(
        new EnvironmentBackendError(
          "streamed_process_write_rejected",
          "Empty streamed stdin writes are rejected; close stdin explicitly instead.",
          "write_streamed",
        ),
      );

    const operation = state.writeTail.then(async () => {
      await this.validateState(state, "write_streamed");
      if (state.writeClosed)
        throw new EnvironmentBackendError(
          "streamed_process_write_rejected",
          "Streamed process stdin is already closed or uncertain.",
          "write_streamed",
        );
      const writeId = randomUUID();
      const byteLength = data.byteLength;
      this.emit(state.handle.environment, "stdin_write_requested", {
        processGeneration: state.handle.processGeneration,
        backendProcessId: state.handle.backendProcessId,
        operationId: writeId,
        byteLength,
      });
      let result: StreamedProcessTransportSideEffect;
      try {
        result = close
          ? await state.transport.closeStdin(writeId)
          : await state.transport.write(writeId, new Uint8Array(data));
      } catch {
        result = { certainty: "ambiguous" };
      }
      if (result.certainty === "acknowledged") {
        if (close) state.writeClosed = true;
        this.emit(state.handle.environment, "stdin_write_acknowledged", {
          processGeneration: state.handle.processGeneration,
          backendProcessId: state.handle.backendProcessId,
          operationId: writeId,
          byteLength,
        });
        return { certainty: "acknowledged" as const, writeId, byteLength };
      }
      if (result.certainty === "rejected")
        throw new EnvironmentBackendError(
          "streamed_process_write_rejected",
          "The streamed process rejected stdin before a physical write was acknowledged.",
          "write_streamed",
        );
      state.writeClosed = true;
      this.emit(state.handle.environment, "stdin_write_ambiguous", {
        processGeneration: state.handle.processGeneration,
        backendProcessId: state.handle.backendProcessId,
        operationId: writeId,
        byteLength,
        errorCode: "streamed_process_write_uncertain",
      });
      throw new EnvironmentBackendError(
        "streamed_process_write_uncertain",
        "The streamed stdin write may have occurred and must not be replayed automatically.",
        "write_streamed",
      );
    });
    state.writeTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }

  private cancel(
    state: ManagedProcessState,
  ): Promise<{ certainty: "acknowledged"; cancellationId: string }> {
    if (state.cancelPromise)
      return this.validateState(state, "cancel_streamed").then(
        () =>
          state.cancelPromise as Promise<{
            certainty: "acknowledged";
            cancellationId: string;
          }>,
      );
    const operation = (async () => {
      await this.validateState(state, "cancel_streamed");
      const cancellationId = randomUUID();
      this.emit(state.handle.environment, "process_cancel_requested", {
        processGeneration: state.handle.processGeneration,
        backendProcessId: state.handle.backendProcessId,
        operationId: cancellationId,
      });
      let result: StreamedProcessTransportSideEffect;
      try {
        result = await state.transport.cancel(cancellationId);
      } catch {
        result = { certainty: "ambiguous" };
      }
      if (result.certainty === "acknowledged") {
        this.emit(state.handle.environment, "process_cancelled", {
          processGeneration: state.handle.processGeneration,
          backendProcessId: state.handle.backendProcessId,
          operationId: cancellationId,
        });
        return { certainty: "acknowledged" as const, cancellationId };
      }
      if (result.certainty === "rejected")
        throw new EnvironmentBackendError(
          "streamed_process_gone",
          "The streamed process was gone before cancellation could be requested.",
          "cancel_streamed",
        );
      throw new EnvironmentBackendError(
        "streamed_process_cancellation_uncertain",
        "Physical process termination may have been requested; it will not be replayed automatically.",
        "cancel_streamed",
      );
    })();
    state.cancelPromise = operation;
    return operation;
  }

  private async reconcileState(
    state: ManagedProcessState,
  ): Promise<StreamedProcessReconciliation> {
    await this.options.validate(state.handle.environment, "inspect_streamed");
    return this.project(state);
  }

  private project(state: ManagedProcessState): StreamedProcessReconciliation {
    return {
      handle: structuredClone(state.handle),
      process: state.terminal ? "exited" : "running",
      streamAttachment: state.disconnected ? "unavailable" : "attached",
      streamRecovery: state.disconnected
        ? "not_recoverable"
        : "current_worker_only",
    };
  }

  private async validateState(
    state: ManagedProcessState,
    operation: EnvironmentBackendOperation,
  ): Promise<void> {
    await this.options.validate(state.handle.environment, operation);
    if (state.terminal)
      throw new EnvironmentBackendError(
        "streamed_process_gone",
        "The streamed process has already reached terminal exit.",
        operation,
      );
    if (state.disconnected)
      throw new EnvironmentBackendError(
        "streamed_process_stream_unavailable",
        "The streamed process attachment is unavailable.",
        operation,
      );
  }

  private async disconnectState(state: ManagedProcessState): Promise<void> {
    if (state.disconnected) return;
    state.disconnected = true;
    state.stdout.abort();
    state.stderr.abort();
    await state.transport.disconnect().catch(() => undefined);
    if (!state.terminal)
      this.settleExit(state, {
        kind: "observation_unavailable",
        errorCode: "streamed_process_stream_unavailable",
      });
    await state.runTask.catch(() => undefined);
    if (this.processes.get(state.handle.processGeneration) === state)
      this.processes.delete(state.handle.processGeneration);
  }

  private settleExit(
    state: ManagedProcessState,
    outcome: StreamedProcessExit,
  ): void {
    if (state.terminal) return;
    state.terminal = structuredClone(outcome);
    state.exit.resolve(structuredClone(outcome));
    this.emit(state.handle.environment, "process_exit_observed", {
      processGeneration: state.handle.processGeneration,
      backendProcessId: state.handle.backendProcessId,
      outcome: outcome.kind,
      ...(outcome.kind === "exited" || outcome.kind === "exited_nonzero"
        ? { exitCode: outcome.exitCode }
        : {}),
      ...(outcome.kind === "signaled" ? { signal: outcome.signal } : {}),
      ...(outcome.kind === "observation_unavailable"
        ? { errorCode: outcome.errorCode }
        : {}),
    });
  }

  private emit(
    ref: EnvironmentRef,
    event: StreamedProcessInfrastructureEvent["event"],
    details: Omit<
      StreamedProcessInfrastructureEvent,
      | "event"
      | "observedAt"
      | "backendKind"
      | "workerId"
      | "runId"
      | "environmentId"
      | "incarnation"
    > = {},
  ): void {
    this.options.onEvent?.({
      event,
      observedAt: this.now().toISOString(),
      backendKind: this.options.backendKind,
      workerId: ref.workerId,
      runId: ref.runId,
      environmentId: ref.environmentId,
      incarnation: ref.incarnation,
      ...details,
    });
  }
}

class BoundedProcessStream
  implements AsyncIterable<StreamedProcessStreamEvent>
{
  private readonly items: Array<{
    event: StreamedProcessStreamEvent;
    bytes: number;
  }> = [];
  private readonly readers: Array<
    (value: IteratorResult<StreamedProcessStreamEvent>) => void
  > = [];
  private readonly spaceWaiters = new Set<() => void>();
  private bufferedBytes = 0;
  private sequence = 0;
  private closed = false;
  private iterated = false;

  constructor(
    private readonly limit: number,
    private readonly onDisconnect: () => Promise<void>,
  ) {}

  async pushData(data: Uint8Array): Promise<void> {
    for (let offset = 0; offset < data.byteLength; offset += this.limit) {
      const chunk = new Uint8Array(
        data.slice(offset, Math.min(offset + this.limit, data.byteLength)),
      );
      const accepted = await this.push(
        { kind: "data", sequence: this.sequence++, data: chunk },
        chunk.byteLength,
      );
      if (!accepted) return;
    }
  }

  async pushEof(): Promise<void> {
    await this.push({ kind: "eof", sequence: this.sequence++ }, 0);
  }

  async pushTransportError(
    errorCode: EnvironmentBackendErrorCode,
  ): Promise<void> {
    await this.push(
      { kind: "transport_error", sequence: this.sequence++, errorCode },
      0,
    );
  }

  finish(): void {
    this.closed = true;
    this.flushReaders();
    this.releaseSpace();
  }

  abort(): void {
    this.closed = true;
    this.items.splice(0);
    this.bufferedBytes = 0;
    this.flushReaders();
    this.releaseSpace();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamedProcessStreamEvent> {
    if (this.iterated)
      throw new EnvironmentBackendError(
        "streamed_process_stream_unavailable",
        "A streamed process byte stream supports one consumer.",
        "inspect_streamed",
      );
    this.iterated = true;
    return {
      next: () => this.next(),
      return: async () => {
        await this.onDisconnect();
        return { done: true, value: undefined };
      },
    };
  }

  private async push(
    event: StreamedProcessStreamEvent,
    bytes: number,
  ): Promise<boolean> {
    while (
      !this.closed &&
      this.readers.length === 0 &&
      (this.bufferedBytes + bytes > this.limit ||
        this.items.length >= MAX_BUFFERED_STREAM_EVENTS)
    )
      await new Promise<void>((resolve) => this.spaceWaiters.add(resolve));
    if (this.closed) return false;
    const reader = this.readers.shift();
    if (reader) reader({ done: false, value: event });
    else {
      this.items.push({ event, bytes });
      this.bufferedBytes += bytes;
    }
    return true;
  }

  private next(): Promise<IteratorResult<StreamedProcessStreamEvent>> {
    const item = this.items.shift();
    if (item) {
      this.bufferedBytes -= item.bytes;
      this.releaseSpace();
      return Promise.resolve({ done: false, value: item.event });
    }
    if (this.closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.readers.push(resolve));
  }

  private flushReaders(): void {
    if (!this.closed || this.items.length > 0) return;
    for (const reader of this.readers.splice(0))
      reader({ done: true, value: undefined });
  }

  private releaseSpace(): void {
    for (const resolve of this.spaceWaiters) resolve();
    this.spaceWaiters.clear();
  }
}

function validateOptions(options: StreamedProcessOptions): {
  bufferBytes: number;
  acknowledgementTimeoutMs: number;
} {
  const bufferBytes = options.bufferBytes ?? DEFAULT_STREAM_BUFFER_BYTES;
  const acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 5_000;
  if (
    !Number.isSafeInteger(bufferBytes) ||
    bufferBytes < 1 ||
    bufferBytes > MAX_STREAM_BUFFER_BYTES
  )
    throw new EnvironmentBackendError(
      "streamed_process_spawn_failed",
      `Stream buffering must be between 1 and ${MAX_STREAM_BUFFER_BYTES} bytes per stream.`,
      "spawn_streamed",
    );
  if (
    !Number.isSafeInteger(acknowledgementTimeoutMs) ||
    acknowledgementTimeoutMs < 1 ||
    acknowledgementTimeoutMs > 60_000
  )
    throw new EnvironmentBackendError(
      "streamed_process_spawn_failed",
      "Stream acknowledgement timeout must be between 1 and 60000 milliseconds.",
      "spawn_streamed",
    );
  return { bufferBytes, acknowledgementTimeoutMs };
}

export function validateStreamedProcessCommand(
  paths: EnvironmentPathMap,
  command: StreamedProcessCommand,
): StreamedProcessCommand {
  if (
    typeof command.executable !== "string" ||
    !posix.isAbsolute(command.executable) ||
    posix.normalize(command.executable) !== command.executable ||
    command.executable.includes("\0")
  )
    throw new EnvironmentBackendError(
      "streamed_process_spawn_failed",
      "Streamed process executable must be one normalized absolute environment path.",
      "spawn_streamed",
    );
  if (
    !Array.isArray(command.args) ||
    command.args.length > MAX_STREAMED_ARGV_ENTRIES
  )
    throw new EnvironmentBackendError(
      "streamed_process_spawn_failed",
      `Streamed process argv must contain at most ${MAX_STREAMED_ARGV_ENTRIES} literal entries.`,
      "spawn_streamed",
    );
  if (
    command.args.some(
      (argument) => typeof argument !== "string" || argument.includes("\0"),
    ) ||
    encodedBytes(command.args) > MAX_STREAMED_ARGV_BYTES
  )
    throw new EnvironmentBackendError(
      "streamed_process_spawn_failed",
      `Streamed process argv must be NUL-free and no larger than ${MAX_STREAMED_ARGV_BYTES} bytes.`,
      "spawn_streamed",
    );
  if (!containedPath(paths, command.cwd))
    throw new EnvironmentBackendError(
      "streamed_process_spawn_failed",
      "Streamed process cwd must be a normalized absolute path contained by the lease path map.",
      "spawn_streamed",
    );
  if (
    !command.environment ||
    typeof command.environment !== "object" ||
    Array.isArray(command.environment)
  )
    throw new EnvironmentBackendError(
      "streamed_process_spawn_failed",
      "Streamed process environment must be an explicit bounded object.",
      "spawn_streamed",
    );
  const entries = Object.entries(command.environment);
  if (
    entries.length > MAX_STREAMED_ENVIRONMENT_ENTRIES ||
    entries.some(
      ([name, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
        typeof value !== "string" ||
        value.includes("\0"),
    ) ||
    encodedBytes(entries.flat()) > MAX_STREAMED_ENVIRONMENT_BYTES
  )
    throw new EnvironmentBackendError(
      "streamed_process_spawn_failed",
      `Streamed process environment must contain at most ${MAX_STREAMED_ENVIRONMENT_ENTRIES} valid entries and ${MAX_STREAMED_ENVIRONMENT_BYTES} bytes.`,
      "spawn_streamed",
    );
  return {
    executable: command.executable,
    args: [...command.args],
    cwd: command.cwd,
    environment: { ...command.environment },
  };
}

function containedPath(paths: EnvironmentPathMap, path: string): boolean {
  if (
    typeof path !== "string" ||
    !posix.isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path.includes("\0")
  )
    return false;
  return Object.values(paths).some(
    (root) => path === root || path.startsWith(`${root}/`),
  );
}

function validateTransportIdentity(
  identity: StreamedProcessTransportIdentity,
): void {
  if (
    !identity.backendProcessId ||
    !identity.processStartIdentity ||
    identity.backendProcessId.includes("\0") ||
    identity.processStartIdentity.includes("\0")
  )
    throw new EnvironmentBackendError(
      "streamed_process_identity_mismatch",
      "The backend did not return a stable streamed process identity.",
      "spawn_streamed",
    );
}

function validateHandle(
  backendKind: string,
  handle: StreamedProcessHandle,
): void {
  if (
    handle.contractVersion !== 1 ||
    handle.backendKind !== backendKind ||
    handle.environment.backendKind !== backendKind ||
    !handle.backendProcessId ||
    !handle.processStartIdentity ||
    !handle.processGeneration ||
    !handle.executable ||
    !posix.isAbsolute(handle.executable) ||
    posix.normalize(handle.executable) !== handle.executable ||
    [
      handle.backendProcessId,
      handle.processStartIdentity,
      handle.processGeneration,
      handle.executable,
      handle.observedExecutable ?? "",
    ].some((value) => value.includes("\0"))
  )
    throw new EnvironmentBackendError(
      "streamed_process_identity_mismatch",
      "The streamed process handle does not belong to this backend.",
      "inspect_streamed",
    );
}

function assertSameHandle(
  expected: StreamedProcessHandle,
  actual: StreamedProcessHandle,
  operation: EnvironmentBackendOperation,
): void {
  if (
    expected.contractVersion !== actual.contractVersion ||
    expected.backendKind !== actual.backendKind ||
    !sameRef(expected.environment, actual.environment) ||
    expected.backendProcessId !== actual.backendProcessId ||
    expected.processStartIdentity !== actual.processStartIdentity ||
    expected.processGeneration !== actual.processGeneration ||
    expected.executable !== actual.executable ||
    expected.observedExecutable !== actual.observedExecutable
  )
    throw new EnvironmentBackendError(
      "streamed_process_identity_mismatch",
      "The streamed process handle conflicts with the active process generation.",
      operation,
    );
}

export function sameRef(left: EnvironmentRef, right: EnvironmentRef): boolean {
  return (
    left.backendKind === right.backendKind &&
    left.environmentId === right.environmentId &&
    left.incarnation === right.incarnation &&
    left.workerId === right.workerId &&
    left.runId === right.runId &&
    left.profile.id === right.profile.id &&
    left.profile.digest === right.profile.digest
  );
}

function encodedBytes(values: readonly string[]): number {
  const encoder = new TextEncoder();
  return values.reduce(
    (total, value) => total + encoder.encode(value).byteLength,
    0,
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
