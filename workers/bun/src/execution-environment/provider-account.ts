import { createHash, randomUUID } from "node:crypto";
import type { WorkerConfig } from "../config.ts";
import {
  authenticationInspection,
  CLAUDE_SUBSCRIPTION_CONFIGURATION,
  classifyClaudeSubscriptionAuthStatus,
  claudeSubscriptionEnvironment,
  FAKE_PROVIDER_AUTH_CONFIGURATION,
  isProviderAuthenticationLoginEligible,
  type ProviderAuthenticationEvidenceContext,
  type ProviderAuthenticationInspection,
  type ProviderAuthenticationMethod,
  type ProviderAuthenticationState,
  unavailableProviderAuthenticationInspection,
} from "../provider-auth.ts";
import { FakeStreamedProcessTransport } from "./fake.ts";
import { providerAccountOwner, sameEnvironmentOwner } from "./ownership.ts";
import {
  assertTrustedSetupLaunchAuthority,
  immutableSetupLaunchSpec,
  type ProviderAccountSetupLaunchAuthority,
  type ProviderAccountSetupLauncher,
  type ProviderAccountSetupLaunchSpec,
  prepareClaudeAccountDirectories,
  setupLaunchAuthority,
} from "./provider-account-setup-launcher.ts";
import { SbxExecutionEnvironmentBackend } from "./sbx-backend.ts";
import {
  SBX_CLAUDE_ACCOUNT_PROFILE,
  SBX_CLAUDE_ACCOUNT_PROFILE_V1,
  SBX_CLAUDE_EXECUTABLE,
  SBX_DISPOSABLE_RESOURCE_POLICY,
  SBX_SHELL_PROFILE,
} from "./sbx-profile.ts";
import {
  type DurableEnvironmentRecord,
  ExecutionEnvironmentStore,
} from "./store.ts";
import { StreamedProcessManager } from "./streamed-process.ts";
import type {
  EnvironmentLease,
  EnvironmentOwner,
  EnvironmentRef,
  ExecutionEnvironmentBackend,
  ProviderAccountEnvironmentSpec,
  StreamedProcess,
  StreamedProcessCancellationReceipt,
  StreamedProcessHandle,
  StreamedProcessReconciliation,
} from "./types.ts";
import { EnvironmentBackendError } from "./types.ts";
import { networkIsolatedWorkspaceToolCommand } from "./workspace-tool-network.ts";

const CANARY_FILENAME = "provider-account-canary-v1";
const BROKER_SECURITY_CANARY_FILENAME =
  "workspace-tool-broker-security-canary-v1";
export const WORKSPACE_TOOL_BROKER_ACCOUNT_CANARY =
  "QE_ACCOUNT_CELL_SECRET_CANARY_DO_NOT_EXPOSE";
const FAKE_ACCOUNT_BROKER_CLIENT_PROGRAM = [
  "import json,sys",
  "for line in sys.stdin:",
  " try: message=json.loads(line)",
  " except Exception: sys.exit(21)",
  " if message.get('type')=='drive' and set(message)=={'type','request'}:",
  "  request=message['request']",
  "  sys.stdout.write(json.dumps(request,separators=(',',':'))+'\\n');sys.stdout.flush()",
  " elif message.get('type')=='result' and set(message)=={'type','response'}:",
  "  response=message['response']",
  "  ack={'type':'client_received','request_id':response.get('request_id')}",
  "  sys.stdout.write(json.dumps(ack,separators=(',',':'))+'\\n');sys.stdout.flush()",
  " elif message.get('type')=='close': sys.exit(0)",
  " else: sys.exit(22)",
].join("\n");
export interface ProviderAccountSetupRuntimeIdentity {
  setupAttemptId: string;
  setupGeneration: number;
  authorizationId: string;
  providerAccountId: string;
  providerKey: string;
  credentialGeneration: number;
  environmentGeneration: number;
  environmentOperationId: string;
  workerGeneration: number;
  backendKind: string;
  environmentId: string;
  environmentIncarnation: string;
  setupLaunchAuthority: ProviderAccountSetupLaunchAuthority | null;
  expectedAuthentication: {
    state: "authentication_required";
    method: "none";
    configurationIdentity: string;
    environmentPolicy: string;
    evidenceIdentity: string;
  };
}

export interface ClaudeCodeAccountRuntime {
  lease: EnvironmentLease;
  ref: EnvironmentRef;
  configRoot: string;
  cwd: string;
  assertCurrent(): void;
}

export type ProviderAccountEnvironmentDesiredState =
  | "available"
  | "stopped"
  | "removed";

export interface ProviderAccountEnvironmentCommand {
  providerAccountId: string;
  providerKey: string;
  credentialGeneration: number;
  workerGeneration: number;
  operationId: string;
  desiredState: ProviderAccountEnvironmentDesiredState;
  expectedPhysicalIdentity: {
    backendKind: string;
    environmentId: string;
    incarnation: string;
  } | null;
}

/** Durable setup authority that fences destructive account-environment changes. */
export interface ActiveProviderAccountSetupFence {
  setupAttemptId: string;
  providerAccountId: string;
  credentialGeneration: number;
  backendKind: string;
  environmentId: string;
  environmentIncarnation: string;
}

export interface ProviderAccountAuthenticationReport {
  state: ProviderAuthenticationState;
  method: ProviderAuthenticationMethod | null;
  configurationIdentity: string;
  environmentPolicy: string;
  evidenceIdentity: string;
  inspectedAt: string;
}

export interface ProviderAccountEnvironmentReport {
  providerAccountId: string;
  credentialGeneration: number;
  workerGeneration: number;
  operationId: string;
  physicalState:
    | "pending"
    | "available"
    | "stopped"
    | "missing"
    | "degraded"
    | "removing"
    | "removed";
  eventType:
    | "environment_ensured"
    | "environment_stopped"
    | "environment_removed"
    | "environment_missing"
    | "environment_degraded"
    | "environment_reconciled"
    | "canary_written"
    | "canary_read";
  backendKind: string | null;
  environmentId: string | null;
  incarnation: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  observedAt: string;
  canaryPersisted: boolean;
  authentication: ProviderAccountAuthenticationReport | null;
}

export interface ProviderAccountEnvironmentManagerOptions {
  backend?: ExecutionEnvironmentBackend;
  store?: ExecutionEnvironmentStore;
  fake?: boolean;
  clock?: () => Date;
  /** Required trusted composition authority; null is valid only for the in-memory fake backend. */
  setupLauncher: ProviderAccountSetupLauncher | null;
  fakeAuthentication?: (
    identity: ProviderAccountSetupRuntimeIdentity | null,
  ) => {
    state: ProviderAuthenticationState;
    method: ProviderAuthenticationMethod | null;
  };
}

/**
 * Owns Phase-A ProviderAccount cells independently of Runs.
 *
 * Reconciliation and inspection are credential-free. Explicit setup may launch
 * provider login only after fresh exact preflight and durable intent; this
 * manager never authorizes inference.
 */
