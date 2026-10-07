import type {
  StreamedProcessSpawnContext,
  StreamedProcessTransport,
  StreamedProcessTransportEvent,
  StreamedProcessTransportIdentity,
  StreamedProcessTransportSideEffect,
} from "./streamed-process.ts";
import {
  type MaterializedEnvironment,
  type TrackedEnvironmentBinding,
  TrackedExecutionEnvironmentBackend,
} from "./tracked-backend.ts";
import type {
  EnvironmentBackendOperation,
  EnvironmentCapability,
  EnvironmentCommand,
  EnvironmentCommandResult,
  EnvironmentFileRead,
  EnvironmentFileWrite,
  EnvironmentReadiness,
  EnvironmentRef,
  EnvironmentSpec,
  HostLaunchDescriptor,
  StreamedProcessInfrastructureEvent,
} from "./types.ts";
import { EnvironmentBackendError } from "./types.ts";

export interface FakeEnvironmentExecContext {
  ref: EnvironmentRef;
  command: EnvironmentCommand;
}

export interface FakeExecutionEnvironmentBackendOptions {
  readiness?: Omit<EnvironmentReadiness, "backendKind" | "capabilities">;
  capabilities?: readonly EnvironmentCapability[];
  exec?: (
    context: FakeEnvironmentExecContext,
  ) => EnvironmentCommandResult | Promise<EnvironmentCommandResult>;
  spawnStreamed?: (
    context: StreamedProcessSpawnContext,
  ) => StreamedProcessTransport | Promise<StreamedProcessTransport>;
  onStreamedProcessEvent?: (event: StreamedProcessInfrastructureEvent) => void;
}

/** Deterministic lifecycle backend for contract and recovery tests only. */
export class FakeExecutionEnvironmentBackend extends TrackedExecutionEnvironmentBackend {
  private readonly failures = new Map<EnvironmentBackendOperation, Error[]>();
  private readonly executionHistory = new Map<string, EnvironmentCommand[]>();
  private readonly files = new Map<string, Uint8Array>();
  private readonly backendCapabilities: readonly EnvironmentCapability[];

  constructor(
    private readonly options: FakeExecutionEnvironmentBackendOptions = {},
  ) {
    super("fake");
    this.backendCapabilities = copyCapabilities(
      options.capabilities ?? [
        { kind: "container_runtime", mode: "unavailable" },
        { kind: "pty_launcher", mode: "descriptor_only" },
        {
          kind: "process.streamed",
          mode: "attached_only",
          detail:
            "Deterministic fake transport; stream attachment is Worker-local.",
        },
      ],
    );
  }

  async readiness(): Promise<EnvironmentReadiness> {
    await this.beforeOperation("readiness");
    const configured = this.options.readiness;
    return {
      backendKind: this.kind,
      status: configured?.status ?? "ready",
      ready: configured?.ready ?? true,
      capabilities: copyCapabilities(this.backendCapabilities),
      diagnostics: configured?.diagnostics.map((item) => ({ ...item })) ?? [],
      provenance: {
        contractVersion: configured?.provenance.contractVersion ?? 1,
        implementationVersion:
          configured?.provenance.implementationVersion ?? "fake-v1",
      },
    };
  }

  failNext(
    operation: EnvironmentBackendOperation,
    error: Error = new EnvironmentBackendError(
      "injected_failure",
      `Injected ${operation} failure.`,
      operation,
    ),
  ): void {
    const queue = this.failures.get(operation) ?? [];
    queue.push(error);
    this.failures.set(operation, queue);
  }

  executions(ref: EnvironmentRef): readonly EnvironmentCommand[] {
    return (this.executionHistory.get(historyKey(ref)) ?? []).map((command) =>
      copyCommand(command),
    );
  }

  protected override async beforeOperation(
    operation: EnvironmentBackendOperation,
  ): Promise<void> {
    const queue = this.failures.get(operation);
    const failure = queue?.shift();
    if (queue?.length === 0) this.failures.delete(operation);
    if (failure) throw failure;
  }

  protected override materialize(
    _spec: EnvironmentSpec,
    ref: EnvironmentRef,
  ): MaterializedEnvironment {
    const root = `/fake/environments/${ref.environmentId}/${ref.incarnation}`;
    return {
      paths: {
        workspace: `${root}/workspace`,
        state: `${root}/state`,
        control: `${root}/control`,
        home: `${root}/home`,
        cache: `${root}/cache`,
        temp: `${root}/tmp`,
      },
      capabilities: copyCapabilities(this.backendCapabilities),
      paneEnvironment: {
        QE_FAKE_ENVIRONMENT_ID: ref.environmentId,
        QE_FAKE_ENVIRONMENT_INCARNATION: ref.incarnation,
      },
    };
  }

