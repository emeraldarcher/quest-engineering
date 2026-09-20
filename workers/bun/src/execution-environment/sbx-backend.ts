import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import type {
  SbxClient,
  SbxNativeVersion,
  SbxSandboxSummary,
} from "./sbx-client.ts";
import { CliSbxClient, SbxClientError } from "./sbx-client.ts";
import {
  SBX_DISABLED_CREDENTIAL_ENVIRONMENT,
  SBX_DISPOSABLE_RESOURCE_POLICY,
  type SBX_EXECUTION_PROFILE_V1,
  SBX_GUEST_PATHS,
  SBX_PI_RUNTIME_NETWORK_TARGETS,
  SBX_SHELL_PROFILE,
  type SbxExecutionProfile,
  type SbxResourcePolicy,
  verifySbxProfileAssets,
} from "./sbx-profile.ts";
import {
  DEFAULT_SBX_VERSION_POLICY,
  inspectSbxReadiness,
  type SbxVersionPolicy,
} from "./sbx-readiness.ts";
import {
  LiveSbxEnvironmentVerifier,
  type SbxEnvironmentVerifier,
  type SbxVerifiedEnvironment,
} from "./sbx-verifier.ts";
import {
  type DurableEnvironmentRecord,
  ExecutionEnvironmentStore,
} from "./store.ts";
import { environmentSpecDigest } from "./tracked-backend.ts";
import type {
  EnvironmentBackendOperation,
  EnvironmentCapability,
  EnvironmentCommand,
  EnvironmentFileRead,
  EnvironmentFileWrite,
  EnvironmentInspection,
  EnvironmentLease,
  EnvironmentProfileIdentity,
  EnvironmentReadiness,
  EnvironmentRef,
  EnvironmentSpec,
  ExecutionEnvironmentBackend,
  HostLaunchDescriptor,
} from "./types.ts";
import {
  EnvironmentBackendError,
  MAX_ENVIRONMENT_FILE_BYTES,
} from "./types.ts";

export interface SbxExecutionEnvironmentBackendOptions {
  workerId: string;
  dataRoot: string;
  client?: SbxClient;
  store?: ExecutionEnvironmentStore;
  verifier?: SbxEnvironmentVerifier;
  /** Legacy identity-only override retained for deterministic backend tests. */
  profile?: typeof SBX_EXECUTION_PROFILE_V1;
  executionProfile?: SbxExecutionProfile;
  resourcePolicy?: SbxResourcePolicy;
  versionPolicy?: SbxVersionPolicy;
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  reconciliationPollMs?: number;
  reconciliationAttempts?: number;
  ownerWaitAttempts?: number;
}

