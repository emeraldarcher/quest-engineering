import { createHash, randomUUID } from "node:crypto";
import type { WorkerConfig } from "../config.ts";
import { FakeStreamedProcessTransport } from "./fake.ts";
import { providerAccountOwner, sameEnvironmentOwner } from "./ownership.ts";
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
  providerAccountId: string;
  providerKey: string;
  environmentGeneration: number;
  backendKind: string;
  environmentId: string;
  environmentIncarnation: string;
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
}

export interface ProviderAccountEnvironmentManagerOptions {
  backend?: ExecutionEnvironmentBackend;
  store?: ExecutionEnvironmentStore;
  fake?: boolean;
  clock?: () => Date;
}

/**
 * Owns Phase-A ProviderAccount cells independently of Runs.
 *
 * Provider behavior is deliberately deterministic and credential-free. The
 * account generation is represented only as a fence; no login or inference is
 * performed. Real SBX uses the existing immutable shell profile.
 */
export class ProviderAccountEnvironmentManager {
  private readonly store: ExecutionEnvironmentStore;
  private readonly backend: ExecutionEnvironmentBackend | null;
  private readonly fake: boolean;
  private readonly clock: () => Date;
  private readonly latestReports = new Map<
    string,
    ProviderAccountEnvironmentReport
  >();
  private readonly accountTails = new Map<string, Promise<void>>();
  private readonly fakeAuthenticatedSetups = new Set<string>();
  private readonly fakeSetupProcesses: StreamedProcessManager;
  private closed = false;