export class ProviderAccountEnvironmentManager {
  private readonly store: ExecutionEnvironmentStore;
  private readonly backend: ExecutionEnvironmentBackend | null;
  private readonly fake: boolean;
  private readonly clock: () => Date;
  private readonly setupLauncher: ProviderAccountSetupLauncher | null;
  private readonly latestReports = new Map<
    string,
    ProviderAccountEnvironmentReport
  >();
  private readonly accountTails = new Map<string, Promise<void>>();
  private readonly fakeAuthenticatedEnvironments = new Set<string>();
  private readonly fakeAuthentication:
    | ProviderAccountEnvironmentManagerOptions["fakeAuthentication"]
    | null;
  private readonly fakeSetupProcesses: StreamedProcessManager;
  private activeSetupLookup:
    | ((providerAccountId: string) => ActiveProviderAccountSetupFence | null)
    | null = null;
  private closed = false;

  constructor(
    private readonly config: Pick<
      WorkerConfig,
      "workerId" | "dataRoot" | "provider"
    >,
    options: ProviderAccountEnvironmentManagerOptions,
  ) {
    this.store =
      options.store ?? new ExecutionEnvironmentStore(config.dataRoot);
    this.fake = options.fake ?? config.provider === "fake";
    this.setupLauncher = options.setupLauncher;
    if (this.fake && this.setupLauncher !== null)
      throw new Error(
        "The in-memory fake ProviderAccount backend cannot use a physical setup launcher.",
      );
    if (!this.fake && this.setupLauncher === null)
      throw new Error(
        "A physical ProviderAccount backend requires an explicit trusted setup launcher.",
      );
    this.backend =
      options.backend ??
      (this.fake
        ? null
        : new SbxExecutionEnvironmentBackend({
            workerId: config.workerId,
            dataRoot: config.dataRoot,
            store: this.store,
            executionProfile: SBX_CLAUDE_ACCOUNT_PROFILE,
            resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY,
          }));
    this.clock = options.clock ?? (() => new Date());
    this.fakeAuthentication = options.fakeAuthentication ?? null;
    this.fakeSetupProcesses = new StreamedProcessManager({
      backendKind: "fake-account",
      validate: (ref) => {
        const record = this.store.byRef(ref);
        if (!record || record.retiredAt || record.state !== "running")
          throw new EnvironmentBackendError(
            "stale_environment_ref",
            "The fake ProviderAccount environment is not available.",
          );
      },
    });
  }

  async apply(
    command: ProviderAccountEnvironmentCommand,
  ): Promise<ProviderAccountEnvironmentReport> {
    this.validateCommand(command);
    return this.withAccount(command.providerAccountId, async () => {
      const environment = await this.applySafely(command);
      const report = await this.withAuthenticationInspection(
        command,
        environment,
      );
      this.latestReports.set(command.providerAccountId, report);
      return report;
    });
  }

  /**
   * Binds the setup coordinator's durable active-attempt predicate. This is a
   * Worker-local defense in depth; it is not a selectable launch policy.
   */
  registerActiveSetupLookup(
    lookup: (
      providerAccountId: string,
    ) => ActiveProviderAccountSetupFence | null,
  ): () => void {
    if (this.activeSetupLookup)
      throw new Error(
        "ProviderAccount active setup authority is already registered.",
      );
    this.activeSetupLookup = lookup;
    return () => {
      if (this.activeSetupLookup === lookup) this.activeSetupLookup = null;
    };
  }

  async reconcile(
    desired: readonly ProviderAccountEnvironmentCommand[],
  ): Promise<ProviderAccountEnvironmentReport[]> {
    const desiredKeys = new Set(
      desired.map((command) =>
        ownerKey(
          providerAccountOwner(
            command.providerAccountId,
            command.credentialGeneration,
          ),
        ),
      ),
    );
    const desiredGenerations = new Map(
      desired.map((command) => [
        command.providerAccountId,
        command.credentialGeneration,
      ]),
    );
    const reports: ProviderAccountEnvironmentReport[] = [];

    for (const record of this.accountRecords()) {
      const desiredGeneration = desiredGenerations.get(
        record.owner.providerAccountId,
      );
      if (
        record.retiredAt ||
        desiredKeys.has(ownerKey(record.owner)) ||
        (desiredGeneration !== undefined &&
          record.owner.credentialGeneration > desiredGeneration)
      )
        continue;
      await this.withAccount(record.owner.providerAccountId, async () => {
        const current = this.store
          .list()
          .find((candidate) => candidate.recordId === record.recordId);
        if (!current || current.retiredAt) return;
        if (current.owner.kind !== "provider_account")
          throw new EnvironmentBackendError(
            "invalid_environment_ref",
            "ProviderAccount reconciliation found a non-account owner.",
          );
        this.assertRecordNotOwnedByActiveSetup(current);
        await this.removeRecord(current);
      }).catch(() => undefined);
    }

    for (const command of desired) {
      const report = await this.apply(command);
      const reconciled = {
        ...report,
        eventType:
          report.physicalState === "degraded"
            ? ("environment_degraded" as const)
            : ("environment_reconciled" as const),
      };
      this.latestReports.set(command.providerAccountId, reconciled);
      reports.push(reconciled);
    }
    return reports;
  }

  reportsFor(
    desired: readonly ProviderAccountEnvironmentCommand[],
  ): ProviderAccountEnvironmentReport[] {
    return desired.map((command) => {
      const latest = this.latestReports.get(command.providerAccountId);
      if (
        latest?.credentialGeneration === command.credentialGeneration &&
        latest.workerGeneration === command.workerGeneration &&
        latest.operationId === command.operationId
      )
        return { ...latest };
      const owner = providerAccountOwner(
        command.providerAccountId,
        command.credentialGeneration,
      );
      const record =
        this.store.current("fake-account", this.config.workerId, owner) ??
        this.store.current("sbx", this.config.workerId, owner);
      return record
        ? record.environmentId
          ? this.recordReport(command, record, "environment_reconciled")
          : this.unboundRecordReport(command, record)
        : command.desiredState === "removed"
          ? this.emptyReport(command, "removed", "environment_removed")
          : this.emptyReport(command, "missing", "environment_missing");
    });
  }