/** Durable Run-owned Docker Sandboxes lifecycle. Not wired to dispatch through Phase 3. */
export class SbxExecutionEnvironmentBackend
  implements ExecutionEnvironmentBackend
{
  readonly kind = "sbx";
  private readonly client: SbxClient;
  private readonly store: ExecutionEnvironmentStore;
  private readonly verifier: SbxEnvironmentVerifier;
  private readonly profile: EnvironmentProfileIdentity;
  private readonly executionProfile: SbxExecutionProfile;
  private readonly resourcePolicy: SbxResourcePolicy;
  private readonly versionPolicy: SbxVersionPolicy;
  private readonly processId: number;
  private readonly isProcessAlive: (processId: number) => boolean;
  private readonly instanceToken = randomUUID();
  private readonly ownerTails = new Map<string, Promise<void>>();
  private readonly launcherPath = resolve(import.meta.dir, "sbx-launcher.ts");
  private readonly reconciliationPollMs: number;
  private readonly reconciliationAttempts: number;
  private readonly ownerWaitAttempts: number;

  constructor(private readonly options: SbxExecutionEnvironmentBackendOptions) {
    this.client = options.client ?? new CliSbxClient();
    this.store =
      options.store ?? new ExecutionEnvironmentStore(options.dataRoot);
    this.executionProfile =
      options.executionProfile ??
      (options.profile
        ? { ...SBX_SHELL_PROFILE, identity: options.profile }
        : SBX_SHELL_PROFILE);
    this.profile = this.executionProfile.identity;
    this.resourcePolicy =
      options.resourcePolicy ?? SBX_DISPOSABLE_RESOURCE_POLICY;
    this.versionPolicy = options.versionPolicy ?? DEFAULT_SBX_VERSION_POLICY;
    this.verifier =
      options.verifier ??
      new LiveSbxEnvironmentVerifier(
        this.client,
        this.resourcePolicy,
        this.executionProfile,
      );
    this.processId = options.processId ?? process.pid;
    this.isProcessAlive = options.isProcessAlive ?? processAlive;
    this.reconciliationPollMs = options.reconciliationPollMs ?? 250;
    this.reconciliationAttempts = options.reconciliationAttempts ?? 120;
    this.ownerWaitAttempts = options.ownerWaitAttempts ?? 2_640;
  }

  readiness(): Promise<EnvironmentReadiness> {
    return inspectSbxReadiness(this.client, this.versionPolicy);
  }

  async ensure(spec: EnvironmentSpec): Promise<EnvironmentLease> {
    this.validateSpec(spec, "ensure");
    await verifySbxProfileAssets(this.executionProfile);
    const owner = ownerKey(spec.workerId, spec.runId);
    return this.withOwner(owner, async () => {
      const readiness = await this.requireReadiness("ensure");
      const native = await this.requireNativeVersion("ensure");
      assertReadinessProvenance(readiness, native, "ensure");
      const specDigest = environmentSpecDigest(spec);
      const claim = this.store.claimCreation({
        recordId: randomUUID(),
        backendKind: this.kind,
        workerId: spec.workerId,
        runId: spec.runId,
        displayName: sbxEnvironmentName(spec.workerId, spec.runId),
        incarnation: randomUUID(),
        profileId: spec.profile.id,
        profileDigest: spec.profile.digest,
        specDigest,
        creationToken: this.instanceToken,
        creatorPid: this.processId,
        nativeVersion: native.clientVersion,
        nativeRevision: native.clientRevision,
        nativeApiVersion: native.apiVersion as string,
      });
      this.assertRecordSpec(claim.record, spec, specDigest, "ensure");
      return this.ensureRecord(claim.record, spec, native);
    });
  }

  async recover(
    ref: EnvironmentRef,
    spec: EnvironmentSpec,
  ): Promise<EnvironmentLease> {
    this.validateSpec(spec, "recover");
    await verifySbxProfileAssets(this.executionProfile);
    return this.withOwner(ownerKey(ref.workerId, ref.runId), async () => {
      const record = this.requireCurrentRef(ref, "recover");
      const digest = environmentSpecDigest(spec);
      this.assertRecordSpec(record, spec, digest, "recover");
      const readiness = await this.requireReadiness("recover");
      const native = await this.requireNativeVersion("recover");
      assertReadinessProvenance(readiness, native, "recover");
      const sandbox = await this.requireExactSandbox(record, "recover");
      const running = await this.startIfStopped(record, sandbox, "recover");
      let verified: SbxVerifiedEnvironment;
      try {
        verified = await this.verifier.verify(record, running);
        this.assertCapabilities(spec, verified.capabilities, "recover");
      } catch (error) {
        this.persistVerificationFailure(record, error);
        throw normalize(error, "recover");
      }
      const persisted = this.persistVerification(
        record,
        verified,
        native,
        "running",
      );
      return this.lease(persisted);
    });
  }

  async inspect(ref: EnvironmentRef): Promise<EnvironmentInspection> {
    const record = this.requireCurrentRef(ref, "inspect");
    if (
      record.profileId !== this.profile.id ||
      record.profileDigest !== this.profile.digest
    ) {
      const incompatible = this.store.markState(
        record.recordId,
        "incompatible",
        [
          {
            code: "environment_spec_mismatch",
            message:
              "Durable environment profile does not match this backend profile.",
          },
        ],
      );
      return this.inspection(incompatible, false, "incompatible", null);
    }
    let native: SbxNativeVersion | null = null;
    try {
      const readiness = await this.readiness();
      if (!readiness.ready) {
        const state =
          readiness.status === "incompatible" ? "incompatible" : "degraded";
        const unavailable = this.store.markState(
          record.recordId,
          state,
          readiness.diagnostics,
        );
        return this.inspection(unavailable, false, state, null);
      }
      native = await this.client.version();
      assertReadinessProvenance(readiness, native, "inspect");
      const sandboxes = await this.client.list();
      const identity = locateSandbox(
        record,
        sandboxes,
        this.executionProfile.nativeAgent,
      );
      if (identity.kind === "missing") {
        const missing = this.store.markState(record.recordId, "missing", [
          {
            code: "environment_not_found",
            message:
              "Durable ownership exists but the SBX environment is missing.",
          },
        ]);
        return this.inspection(missing, false, "missing", native);
      }
      if (identity.kind === "mismatch") {
        const incompatible = this.store.markState(
          record.recordId,
          "incompatible",
          [
            {
              code: "environment_identity_mismatch",
              message: identity.message,
            },
          ],
        );
        return this.inspection(incompatible, false, "incompatible", native);
      }
      if (identity.sandbox.status === "stopped") {
        const stopped = this.store.markState(record.recordId, "stopped");
        return this.inspection(stopped, false, "stopped", native);
      }
      if (identity.sandbox.status !== "running") {
        const degraded = this.store.markState(record.recordId, "degraded", [
          {
            code: "environment_unhealthy",
            message: `SBX reported unsupported lifecycle state ${identity.sandbox.status}.`,
          },
        ]);
        return this.inspection(degraded, false, "degraded", native);
      }
      try {
        const verified = await this.verifier.verify(record, identity.sandbox);
        const current = this.persistVerification(
          record,
          verified,
          native,
          "running",
        );
        return this.inspection(current, true, "running", native);
      } catch (error) {
        const incompatible =
          error instanceof EnvironmentBackendError &&
          error.code === "environment_identity_mismatch";
        const state = incompatible ? "incompatible" : "degraded";
        const current = this.store.markState(record.recordId, state, [
          {
            code: incompatible
              ? "environment_identity_mismatch"
              : "environment_unhealthy",
            message: errorMessage(error),
          },
        ]);
        return this.inspection(current, false, state, native);
      }
    } catch (error) {
      const degraded = this.store.markState(record.recordId, "degraded", [
        { code: "backend_unavailable", message: errorMessage(error) },
      ]);
      return this.inspection(degraded, false, "degraded", native);
    }
  }

  async stop(ref: EnvironmentRef): Promise<void> {
    await this.withOwner(ownerKey(ref.workerId, ref.runId), async () => {
      const record = this.requireCurrentRef(ref, "stop");
      const sandbox = await this.requireExactSandbox(record, "stop");
      if (sandbox.status !== "stopped") {
        if (sandbox.status !== "running")
          throw unhealthy(
            `Cannot stop SBX environment in state ${sandbox.status}.`,
            "stop",
          );
        try {
          await this.client.stop(record.displayName);
        } catch (error) {
          const reconciled = await this.requireExactSandbox(record, "stop");
          if (reconciled.status !== "stopped") throw normalize(error, "stop");
        }
      }
      const stopped = await this.pollSandbox(record, "stopped", "stop");
      if (!stopped || stopped.status !== "stopped")
        throw unhealthy("SBX environment did not reach stopped state.", "stop");
      this.store.markState(record.recordId, "stopped");
    });
  }

  async remove(ref: EnvironmentRef): Promise<void> {
    await this.withOwner(ownerKey(ref.workerId, ref.runId), async () => {
      const historical = this.store.byRef(ref);
      if (historical?.retiredAt) {
        if (
          ref.backendKind === this.kind &&
          ref.workerId === this.options.workerId &&
          historical.profileId === ref.profile.id &&
          historical.profileDigest === ref.profile.digest
        )
          return;
        throw new EnvironmentBackendError(
          "stale_environment_ref",
          "Retired environment ref provenance does not match history.",
          "remove",
        );
      }
      const record = this.requireCurrentRef(ref, "remove");
      let sandboxes: SbxSandboxSummary[];
      try {
        sandboxes = await this.client.list();
      } catch (error) {
        throw normalize(error, "remove");
      }
      const identity = locateSandbox(
        record,
        sandboxes,
        this.executionProfile.nativeAgent,
      );
      if (identity.kind === "mismatch")
        throw identityMismatch(identity.message, "remove");
      if (identity.kind === "exact") {
        try {
          await this.client.remove(record.displayName);
        } catch (error) {
          let remaining: LocatedSandbox;
          try {
            remaining = locateSandbox(
              record,
              await this.client.list(),
              this.executionProfile.nativeAgent,
            );
          } catch {
            throw normalize(error, "remove");
          }
          if (remaining.kind === "exact") throw normalize(error, "remove");
          if (remaining.kind === "mismatch")
            throw identityMismatch(remaining.message, "remove");
        }
      }
      let remaining: LocatedSandbox;
      try {
        remaining = locateSandbox(
          record,
          await this.client.list(),
          this.executionProfile.nativeAgent,
        );
      } catch (error) {
        throw normalize(error, "remove");
      }
      if (remaining.kind === "exact")
        throw unhealthy(
          "SBX environment still exists after removal.",
          "remove",
        );
      if (remaining.kind === "mismatch")
        throw identityMismatch(remaining.message, "remove");
      this.store.retire(record.recordId);
    });
  }

  close(): void {
    this.store.close();
  }

  private async ensureRecord(
    initial: DurableEnvironmentRecord,
    spec: EnvironmentSpec,
    native: SbxNativeVersion,
  ): Promise<EnvironmentLease> {
    let record = initial;
    if (record.environmentId) {
      const sandbox = await this.requireExactSandbox(record, "ensure");
      const running = await this.startIfStopped(record, sandbox, "ensure");
      let verified: SbxVerifiedEnvironment;
      try {
        verified = await this.verifier.verify(record, running);
        this.assertCapabilities(spec, verified.capabilities, "ensure");
      } catch (error) {
        this.persistVerificationFailure(record, error);
        throw normalize(error, "ensure");
      }
      record = this.persistVerification(record, verified, native, "running");
      return this.lease(record);
    }

    if (record.state !== "creating")
      throw new EnvironmentBackendError(
        record.state === "incompatible"
          ? "environment_identity_mismatch"
          : "environment_unhealthy",
        record.diagnostics.map((item) => item.message).join(" ") ||
          `Unbound environment intent is ${record.state}.`,
        "ensure",
      );

    const ownsCreation = this.store.acquireCreationOwnership({
      recordId: record.recordId,
      creationToken: this.instanceToken,
      creatorPid: this.processId,
      allowTakeover: !this.isProcessAlive(record.creatorPid),
    });
    if (!ownsCreation) {
      const adopted = await this.waitForPhysicalBinding(record);
      if (adopted) return this.ensureRecord(adopted, spec, native);
      const latest = this.store.current(
        this.kind,
        record.workerId,
        record.runId,
      );
      if (
        latest?.state === "creating" &&
        !this.isProcessAlive(latest.creatorPid)
      )
        return this.ensureRecord(latest, spec, native);
      throw new EnvironmentBackendError(
        "environment_creation_ambiguous",
        "Another live Worker process owns this environment creation intent.",
        "ensure",
      );
    }
    record = this.store.current(
      this.kind,
      record.workerId,
      record.runId,
    ) as DurableEnvironmentRecord;

    let sandbox = await this.findUnboundSandbox(record);
    let createdThisAttempt = false;
    if (!sandbox) {
      try {
        await this.client.create({
          name: record.displayName,
          agentReference: this.executionProfile.agentReference,
          denyAllNetwork: this.executionProfile.networkMode === "deny_all",
          cpus: this.resourcePolicy.cpus,
          memory: this.resourcePolicy.memory,
          privateDockerDisk: this.resourcePolicy.privateDockerDisk,
          environment: creationEnvironment(record),
        });
        createdThisAttempt = true;
      } catch (error) {
        sandbox = await this.pollUnboundSandbox(record);
        createdThisAttempt = sandbox !== null;
        if (!sandbox) {
          this.store.markState(record.recordId, "degraded", [
            {
              code: "environment_creation_ambiguous",
              message:
                "SBX creation did not return success and no exact deterministic identity could be reconciled.",
            },
          ]);
          throw new EnvironmentBackendError(
            "environment_creation_ambiguous",
            errorMessage(error),
            "ensure",
          );
        }
      }
    }
    sandbox ??= await this.pollUnboundSandbox(record);
    if (!sandbox)
      throw new EnvironmentBackendError(
        "environment_creation_ambiguous",
        "SBX create returned without a discoverable deterministic environment.",
        "ensure",
      );
    if (sandbox.agent !== this.executionProfile.nativeAgent)
      throw identityMismatch(
        `Deterministic SBX name belongs to agent ${sandbox.agent}, not ${this.executionProfile.nativeAgent}.`,
        "ensure",
      );

    let verified: SbxVerifiedEnvironment;
    try {
      await this.client.denyNetwork(
        sandbox.name,
        this.executionProfile.postCreateNetworkDenies,
      );
      verified = await this.verifier.initialize(record, sandbox);
      this.assertCapabilities(spec, verified.capabilities, "ensure");
    } catch (error) {
      this.persistVerificationFailure(record, error);
      if (createdThisAttempt) {
        try {
          await this.client.remove(record.displayName);
          this.store.retire(record.recordId);
        } catch {
          // Keep the incompatible durable record authoritative if cleanup fails.
        }
      }
      throw normalize(error, "ensure");
    }
    record = this.store.bindPhysical({
      recordId: record.recordId,
      environmentId: sandbox.id,
      nativeAgent: sandbox.agent,
      markerDigest: verified.markerDigest,
      state: "running",
      capabilities: verified.capabilities,
      diagnostics: verified.diagnostics,
    });
    record = this.persistVerification(record, verified, native, "running");
    return this.lease(record);
  }

  private lease(record: DurableEnvironmentRecord): EnvironmentLease {
    const ref = refFor(record);
    return {
      ref,
      paths: { ...SBX_GUEST_PATHS },
      capabilities: record.capabilities.map((capability) => ({
        ...capability,
      })),
      paneEnvironment: leaseEnvironment(record),
      launcher: async (command) => {
        validateCommand(command);
        const current = await this.requireUsableLease(record, "launcher");
        const requested = withDefaultCwd(command);
        return {
          executable: process.execPath,
          args: [
            this.launcherPath,
            "--sbx",
            this.client.executable,
            "--name",
            current.displayName,
            "--id",
            current.environmentId as string,
            "--agent",
            this.executionProfile.nativeAgent,
            "--command",
            Buffer.from(JSON.stringify(requested)).toString("base64"),
          ],
          cwd: resolve(this.options.dataRoot),
          environment: {},
          io: "pty",
          provenance: {
            kind: "execution_environment",
            ref: refFor(current),
            profile: {
              id: current.profileId,
              digest: current.profileDigest,
            },
          },
        } satisfies HostLaunchDescriptor;
      },
      exec: async (command) => {
        validateCommand(command);
        const current = await this.requireUsableLease(record, "exec");
        try {
          return await this.client.exec(
            current.displayName,
            withDefaultCwd(command),
            { allowNonZero: true },
          );
        } catch (error) {
          throw normalize(error, "exec");
        }
      },
      workerExec: async (command) => {
        validateCommand(command);
        const current = await this.requireUsableLease(record, "exec");
        try {
          return await this.client.exec(
            current.displayName,
            withDefaultCwd(command),
            { allowNonZero: true, user: "root" },
          );
        } catch (error) {
          throw normalize(error, "exec");
        }
      },
      writeFile: async (input) => {
        validateFileWrite(input);
        return this.writeLeaseFile(record, input);
      },
      readFile: async (input) => {
        validateFileRead(input);
        return this.readLeaseFile(record, input);
      },
    };
  }

  private async writeLeaseFile(
    leased: DurableEnvironmentRecord,
    input: EnvironmentFileWrite,
  ): Promise<{ path: string; byteLength: number; sha256: string }> {
    const current = await this.requireUsableLease(leased, "transfer");
    const expected = createHash("sha256").update(input.data).digest("hex");
    const directory = await this.transferDirectory();
    const localPath = join(directory, "payload");
    const guestTransferRoot = `${posix.dirname(SBX_GUEST_PATHS.state)}/.qe-transfers`;
    const guestStagingPath = `${guestTransferRoot}/${randomUUID()}`;
    try {
      await writeFile(localPath, input.data, { flag: "wx", mode: 0o600 });
      await this.client.exec(
        current.displayName,
        {
          executable: "/usr/bin/install",
          args: [
            "-d",
            "-m",
            "0700",
            "-o",
            "root",
            "-g",
            "root",
            guestTransferRoot,
          ],
        },
        { user: "root" },
      );
      await this.client.exec(
        current.displayName,
        {
          executable: "/usr/bin/python3",
          args: [
            "-c",
            "import os,pathlib; root=pathlib.Path(os.environ['QE_ROOT']); parent=pathlib.Path(os.environ['QE_PARENT']); rel=parent.relative_to(root); current=root\nfor part in rel.parts:\n current=current/part\n if current.is_symlink(): raise RuntimeError('transfer parent contains symlink')\n current.mkdir(mode=0o700,exist_ok=True)\n if not current.is_dir(): raise RuntimeError('transfer parent is not directory')",
          ],
          environment: {
            QE_PARENT: posix.dirname(input.path),
            QE_ROOT: transferPathRoot(input.path),
          },
        },
        { user: "root" },
      );
      await this.client.copyTo(
        current.displayName,
        localPath,
        guestStagingPath,
      );
      const verification = await this.client.exec(
        current.displayName,
        {
          executable: "/usr/bin/python3",
          args: [
            "-c",
            "import hashlib,json,os,pathlib,stat; src=pathlib.Path(os.environ['QE_STAGING']); p=pathlib.Path(os.environ['QE_PATH']); s=src.lstat(); ok=stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode); os.replace(src,p); os.chown(p,1000,1000); os.chmod(p,int(os.environ['QE_MODE'],8)); s=p.lstat(); print(json.dumps({'regular':ok and stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode),'size':s.st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()},separators=(',',':')))",
          ],
          environment: {
            QE_MODE: (input.mode ?? 0o600).toString(8),
            QE_PATH: input.path,
            QE_STAGING: guestStagingPath,
          },
        },
        { user: "root" },
      );
      const proof = parseTransferProof(verification.stdout);
      if (
        !proof.regular ||
        proof.size !== input.data.byteLength ||
        proof.sha256 !== expected
      )
        throw new EnvironmentBackendError(
          "environment_operation_failed",
          "SBX write transfer hash or file identity did not verify.",
          "transfer",
        );
      await this.requireUsableLease(leased, "transfer");
      return {
        path: input.path,
        byteLength: input.data.byteLength,
        sha256: expected,
      };
    } catch (error) {
      throw normalize(error, "transfer");
    } finally {
      await this.requireUsableLease(leased, "transfer")
        .then((exact) =>
          this.client.exec(
            exact.displayName,
            { executable: "/bin/rm", args: ["-f", guestStagingPath] },
            { user: "root", allowNonZero: true },
          ),
        )
        .catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async readLeaseFile(
    leased: DurableEnvironmentRecord,
    input: EnvironmentFileRead,
  ): Promise<Uint8Array> {
    const current = await this.requireUsableLease(leased, "transfer");
    const directory = await this.transferDirectory();
    const localPath = join(directory, "payload");
    try {
      const verification = await this.client.exec(
        current.displayName,
        {
          executable: "/usr/bin/python3",
          args: [
            "-c",
            "import hashlib,json,os,pathlib,stat; p=pathlib.Path(os.environ['QE_PATH']); s=p.lstat(); ok=stat.S_ISREG(s.st_mode) and not stat.S_ISLNK(s.st_mode); print(json.dumps({'regular':ok,'size':s.st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest() if ok else ''},separators=(',',':')))",
          ],
          environment: { QE_PATH: input.path },
        },
        { user: "root" },
      );
      const proof = parseTransferProof(verification.stdout);
      if (!proof.regular || proof.size > input.maxBytes)
        throw new EnvironmentBackendError(
          "environment_operation_failed",
          proof.regular
            ? `Environment file exceeds the ${input.maxBytes}-byte transfer bound.`
            : "SBX read transfer source is not a regular file.",
          "transfer",
        );
      await this.client.copyFrom(current.displayName, input.path, localPath);
      const data = new Uint8Array(await readFile(localPath));
      const actual = createHash("sha256").update(data).digest("hex");
      if (data.byteLength !== proof.size || actual !== proof.sha256)
        throw new EnvironmentBackendError(
          "environment_operation_failed",
          "SBX read transfer changed during copy or failed hash verification.",
          "transfer",
        );
      await this.requireUsableLease(leased, "transfer");
      return data;
    } catch (error) {
      throw normalize(error, "transfer");
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }

  private async transferDirectory(): Promise<string> {
    const root = join(resolve(this.options.dataRoot), "environment-transfers");
    await mkdir(root, { recursive: true, mode: 0o700 });
    return mkdtemp(join(root, "transfer-"));
  }

  private async requireUsableLease(
    leased: DurableEnvironmentRecord,
    operation: Extract<
      EnvironmentBackendOperation,
      "launcher" | "exec" | "transfer"
    >,
  ): Promise<DurableEnvironmentRecord> {
    const ref = refFor(leased);
    const current = this.requireCurrentRef(ref, operation);
    if (current.state !== "running")
      throw new EnvironmentBackendError(
        "environment_not_usable",
        `Environment is ${current.state}.`,
        operation,
      );
    const sandbox = await this.requireExactSandbox(current, operation);
    if (sandbox.status !== "running") {
      this.store.markState(
        current.recordId,
        sandbox.status === "stopped" ? "stopped" : "degraded",
        [
          {
            code: "environment_not_usable",
            message: `SBX environment is ${sandbox.status}; recover it before execution.`,
          },
        ],
      );
      throw new EnvironmentBackendError(
        "environment_not_usable",
        `SBX environment is ${sandbox.status}; recover it before execution.`,
        operation,
      );
    }
    return current;
  }

  private async startIfStopped(
    record: DurableEnvironmentRecord,
    sandbox: SbxSandboxSummary,
    operation: EnvironmentBackendOperation,
  ): Promise<SbxSandboxSummary> {
    if (sandbox.status === "running") return sandbox;
    if (sandbox.status !== "stopped")
      throw unhealthy(
        `SBX environment is ${sandbox.status}, not recoverable stopped state.`,
        operation,
      );
    try {
      await this.client.exec(record.displayName, {
        executable: "/usr/bin/true",
        args: [],
        timeoutMs: 60_000,
      });
    } catch (error) {
      throw normalize(error, operation);
    }
    const running = await this.pollSandbox(record, "running", operation);
    if (!running || running.status !== "running")
      throw unhealthy("Stopped SBX environment did not restart.", operation);
    return running;
  }

  private async requireExactSandbox(
    record: DurableEnvironmentRecord,
    operation: EnvironmentBackendOperation,
  ): Promise<SbxSandboxSummary> {
    let sandboxes: SbxSandboxSummary[];
    try {
      sandboxes = await this.client.list();
    } catch (error) {
      throw normalize(error, operation);
    }
    const identity = locateSandbox(
      record,
      sandboxes,
      this.executionProfile.nativeAgent,
    );
    if (identity.kind === "missing") {
      this.store.markState(record.recordId, "missing", [
        {
          code: "environment_not_found",
          message:
            "Durable environment record has no physical SBX environment.",
        },
      ]);
      throw new EnvironmentBackendError(
        "environment_not_found",
        "Durable environment record has no physical SBX environment.",
        operation,
      );
    }
    if (identity.kind === "mismatch")
      throw identityMismatch(identity.message, operation);
    return identity.sandbox;
  }

  private requireCurrentRef(
    ref: EnvironmentRef,
    operation: EnvironmentBackendOperation,
  ): DurableEnvironmentRecord {
    if (ref.backendKind !== this.kind || ref.workerId !== this.options.workerId)
      throw new EnvironmentBackendError(
        "invalid_environment_ref",
        "Environment ref does not belong to this SBX Worker backend.",
        operation,
      );
    const historical = this.store.byRef(ref);
    const current = this.store.current(this.kind, ref.workerId, ref.runId);
    if (!historical)
      throw new EnvironmentBackendError(
        current ? "stale_environment_ref" : "environment_not_found",
        "Environment ref is unknown or stale.",
        operation,
      );
    if (
      historical.retiredAt ||
      !current ||
      historical.recordId !== current.recordId ||
      historical.profileId !== ref.profile.id ||
      historical.profileDigest !== ref.profile.digest
    )
      throw new EnvironmentBackendError(
        "stale_environment_ref",
        "Environment ref is not the current Run incarnation.",
        operation,
      );
    return current;
  }

  private assertRecordSpec(
    record: DurableEnvironmentRecord,
    spec: EnvironmentSpec,
    digest: string,
    operation: EnvironmentBackendOperation,
  ): void {
    if (
      record.workerId !== spec.workerId ||
      record.runId !== spec.runId ||
      record.profileId !== spec.profile.id ||
      record.profileDigest !== spec.profile.digest ||
      record.specDigest !== digest
    )
      throw new EnvironmentBackendError(
        "environment_spec_mismatch",
        "Current Run environment does not match the exact requested spec/profile.",
        operation,
      );
  }

  private validateSpec(
    spec: EnvironmentSpec,
    operation: EnvironmentBackendOperation,
  ): void {
    if (spec.workerId !== this.options.workerId)
      throw new EnvironmentBackendError(
        "invalid_environment_spec",
        `SBX backend belongs to Worker ${this.options.workerId}.`,
        operation,
      );
    if (
      spec.profile.id !== this.profile.id ||
      spec.profile.digest !== this.profile.digest
    )
      throw new EnvironmentBackendError(
        "environment_spec_mismatch",
        "Environment profile does not match qe-execution-v1.",
        operation,
      );
    if (
      spec.resourcePolicy.id !== this.resourcePolicy.identity.id ||
      spec.resourcePolicy.digest !== this.resourcePolicy.identity.digest
    )
      throw new EnvironmentBackendError(
        "environment_spec_mismatch",
        "Resource policy is not the pinned Phase-2 SBX policy.",
        operation,
      );
    if (
      spec.workspace.materialization.kind !== "disposable_fixture" &&
      spec.workspace.materialization.kind !== "frozen_import"
    )
      throw new EnvironmentBackendError(
        "environment_spec_mismatch",
        "SBX supports disposable fixtures and Worker-controlled frozen imports only.",
        operation,
      );
    if (this.executionProfile.credentialMode === "none") {
      if (
        spec.credentialGrants.length > 0 ||
        spec.networkRequirements.length > 0 ||
        spec.controlChannels.length > 0
      )
        throw new EnvironmentBackendError(
          "environment_requirements_unmet",
          "The shell SBX profile does not materialize credentials, egress grants, or control channels.",
          operation,
        );
      return;
    }
    const providerTargets = spec.networkRequirements
      .filter((requirement) => requirement.capability === "model_provider")
      .flatMap((requirement) => [...requirement.targets])
      .sort();
    const expectedTargets = [...SBX_PI_RUNTIME_NETWORK_TARGETS].sort();
    const exactProviderNetwork =
      spec.networkRequirements.length === 1 &&
      providerTargets.length === expectedTargets.length &&
      providerTargets.every(
        (target, index) => target === expectedTargets[index],
      );
    const exactCredential =
      spec.credentialGrants.length === 1 &&
      spec.credentialGrants[0]?.kind === "openai-codex-oauth" &&
      spec.credentialGrants[0]?.scope === "subscription";
    const exactControl =
      spec.controlChannels.length === 1 &&
      spec.controlChannels[0]?.kind === "worker_file_mailbox_v1" &&
      spec.controlChannels[0]?.required === true;
    if (!exactProviderNetwork || !exactCredential || !exactControl)
      throw new EnvironmentBackendError(
        "environment_requirements_unmet",
        "Pi SBX requires exact OpenAI subscription egress, one opaque OAuth grant, and the attempt-scoped Worker mailbox relay.",
        operation,
      );
  }

  private assertCapabilities(
    spec: EnvironmentSpec,
    capabilities: readonly EnvironmentCapability[],
    operation: EnvironmentBackendOperation,
  ): void {
    const missing = spec.requiredCapabilities.filter(
      (requirement) =>
        !capabilities.some(
          (capability) =>
            capability.kind === requirement.kind &&
            capability.mode === requirement.mode,
        ),
    );
    if (missing.length > 0)
      throw new EnvironmentBackendError(
        "environment_requirements_unmet",
        `Verified SBX environment lacks ${missing
          .map((item) => `${item.kind}:${item.mode}`)
          .join(", ")}.`,
        operation,
      );
  }

  private async requireReadiness(
    operation: EnvironmentBackendOperation,
  ): Promise<EnvironmentReadiness> {
    const readiness = await this.readiness();
    if (!readiness.ready)
      throw new EnvironmentBackendError(
        readiness.status === "incompatible"
          ? "backend_incompatible"
          : "backend_unavailable",
        readiness.diagnostics.map((item) => item.message).join(" "),
        operation,
      );
    return readiness;
  }

  private async requireNativeVersion(
    operation: EnvironmentBackendOperation,
  ): Promise<SbxNativeVersion> {
    try {
      const native = await this.client.version();
      if (
        native.serverState !== "running" ||
        !native.apiVersion ||
        !native.serverVersion ||
        !native.serverRevision
      )
        throw new EnvironmentBackendError(
          "backend_unavailable",
          "SBX daemon provenance is unavailable.",
          operation,
        );
      return native;
    } catch (error) {
      throw normalize(error, operation);
    }
  }

  private persistVerificationFailure(
    record: DurableEnvironmentRecord,
    error: unknown,
  ): void {
    const identityConflict =
      error instanceof EnvironmentBackendError &&
      (error.code === "environment_identity_mismatch" ||
        error.code === "environment_requirements_unmet" ||
        error.code === "environment_spec_mismatch");
    this.store.markState(
      record.recordId,
      identityConflict ? "incompatible" : "degraded",
      [
        {
          code:
            error instanceof EnvironmentBackendError
              ? error.code
              : "environment_unhealthy",
          message: errorMessage(error),
        },
      ],
    );
  }

  private persistVerification(
    record: DurableEnvironmentRecord,
    verified: SbxVerifiedEnvironment,
    native: SbxNativeVersion,
    state: "running" | "stopped",
  ): DurableEnvironmentRecord {
    return this.store.markVerified({
      recordId: record.recordId,
      state,
      markerDigest: verified.markerDigest,
      capabilities: verified.capabilities,
      diagnostics: verified.diagnostics,
      nativeVersion: native.clientVersion,
      nativeRevision: native.clientRevision,
      nativeApiVersion: native.apiVersion as string,
    });
  }

  private inspection(
    record: DurableEnvironmentRecord,
    usable: boolean,
    state: EnvironmentInspection["state"],
    native: SbxNativeVersion | null,
  ): EnvironmentInspection {
    return {
      ref: refFor(record),
      state,
      usable,
      specDigest: record.specDigest,
      paths: { ...SBX_GUEST_PATHS },
      capabilities: record.capabilities.map((item) => ({ ...item })),
      specMatches: state !== "incompatible",
      profileMatches:
        record.profileId === this.profile.id &&
        record.profileDigest === this.profile.digest,
      diagnostics: record.diagnostics.map((item) => ({ ...item })),
      provenance: {
        implementationVersion: "sbx-environment-backend-v1",
        ...(native?.clientVersion
          ? { nativeVersion: native.clientVersion }
          : record.nativeVersion
            ? { nativeVersion: record.nativeVersion }
            : {}),
        ...(native?.clientRevision
          ? { nativeRevision: native.clientRevision }
          : record.nativeRevision
            ? { nativeRevision: record.nativeRevision }
            : {}),
        ...(native?.apiVersion
          ? { nativeApiVersion: native.apiVersion }
          : record.nativeApiVersion
            ? { nativeApiVersion: record.nativeApiVersion }
            : {}),
        profile: { id: record.profileId, digest: record.profileDigest },
      },
    };
  }

  private async findUnboundSandbox(
    record: DurableEnvironmentRecord,
  ): Promise<SbxSandboxSummary | null> {
    let sandboxes: SbxSandboxSummary[];
    try {
      sandboxes = await this.client.list();
    } catch (error) {
      throw normalize(error, "ensure");
    }
    const matches = sandboxes.filter(
      (sandbox) => sandbox.name === record.displayName,
    );
    if (matches.length > 1)
      throw identityMismatch(
        "Multiple SBX environments share the deterministic QE name.",
        "ensure",
      );
    return matches[0] ?? null;
  }

  private async pollUnboundSandbox(
    record: DurableEnvironmentRecord,
  ): Promise<SbxSandboxSummary | null> {
    for (let attempt = 0; attempt < this.reconciliationAttempts; attempt += 1) {
      const found = await this.findUnboundSandbox(record);
      if (found) return found;
      await Bun.sleep(this.reconciliationPollMs);
    }
    return null;
  }

  private async pollSandbox(
    record: DurableEnvironmentRecord,
    target: "running" | "stopped",
    operation: EnvironmentBackendOperation,
  ): Promise<SbxSandboxSummary | null> {
    for (let attempt = 0; attempt < this.reconciliationAttempts; attempt += 1) {
      let identity: LocatedSandbox;
      try {
        identity = locateSandbox(
          record,
          await this.client.list(),
          this.executionProfile.nativeAgent,
        );
      } catch (error) {
        throw normalize(error, operation);
      }
      if (identity.kind === "mismatch")
        throw identityMismatch(identity.message, operation);
      if (identity.kind === "exact" && identity.sandbox.status === target)
        return identity.sandbox;
      await Bun.sleep(this.reconciliationPollMs);
    }
    return null;
  }

  private async waitForPhysicalBinding(
    record: DurableEnvironmentRecord,
  ): Promise<DurableEnvironmentRecord | null> {
    for (let attempt = 0; attempt < this.ownerWaitAttempts; attempt += 1) {
      const current = this.store.current(
        this.kind,
        record.workerId,
        record.runId,
      );
      if (!current || current.recordId !== record.recordId) return null;
      if (current.environmentId) return current;
      if (current.state !== "creating") return null;
      await Bun.sleep(this.reconciliationPollMs);
    }
    return null;
  }

  private async withOwner<T>(
    owner: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.ownerTails.get(owner) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
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

type LocatedSandbox =
  | { kind: "exact"; sandbox: SbxSandboxSummary }
  | { kind: "missing" }
  | { kind: "mismatch"; message: string };

function locateSandbox(
  record: DurableEnvironmentRecord,
  sandboxes: readonly SbxSandboxSummary[],
  expectedAgent = "shell",
): LocatedSandbox {
  const byId = record.environmentId
    ? sandboxes.find((sandbox) => sandbox.id === record.environmentId)
    : undefined;
  const byName = sandboxes.find(
    (sandbox) => sandbox.name === record.displayName,
  );
  if (!record.environmentId)
    return byName ? { kind: "exact", sandbox: byName } : { kind: "missing" };
  if (!byId && !byName) return { kind: "missing" };
  if (
    !byId ||
    !byName ||
    byId.id !== byName.id ||
    byId.name !== record.displayName ||
    byId.agent !== expectedAgent
  )
    return {
      kind: "mismatch",
      message: `SBX native ID, deterministic name, or ${expectedAgent}-agent identity conflicts with durable ownership.`,
    };
  return { kind: "exact", sandbox: byId };
}

function creationEnvironment(
  record: DurableEnvironmentRecord,
): Record<string, string> {
  return {
    ...SBX_DISABLED_CREDENTIAL_ENVIRONMENT,
    HOME: SBX_GUEST_PATHS.home,
    QE_ENVIRONMENT_INCARNATION: record.incarnation,
    QE_ENVIRONMENT_PROFILE_DIGEST: record.profileDigest,
    QE_ENVIRONMENT_SPEC_DIGEST: record.specDigest,
    QE_RUN_ID: record.runId,
    QE_WORKER_ID: record.workerId,
  };
}

function leaseEnvironment(
  record: DurableEnvironmentRecord,
): Record<string, string> {
  return {
    HOME: SBX_GUEST_PATHS.home,
    QE_ENVIRONMENT_ID: record.environmentId as string,
    QE_ENVIRONMENT_INCARNATION: record.incarnation,
    QE_ENVIRONMENT_PROFILE_DIGEST: record.profileDigest,
    QE_ENVIRONMENT_SPEC_DIGEST: record.specDigest,
    QE_RUN_ID: record.runId,
    QE_WORKER_ID: record.workerId,
  };
}

function refFor(record: DurableEnvironmentRecord): EnvironmentRef {
  if (!record.environmentId)
    throw new EnvironmentBackendError(
      "environment_creation_ambiguous",
      "Environment creation intent has no physical identity.",
    );
  return {
    backendKind: "sbx",
    environmentId: record.environmentId,
    incarnation: record.incarnation,
    workerId: record.workerId,
    runId: record.runId,
    profile: { id: record.profileId, digest: record.profileDigest },
  };
}

export function sbxEnvironmentName(workerId: string, runId: string): string {
  const readable =
    runId
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 24) || "run";
  const hash = createHash("sha256")
    .update(`${workerId}\0${runId}`)
    .digest("hex")
    .slice(0, 12);
  return `qe-run-${readable}-${hash}`;
}

function ownerKey(workerId: string, runId: string): string {
  return `${workerId}\0${runId}`;
}

function withDefaultCwd(command: EnvironmentCommand): EnvironmentCommand {
  return {
    executable: command.executable,
    args: [...command.args],
    cwd: command.cwd ?? SBX_GUEST_PATHS.workspace,
    ...(command.environment ? { environment: { ...command.environment } } : {}),
    ...(command.timeoutMs ? { timeoutMs: command.timeoutMs } : {}),
  };
}

function validateCommand(command: EnvironmentCommand): void {
  if (!command.executable || !Array.isArray(command.args))
    throw new EnvironmentBackendError(
      "operation_failed",
      "Structured environment command is invalid.",
    );
  if (
    command.timeoutMs !== undefined &&
    (!Number.isSafeInteger(command.timeoutMs) || command.timeoutMs < 1)
  )
    throw new EnvironmentBackendError(
      "operation_failed",
      "Environment command timeout must be a positive integer.",
    );
}

function validateFileWrite(input: EnvironmentFileWrite): void {
  validateTransferPath(input.path);
  if (
    !(input.data instanceof Uint8Array) ||
    input.data.byteLength > MAX_ENVIRONMENT_FILE_BYTES
  )
    throw new EnvironmentBackendError(
      "operation_failed",
      `Environment transfer data must be bytes no larger than ${MAX_ENVIRONMENT_FILE_BYTES}.`,
      "transfer",
    );
  if (
    input.mode !== undefined &&
    (!Number.isSafeInteger(input.mode) || input.mode < 0 || input.mode > 0o777)
  )
    throw new EnvironmentBackendError(
      "operation_failed",
      "Environment transfer mode is invalid.",
      "transfer",
    );
}

function validateFileRead(input: EnvironmentFileRead): void {
  validateTransferPath(input.path);
  if (
    !Number.isSafeInteger(input.maxBytes) ||
    input.maxBytes < 0 ||
    input.maxBytes > MAX_ENVIRONMENT_FILE_BYTES
  )
    throw new EnvironmentBackendError(
      "operation_failed",
      "Environment transfer bound is invalid.",
      "transfer",
    );
}

function validateTransferPath(path: string): void {
  const normalized = posix.normalize(path);
  const contained = Object.values(SBX_GUEST_PATHS).some(
    (root) => normalized.startsWith(`${root}/`) && normalized !== root,
  );
  if (!posix.isAbsolute(path) || normalized !== path || !contained)
    throw new EnvironmentBackendError(
      "operation_failed",
      "Environment transfer path is outside the canonical lease path map.",
      "transfer",
    );
}

function transferPathRoot(path: string): string {
  const matches = Object.values(SBX_GUEST_PATHS)
    .filter((root) => path.startsWith(`${root}/`))
    .sort((left, right) => right.length - left.length);
  const root = matches[0];
  if (!root)
    throw new EnvironmentBackendError(
      "operation_failed",
      "Environment transfer path has no canonical root.",
      "transfer",
    );
  return root;
}

function parseTransferProof(value: string): {
  regular: boolean;
  size: number;
  sha256: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new EnvironmentBackendError(
      "operation_failed",
      "SBX transfer proof was malformed.",
      "transfer",
    );
  const proof = parsed as Record<string, unknown>;
  if (
    typeof proof.regular !== "boolean" ||
    typeof proof.size !== "number" ||
    !Number.isSafeInteger(proof.size) ||
    proof.size < 0 ||
    typeof proof.sha256 !== "string"
  )
    throw new EnvironmentBackendError(
      "operation_failed",
      "SBX transfer proof fields were malformed.",
      "transfer",
    );
  return {
    regular: proof.regular,
    size: proof.size,
    sha256: proof.sha256,
  };
}

function normalize(
  error: unknown,
  operation: EnvironmentBackendOperation,
): EnvironmentBackendError {
  if (error instanceof EnvironmentBackendError)
    return error.operation
      ? error
      : new EnvironmentBackendError(error.code, error.message, operation);
  if (error instanceof SbxClientError) {
    const code =
      error.code === "operation_timeout"
        ? "operation_timeout"
        : error.code === "malformed_backend_response"
          ? "backend_incompatible"
          : "operation_failed";
    return new EnvironmentBackendError(code, error.message, operation);
  }
  return new EnvironmentBackendError(
    "operation_failed",
    errorMessage(error),
    operation,
  );
}

function assertReadinessProvenance(
  readiness: EnvironmentReadiness,
  native: SbxNativeVersion,
  operation: EnvironmentBackendOperation,
): void {
  if (
    readiness.provenance.nativeVersion !== native.clientVersion ||
    readiness.provenance.nativeRevision !== native.clientRevision ||
    readiness.provenance.nativeApiVersion !== native.apiVersion
  )
    throw new EnvironmentBackendError(
      "backend_unavailable",
      "SBX native provenance changed during the readiness operation.",
      operation,
    );
}

function identityMismatch(
  message: string,
  operation: EnvironmentBackendOperation,
): EnvironmentBackendError {
  return new EnvironmentBackendError(
    "environment_identity_mismatch",
    message,
    operation,
  );
}

function unhealthy(
  message: string,
  operation: EnvironmentBackendOperation,
): EnvironmentBackendError {
  return new EnvironmentBackendError(
    "environment_unhealthy",
    message,
    operation,
  );
}

function processAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