  protected override launchInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    command: EnvironmentCommand,
  ): HostLaunchDescriptor {
    return {
      executable: "qe-fake-environment-launcher",
      args: [
        binding.ref.environmentId,
        binding.ref.incarnation,
        "--",
        command.executable,
        ...command.args,
      ],
      cwd: command.cwd ?? binding.paths.workspace,
      environment: {
        ...binding.paneEnvironment,
        ...command.environment,
      },
      io: "pty",
      provenance: {
        kind: "execution_environment",
        ref: structuredClone(binding.ref),
        profile: { ...binding.ref.profile },
      },
    };
  }

  protected override async execInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    command: EnvironmentCommand,
  ): Promise<EnvironmentCommandResult> {
    const key = historyKey(binding.ref);
    const history = this.executionHistory.get(key) ?? [];
    history.push(copyCommand(command));
    this.executionHistory.set(key, history);
    if (this.options.exec)
      return this.options.exec({
        ref: structuredClone(binding.ref),
        command: copyCommand(command),
      });
    return {
      exitCode: 0,
      stdout: command.args.length > 0 ? `${command.args.join(" ")}\n` : "",
      stderr: "",
    };
  }

  protected override async spawnStreamedInEnvironment(
    _binding: Readonly<TrackedEnvironmentBinding>,
    context: StreamedProcessSpawnContext,
  ): Promise<StreamedProcessTransport> {
    if (this.options.spawnStreamed)
      return this.options.spawnStreamed(structuredClone(context));
    return new FakeStreamedProcessTransport({
      backendProcessId: `fake-process-${context.processGeneration}`,
      processStartIdentity: `fake-start-${context.processGeneration}`,
      observedExecutable: context.command.executable,
    });
  }

  protected override onStreamedProcessEvent(
    event: StreamedProcessInfrastructureEvent,
  ): void {
    this.options.onStreamedProcessEvent?.(structuredClone(event));
  }

  protected override async writeFileInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    input: EnvironmentFileWrite,
  ): Promise<void> {
    this.files.set(
      fileKey(binding.ref, input.path),
      new Uint8Array(input.data),
    );
  }

  protected override async readFileInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    input: EnvironmentFileRead,
  ): Promise<Uint8Array> {
    const data = this.files.get(fileKey(binding.ref, input.path));
    if (!data)
      throw new EnvironmentBackendError(
        "environment_operation_failed",
        `Fake environment file is missing: ${input.path}.`,
        "transfer",
      );
    if (data.byteLength > input.maxBytes)
      throw new EnvironmentBackendError(
        "environment_operation_failed",
        `Environment file exceeds the ${input.maxBytes}-byte transfer bound.`,
        "transfer",
      );
    return new Uint8Array(data);
  }
}

/** Scriptable transport for deterministic streamed-process conformance tests. */
export class FakeStreamedProcessTransport implements StreamedProcessTransport {
  readonly writes: Uint8Array[] = [];
  readonly writeIds: string[] = [];
  readonly cancellationIds: string[] = [];
  readonly closeStdinIds: string[] = [];
  deliveredEvents = 0;
  disconnected = false;
  private readonly events: StreamedProcessTransportEvent[] = [];
  private readonly readers: Array<
    (value: IteratorResult<StreamedProcessTransportEvent>) => void
  > = [];
  private readonly writeOutcomes: StreamedProcessTransportSideEffect[] = [];
  private readonly cancellationOutcomes: StreamedProcessTransportSideEffect[] =
    [];
  private queuedEventBytes = 0;
  private recordedWriteBytes = 0;
  private ended = false;

  constructor(
    readonly identity: StreamedProcessTransportIdentity,
    private readonly cancelExits = true,
  ) {}

  async run(
    onEvent: (event: StreamedProcessTransportEvent) => Promise<void>,
  ): Promise<void> {
    while (true) {
      const next = await this.nextEvent();
      if (next.done) return;
      this.deliveredEvents += 1;
      await onEvent(next.value);
    }
  }

  async write(
    writeId: string,
    data: Uint8Array,
  ): Promise<StreamedProcessTransportSideEffect> {
    if (this.disconnected || this.ended) return { certainty: "rejected" };
    if (
      this.writes.length >= 1_024 ||
      this.recordedWriteBytes + data.byteLength > 8 * 1024 * 1024
    )
      return { certainty: "rejected" };
    this.writeIds.push(writeId);
    this.writes.push(new Uint8Array(data));
    this.recordedWriteBytes += data.byteLength;
    return this.writeOutcomes.shift() ?? { certainty: "acknowledged" };
  }