  /**
   * Holds the account environment-operation lock only through the exact launch
   * transition. The caller must durably acknowledge and register supervision
   * in `acknowledgeSpawn` before this method releases the lock. Control-plane
   * reporting and the supervised process lifetime happen after release.
   */
  async beginSetupProcess(
    identity: ProviderAccountSetupRuntimeIdentity,
    beforeSpawn: (
      inspection: ProviderAuthenticationInspection,
      eligible: boolean,
      launchAuthority: ProviderAccountSetupLaunchAuthority | null,
    ) => Promise<void>,
    acknowledgeSpawn: (process: StreamedProcess) => Promise<void>,
  ): Promise<{
    inspection: ProviderAuthenticationInspection;
    process: StreamedProcess | null;
  }> {
    const release = await this.acquireAccountOperation(
      identity.providerAccountId,
    );
    let process: StreamedProcess | null = null;
    try {
      const record = this.setupRecord(identity);
      const inspection = await this.inspectAuthenticationForRecord(
        record,
        identity.providerKey,
        identity,
      );
      const expected = identity.expectedAuthentication;
      const eligible =
        isProviderAuthenticationLoginEligible(inspection) &&
        inspection.state === expected.state &&
        inspection.method === expected.method &&
        inspection.configuration.identity === expected.configurationIdentity &&
        inspection.configuration.environmentPolicy ===
          expected.environmentPolicy &&
        inspection.evidenceIdentity === expected.evidenceIdentity;
      const prepared = eligible
        ? await this.prepareSetupLaunch(identity, record)
        : null;
      await beforeSpawn(inspection, eligible, prepared?.authority ?? null);
      if (!eligible || !prepared) return { inspection, process: null };
      if (prepared.kind === "fake") {
        const paths = fakePaths(prepared.ref);
        process = await this.fakeSetupProcesses.spawn(
          prepared.ref,
          paths,
          prepared.spec.command,
          prepared.spec.options,
          async (context) =>
            new DeterministicFakeLoginTransport(
              context.processGeneration,
              identity.setupAttemptId,
              () =>
                this.fakeAuthenticatedEnvironments.add(
                  fakeAuthenticationIdentity(identity),
                ),
            ),
        );
      } else {
        await prepared.launcher.prepare(prepared.lease, prepared.spec);
        process = await prepared.lease.spawnStreamed(
          prepared.spec.command,
          prepared.spec.options,
        );
      }
      this.assertSetupProcessIdentity(
        prepared.kind === "fake" ? prepared.ref : prepared.lease.ref,
        process.handle,
        prepared.authority,
      );
      await acknowledgeSpawn(process);
      return { inspection, process };
    } catch (error) {
      // Never hold the account operation while fail-closed transport cleanup
      // waits for a process. A process not registered by the callback is not
      // allowed to continue detached.
      release();
      await process?.disconnect().catch(() => undefined);
      throw error;
    } finally {
      release();
    }
  }

  private async prepareSetupLaunch(
    identity: ProviderAccountSetupRuntimeIdentity,
    record: DurableEnvironmentRecord,
  ): Promise<
    | {
        kind: "fake";
        ref: EnvironmentRef;
        spec: ProviderAccountSetupLaunchSpec;
        authority: ProviderAccountSetupLaunchAuthority;
      }
    | {
        kind: "physical";
        lease: EnvironmentLease;
        launcher: ProviderAccountSetupLauncher;
        spec: ProviderAccountSetupLaunchSpec;
        authority: ProviderAccountSetupLaunchAuthority;
      }
  > {
    const ref = recordRef(record);
    if (this.fake) {
      const launcher = inMemoryFakeSetupLauncher(identity.providerKey);
      const paths = fakePaths(ref);
      const spec = launcher.specification({
        providerKey: identity.providerKey,
        paths,
      });
      return {
        kind: "fake",
        ref,
        spec,
        authority: setupLaunchAuthority(launcher, spec, paths),
      };
    }
    const launcher = this.requiredSetupLauncher();
    const lease = await (this.backend as ExecutionEnvironmentBackend).recover(
      ref,
      this.setupSpec(identity),
    );
    const spec = launcher.specification({
      providerKey: identity.providerKey,
      paths: lease.paths,
    });
    return {
      kind: "physical",
      lease,
      launcher,
      spec,
      authority: setupLaunchAuthority(launcher, spec, lease.paths),
    };
  }

  private async requireTrustedSetupLaunch(
    identity: ProviderAccountSetupRuntimeIdentity,
    record: DurableEnvironmentRecord,
  ): Promise<{
    authority: ProviderAccountSetupLaunchAuthority;
    lease: EnvironmentLease | null;
  }> {
    const ref = recordRef(record);
    if (this.fake) {
      const launcher = inMemoryFakeSetupLauncher(identity.providerKey);
      const paths = fakePaths(ref);
      const spec = launcher.specification({
        providerKey: identity.providerKey,
        paths,
      });
      const authority = setupLaunchAuthority(launcher, spec, paths);
      assertTrustedSetupLaunchAuthority(
        identity.setupLaunchAuthority,
        authority,
      );
      return { authority, lease: null };
    }
    const launcher = this.requiredSetupLauncher();
    const lease = await (this.backend as ExecutionEnvironmentBackend).recover(
      ref,
      this.setupSpec(identity),
    );
    const spec = launcher.specification({
      providerKey: identity.providerKey,
      paths: lease.paths,
    });
    const authority = setupLaunchAuthority(launcher, spec, lease.paths);
    assertTrustedSetupLaunchAuthority(identity.setupLaunchAuthority, authority);
    return { authority, lease };
  }

  private requiredSetupLauncher(): ProviderAccountSetupLauncher {
    if (!this.setupLauncher)
      throw new EnvironmentBackendError(
        "backend_incompatible",
        "The physical ProviderAccount setup launcher is unavailable.",
      );
    return this.setupLauncher;
  }

  private assertSetupProcessIdentity(
    ref: EnvironmentRef,
    handle: StreamedProcessHandle,
    authority: ProviderAccountSetupLaunchAuthority,
  ): void {
    if (
      !sameRefIdentity(handle.environment, ref) ||
      handle.executable !== authority.expectedExecutable ||
      handle.observedExecutable !== authority.expectedExecutable
    )
      throw new EnvironmentBackendError(
        "streamed_process_identity_mismatch",
        "ProviderAccount setup process does not match its environment and trusted launcher authority.",
      );
  }

  async workspaceToolBrokerAuthority(input: {
    providerAccountId: string;
    environmentGeneration: number;
    expected: {
      backendKind: string;
      environmentId: string;
      incarnation: string;
    };
  }): Promise<{
    ref: EnvironmentRef;
    spawnClient(
      sessionId: string,
      brokerGeneration: number,
    ): Promise<StreamedProcess>;
    assertCurrent(): void;
  }> {
    const owner = providerAccountOwner(
      input.providerAccountId,
      input.environmentGeneration,
    );
    const record =
      this.store.current("sbx", this.config.workerId, owner) ??
      this.store.current("fake-account", this.config.workerId, owner);
    if (
      !record ||
      record.retiredAt ||
      record.state !== "running" ||
      record.backendKind !== input.expected.backendKind ||
      record.environmentId !== input.expected.environmentId ||
      record.incarnation !== input.expected.incarnation
    )
      throw new EnvironmentBackendError(
        "stale_environment_ref",
        "ProviderAccount broker environment is stale.",
      );
    const ref = recordRef(record);
    const assertCurrent = () => {
      const current = this.store.byRef(ref);
      if (
        !current ||
        current.retiredAt ||
        current.state !== "running" ||
        current.incarnation !== ref.incarnation
      )
        throw new EnvironmentBackendError(
          "stale_environment_ref",
          "ProviderAccount broker environment was replaced.",
        );
    };
    return {
      ref,
      assertCurrent,
      spawnClient: async (_sessionId, _brokerGeneration) => {
        assertCurrent();
        if (this.fake)
          throw new EnvironmentBackendError(
            "streamed_process_unsupported",
            "The in-memory fake account environment cannot host the physical broker client.",
            "spawn_streamed",
            "not_submitted",
          );
        const lease = await (
          this.backend as ExecutionEnvironmentBackend
        ).recover(ref, this.specForOwner(owner));
        await lease.writeFile({
          path: `${lease.paths.state}/${BROKER_SECURITY_CANARY_FILENAME}`,
          data: new TextEncoder().encode(WORKSPACE_TOOL_BROKER_ACCOUNT_CANARY),
          mode: 0o600,
        });
        return lease.spawnStreamed(
          networkIsolatedWorkspaceToolCommand({
            executable: "/usr/bin/python3",
            args: ["-u", "-c", FAKE_ACCOUNT_BROKER_CLIENT_PROGRAM],
            cwd: lease.paths.state,
            environment: { QE_FAKE_BROKER_CLIENT: "1" },
          }),
          { bufferBytes: 384 * 1024, acknowledgementTimeoutMs: 5_000 },
        );
      },
    };
  }

