import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve as resolvePath } from "node:path";
import type {
  EnvironmentBackendOperation,
  EnvironmentCapability,
  EnvironmentCommand,
  EnvironmentCommandResult,
  EnvironmentFileRead,
  EnvironmentFileReceipt,
  EnvironmentFileWrite,
  EnvironmentInspection,
  EnvironmentLease,
  EnvironmentPathMap,
  EnvironmentRef,
  EnvironmentSpec,
  ExecutionEnvironmentBackend,
  HostLaunchDescriptor,
} from "./types.ts";
import {
  EnvironmentBackendError,
  MAX_ENVIRONMENT_FILE_BYTES,
} from "./types.ts";

export interface TrackedEnvironmentBinding {
  ref: EnvironmentRef;
  spec: EnvironmentSpec;
  specJson: string;
  specDigest: string;
  state: "running" | "stopped" | "removed";
  paths: EnvironmentPathMap;
  capabilities: readonly EnvironmentCapability[];
  paneEnvironment: Readonly<Record<string, string>>;
}

export interface MaterializedEnvironment {
  paths: EnvironmentPathMap;
  capabilities: readonly EnvironmentCapability[];
  paneEnvironment: Readonly<Record<string, string>>;
}

/** Shared exact-identity lifecycle used by the Phase-1 in-memory backends. */
export abstract class TrackedExecutionEnvironmentBackend
  implements ExecutionEnvironmentBackend
{
  private readonly backendInstanceId = randomUUID();
  private readonly records = new Map<string, TrackedEnvironmentBinding>();
  private readonly currentByOwner = new Map<string, string>();
  private readonly generations = new Map<string, number>();
  private readonly ownerTails = new Map<string, Promise<void>>();

  protected constructor(readonly kind: string) {}

  abstract readiness(): ReturnType<ExecutionEnvironmentBackend["readiness"]>;

  async ensure(spec: EnvironmentSpec): Promise<EnvironmentLease> {
    await this.beforeOperation("ensure");
    const snapshot = copySpec(spec);
    validateSpec(snapshot);
    const owner = ownerKey(snapshot.workerId, snapshot.runId);
    return this.withOwner(owner, async () => {
      const currentKey = this.currentByOwner.get(owner);
      const current = currentKey ? this.records.get(currentKey) : undefined;
      if (current && current.state !== "removed") {
        this.assertSpec(current, snapshot, "ensure");
        current.state = "running";
        return this.lease(current);
      }

      const generation = (this.generations.get(owner) ?? 0) + 1;
      const ref = this.createRef(snapshot, generation);
      validateCreatedRef(this.kind, snapshot, ref);
      const materialized = await this.materialize(snapshot, ref);
      assertRequiredCapabilities(snapshot, materialized.capabilities);
      const specJson = canonicalJson(snapshot);
      const binding: TrackedEnvironmentBinding = {
        ref: copyRef(ref),
        spec: snapshot,
        specJson,
        specDigest: digest(specJson),
        state: "running",
        paths: copyPaths(materialized.paths),
        capabilities: copyCapabilities(materialized.capabilities),
        paneEnvironment: { ...materialized.paneEnvironment },
      };
      const key = refKey(binding.ref);
      if (this.records.has(key))
        throw new EnvironmentBackendError(
          "invalid_environment_ref",
          `Backend ${this.kind} reused physical environment identity ${key}.`,
          "ensure",
        );
      this.records.set(key, binding);
      this.currentByOwner.set(owner, key);
      this.generations.set(owner, generation);
      return this.lease(binding);
    });
  }

  async recover(
    ref: EnvironmentRef,
    spec: EnvironmentSpec,
  ): Promise<EnvironmentLease> {
    await this.beforeOperation("recover");
    const snapshot = copySpec(spec);
    validateSpec(snapshot);
    const binding = this.resolve(ref, "recover");
    this.assertSpec(binding, snapshot, "recover");
    this.assertUsable(binding, "recover");
    return this.lease(binding);
  }

  async inspect(ref: EnvironmentRef): Promise<EnvironmentInspection> {
    await this.beforeOperation("inspect");
    const binding = this.resolve(ref, "inspect");
    return {
      ref: copyRef(binding.ref),
      state: binding.state,
      usable: binding.state === "running",
      specDigest: binding.specDigest,
      paths: copyPaths(binding.paths),
      capabilities: copyCapabilities(binding.capabilities),
    };
  }

  async stop(ref: EnvironmentRef): Promise<void> {
    await this.beforeOperation("stop");
    await this.withOwner(ownerKey(ref.workerId, ref.runId), async () => {
      const binding = this.resolve(ref, "stop");
      if (binding.state === "removed")
        throw new EnvironmentBackendError(
          "environment_removed",
          `Environment ${binding.ref.environmentId} has been removed.`,
          "stop",
        );
      binding.state = "stopped";
    });
  }

  async remove(ref: EnvironmentRef): Promise<void> {
    await this.beforeOperation("remove");
    await this.withOwner(ownerKey(ref.workerId, ref.runId), async () => {
      this.resolve(ref, "remove").state = "removed";
    });
  }

  protected async beforeOperation(
    _operation: EnvironmentBackendOperation,
  ): Promise<void> {}

  protected createRef(
    spec: EnvironmentSpec,
    generation: number,
  ): EnvironmentRef {
    const logical = digest(
      `${this.kind}\0${this.backendInstanceId}\0${spec.workerId}\0${spec.runId}`,
    ).slice(0, 24);
    const incarnation = digest(
      `${this.backendInstanceId}\0${spec.workerId}\0${spec.runId}\0${generation}`,
    ).slice(0, 24);
    return {
      backendKind: this.kind,
      environmentId: `${this.kind}-${logical}-${generation}`,
      incarnation: `${this.kind}-incarnation-${incarnation}`,
      workerId: spec.workerId,
      runId: spec.runId,
      profile: { ...spec.profile },
    };
  }

  protected abstract materialize(
    spec: EnvironmentSpec,
    ref: EnvironmentRef,
  ): MaterializedEnvironment | Promise<MaterializedEnvironment>;

  protected abstract launchInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    command: EnvironmentCommand,
  ): HostLaunchDescriptor | Promise<HostLaunchDescriptor>;

  protected abstract execInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    command: EnvironmentCommand,
  ): Promise<EnvironmentCommandResult>;

  protected workerExecInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    command: EnvironmentCommand,
  ): Promise<EnvironmentCommandResult> {
    return this.execInEnvironment(binding, command);
  }

  protected abstract writeFileInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    input: EnvironmentFileWrite,
  ): Promise<void>;

  protected abstract readFileInEnvironment(
    binding: Readonly<TrackedEnvironmentBinding>,
    input: EnvironmentFileRead,
  ): Promise<Uint8Array>;

  private lease(binding: TrackedEnvironmentBinding): EnvironmentLease {
    const ref = copyRef(binding.ref);
    return {
      ref,
      paths: copyPaths(binding.paths),
      capabilities: copyCapabilities(binding.capabilities),
      paneEnvironment: { ...binding.paneEnvironment },
      launcher: async (command) => {
        await this.beforeOperation("launcher");
        const current = this.resolve(ref, "launcher");
        this.assertUsable(current, "launcher");
        return this.launchInEnvironment(
          current,
          copyCommand(validateCommand(command)),
        );
      },
      exec: async (command) => {
        await this.beforeOperation("exec");
        const current = this.resolve(ref, "exec");
        this.assertUsable(current, "exec");
        return this.execInEnvironment(
          current,
          copyCommand(validateCommand(command)),
        );
      },
      workerExec: async (command) => {
        await this.beforeOperation("exec");
        const current = this.resolve(ref, "exec");
        this.assertUsable(current, "exec");
        return this.workerExecInEnvironment(
          current,
          copyCommand(validateCommand(command)),
        );
      },
      writeFile: async (input) => {
        await this.beforeOperation("transfer");
        const current = this.resolve(ref, "transfer");
        this.assertUsable(current, "transfer");
        const request = validateFileWrite(current.paths, input);
        await this.writeFileInEnvironment(current, request);
        return fileReceipt(request.path, request.data);
      },
      readFile: async (input) => {
        await this.beforeOperation("transfer");
        const current = this.resolve(ref, "transfer");
        this.assertUsable(current, "transfer");
        const request = validateFileRead(current.paths, input);
        const data = await this.readFileInEnvironment(current, request);
        if (data.byteLength > request.maxBytes)
          throw new EnvironmentBackendError(
            "environment_operation_failed",
            `Environment file exceeds the ${request.maxBytes}-byte transfer bound.`,
            "transfer",
          );
        return new Uint8Array(data);
      },
    };
  }

  private resolve(
    requested: EnvironmentRef,
    operation: EnvironmentBackendOperation,
  ): TrackedEnvironmentBinding {
    if (requested.backendKind !== this.kind)
      throw new EnvironmentBackendError(
        "invalid_environment_ref",
        `Environment ref belongs to ${requested.backendKind}, not ${this.kind}.`,
        operation,
      );
    const owner = ownerKey(requested.workerId, requested.runId);
    const requestedKey = refKey(requested);
    const binding = this.records.get(requestedKey);
    const currentKey = this.currentByOwner.get(owner);
    if (!binding) {
      if (currentKey)
        throw new EnvironmentBackendError(
          "stale_environment_ref",
          `Environment ref is not the current incarnation for Run ${requested.runId}.`,
          operation,
        );
      throw new EnvironmentBackendError(
        "environment_not_found",
        `Environment ${requested.environmentId} is unknown.`,
        operation,
      );
    }
    if (
      canonicalJson(binding.ref) !== canonicalJson(requested) ||
      currentKey !== requestedKey ||
      (binding.state === "removed" && operation !== "remove")
    )
      throw new EnvironmentBackendError(
        "stale_environment_ref",
        `Environment ref is not the current incarnation for Run ${requested.runId}.`,
        operation,
      );
    return binding;
  }

  private assertSpec(
    binding: TrackedEnvironmentBinding,
    spec: EnvironmentSpec,
    operation: EnvironmentBackendOperation,
  ): void {
    if (binding.specJson !== canonicalJson(spec))
      throw new EnvironmentBackendError(
        "incompatible_environment_spec",
        `Run ${spec.runId} already has an environment with a different exact spec.`,
        operation,
      );
  }

  private assertUsable(
    binding: TrackedEnvironmentBinding,
    operation: EnvironmentBackendOperation,
  ): void {
    if (binding.state !== "running")
      throw new EnvironmentBackendError(
        "environment_not_usable",
        `Environment ${binding.ref.environmentId} is ${binding.state}.`,
        operation,
      );
  }

  private async withOwner<T>(
    owner: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.ownerTails.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.ownerTails.set(owner, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.ownerTails.get(owner) === tail) this.ownerTails.delete(owner);
    }
  }
}

