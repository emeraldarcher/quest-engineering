import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  type MaterializedEnvironment,
  type TrackedEnvironmentBinding,
  TrackedExecutionEnvironmentBackend,
} from "./tracked-backend.ts";
import type {
  EnvironmentCapability,
  EnvironmentCommand,
  EnvironmentCommandResult,
  EnvironmentFileRead,
  EnvironmentFileWrite,
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

  protected override async writeFileInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    input: EnvironmentFileWrite,
  ): Promise<void> {
    await assertHostTransferPath(binding.paths, input.path, false);
    await mkdir(dirname(input.path), { recursive: true });
    const temporary = `${input.path}.qe-transfer-${randomUUID()}`;
    try {
      await writeFile(temporary, input.data, {
        mode: input.mode ?? 0o600,
        flag: "wx",
      });
      await rename(temporary, input.path);
      if (input.mode !== undefined) await chmod(input.path, input.mode);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  protected override async readFileInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    input: EnvironmentFileRead,
  ): Promise<Uint8Array> {
    await assertHostTransferPath(binding.paths, input.path, true);
    const metadata = await lstat(input.path);
    if (!metadata.isFile() || metadata.isSymbolicLink())
      throw new EnvironmentBackendError(
        "environment_operation_failed",
        "Host-native transfer source must be a regular file.",
        "transfer",
      );
    if (metadata.size > input.maxBytes)
      throw new EnvironmentBackendError(
        "environment_operation_failed",
        `Environment file exceeds the ${input.maxBytes}-byte transfer bound.`,
        "transfer",
      );
    return new Uint8Array(await readFile(input.path));
  }
}

async function assertHostTransferPath(
  paths: EnvironmentPathMap,
  path: string,
  mustExist: boolean,
): Promise<void> {
  const parent = dirname(path);
  let ancestor = parent;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor)
    ancestor = dirname(ancestor);
  const existingAncestor = existsSync(ancestor) ? realpathSync(ancestor) : null;
  const roots = Object.values(paths)
    .filter((root) => existsSync(root))
    .map((root) => realpathSync(root));
  if (existingAncestor) {
    const contained = roots.some((root) => {
      const candidate = relative(root, existingAncestor);
      return (
        candidate === "" ||
        (!candidate.startsWith("..") && !isAbsolute(candidate))
      );
    });
    if (!contained)
      throw new EnvironmentBackendError(
        "environment_operation_failed",
        "Host-native transfer resolves outside the lease path map.",
        "transfer",
      );
  }
  if (mustExist && !existsSync(path))
    throw new EnvironmentBackendError(
      "environment_operation_failed",
      "Host-native transfer source does not exist.",
      "transfer",
    );
  if (!isAbsolute(resolve(path)))
    throw new EnvironmentBackendError(
      "environment_operation_failed",
      "Host-native transfer path is invalid.",
      "transfer",
    );
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