  async reconcileSetupProcess(
    identity: ProviderAccountSetupRuntimeIdentity,
    handle: StreamedProcessHandle,
  ): Promise<StreamedProcessReconciliation> {
    const record = this.setupRecord(identity);
    const trusted = await this.requireTrustedSetupLaunch(identity, record);
    this.assertSetupProcessIdentity(
      recordRef(record),
      handle,
      trusted.authority,
    );
    const inspection = this.fake
      ? await this.fakeSetupProcesses.reconcile(handle)
      : await (trusted.lease as EnvironmentLease).reconcileStreamedProcess(
          handle,
        );
    this.assertSetupProcessIdentity(
      recordRef(record),
      inspection.handle,
      trusted.authority,
    );
    return inspection;
  }

  async cancelSetupProcess(
    identity: ProviderAccountSetupRuntimeIdentity,
    handle: StreamedProcessHandle,
    cancellationId: string,
  ): Promise<StreamedProcessCancellationReceipt> {
    const record = this.setupRecord(identity);
    const trusted = await this.requireTrustedSetupLaunch(identity, record);
    this.assertSetupProcessIdentity(
      recordRef(record),
      handle,
      trusted.authority,
    );
    if (this.fake) {
      const receipt = await this.fakeSetupProcesses.cancelAttached(
        handle,
        cancellationId,
      );
      if (receipt) return receipt;
      throw new EnvironmentBackendError(
        "streamed_process_gone",
        "The fake setup process is no longer attached.",
        "cancel_streamed",
      );
    }
    const backend = this.backend as ExecutionEnvironmentBackend;
    if (!backend.cancelStreamedProcess)
      throw new EnvironmentBackendError(
        "backend_incompatible",
        "The ProviderAccount backend cannot cancel an exact durable process identity.",
        "cancel_streamed",
      );
    return backend.cancelStreamedProcess(handle, cancellationId);
  }

  validateSetup(
    identity: ProviderAccountSetupRuntimeIdentity,
  ): Promise<ProviderAuthenticationInspection> {
    return this.withAccount(identity.providerAccountId, async () => {
      const record = this.setupRecord(identity);
      await this.requireTrustedSetupLaunch(identity, record);
      return this.inspectAuthenticationForRecord(
        record,
        identity.providerKey,
        identity,
      );
    });
  }