export function environmentSpecDigest(spec: EnvironmentSpec): string {
  validateSpec(spec);
  return digest(canonicalJson(spec));
}

function validateSpec(spec: EnvironmentSpec): void {
  for (const [name, value] of [
    ["workerId", spec.workerId],
    ["runId", spec.runId],
    ["workspace.workspaceId", spec.workspace.workspaceId],
    [
      "workspace.materialization.sourceIdentity",
      spec.workspace.materialization.sourceIdentity,
    ],
    [
      "workspace.materialization.frozenBase.kind",
      spec.workspace.materialization.frozenBase.kind,
    ],
    [
      "workspace.materialization.frozenBase.value",
      spec.workspace.materialization.frozenBase.value,
    ],
    ["profile.id", spec.profile.id],
    ["profile.digest", spec.profile.digest],
    ["resourcePolicy.id", spec.resourcePolicy.id],
    ["resourcePolicy.digest", spec.resourcePolicy.digest],
  ] as const) {
    if (typeof value !== "string" || value.length === 0)
      throw new EnvironmentBackendError(
        "invalid_environment_spec",
        `${name} is required.`,
      );
  }
  for (const grant of spec.credentialGrants) {
    const unknown = Object.keys(grant).filter(
      (key) => !["grantId", "kind", "scope"].includes(key),
    );
    if (!grant.grantId || !grant.kind || unknown.length > 0)
      throw new EnvironmentBackendError(
        "invalid_environment_spec",
        "Credential grants must contain descriptors only, never secret material.",
      );
  }
  canonicalJson(spec);
}