  constructor(
    private readonly config: Pick<
      WorkerConfig,
      "workerId" | "dataRoot" | "provider"
    >,
    options: ProviderAccountEnvironmentManagerOptions = {},
  ) {
    this.store =
      options.store ?? new ExecutionEnvironmentStore(config.dataRoot);
    this.fake = options.fake ?? config.provider === "fake";
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
      const report = await this.applySafely(command);
      this.latestReports.set(command.providerAccountId, report);
      return report;
    });
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

  async spawnSetupProcess(
    identity: ProviderAccountSetupRuntimeIdentity,
  ): Promise<StreamedProcess> {
    const release = await this.acquireAccountOperation(
      identity.providerAccountId,
    );
    try {
      const record = this.setupRecord(identity);
      const ref = recordRef(record);
      const validationIdentity = setupValidationIdentity(identity);
      let process: StreamedProcess;
      if (this.fake) {
        const paths = fakePaths(ref);
        process = await this.fakeSetupProcesses.spawn(
          ref,
          paths,
          {
            executable: "/usr/bin/qe-fake-provider-login",
            args: [],
            cwd: paths.state,
            environment: {},
          },
          {},
          async (context) =>
            new DeterministicFakeLoginTransport(
              context.processGeneration,
              identity.setupAttemptId,
              () => this.fakeAuthenticatedSetups.add(validationIdentity),
            ),
        );
      } else {
        if (identity.providerKey !== "anthropic")
          throw new EnvironmentBackendError(
            "backend_incompatible",
            "The immutable ProviderAccount runtime supports Anthropic accounts only.",
          );
        const lease = await (
          this.backend as ExecutionEnvironmentBackend
        ).recover(ref, this.setupSpec(identity));
        const configRoot = `${lease.paths.state}/claude/config`;
        await this.prepareClaudeDirectories(lease, configRoot);
        process = await lease.spawnStreamed(
          {
            executable: SBX_CLAUDE_EXECUTABLE,
            args: ["auth", "login"],
            cwd: `${lease.paths.state}/claude/empty-cwd`,
            environment: claudeAccountEnvironment(configRoot),
          },
          { bufferBytes: 64 * 1024, acknowledgementTimeoutMs: 30_000 },
        );
      }
      void process.exit.then(release, release);
      return process;
    } catch (error) {
      release();
      throw error;
    }
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
    const ref = recordRef(record);
    if (this.fake) return this.fakeSetupProcesses.reconcile(handle);
    const lease = await (this.backend as ExecutionEnvironmentBackend).recover(
      ref,
      this.setupSpec(identity),
    );
    return lease.reconcileStreamedProcess(handle);
  }

  validateSetup(
    identity: ProviderAccountSetupRuntimeIdentity,
  ): Promise<{ authenticated: boolean; identity: string | null }> {
    return this.withAccount(identity.providerAccountId, () =>
      this.validateSetupUnlocked(identity),
    );
  }

  private async validateSetupUnlocked(
    identity: ProviderAccountSetupRuntimeIdentity,
  ): Promise<{ authenticated: boolean; identity: string | null }> {
    const record = this.setupRecord(identity);
    const validationIdentity = setupValidationIdentity(identity);
    if (this.fake)
      return this.fakeAuthenticatedSetups.has(validationIdentity)
        ? { authenticated: true, identity: validationIdentity }
        : { authenticated: false, identity: null };
    if (identity.providerKey !== "anthropic")
      return { authenticated: false, identity: null };
    const ref = recordRef(record);
    const lease = await (this.backend as ExecutionEnvironmentBackend).recover(
      ref,
      this.setupSpec(identity),
    );
    const configRoot = `${lease.paths.state}/claude/config`;
    await this.prepareClaudeDirectories(lease, configRoot);
    const result = await lease.exec({
      executable: SBX_CLAUDE_EXECUTABLE,
      args: ["auth", "status"],
      cwd: `${lease.paths.state}/claude/empty-cwd`,
      environment: claudeAccountEnvironment(configRoot),
      timeoutMs: 30_000,
    });
    if (result.exitCode !== 0) return { authenticated: false, identity: null };
    try {
      const status = JSON.parse(result.stdout) as Record<string, unknown>;
      const authenticated =
        status.loggedIn === true &&
        status.authMethod === "claude.ai" &&
        status.configDirectory === configRoot;
      return authenticated
        ? {
            authenticated: true,
            identity: `claude-auth-v1:${digest(
              JSON.stringify({
                authMethod: status.authMethod,
                configDirectory: status.configDirectory,
                providerAccountId: identity.providerAccountId,
                generation: identity.environmentGeneration,
              }),
            )}`,
          }
        : { authenticated: false, identity: null };
    } catch {
      return { authenticated: false, identity: null };
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
    await this.prepareClaudeDirectories(lease, configRoot);
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
    if (this.fake) return;
    const record = this.setupRecord(identity);
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

  private async prepareClaudeDirectories(
    lease: EnvironmentLease,
    configRoot: string,
  ): Promise<void> {
    const cwd = `${lease.paths.state}/claude/empty-cwd`;
    await lease.workerExec({
      executable: "/usr/bin/install",
      args: [
        "-d",
        "-m",
        "0700",
        "-o",
        "1000",
        "-g",
        "1000",
        configRoot,
        `${configRoot}/tmp`,
        cwd,
      ],
    });
    await lease.workerExec({
      executable: "/usr/bin/python3",
      args: [
        "-c",
        "import json,os,pathlib; p=pathlib.Path(os.environ['P']); value={}\ntry:\n value=json.loads(p.read_text())\nexcept Exception: pass\nvalue['hasCompletedOnboarding']=True; t=p.with_suffix('.tmp'); t.write_text(json.dumps(value,separators=(',',':'))); os.chmod(t,0o600); os.chown(t,1000,1000); os.replace(t,p)",
      ],
      environment: { P: `${configRoot}/.claude.json` },
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.fakeSetupProcesses.shutdown();
    if (this.backend) await this.backend.close?.();
    else this.store.close();
  }

  private async applySafely(
    command: ProviderAccountEnvironmentCommand,
  ): Promise<ProviderAccountEnvironmentReport> {
    try {
      this.assertExpectedPhysicalIdentity(command);
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
      identity.environmentGeneration,
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
      record.incarnation !== identity.environmentIncarnation
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
        identity.environmentGeneration,
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

function ownerKey(owner: EnvironmentOwner): string {
  return owner.kind === "run"
    ? `run\0${owner.runId}`
    : `provider_account\0${owner.providerAccountId}\0${owner.credentialGeneration}`;
}

function canaryValue(owner: EnvironmentOwner): string {
  return `qe-provider-account-canary-v1:${digest(ownerKey(owner))}`;
}

function setupValidationIdentity(
  identity: ProviderAccountSetupRuntimeIdentity,
): string {
  return `qe-fake-auth-v1:${digest(
    [
      identity.providerAccountId,
      identity.environmentGeneration,
      identity.backendKind,
      identity.environmentId,
      identity.environmentIncarnation,
      identity.setupAttemptId,
      identity.setupGeneration,
    ].join("\0"),
  )}`;
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

export function claudeAccountEnvironment(
  configRoot: string,
  additions: Record<string, string> = {},
): Record<string, string> {
  return {
    HOME: configRoot,
    CLAUDE_CONFIG_DIR: configRoot,
    TMPDIR: `${configRoot}/tmp`,
    PATH: "/usr/bin:/bin",
    BROWSER: "/bin/false",
    GIT_TERMINAL_PROMPT: "0",
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    ENABLE_TOOL_SEARCH: "false",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
    CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1",
    CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1",
    CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1",
    CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    CLAUDE_CODE_DISABLE_ADVISOR_TOOL: "1",
    CLAUDE_CODE_DISABLE_ARTIFACT: "1",
    CLAUDE_CODE_DISABLE_FAST_MODE: "1",
    ...additions,
  };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