  private async inspectAuthenticationForRecord(
    record: DurableEnvironmentRecord,
    providerKey: string,
    identity: ProviderAccountSetupRuntimeIdentity | null,
  ): Promise<ProviderAuthenticationInspection> {
    const context = this.authenticationContext(record, providerKey);
    const inspectedAt = this.clock().toISOString();
    const overridden = this.fakeAuthentication?.(identity);
    if (overridden) {
      return authenticationInspection(
        overridden.state,
        overridden.method,
        context,
        inspectedAt,
        "Injected deterministic ProviderAccount authentication was inspected.",
      );
    }
    if (this.fake) {
      const authenticated = identity
        ? this.fakeAuthenticatedEnvironments.has(
            fakeAuthenticationIdentity(identity),
          )
        : false;
      const observed = authenticated
        ? {
            state: "authenticated" as const,
            method: "provider_account" as const,
          }
        : {
            state: "authentication_required" as const,
            method: "none" as const,
          };
      return authenticationInspection(
        observed.state,
        observed.method,
        context,
        inspectedAt,
        "Deterministic fake provider authentication was inspected.",
      );
    }
    if (providerKey !== "anthropic")
      return authenticationInspection(
        "incompatible_status",
        null,
        context,
        inspectedAt,
        "The ProviderAccount runtime does not support this provider authentication configuration.",
      );
    const ref = recordRef(record);
    try {
      const lease = await (this.backend as ExecutionEnvironmentBackend).recover(
        ref,
        this.specForOwner(
          ref.owner as Extract<EnvironmentOwner, { kind: "provider_account" }>,
        ),
      );
      const configRoot = `${lease.paths.state}/claude/config`;
      await prepareClaudeAccountDirectories(lease);
      const environment = claudeAccountEnvironment(configRoot);
      const result = await lease.exec({
        executable: "/usr/bin/env",
        args: [
          "-i",
          ...Object.entries(environment)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, value]) => `${name}=${value}`),
          SBX_CLAUDE_EXECUTABLE,
          "auth",
          "status",
        ],
        cwd: `${lease.paths.state}/claude/empty-cwd`,
        environment: {},
        timeoutMs: 30_000,
      });
      return classifyClaudeSubscriptionAuthStatus(
        result,
        configRoot,
        context,
        inspectedAt,
      );
    } catch {
      return unavailableProviderAuthenticationInspection(context, inspectedAt);
    }
  }

  async claudeCodeRuntime(input: {
    providerAccountId: string;
    credentialGeneration: number;
    expected: {
      backendKind: string;
      environmentId: string;
      incarnation: string;
    };
  }): Promise<ClaudeCodeAccountRuntime> {
    if (this.fake)
      throw new EnvironmentBackendError(
        "backend_incompatible",
        "The fake ProviderAccount boundary cannot run Claude Code.",
      );
    const owner = providerAccountOwner(
      input.providerAccountId,
      input.credentialGeneration,
    );
    const record = this.store.current("sbx", this.config.workerId, owner);
    if (
      !record ||
      record.retiredAt ||
      record.state !== "running" ||
      record.environmentId !== input.expected.environmentId ||
      record.incarnation !== input.expected.incarnation ||
      record.backendKind !== input.expected.backendKind ||
      record.profileId !== SBX_CLAUDE_ACCOUNT_PROFILE_V1.id ||
      record.profileDigest !== SBX_CLAUDE_ACCOUNT_PROFILE_V1.digest
    )
      throw new EnvironmentBackendError(
        "stale_environment_ref",
        "Claude ProviderAccount execution authority is stale.",
      );
    const ref = recordRef(record);
    const lease = await (this.backend as ExecutionEnvironmentBackend).recover(
      ref,
      this.specForOwner(owner),
    );
    const capabilities = new Set(
      lease.capabilities.map(
        (capability) => `${capability.kind}:${capability.mode}`,
      ),
    );
    for (const required of [
      "credentials:account_private_claude_oauth",
      "network_policy:anthropic_account_only",
      "harness_runtime:claude_code_managed_mod_v1",
      "control_channel:worker_account_mailbox_v1",
      "process.streamed:attached_only",
    ])
      if (!capabilities.has(required))
        throw new EnvironmentBackendError(
          "backend_incompatible",
          `Claude account runtime capability is missing: ${required}.`,
        );
    const configRoot = `${lease.paths.state}/claude/config`;
    const cwd = `${lease.paths.state}/claude/empty-cwd`;
    await prepareClaudeAccountDirectories(lease);
    const assertCurrent = () => {
      const current = this.store.byRef(ref);
      if (
        !current ||
        current.retiredAt ||
        current.state !== "running" ||
        current.incarnation !== ref.incarnation
      )
        throw new EnvironmentBackendError(
          "stale_environment_ref",
          "Claude ProviderAccount execution environment was replaced.",
        );
    };
    return { lease, ref, configRoot, cwd, assertCurrent };
  }

  withSerializedAccount<T>(
    providerAccountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.withAccount(providerAccountId, operation);
  }

  async retireSetupProcesses(
    identity: ProviderAccountSetupRuntimeIdentity,
  ): Promise<void> {
    const record = this.setupRecord(identity);
    await this.requireTrustedSetupLaunch(identity, record);
    if (this.fake) return;
    const ref = recordRef(record);
    await this.withAccount(identity.providerAccountId, async () => {
      await (
        this.backend as ExecutionEnvironmentBackend
      ).retireStreamedProcesses(ref);
    });
  }

  async retireClaudeAccountProcesses(ref: EnvironmentRef): Promise<void> {
    if (!this.backend || ref.owner.kind !== "provider_account")
      throw new EnvironmentBackendError(
        "invalid_environment_ref",
        "Claude account process retirement requires a physical ProviderAccount cell.",
      );
    await this.backend.retireStreamedProcesses(ref);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.fakeSetupProcesses.shutdown();
    if (this.backend) await this.backend.close?.();
    else this.store.close();
  }

  private async withAuthenticationInspection(
    command: ProviderAccountEnvironmentCommand,
    report: ProviderAccountEnvironmentReport,
  ): Promise<ProviderAccountEnvironmentReport> {
    if (
      command.desiredState !== "available" ||
      report.physicalState !== "available" ||
      !report.canaryPersisted
    )
      return { ...report, authentication: null };
    const record = this.currentRecord(command);
    if (!record || !record.environmentId)
      return { ...report, authentication: null };
    const inspection = await this.inspectAuthenticationForRecord(
      record,
      command.providerKey,
      null,
    );
    return {
      ...report,
      authentication: authenticationReport(inspection),
    };
  }

  private authenticationContext(
    record: DurableEnvironmentRecord,
    providerKey: string,
  ): ProviderAuthenticationEvidenceContext {
    if (record.owner.kind !== "provider_account" || !record.environmentId)
      throw new EnvironmentBackendError(
        "environment_identity_mismatch",
        "Provider authentication inspection requires an exact account environment.",
      );
    return {
      providerKey,
      owner: {
        kind: "provider_account",
        id: record.owner.providerAccountId,
        generation: record.owner.credentialGeneration,
      },
      backendKind: record.backendKind,
      environmentId: record.environmentId,
      environmentIncarnation: record.incarnation,
      profile: { id: record.profileId, digest: record.profileDigest },
      configuration: {
        ...(this.fake
          ? FAKE_PROVIDER_AUTH_CONFIGURATION
          : CLAUDE_SUBSCRIPTION_CONFIGURATION),
      },
    };
  }

  private async applySafely(
    command: ProviderAccountEnvironmentCommand,
  ): Promise<ProviderAccountEnvironmentReport> {
    try {
      this.assertExpectedPhysicalIdentity(command);
      const active =
        this.activeSetupLookup?.(command.providerAccountId) ?? null;
      if (active)
        return await this.reconcileActiveSetupEnvironment(command, active);
      if (command.desiredState === "available")
        await this.retireOtherGenerations(command);
      switch (command.desiredState) {
        case "available":
          return await this.ensure(command, "environment_ensured");
        case "stopped":
          return await this.stop(command);
        case "removed":
          return await this.remove(command);
      }
    } catch (error) {
      return this.failureReport(command, error);
    }
  }

  private async reconcileActiveSetupEnvironment(
    command: ProviderAccountEnvironmentCommand,
    active: ActiveProviderAccountSetupFence,
  ): Promise<ProviderAccountEnvironmentReport> {
    const expected = command.expectedPhysicalIdentity;
    if (
      command.desiredState !== "available" ||
      command.credentialGeneration !== active.credentialGeneration
    )
      throw new EnvironmentBackendError(
        "environment_operation_failed",
        "ProviderAccount environment mutation is fenced by an active setup invocation.",
      );
    if (
      !expected ||
      expected.backendKind !== active.backendKind ||
      expected.environmentId !== active.environmentId ||
      expected.incarnation !== active.environmentIncarnation
    )
      throw new EnvironmentBackendError(
        "environment_identity_mismatch",
        "Active ProviderAccount setup environment authority cannot transfer.",
      );
    const record = this.currentRecord(command);
    if (
      !record ||
      record.retiredAt ||
      record.state !== "running" ||
      record.backendKind !== active.backendKind ||
      record.environmentId !== active.environmentId ||
      record.incarnation !== active.environmentIncarnation
    )
      throw new EnvironmentBackendError(
        "environment_identity_mismatch",
        "The environment owned by the active ProviderAccount setup is missing or replaced.",
      );

    const expectedCanary = canaryValue(record.owner);
    if (this.fake) {
      if (
        this.store.readDeterministicCanary(record.recordId) !== expectedCanary
      )
        throw new EnvironmentBackendError(
          "environment_unhealthy",
          "The active ProviderAccount setup environment canary is invalid.",
        );
    } else {
      const lease = await (this.backend as ExecutionEnvironmentBackend).recover(
        recordRef(record),
        this.spec(command),
      );
      if (!sameRefIdentity(lease.ref, recordRef(record)))
        throw new EnvironmentBackendError(
          "environment_identity_mismatch",
          "The active ProviderAccount setup environment incarnation changed.",
        );
      let observedCanary: string;
      try {
        observedCanary = new TextDecoder().decode(
          await lease.readFile({
            path: `${lease.paths.state}/${CANARY_FILENAME}`,
            maxBytes: 512,
          }),
        );
      } catch {
        throw new EnvironmentBackendError(
          "environment_unhealthy",
          "The active ProviderAccount setup environment canary is unavailable.",
        );
      }
      if (observedCanary !== expectedCanary)
        throw new EnvironmentBackendError(
          "environment_unhealthy",
          "The active ProviderAccount setup environment canary is invalid.",
        );
    }
    return this.recordReport(command, record, "environment_reconciled", true);
  }

  private assertRecordNotOwnedByActiveSetup(
    record: DurableEnvironmentRecord,
  ): void {
    if (record.owner.kind !== "provider_account")
      throw new EnvironmentBackendError(
        "invalid_environment_ref",
        "ProviderAccount setup fence received a non-account owner.",
      );
    const active = this.activeSetupLookup?.(record.owner.providerAccountId);
    if (
      active &&
      record.owner.credentialGeneration === active.credentialGeneration &&
      record.backendKind === active.backendKind &&
      record.environmentId === active.environmentId &&
      record.incarnation === active.environmentIncarnation
    )
      throw new EnvironmentBackendError(
        "environment_operation_failed",
        "ProviderAccount environment retirement is fenced by an active setup invocation.",
      );
  }

  private async ensure(
    command: ProviderAccountEnvironmentCommand,
    eventType: ProviderAccountEnvironmentReport["eventType"],
  ): Promise<ProviderAccountEnvironmentReport> {
    if (this.fake) {
      const record = this.ensureFake(command);
      const expected = canaryValue(record.owner);
      const existing = this.store.readDeterministicCanary(record.recordId);
      if (existing === null)
        this.store.writeDeterministicCanary(record.recordId, expected);
      if (this.store.readDeterministicCanary(record.recordId) !== expected)
        throw new Error("Durable account environment canary mismatch.");
      return this.recordReport(command, record, eventType, true);
    }

    const lease = await (this.backend as ExecutionEnvironmentBackend).ensure(
      this.spec(command),
    );
    const expected = canaryValue(lease.ref.owner);
    const canaryPath = `${lease.paths.state}/${CANARY_FILENAME}`;
    let persisted = false;
    try {
      const current = new TextDecoder().decode(
        await lease.readFile({ path: canaryPath, maxBytes: 512 }),
      );
      persisted = current === expected;
    } catch {
      await lease.writeFile({
        path: canaryPath,
        data: new TextEncoder().encode(expected),
        mode: 0o600,
      });
      const current = new TextDecoder().decode(
        await lease.readFile({ path: canaryPath, maxBytes: 512 }),
      );
      persisted = current === expected;
    }
    if (!persisted)
      throw new Error("Durable account environment canary mismatch.");
    return this.refReport(command, lease.ref, "available", eventType, true);
  }

  private async stop(
    command: ProviderAccountEnvironmentCommand,
  ): Promise<ProviderAccountEnvironmentReport> {
    const record = this.currentRecord(command);
    if (!record)
      return this.emptyReport(command, "missing", "environment_missing");
    if (this.fake) {
      const stopped = this.store.markState(record.recordId, "stopped");
      return this.recordReport(command, stopped, "environment_stopped");
    }
    const ref = recordRef(record);
    const result = await (this.backend as ExecutionEnvironmentBackend).stop(
      ref,
    );
    const converged =
      result.state === "stopped"
        ? result
        : await (this.backend as ExecutionEnvironmentBackend).reconcileStop(
            ref,
          );
    if (converged.state !== "stopped")
      throw new EnvironmentBackendError(
        converged.errorCode ?? "environment_operation_failed",
        "ProviderAccount environment stop has not converged.",
        "stop",
      );
    return this.refReport(command, ref, "stopped", "environment_stopped");
  }

  private async remove(
    command: ProviderAccountEnvironmentCommand,
  ): Promise<ProviderAccountEnvironmentReport> {
    const record =
      this.currentRecord(command) ?? this.retiredExpectedRecord(command);
    if (!record)
      return this.emptyReport(command, "removed", "environment_removed");
    if (record.retiredAt)
      return this.refReport(
        command,
        recordRef(record),
        "removed",
        "environment_removed",
      );
    await this.removeRecord(record);
    return this.refReport(
      command,
      recordRef(record),
      "removed",
      "environment_removed",
    );
  }

  private async removeRecord(record: DurableEnvironmentRecord): Promise<void> {
    if (this.fake) {
      this.store.markState(record.recordId, "stopped");
      this.store.retire(record.recordId);
      return;
    }
    const backend = this.backend as ExecutionEnvironmentBackend;
    const ref = recordRef(record);
    const inspection = await backend.inspect(ref);
    if (inspection.state !== "stopped") {
      const result =
        inspection.stop?.intent === "recorded"
          ? await backend.reconcileStop(ref)
          : await backend.stop(ref);
      const converged =
        result.state === "stopped" ? result : await backend.reconcileStop(ref);
      if (converged.state !== "stopped")
        throw new Error("Account environment stop certainty is unresolved.");
    }
    await backend.remove(ref);
  }

  private async retireOtherGenerations(
    command: ProviderAccountEnvironmentCommand,
  ): Promise<void> {
    for (const record of this.accountRecords()) {
      if (
        record.retiredAt ||
        record.owner.providerAccountId !== command.providerAccountId ||
        record.owner.credentialGeneration === command.credentialGeneration
      )
        continue;
      if (record.owner.credentialGeneration > command.credentialGeneration)
        throw new EnvironmentBackendError(
          "stale_environment_ref",
          "A stale ProviderAccount generation cannot replace a newer environment.",
        );
      await this.removeRecord(record);
    }
  }

  private assertExpectedPhysicalIdentity(
    command: ProviderAccountEnvironmentCommand,
  ): void {
    const expected = command.expectedPhysicalIdentity;
    if (!expected) return;
    const record =
      this.currentRecord(command) ??
      (command.desiredState === "removed"
        ? this.retiredExpectedRecord(command)
        : null);
    if (
      !record ||
      record.backendKind !== expected.backendKind ||
      record.environmentId !== expected.environmentId ||
      record.incarnation !== expected.incarnation
    )
      throw new EnvironmentBackendError(
        "environment_identity_mismatch",
        "ProviderAccount environment differs from Product's exact physical fence.",
      );
  }

  private retiredExpectedRecord(
    command: ProviderAccountEnvironmentCommand,
  ): DurableEnvironmentRecord | null {
    const expected = command.expectedPhysicalIdentity;
    if (!expected) return null;
    return (
      this.accountRecords().find(
        (record) =>
          record.retiredAt !== null &&
          record.owner.providerAccountId === command.providerAccountId &&
          record.owner.credentialGeneration === command.credentialGeneration &&
          record.backendKind === expected.backendKind &&
          record.environmentId === expected.environmentId &&
          record.incarnation === expected.incarnation,
      ) ?? null
    );
  }

  private ensureFake(
    command: ProviderAccountEnvironmentCommand,
  ): DurableEnvironmentRecord {
    const owner = providerAccountOwner(
      command.providerAccountId,
      command.credentialGeneration,
    );
    const identity = digest(`${this.config.workerId}\0${ownerKey(owner)}`);
    const claim = this.store.claimCreation({
      recordId: randomUUID(),
      backendKind: "fake-account",
      workerId: this.config.workerId,
      owner,
      displayName: `fake-account-${identity.slice(0, 24)}`,
      incarnation: randomUUID(),
      profileId: SBX_SHELL_PROFILE.identity.id,
      profileDigest: SBX_SHELL_PROFILE.identity.digest,
      specDigest: digest(JSON.stringify(this.spec(command))),
      creationToken: randomUUID(),
      creatorPid: process.pid,
      nativeVersion: "fake-1",
      nativeRevision: "fake-1",
      nativeApiVersion: "fake-1",
    });
    if (claim.record.environmentId) {
      if (claim.record.state === "stopped")
        return this.store.markState(claim.record.recordId, "running");
      return claim.record;
    }
    return this.store.bindPhysical({
      recordId: claim.record.recordId,
      environmentId: `fake-${identity.slice(0, 32)}`,
      nativeAgent: "fake",
      markerDigest: digest(ownerKey(owner)),
      state: "running",
      capabilities: [
        { kind: "environment_persistence", mode: "verified" },
        { kind: "credentials", mode: "none" },
        { kind: "network_policy", mode: "deny_all" },
      ],
      diagnostics: [],
    });
  }

  private currentRecord(
    command: ProviderAccountEnvironmentCommand,
  ): DurableEnvironmentRecord | null {
    const owner = providerAccountOwner(
      command.providerAccountId,
      command.credentialGeneration,
    );
    return this.store.current(
      this.fake ? "fake-account" : "sbx",
      this.config.workerId,
      owner,
    );
  }

  private accountRecords(): Array<
    DurableEnvironmentRecord & {
      owner: Extract<EnvironmentOwner, { kind: "provider_account" }>;
    }
  > {
    return this.store.list().filter(
      (
        record,
      ): record is DurableEnvironmentRecord & {
        owner: Extract<EnvironmentOwner, { kind: "provider_account" }>;
      } =>
        record.workerId === this.config.workerId &&
        record.owner.kind === "provider_account",
    );
  }

  private setupRecord(
    identity: ProviderAccountSetupRuntimeIdentity,
  ): DurableEnvironmentRecord {
    const owner = providerAccountOwner(
      identity.providerAccountId,
      identity.credentialGeneration,
    );
    const record = this.store.current(
      this.fake ? "fake-account" : "sbx",
      this.config.workerId,
      owner,
    );
    if (
      !record ||
      record.retiredAt ||
      record.state !== "running" ||
      record.backendKind !== identity.backendKind ||
      record.environmentId !== identity.environmentId ||
      record.incarnation !== identity.environmentIncarnation ||
      (!this.fake &&
        (record.profileId !== SBX_CLAUDE_ACCOUNT_PROFILE_V1.id ||
          record.profileDigest !== SBX_CLAUDE_ACCOUNT_PROFILE_V1.digest))
    )
      throw new EnvironmentBackendError(
        "environment_identity_mismatch",
        "ProviderAccount setup does not match the exact available environment.",
      );
    return record;
  }

  private setupSpec(
    identity: ProviderAccountSetupRuntimeIdentity,
  ): ProviderAccountEnvironmentSpec {
    return this.specForOwner(
      providerAccountOwner(
        identity.providerAccountId,
        identity.credentialGeneration,
      ),
    );
  }

  private specForOwner(
    owner: Extract<EnvironmentOwner, { kind: "provider_account" }>,
  ): ProviderAccountEnvironmentSpec {
    return {
      workerId: this.config.workerId,
      owner,
      layout: { kind: "provider_account", version: "provider-account-cell-v1" },
      profile: SBX_CLAUDE_ACCOUNT_PROFILE_V1,
      resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY.identity,
      networkRequirements: [
        {
          capability: "anthropic_account",
          targets: ["api.anthropic.com", "claude.ai"],
        },
      ],
      credentialGrants: [
        {
          grantId: `provider-account:${owner.providerAccountId}:${owner.credentialGeneration}`,
          kind: "claude-oauth",
          scope: "provider_account",
        },
      ],
      controlChannels: [{ kind: "worker_account_mailbox_v1", required: true }],
      requiredCapabilities: [
        { kind: "environment_persistence", mode: "verified" },
        { kind: "credentials", mode: "account_private_claude_oauth" },
        { kind: "network_policy", mode: "anthropic_account_only" },
        { kind: "harness_runtime", mode: "claude_code_managed_mod_v1" },
        { kind: "control_channel", mode: "worker_account_mailbox_v1" },
        { kind: "process.streamed", mode: "attached_only" },
      ],
    };
  }

  private async acquireAccountOperation(
    providerAccountId: string,
  ): Promise<() => void> {
    let acquired!: () => void;
    let releaseWait!: () => void;
    const acquisition = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseWait = resolve;
    });
    const operation = this.withAccount(providerAccountId, async () => {
      acquired();
      await hold;
    });
    void operation.catch(() => undefined);
    await acquisition;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseWait();
    };
  }

  private async withAccount<T>(
    providerAccountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.accountTails.get(providerAccountId);
    const result = previous ? previous.then(operation) : operation();
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.accountTails.set(providerAccountId, tail);
    try {
      return await result;
    } finally {
      if (this.accountTails.get(providerAccountId) === tail)
        this.accountTails.delete(providerAccountId);
    }
  }

  private spec(
    command: ProviderAccountEnvironmentCommand,
  ): ProviderAccountEnvironmentSpec {
    return this.specForOwner(
      providerAccountOwner(
        command.providerAccountId,
        command.credentialGeneration,
      ),
    );
  }

  private recordReport(
    command: ProviderAccountEnvironmentCommand,
    record: DurableEnvironmentRecord,
    eventType: ProviderAccountEnvironmentReport["eventType"],
    canaryPersisted = this.store.readDeterministicCanary(record.recordId) ===
      canaryValue(record.owner),
  ): ProviderAccountEnvironmentReport {
    return this.refReport(
      command,
      recordRef(record),
      record.state === "running"
        ? "available"
        : record.state === "stopped"
          ? "stopped"
          : record.state === "removed"
            ? "removed"
            : record.state === "missing"
              ? "missing"
              : "degraded",
      eventType,
      canaryPersisted,
    );
  }

  private refReport(
    command: ProviderAccountEnvironmentCommand,
    ref: EnvironmentRef,
    physicalState: ProviderAccountEnvironmentReport["physicalState"],
    eventType: ProviderAccountEnvironmentReport["eventType"],
    canaryPersisted = false,
  ): ProviderAccountEnvironmentReport {
    if (
      ref.workerId !== this.config.workerId ||
      !sameEnvironmentOwner(
        ref.owner,
        providerAccountOwner(
          command.providerAccountId,
          command.credentialGeneration,
        ),
      )
    )
      throw new Error("ProviderAccount environment identity mismatch.");
    return {
      providerAccountId: command.providerAccountId,
      credentialGeneration: command.credentialGeneration,
      workerGeneration: command.workerGeneration,
      operationId: command.operationId,
      physicalState,
      eventType,
      backendKind: ref.backendKind,
      environmentId: ref.environmentId,
      incarnation: ref.incarnation,
      errorCode: null,
      errorMessage: null,
      observedAt: this.clock().toISOString(),
      canaryPersisted,
      authentication: null,
    };
  }

  private unboundRecordReport(
    command: ProviderAccountEnvironmentCommand,
    record: DurableEnvironmentRecord,
  ): ProviderAccountEnvironmentReport {
    return {
      providerAccountId: command.providerAccountId,
      credentialGeneration: command.credentialGeneration,
      workerGeneration: command.workerGeneration,
      operationId: command.operationId,
      physicalState: record.state === "creating" ? "pending" : "degraded",
      eventType:
        record.state === "creating"
          ? "environment_reconciled"
          : "environment_degraded",
      backendKind: record.backendKind,
      environmentId: null,
      incarnation: null,
      errorCode:
        record.state === "creating"
          ? null
          : "account_environment_operation_failed",
      errorMessage:
        record.state === "creating"
          ? null
          : "ProviderAccount environment is not physically bound.",
      observedAt: this.clock().toISOString(),
      canaryPersisted: false,
      authentication: null,
    };
  }

  private emptyReport(
    command: ProviderAccountEnvironmentCommand,
    physicalState: "missing" | "removed",
    eventType: "environment_missing" | "environment_removed",
  ): ProviderAccountEnvironmentReport {
    return {
      providerAccountId: command.providerAccountId,
      credentialGeneration: command.credentialGeneration,
      workerGeneration: command.workerGeneration,
      operationId: command.operationId,
      physicalState,
      eventType,
      backendKind: this.fake ? "fake-account" : "sbx",
      environmentId: null,
      incarnation: null,
      errorCode: null,
      errorMessage: null,
      observedAt: this.clock().toISOString(),
      canaryPersisted: false,
      authentication: null,
    };
  }

  private failureReport(
    command: ProviderAccountEnvironmentCommand,
    error: unknown,
  ): ProviderAccountEnvironmentReport {
    const current = this.currentRecord(command);
    const observedIdentity = current
      ? {
          backendKind: current.backendKind,
          environmentId: current.environmentId,
          incarnation: current.incarnation,
        }
      : {
          backendKind:
            command.expectedPhysicalIdentity?.backendKind ??
            (this.fake ? "fake-account" : "sbx"),
          environmentId:
            command.expectedPhysicalIdentity?.environmentId ?? null,
          incarnation: command.expectedPhysicalIdentity?.incarnation ?? null,
        };
    return {
      providerAccountId: command.providerAccountId,
      credentialGeneration: command.credentialGeneration,
      workerGeneration: command.workerGeneration,
      operationId: command.operationId,
      physicalState: "degraded",
      eventType: "environment_degraded",
      ...observedIdentity,
      errorCode:
        error instanceof EnvironmentBackendError
          ? error.code
          : "account_environment_operation_failed",
      errorMessage: "ProviderAccount environment operation failed safely.",
      observedAt: this.clock().toISOString(),
      canaryPersisted: false,
      authentication: null,
    };
  }

  private validateCommand(command: ProviderAccountEnvironmentCommand): void {
    if (
      !command.providerAccountId ||
      !command.providerKey ||
      !command.operationId ||
      !Number.isSafeInteger(command.credentialGeneration) ||
      command.credentialGeneration < 1 ||
      !Number.isSafeInteger(command.workerGeneration) ||
      command.workerGeneration < 1 ||
      (command.expectedPhysicalIdentity !== null &&
        (!command.expectedPhysicalIdentity.backendKind ||
          !command.expectedPhysicalIdentity.environmentId ||
          !command.expectedPhysicalIdentity.incarnation))
    )
      throw new Error("ProviderAccount environment command is invalid.");
  }
}