function assertRequiredCapabilities(
  spec: EnvironmentSpec,
  capabilities: readonly EnvironmentCapability[],
): void {
  const unmet = spec.requiredCapabilities.filter(
    (requirement) =>
      !capabilities.some(
        (capability) =>
          capability.kind === requirement.kind &&
          capability.mode === requirement.mode,
      ),
  );
  if (unmet.length > 0)
    throw new EnvironmentBackendError(
      "environment_requirements_unmet",
      `Backend cannot satisfy required capabilities: ${unmet
        .map((requirement) => `${requirement.kind}:${requirement.mode}`)
        .join(", ")}.`,
      "ensure",
    );
}

function validateCreatedRef(
  backendKind: string,
  spec: EnvironmentSpec,
  ref: EnvironmentRef,
): void {
  if (
    ref.backendKind !== backendKind ||
    ref.workerId !== spec.workerId ||
    ref.runId !== spec.runId ||
    canonicalJson(ref.profile) !== canonicalJson(spec.profile) ||
    !ref.environmentId ||
    !ref.incarnation
  )
    throw new EnvironmentBackendError(
      "invalid_environment_ref",
      `Backend ${backendKind} created an invalid environment ref.`,
      "ensure",
    );
}

function validateCommand(command: EnvironmentCommand): EnvironmentCommand {
  if (!command.executable)
    throw new EnvironmentBackendError(
      "environment_operation_failed",
      "Environment command executable is required.",
    );
  canonicalJson(command);
  return command;
}

