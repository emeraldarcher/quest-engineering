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