function recordRef(record: DurableEnvironmentRecord): EnvironmentRef {
  if (!record.environmentId)
    throw new Error("ProviderAccount environment has no physical identity.");
  return {
    backendKind: record.backendKind,
    environmentId: record.environmentId,
    incarnation: record.incarnation,
    workerId: record.workerId,
    owner: structuredClone(record.owner),
    profile: { id: record.profileId, digest: record.profileDigest },
  };
}

function sameRefIdentity(left: EnvironmentRef, right: EnvironmentRef): boolean {
  return (
    left.backendKind === right.backendKind &&
    left.environmentId === right.environmentId &&
    left.incarnation === right.incarnation &&
    left.workerId === right.workerId &&
    sameEnvironmentOwner(left.owner, right.owner) &&
    left.profile.id === right.profile.id &&
    left.profile.digest === right.profile.digest
  );
}

function ownerKey(owner: EnvironmentOwner): string {
  return owner.kind === "run"
    ? `run\0${owner.runId}`
    : `provider_account\0${owner.providerAccountId}\0${owner.credentialGeneration}`;
}

function canaryValue(owner: EnvironmentOwner): string {
  return `qe-provider-account-canary-v1:${digest(ownerKey(owner))}`;
}

function fakeAuthenticationIdentity(
  identity: ProviderAccountSetupRuntimeIdentity,
): string {
  return digest(
    [
      identity.providerAccountId,
      identity.environmentGeneration,
      identity.backendKind,
      identity.environmentId,
      identity.environmentIncarnation,
    ].join("\0"),
  );
}

