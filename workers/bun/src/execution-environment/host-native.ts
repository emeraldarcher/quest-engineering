import { isAbsolute } from "node:path";
import {
  type MaterializedEnvironment,
  type TrackedEnvironmentBinding,
  TrackedExecutionEnvironmentBackend,
} from "./tracked-backend.ts";
import type {
  EnvironmentCapability,
  EnvironmentCommand,
  EnvironmentCommandResult,
  EnvironmentPathMap,
  EnvironmentReadiness,
  EnvironmentRef,
  EnvironmentSpec,
  HostLaunchDescriptor,
} from "./types.ts";
import { EnvironmentBackendError } from "./types.ts";

export interface HostNativeExecutionEnvironmentBackendOptions {
  workerId: string;
  pathsFor(spec: EnvironmentSpec): EnvironmentPathMap;
  paneEnvironmentFor?(spec: EnvironmentSpec): Readonly<Record<string, string>>;
  capabilities?: readonly EnvironmentCapability[];
  readiness?: Omit<EnvironmentReadiness, "backendKind" | "capabilities">;
}

/**
 * Unwired compatibility adapter for today's direct host paths and processes.
 * stop/remove retire only the logical lease and never alter the host itself.
 */
export class HostNativeExecutionEnvironmentBackend extends TrackedExecutionEnvironmentBackend {
  private readonly backendCapabilities: readonly EnvironmentCapability[];

  constructor(
    private readonly options: HostNativeExecutionEnvironmentBackendOptions,
  ) {
    super("host_native");
    this.backendCapabilities = copyCapabilities(
      options.capabilities ?? [
        { kind: "filesystem_namespace", mode: "host_shared" },
        { kind: "home", mode: "host_shared" },
        { kind: "git_metadata", mode: "host_shared" },
        { kind: "container_runtime", mode: "unavailable" },
        { kind: "pty_launcher", mode: "host_native" },
      ],
    );
  }

  async readiness(): Promise<EnvironmentReadiness> {
    await this.beforeOperation("readiness");
    return {
      backendKind: this.kind,
      status: this.options.readiness?.status ?? "ready",
      ready: this.options.readiness?.ready ?? true,
      capabilities: copyCapabilities(this.backendCapabilities),
      diagnostics:
        this.options.readiness?.diagnostics.map((item) => ({ ...item })) ?? [],
      provenance: {
        contractVersion:
          this.options.readiness?.provenance.contractVersion ?? 1,
        implementationVersion:
          this.options.readiness?.provenance.implementationVersion ??
          "host-native-v1",
      },
    };
  }

  protected override materialize(
    spec: EnvironmentSpec,
    _ref: EnvironmentRef,
  ): MaterializedEnvironment {
    if (spec.workerId !== this.options.workerId)
      throw new EnvironmentBackendError(
        "invalid_environment_spec",
        `Host-native backend belongs to Worker ${this.options.workerId}.`,
        "ensure",
      );
    const paths = this.options.pathsFor(structuredClone(spec));
    if (Object.values(paths).some((path) => !isAbsolute(path)))
      throw new EnvironmentBackendError(
        "invalid_environment_spec",
        "Host-native compatibility paths must be absolute host paths.",
        "ensure",
      );
    return {
      paths: { ...paths },
      capabilities: copyCapabilities(this.backendCapabilities),
      paneEnvironment: {
        ...(this.options.paneEnvironmentFor?.(structuredClone(spec)) ?? {}),
      },
    };
  }

  protected override launchInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    command: EnvironmentCommand,
  ): HostLaunchDescriptor {
    return {
      executable: command.executable,
      args: [...command.args],
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
    try {
      const child = Bun.spawn([command.executable, ...command.args], {
        cwd: command.cwd ?? binding.paths.workspace,
        env: {
          ...definedProcessEnvironment(),
          ...binding.paneEnvironment,
          ...command.environment,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      let timedOut = false;
      let forceTimer: ReturnType<typeof setTimeout> | null = null;
      const timer = command.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            forceTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
          }, command.timeoutMs)
        : null;
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]).finally(() => {
        if (timer) clearTimeout(timer);
        if (forceTimer) clearTimeout(forceTimer);
      });
      if (timedOut)
        throw new EnvironmentBackendError(
          "operation_timeout",
          `Host-native command timed out after ${command.timeoutMs}ms.`,
          "exec",
        );
      return { exitCode, stdout, stderr };
    } catch (error) {
      if (error instanceof EnvironmentBackendError) throw error;
      throw new EnvironmentBackendError(
        "environment_operation_failed",
        error instanceof Error ? error.message : String(error),
        "exec",
      );
    }
  }
}

function definedProcessEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function copyCapabilities(
  capabilities: readonly EnvironmentCapability[],
): EnvironmentCapability[] {
  return capabilities.map((capability) => ({ ...capability }));
}