function validateFileWrite(
  paths: EnvironmentPathMap,
  input: EnvironmentFileWrite,
): EnvironmentFileWrite {
  validateTransferPath(paths, input.path);
  if (
    !(input.data instanceof Uint8Array) ||
    input.data.byteLength > MAX_ENVIRONMENT_FILE_BYTES
  )
    throw new EnvironmentBackendError(
      "environment_operation_failed",
      `Environment file transfer data must be bytes no larger than ${MAX_ENVIRONMENT_FILE_BYTES}.`,
      "transfer",
    );
  if (
    input.mode !== undefined &&
    (!Number.isSafeInteger(input.mode) || input.mode < 0 || input.mode > 0o777)
  )
    throw new EnvironmentBackendError(
      "environment_operation_failed",
      "Environment file mode must be valid POSIX permission bits.",
      "transfer",
    );
  return {
    path: input.path,
    data: new Uint8Array(input.data),
    ...(input.mode === undefined ? {} : { mode: input.mode }),
  };
}

function validateFileRead(
  paths: EnvironmentPathMap,
  input: EnvironmentFileRead,
): EnvironmentFileRead {
  validateTransferPath(paths, input.path);
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 0 ||
    input.maxBytes > MAX_ENVIRONMENT_FILE_BYTES
  )
    throw new EnvironmentBackendError(
      "environment_operation_failed",
      "Environment file transfer bound must be a non-negative safe integer.",
      "transfer",
    );
  return { ...input };
}

function validateTransferPath(paths: EnvironmentPathMap, path: string): void {
  if (!isAbsolute(path))
    throw new EnvironmentBackendError(
      "environment_operation_failed",
      "Environment transfer paths must be absolute.",
      "transfer",
    );
  const target = resolvePath(path);
  const contained = Object.values(paths).some((root) => {
    const candidate = relative(resolvePath(root), target);
    return (
      candidate !== "" && !candidate.startsWith("..") && !isAbsolute(candidate)
    );
  });
  if (!contained)
    throw new EnvironmentBackendError(
      "environment_operation_failed",
      "Environment transfer path is outside the lease path map or names a path-map root.",
      "transfer",
    );
}

function fileReceipt(path: string, data: Uint8Array): EnvironmentFileReceipt {
  return {
    path,
    byteLength: data.byteLength,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

function ownerKey(workerId: string, runId: string): string {
  return `${workerId}\0${runId}`;
}

function refKey(ref: EnvironmentRef): string {
  return `${ref.backendKind}\0${ref.environmentId}\0${ref.incarnation}`;
}

function copySpec(spec: EnvironmentSpec): EnvironmentSpec {
  return structuredClone(spec);
}

function copyRef(ref: EnvironmentRef): EnvironmentRef {
  return structuredClone(ref);
}

function copyPaths(paths: EnvironmentPathMap): EnvironmentPathMap {
  return { ...paths };
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

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new EnvironmentBackendError(
        "invalid_environment_spec",
        "Environment values must be finite.",
      );
    return JSON.stringify(value);
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw new EnvironmentBackendError(
    "invalid_environment_spec",
    "Environment values must be JSON-compatible and cannot contain undefined.",
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