function authenticationReport(
  inspection: ProviderAuthenticationInspection,
): ProviderAccountAuthenticationReport {
  return {
    state: inspection.state,
    method: inspection.method,
    configurationIdentity: inspection.configuration.identity,
    environmentPolicy: inspection.configuration.environmentPolicy,
    evidenceIdentity: inspection.evidenceIdentity,
    inspectedAt: inspection.inspectedAt,
  };
}

function fakePaths(ref: EnvironmentRef) {
  const root = `/fake/provider-accounts/${ref.environmentId}/${ref.incarnation}`;
  return {
    workspace: `${root}/workspace`,
    state: `${root}/state`,
    control: `${root}/control`,
    home: `${root}/home`,
    cache: `${root}/cache`,
    temp: `${root}/tmp`,
  };
}

function inMemoryFakeSetupLauncher(
  providerKey: string,
): ProviderAccountSetupLauncher {
  return {
    identity: "qe-in-memory-fake-provider-login-v1",
    providerKey,
    executable: "/usr/bin/qe-fake-provider-login",
    interactionRecognizerIdentity: "qe-fake-provider-login-json-v1",
    specification: (context) =>
      immutableSetupLaunchSpec({
        contractVersion: 1,
        launcherIdentity: "qe-in-memory-fake-provider-login-v1",
        providerKey: context.providerKey,
        interactionRecognizerIdentity: "qe-fake-provider-login-json-v1",
        command: {
          executable: "/usr/bin/qe-fake-provider-login",
          args: [],
          cwd: context.paths.state,
          environment: {},
        },
        options: {
          bufferBytes: 64 * 1024,
          acknowledgementTimeoutMs: 30_000,
        },
      }),
    prepare: async () => undefined,
  };
}