  async closeStdin(
    writeId: string,
  ): Promise<StreamedProcessTransportSideEffect> {
    if (this.disconnected || this.ended) return { certainty: "rejected" };
    this.closeStdinIds.push(writeId);
    return this.writeOutcomes.shift() ?? { certainty: "acknowledged" };
  }

  async cancel(
    cancellationId: string,
  ): Promise<StreamedProcessTransportSideEffect> {
    if (this.disconnected || this.ended) return { certainty: "rejected" };
    this.cancellationIds.push(cancellationId);
    const outcome = this.cancellationOutcomes.shift() ?? {
      certainty: "acknowledged" as const,
    };
    if (outcome.certainty === "acknowledged" && this.cancelExits)
      this.emitExit({ kind: "signaled", signal: "SIGTERM" });
    return outcome;
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
    this.end();
  }

  nextWriteOutcome(
    certainty: StreamedProcessTransportSideEffect["certainty"],
  ): void {
    if (this.writeOutcomes.length >= 1_024)
      throw new Error(
        "Fake streamed-process write outcomes exceeded their bound.",
      );
    this.writeOutcomes.push({ certainty });
  }

  nextCancellationOutcome(
    certainty: StreamedProcessTransportSideEffect["certainty"],
  ): void {
    if (this.cancellationOutcomes.length >= 1_024)
      throw new Error(
        "Fake streamed-process cancellation outcomes exceeded their bound.",
      );
    this.cancellationOutcomes.push({ certainty });
  }

  emitStdout(data: Uint8Array): void {
    this.emit({ kind: "data", stream: "stdout", data: new Uint8Array(data) });
  }

  emitStderr(data: Uint8Array): void {
    this.emit({ kind: "data", stream: "stderr", data: new Uint8Array(data) });
  }

  emitEof(stream: "stdout" | "stderr"): void {
    this.emit({ kind: "eof", stream });
  }

  emitExit(
    exit: Extract<StreamedProcessTransportEvent, { kind: "exit" }>["exit"],
  ): void {
    this.emit({ kind: "exit", exit: structuredClone(exit) });
    this.end();
  }

  failTransport(
    errorCode: Extract<
      StreamedProcessTransportEvent,
      { kind: "transport_error" }
    >["errorCode"] = "backend_unavailable",
  ): void {
    this.emit({ kind: "transport_error", errorCode });
    this.end();
  }

  private emit(event: StreamedProcessTransportEvent): void {
    if (this.ended) return;
    const reader = this.readers.shift();
    if (reader) reader({ done: false, value: event });
    else {
      const bytes = event.kind === "data" ? event.data.byteLength : 0;
      if (
        this.events.length >= 1_024 ||
        this.queuedEventBytes + bytes > 8 * 1024 * 1024
      )
        throw new EnvironmentBackendError(
          "streamed_process_stream_unavailable",
          "Fake streamed-process event queue exceeded its deterministic bound.",
          "spawn_streamed",
        );
      this.events.push(event);
      this.queuedEventBytes += bytes;
    }
  }

  private end(): void {
    this.ended = true;
    if (this.events.length === 0)
      for (const reader of this.readers.splice(0))
        reader({ done: true, value: undefined });
  }

  private nextEvent(): Promise<IteratorResult<StreamedProcessTransportEvent>> {
    const event = this.events.shift();
    if (event) {
      if (event.kind === "data") this.queuedEventBytes -= event.data.byteLength;
      return Promise.resolve({ done: false, value: event });
    }
    if (this.ended) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve) => this.readers.push(resolve));
  }
}

function fileKey(ref: EnvironmentRef, path: string): string {
  return `${historyKey(ref)}\0${path}`;
}

function historyKey(ref: EnvironmentRef): string {
  return `${ref.environmentId}\0${ref.incarnation}`;
}

function copyCapabilities(
  capabilities: readonly EnvironmentCapability[],
): EnvironmentCapability[] {
  return capabilities.map((capability) => ({ ...capability }));
}

function copyCommand(command: EnvironmentCommand): EnvironmentCommand {
  return {
    executable: command.executable,
    args: [...command.args],
    ...(command.cwd ? { cwd: command.cwd } : {}),
    ...(command.environment ? { environment: { ...command.environment } } : {}),
    ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
  };
}