class DeterministicFakeLoginTransport extends FakeStreamedProcessTransport {
  private settled = false;

  constructor(
    processGeneration: string,
    setupAttemptId: string,
    private readonly onAuthenticated: () => void,
  ) {
    super({
      backendProcessId: `fake-login-${processGeneration}`,
      processStartIdentity: `fake-login-start-${processGeneration}`,
      observedExecutable: "/usr/bin/qe-fake-provider-login",
    });
    queueMicrotask(() =>
      this.emitStdout(
        new TextEncoder().encode(
          `${JSON.stringify({
            kind: "fake_provider_login",
            url: "https://fake-provider.invalid/device",
            code: setupAttemptId.slice(-8),
          })}\n`,
        ),
      ),
    );
  }

  override async write(writeId: string, data: Uint8Array) {
    const outcome = await super.write(writeId, data);
    if (outcome.certainty === "acknowledged" && !this.settled) {
      this.settled = true;
      this.onAuthenticated();
      this.emitEof("stdout");
      this.emitEof("stderr");
      this.emitExit({ kind: "exited", exitCode: 0 });
    }
    return outcome;
  }
}

const CLAUDE_ACCOUNT_RUNTIME_ADDITION_NAMES = new Set([
  "QE_ACCOUNT_CELL_MOD_PROTOCOL",
  "QE_CLAUDE_MODEL",
  "QE_CLAUDE_EFFORT",
  "QE_ACCOUNT_CELL_MAILBOX",
  "QE_ACCOUNT_CELL_BRIDGE_TOKEN",
  "CLAUDE_CODE_STARTUP_FAILURE_RESULTS",
]);

export function claudeAccountEnvironment(
  configRoot: string,
  additions: Record<string, string> = {},
): Record<string, string> {
  if (
    Object.keys(additions).some(
      (name) => !CLAUDE_ACCOUNT_RUNTIME_ADDITION_NAMES.has(name),
    )
  )
    throw new EnvironmentBackendError(
      "backend_incompatible",
      "Claude account runtime environment additions are not allowlisted.",
    );
  return { ...claudeSubscriptionEnvironment(configRoot), ...additions };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
