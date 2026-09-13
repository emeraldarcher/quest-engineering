import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import { arch, platform } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
  assertExecutionSupported,
  workerCapabilities,
} from "./capabilities.ts";
import type { WorkerConfig } from "./config.ts";
import { DispatchExecutor } from "./dispatch/executor.ts";
import {
  type DispatchRecord,
  DispatchRegistry,
  type HarnessLineage,
} from "./dispatch/registry.ts";
import { AntigravityHarness } from "./harnesses/antigravity/adapter.ts";
import { HarnessControlAuthority } from "./harnesses/control/authority.ts";
import { HarnessControlServer } from "./harnesses/control/server.ts";
import { FakeHarness } from "./harnesses/fake/adapter.ts";
import { PiHarness } from "./harnesses/pi/adapter.ts";
import { HarnessRegistry } from "./harnesses/registry.ts";
import type { AgentHarness } from "./harnesses/types.ts";
import { decodeExecuteAction } from "./protocol/codec.ts";
import { PhoenixWorkerChannel } from "./protocol/phoenix-channel.ts";
import type {
  ReconcileDispatch,
  ReconcileSession,
  WorkerCapabilities,
} from "./protocol/types.ts";
import { WORKER_PROTOCOL_VERSION } from "./protocol/types.ts";
import { LocalHerdrConnectionProvider } from "./session-host/herdr/connection.ts";
import { HerdrTerminalBackend } from "./session-host/herdr/session-host.ts";
import {
  applyBindingReconciliation,
  persistWorkspaceBindings,
} from "./workspace/binding-state.ts";
import {
  type DeliveryCommand,
  DeliveryError,
  RunDeliveryRegistry,
} from "./workspace/run-delivery.ts";
import {
  type ProvisionRunWorktree,
  type RunWorktreeRecord,
  RunWorktreeRegistry,
} from "./workspace/run-worktrees.ts";

export class QuestEngineeringWorker {
  readonly registry: DispatchRegistry;
  readonly executor: DispatchExecutor;
  readonly worktrees: RunWorktreeRegistry;
  readonly deliveries: RunDeliveryRegistry;
  readonly harnessControl: HarnessControlAuthority;
  readonly harnesses: HarnessRegistry;
  private readonly harnessControlServer: HarnessControlServer;
  private readonly channel: PhoenixWorkerChannel;
  private readonly capabilities: WorkerCapabilities;
  private stopping = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private recoveryScanActive = false;
  private readonly sessionReports = new Map<string, Promise<boolean>>();
  private readonly sourceCandidates = new Map<
    string,
    {
      rootKey: string;
      path: string;
      maxAccess: "none" | "read_only" | "read_write";
      allowShell: boolean;
      fingerprint: string | null;
      publicationRemoteName: string | null;
      publicationRepositoryIdentity: string | null;
    }
  >();

  constructor(private readonly config: WorkerConfig) {
    this.worktrees = new RunWorktreeRegistry(config);
    this.deliveries = new RunDeliveryRegistry(config, this.worktrees);
    const harnesses: AgentHarness[] =
      config.provider === "fake"
        ? [new FakeHarness(config.fakeOutputs, config.fakeDelayMs)]
        : (config.enabledHarnesses ?? ["pi", "antigravity"]).map((kind) => {
            const host = new HerdrTerminalBackend(
              new LocalHerdrConnectionProvider(config.herdrSession),
            );
            return kind === "antigravity"
              ? new AntigravityHarness(host, config)
              : new PiHarness(host, config);
          });
    this.harnesses = new HarnessRegistry(harnesses);
    const defaultHarness = harnesses[0];
    if (!defaultHarness) throw new Error("Worker has no enabled harnesses.");
    this.registry = new DispatchRegistry(
      join(config.dataRoot, "dispatches.sqlite"),
      config.dataRoot,
      defaultHarness.kind,
      (kind) => this.harnesses.get(kind).capabilities,
    );
    this.harnessControl = new HarnessControlAuthority(this.registry);
    this.harnessControlServer = new HarnessControlServer(this.harnessControl);
    // Harness and terminal transport are composed once per long-lived Worker.
    const capabilities = workerCapabilities(config, platform(), arch());
    this.capabilities = capabilities;
    this.channel = new PhoenixWorkerChannel(
      config.controlPlaneUrl,
      config.workerId,
      config.workerToken,
      capabilities,
      {
        onProtocol: (message) => this.handleProtocol(message),
        onRegistered: (response) => this.onRegistered(response),
        onSuperseded: () => {
          console.warn(
            "Worker connection was superseded by a newer generation; stopping this controller.",
          );
          this.stopping = true;
        },
      },
    );
    this.executor = new DispatchExecutor(
      this.registry,
      this.harnesses,
      (dispatch, type) => this.report(dispatch, type),
      (dispatch, lineage) => this.reportHarnessSession(dispatch, lineage),
      this.harnessControl,
    );
  }

  async run(): Promise<void> {
    await this.refreshHarnessCapabilities();
    await this.harnessControlServer.start();
    await this.executor.recoverAll();
    while (!this.stopping) {
      try {
        await this.channel.connect();
        while (!this.stopping && this.channel.isRegistered())
          await Bun.sleep(250);
      } catch (error) {
        if (!this.stopping)
          console.error(
            "Worker connection error",
            error instanceof Error ? error.message : String(error),
          );
      }
      if (!this.stopping) await Bun.sleep(this.config.reconnectMs);
    }
  }

  private async refreshHarnessCapabilities(): Promise<void> {
    const discoveries = await this.harnesses.discover();
    const discovered = workerCapabilities(
      this.config,
      platform(),
      arch(),
      discoveries,
    );
    if (discovered.executors.length === 0)
      throw new Error(
        `No enabled harness is ready: ${discoveries
          .map((item) => `${item.displayName}: ${item.integration.detail}`)
          .join(" ")}`,
      );
    Object.assign(this.capabilities, discovered);
  }

  attachment(actionId: string) {
    return this.executor.attachment(actionId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.channel.close();
    this.executor.disconnect();
    await this.harnessControlServer.stop();
    this.registry.close();
    this.deliveries.close();
    this.worktrees.close();
  }

  private async handleProtocol(
    message: Record<string, unknown>,
  ): Promise<void> {
    if (message.type === "discover_workspace_sources") {
      await this.reportWorkspaceSources();
      return;
    }
    if (message.type === "bind_workspace_source") {
      const binding = message.binding as Record<string, unknown>;
      try {
        await this.bindWorkspaceSource(binding);
      } catch (error) {
        await this.channel.sendProtocol({
          type: "workspace_binding_failed",
          protocol_version: WORKER_PROTOCOL_VERSION,
          worker_id: this.config.workerId,
          binding: {
            binding_id: String(binding.binding_id ?? ""),
            failure_code: "workspace_binding_failed",
            failure_details: {
              message:
                error instanceof Error
                  ? error.message.slice(0, 300)
                  : "Project setup failed.",
            },
          },
        });
      }
      return;
    }
    if (message.type === "retain_run_worktree") {
      const request = message.worktree as Record<string, unknown>;
      try {
        const id = String(request.worktree_id ?? "");
        this.assertRunIdle(String(request.run_id ?? ""));
        const record = await this.worktrees.retain(id);
        await this.reportWorktreeState("run_worktree_retained", record);
      } catch (error) {
        await this.reportWorktreeCommandFailure(request, error);
      }
      return;
    }
    if (message.type === "cleanup_run_worktree") {
      const request = message.worktree as Record<string, unknown>;
      try {
        this.assertRunIdle(String(request.run_id ?? ""));
        const record = await this.worktrees.cleanup(
          String(request.worktree_id ?? ""),
        );
        if (record.state === "removed")
          await this.reportWorktreeState("run_worktree_removed", record);
        else await this.reportWorktree(record);
      } catch (error) {
        await this.reportWorktreeCommandFailure(request, error);
      }
      return;
    }
    if (message.type === "inspect_run_delivery") {
      const command = message.delivery as unknown as DeliveryCommand;
      await this.handleDelivery(command, "inspect");
      return;
    }
    if (message.type === "publish_run_delivery") {
      const command = message.delivery as unknown as DeliveryCommand & {
        quest_title?: string;
      };
      await this.handleDelivery(command, "publish");
      return;
    }
    if (message.type === "provision_run_worktree") {
      const request = message.worktree as unknown as ProvisionRunWorktree;
      const record = await this.worktrees.provision(request);
      await this.reportWorktree(record);
      return;
    }
    if (message.type === "reconcile_run_worktrees") {
      const requested = Array.isArray(message.worktrees)
        ? message.worktrees
        : [];
      for (const item of requested) {
        if (!item || typeof item !== "object") continue;
        const id = (item as Record<string, unknown>).worktree_id;
        if (typeof id !== "string") continue;
        const request = item as Record<string, unknown>;
        const record = this.worktrees.get(id);
        if (record) {
          const desired = String(request.desired_state ?? "");
          if (desired === "retained") {
            this.assertRunIdle(String(request.run_id ?? ""));
            const retained = await this.worktrees.retain(id);
            await this.reportWorktreeState("run_worktree_retained", retained);
          } else if (desired === "cleanup_requested" || desired === "removed") {
            this.assertRunIdle(String(request.run_id ?? ""));
            const removed = await this.worktrees.cleanup(id);
            if (removed.state === "removed")
              await this.reportWorktreeState("run_worktree_removed", removed);
            else await this.reportWorktree(removed);
          } else {
            const observed =
              record.state === "ready" || record.state === "retained"
                ? await this.worktrees.verify(id)
                : record;
            await this.reportWorktree(observed);
          }
        } else {
          await this.channel.sendProtocol({
            type: "run_worktree_attention",
            protocol_version: WORKER_PROTOCOL_VERSION,
            worker_id: this.config.workerId,
            worktree_id: id,
            run_id: String(request.run_id ?? ""),
            workspace_binding_id: String(request.workspace_binding_id ?? ""),
            identity_hash: String(request.identity_hash ?? ""),
            failure: {
              code: "run_worktree_missing",
              message:
                "The durable Worker mapping for the assigned Run worktree is missing.",
            },
          });
        }
      }
      return;
    }
    if (message.type === "resolve_uncertain_dispatch") {
      await this.resolveUncertainDispatch(message);
      return;
    }
    if (message.type === "execute_action") {
      const action = decodeExecuteAction(message, this.config.workerId);
      assertExecutionSupported(action, this.capabilities);
      const worktree = await this.worktrees.verify(
        action.execution.execution_workspace.worktree_id,
      );
      if (worktree.state !== "ready")
        throw new Error(`Run worktree is fenced in ${worktree.state}.`);
      if (
        worktree.canonicalRoot !==
        action.execution.execution_workspace.canonical_root
      )
        throw new Error(
          "Resolved execution root differs from the durable Run worktree.",
        );
      let acceptance: ReturnType<DispatchExecutor["accept"]>;
      try {
        acceptance = this.executor.accept(action);
      } catch (error) {
        if (action.operational_recovery?.authorization_kind !== "human")
          throw error;
        await this.channel.sendProtocol({
          type: "step_failed",
          protocol_version: WORKER_PROTOCOL_VERSION,
          worker_id: this.config.workerId,
          action_id: action.action_id,
          occurrence_id: action.occurrence_id,
          attempt_id: action.attempt_id,
          failure: {
            reason: "retained_recovery_unavailable",
            classification: "operator_recovery_required",
            message:
              "The retained session could not be safely continued. Explicitly retry with a fresh session.",
          },
        });
        return;
      }
      try {
        await this.sendAcceptedOrState(acceptance.dispatch);
      } finally {
        // Durable acceptance is sufficient to begin; a lost ACK reply must not
        // strand accepted work in this still-running Worker process.
        if (acceptance.dispatch.state === "accepted")
          void this.executor.start(action.action_id);
      }
      return;
    }
    if (message.type === "reconcile_request") {
      const dispatches = this.registry.reconcilePayloads();
      const sessions = this.registry.listLineages().flatMap((lineage) => {
        const dispatch = this.registry
          .list()
          .filter((item) => item.lineageId === lineage.lineageId)
          .at(-1);
        return dispatch
          ? [harnessSessionPayload(dispatch, lineage, this.executor)]
          : [];
      });
      const response = await this.channel.sendProtocol({
        type: "reconcile_state",
        protocol_version: WORKER_PROTOCOL_VERSION,
        worker_id: this.config.workerId,
        dispatches,
        sessions,
      });
      if (response.result === "reconciled") {
        for (const dispatch of this.registry.list()) {
          if (dispatch.state === "completed")
            this.registry.acknowledgeServerCompletion(
              dispatch.action.action_id,
            );
        }
        const resolutions = Array.isArray(response.dispatch_resolutions)
          ? response.dispatch_resolutions
          : [];
        for (const resolution of resolutions) {
          if (resolution && typeof resolution === "object")
            await this.resolveUncertainDispatch(
              resolution as Record<string, unknown>,
            );
        }
      }
    }
  }

  private async onRegistered(response: Record<string, unknown>): Promise<void> {
    applyBindingReconciliation(
      this.config,
      this.capabilities,
      response.workspace_binding_reconciliation,
    );
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      void this.channel
        .sendProtocol({
          type: "worker_heartbeat",
          protocol_version: WORKER_PROTOCOL_VERSION,
          worker_id: this.config.workerId,
        })
        .catch(() => undefined);
      void this.scanRecoveryRequests();
    }, this.config.heartbeatMs);
    this.heartbeat.unref?.();
    void this.scanRecoveryRequests();
    // Publish the bounded authorized-root catalog on every registration so a
    // discovery request racing the join acknowledgement cannot be lost.
    void this.reportWorkspaceSources().catch((error) =>
      console.warn(
        "Workspace source discovery failed",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  private async scanRecoveryRequests(): Promise<void> {
    if (this.recoveryScanActive || !this.channel.isRegistered()) return;
    this.recoveryScanActive = true;
    try {
      for (const lineage of this.registry.listLineages()) {
        if (
          lineage.activeActionId !== null ||
          lineage.sessionState !== "retained"
        )
          continue;
        const path = join(
          dirname(lineage.resultControlPath),
          "recovery-control.json",
        );
        if (!existsSync(path)) continue;
        let request: Record<string, unknown>;
        try {
          request = JSON.parse(await Bun.file(path).text()) as Record<
            string,
            unknown
          >;
        } catch {
          continue;
        }
        if (request.version !== 1 || request.state !== "requested") continue;
        const identity = request.identity as Record<string, unknown>;
        const actionId = String(identity?.actionId ?? "");
        let dispatch: DispatchRecord;
        try {
          dispatch = this.registry.get(actionId);
        } catch {
          await writeRecoveryResult(path, request, "rejected", {
            rejectionCode: "unknown_action",
          });
          continue;
        }
        const nativeSession =
          lineage.nativeSession?.kind === "id"
            ? lineage.nativeSession.value
            : null;
        if (
          dispatch.state !== "failed" ||
          dispatch.lineageId !== lineage.lineageId ||
          identity.workerId !== this.config.workerId ||
          identity.lineageId !== lineage.lineageId ||
          identity.runId !== dispatch.action.run_id ||
          identity.occurrenceId !== dispatch.action.occurrence_id ||
          identity.attemptId !== dispatch.action.attempt_id ||
          request.memberKey !==
            dispatch.action.execution.performer.member_key ||
          request.piSessionId !== nativeSession
        ) {
          await writeRecoveryResult(path, request, "rejected", {
            rejectionCode: "recovery_provenance_mismatch",
          });
          continue;
        }
        try {
          const response = await this.channel.sendProtocol({
            type: "human_recovery_requested",
            protocol_version: WORKER_PROTOCOL_VERSION,
            worker_id: this.config.workerId,
            recovery: {
              request_id: String(request.requestId),
              run_id: dispatch.action.run_id,
              occurrence_id: dispatch.action.occurrence_id,
              attempt_id: dispatch.action.attempt_id,
              action_id: dispatch.action.action_id,
              member_key: dispatch.action.execution.performer.member_key,
              session_id: lineage.lineageId,
              lineage_id: lineage.lineageId,
              native_session_id: String(request.piSessionId),
            },
          });
          await writeRecoveryResult(path, request, "authorized", {
            recoveryEpoch: Number(response.recovery_epoch),
            attemptAllowance: Number(response.attempt_allowance),
          });
        } catch {
          // Keep the stable request pending across disconnects and lost acknowledgements.
        }
      }
    } finally {
      this.recoveryScanActive = false;
    }
  }

  private async reportWorkspaceSources(): Promise<void> {
    const discoveredCandidates = new Map<
      string,
      {
        rootKey: string;
        path: string;
        maxAccess: "none" | "read_only" | "read_write";
        allowShell: boolean;
        fingerprint: string | null;
        publicationRemoteName: string | null;
        publicationRepositoryIdentity: string | null;
      }
    >();
    const candidates: Array<Record<string, unknown>> = [];
    for (const root of this.config.allowedRoots) {
      for (const path of discoverGitRoots(
        root.path,
        root.discover_depth,
        this.config.worktreeRoot,
      )) {
        const candidateId = createHash("sha256")
          .update(`${this.config.workerId}\n${path}`)
          .digest("hex");
        const publication = await publicationMetadata(path);
        const fingerprint = publication.fingerprint;
        discoveredCandidates.set(candidateId, {
          rootKey: root.key,
          path,
          maxAccess: root.max_access,
          allowShell: root.allow_unconfined_shell,
          fingerprint,
          publicationRemoteName: publication.remoteName,
          publicationRepositoryIdentity: publication.repositoryIdentity,
        });
        candidates.push({
          candidate_id: candidateId,
          name: basename(path),
          source_kind: fingerprint ? "git_remote" : "local_git",
          source_fingerprint: fingerprint,
          publication_remote_name: publication.remoteName,
          publication_repository_identity: publication.repositoryIdentity,
          max_access: root.max_access,
          allow_unconfined_shell: root.allow_unconfined_shell,
        });
      }
    }
    this.sourceCandidates.clear();
    for (const [candidateId, candidate] of discoveredCandidates)
      this.sourceCandidates.set(candidateId, candidate);
    await this.channel.sendProtocol({
      type: "workspace_sources",
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: this.config.workerId,
      candidates,
    });
  }

  private async bindWorkspaceSource(
    input: Record<string, unknown>,
  ): Promise<void> {
    const candidateId = String(input.candidate_id ?? "");
    const candidate = this.sourceCandidates.get(candidateId);
    if (!candidate)
      throw new Error(
        "Workspace source candidate is unknown or stale; discover again.",
      );
    const expectedFingerprint =
      typeof input.source_fingerprint === "string"
        ? input.source_fingerprint
        : null;
    const sourceKind = String(input.source_kind ?? "");
    const candidateKind = candidate.fingerprint ? "git_remote" : "local_git";
    if (sourceKind !== candidateKind)
      throw new Error(
        "Workspace source kind does not match the discovered repository.",
      );
    if (sourceKind === "git_remote" && !expectedFingerprint)
      throw new Error("A git_remote Workspace requires a source fingerprint.");
    if (expectedFingerprint && expectedFingerprint !== candidate.fingerprint)
      throw new Error(
        "Workspace source fingerprint does not match the logical Workspace.",
      );
    const binding = {
      binding_id: String(input.binding_id),
      workspace_id: String(input.workspace_id),
      authorized_root_key: candidate.rootKey,
      source_repository_root: candidate.path,
      source_fingerprint: candidate.fingerprint,
      publication_remote_name: candidate.publicationRemoteName,
      publication_repository_identity: candidate.publicationRepositoryIdentity,
      max_access: candidate.maxAccess,
      allow_unconfined_shell: candidate.allowShell,
    };
    if (
      !this.config.workspaceBindings.some(
        (item) => item.binding_id === binding.binding_id,
      )
    )
      this.config.workspaceBindings.push(binding);
    if (
      !this.capabilities.workspace_bindings.some(
        (item) => item.binding_id === binding.binding_id,
      )
    )
      this.capabilities.workspace_bindings.push(binding);
    persistWorkspaceBindings(this.config);
    await this.channel.sendProtocol({
      type: "workspace_binding_ready",
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: this.config.workerId,
      binding,
    });
  }

  private assertRunIdle(runId: string): void {
    const occupied = this.registry
      .list()
      .some(
        (dispatch) =>
          dispatch.action.run_id === runId &&
          ["accepted", "running", "uncertain"].includes(dispatch.state),
      );
    if (occupied)
      throw new DeliveryError(
        "run_execution_not_settled",
        "Run still has active or uncertain local execution.",
      );
  }

  private async handleDelivery(
    command: DeliveryCommand & { quest_title?: string },
    operation: "inspect" | "publish",
  ): Promise<void> {
    try {
      this.assertRunIdle(command.run_id);
      if (operation === "inspect") {
        const result = await this.deliveries.inspect(command);
        await this.channel.sendProtocol({
          type: "run_delivery_inspected",
          protocol_version: WORKER_PROTOCOL_VERSION,
          worker_id: this.config.workerId,
          delivery: {
            delivery_id: command.delivery_id,
            run_id: command.run_id,
            worktree_id: command.worktree_id,
            identity_hash: command.identity_hash,
            fingerprint: result.fingerprint,
            evidence: result.evidence,
            no_changes: result.noChanges,
            base_revision: result.record.baseRevision,
            base_branch_name: result.record.baseBranchName,
            branch_name: result.record.branchName,
            head_before_finalize: result.evidence.head_before_finalize,
            repository_host: "github.com",
            repository_identity: result.record.publicationRepositoryIdentity,
            remote_name: result.record.publicationRemoteName,
          },
        });
      } else {
        const result = await this.deliveries.publish(
          command,
          command.quest_title ?? "changes",
        );
        await this.channel.sendProtocol({
          type: "run_delivery_published",
          protocol_version: WORKER_PROTOCOL_VERSION,
          worker_id: this.config.workerId,
          delivery: {
            delivery_id: command.delivery_id,
            run_id: command.run_id,
            worktree_id: command.worktree_id,
            identity_hash: command.identity_hash,
            fingerprint: result.fingerprint,
            branch_name: result.record.branchName,
            head_revision: result.headRevision,
          },
        });
      }
    } catch (error) {
      const code =
        error instanceof DeliveryError ? error.code : "run_delivery_failed";
      await this.channel.sendProtocol({
        type: "run_delivery_failed",
        protocol_version: WORKER_PROTOCOL_VERSION,
        worker_id: this.config.workerId,
        delivery: {
          delivery_id: command.delivery_id,
          run_id: command.run_id,
          worktree_id: command.worktree_id,
          identity_hash: command.identity_hash,
          stage: operation,
          code,
          details: { message: safeDeliveryMessage(code) },
        },
      });
    }
  }

  private async reportWorktreeCommandFailure(
    request: Record<string, unknown>,
    error: unknown,
  ): Promise<void> {
    await this.channel.sendProtocol({
      type: "run_worktree_attention",
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: this.config.workerId,
      worktree_id: String(request.worktree_id ?? ""),
      run_id: String(request.run_id ?? ""),
      workspace_binding_id: String(request.workspace_binding_id ?? ""),
      identity_hash: String(request.identity_hash ?? ""),
      failure: {
        code:
          error instanceof DeliveryError
            ? error.code
            : "run_worktree_operation_failed",
        message:
          error instanceof Error
            ? error.message.slice(0, 500)
            : "Run worktree operation failed.",
      },
    });
  }

  private async reportWorktreeState(
    type: "run_worktree_retained" | "run_worktree_removed",
    record: RunWorktreeRecord,
  ): Promise<void> {
    await this.channel.sendProtocol({
      type,
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: this.config.workerId,
      worktree: {
        worktree_id: record.worktreeId,
        run_id: record.runId,
        workspace_binding_id: record.bindingId,
        identity_hash: record.identityHash,
      },
    });
  }

  private async reportWorktree(record: RunWorktreeRecord): Promise<void> {
    const common = {
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: this.config.workerId,
      worktree_id: record.worktreeId,
      run_id: record.runId,
      workspace_binding_id: record.bindingId,
      identity_hash: record.identityHash,
    };
    if (record.state === "ready" || record.state === "retained") {
      await this.channel.sendProtocol({
        type: "run_worktree_ready",
        ...common,
        worktree: {
          worktree_id: record.worktreeId,
          run_id: record.runId,
          workspace_binding_id: record.bindingId,
          base_revision: record.baseRevision,
          base_branch_name: record.baseBranchName,
          branch_name: record.branchName,
          publication_remote_name: record.publicationRemoteName,
          publication_repository_identity: record.publicationRepositoryIdentity,
          canonical_root: record.canonicalRoot,
          source_dirty_excluded: record.sourceDirtyExcluded,
          identity_hash: record.identityHash,
        },
      });
      return;
    }
    await this.channel.sendProtocol({
      type:
        record.state === "attention_required"
          ? "run_worktree_attention"
          : "run_worktree_failed",
      ...common,
      failure: {
        code: record.failureCode ?? "run_worktree_failed",
        ...(record.failureDetails ?? {}),
      },
    });
  }

  private async resolveUncertainDispatch(
    message: Record<string, unknown>,
  ): Promise<void> {
    const actionId = String(message.action_id ?? "");
    const resolution = String(message.resolution ?? "");
    if (!actionId || !["retry", "mark_failed"].includes(resolution))
      throw new Error("Invalid uncertain-dispatch resolution command.");

    const current = this.registry.get(actionId);
    if (current.state === "failed") return;
    if (current.state !== "uncertain")
      throw new Error(
        `Cannot resolve ${actionId} from local state ${current.state}.`,
      );

    const failed = this.registry.fail(
      actionId,
      {
        reason:
          resolution === "retry"
            ? "operator_retry_requested"
            : "operator_marked_failed",
      },
      false,
    );
    await this.report(dispatchPayload(failed, "failed"), "step_failed");
  }

  private async sendAcceptedOrState(dispatch: DispatchRecord): Promise<void> {
    if (dispatch.state === "accepted") {
      await this.channel.sendProtocol(
        identityMessage(this.config.workerId, dispatch, "dispatch_accepted"),
      );
      return;
    }
    if (dispatch.state === "completed") {
      await this.report(
        dispatchPayload(dispatch, "completed"),
        "step_completed",
      );
      return;
    }
    if (dispatch.state === "failed") {
      await this.report(dispatchPayload(dispatch, "failed"), "step_failed");
      return;
    }
    if (dispatch.state === "uncertain") {
      await this.report(
        dispatchPayload(dispatch, "uncertain"),
        "dispatch_state",
      );
      return;
    }
    await this.report(dispatchPayload(dispatch, "running"), "dispatch_state");
  }

  private reportHarnessSession(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<boolean> {
    const previous =
      this.sessionReports.get(lineage.lineageId) ?? Promise.resolve(false);
    const operation = previous
      .catch(() => false)
      .then(async () => {
        if (!this.channel.isRegistered()) return false;
        try {
          await this.channel.sendProtocol({
            type: "session_state",
            protocol_version: WORKER_PROTOCOL_VERSION,
            worker_id: this.config.workerId,
            session: harnessSessionPayload(dispatch, lineage, this.executor),
          });
          return true;
        } catch (error) {
          console.warn(
            `Could not report harness session ${lineage.lineageId}`,
            error instanceof Error ? error.message : String(error),
          );
          return false;
        }
      });
    this.sessionReports.set(lineage.lineageId, operation);
    void operation.finally(() => {
      if (this.sessionReports.get(lineage.lineageId) === operation)
        this.sessionReports.delete(lineage.lineageId);
    });
    return operation;
  }

  private async report(
    dispatch: ReconcileDispatch,
    type: DispatchReportType,
  ): Promise<boolean> {
    if (!this.channel.isRegistered()) return false;
    try {
      if (type === "step_completed" || type === "step_failed") {
        const local = this.registry.get(dispatch.action_id);
        const record = await this.worktrees.verify(
          local.action.execution.execution_workspace.worktree_id,
        );
        if (record.state !== "ready") {
          await this.channel.sendProtocol({
            type: "run_worktree_integrity_failed",
            protocol_version: WORKER_PROTOCOL_VERSION,
            worker_id: this.config.workerId,
            action_id: dispatch.action_id,
            failure: {
              code: record.failureCode ?? "run_worktree_integrity_violation",
              message:
                "Run worktree failed post-execution integrity verification.",
            },
          });
        }
      }
      const message = dispatchReportMessage(
        this.config.workerId,
        dispatch,
        type,
      );
      const response = await this.channel.sendProtocol(message);
      return (
        type !== "step_completed" || response.result === "completion_applied"
      );
    } catch (error) {
      console.warn(
        `Could not report ${type} for ${dispatch.action_id}`,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }
}

function harnessSessionPayload(
  dispatch: DispatchRecord,
  lineage: HarnessLineage,
  executor: DispatchExecutor,
): ReconcileSession {
  const capability = lineage.capabilities;
  let terminal: ReconcileSession["terminal"] = null;
  if (capability.canAttachTerminal) {
    try {
      const descriptor = executor.attachment(dispatch.action.action_id);
      terminal = {
        attachment_mode: descriptor.mode,
        backend_kind: descriptor.backendKind,
        terminal_session_id: descriptor.terminalSessionId,
        terminal_target_id: descriptor.terminalTargetId,
        ...(descriptor.terminalId
          ? { terminal_id: descriptor.terminalId }
          : {}),
        supports_observation: descriptor.supportsObservation,
        supports_takeover: descriptor.supportsTakeover,
      };
    } catch {
      terminal = null;
    }
  }
  return {
    session_id: lineage.lineageId,
    action_id: dispatch.action.action_id,
    run_id: dispatch.action.run_id,
    occurrence_id: dispatch.action.occurrence_id,
    attempt_id: dispatch.action.attempt_id,
    member_key: dispatch.action.execution.performer.member_key,
    harness_kind: lineage.harnessKind,
    harness_display_name:
      lineage.harnessKind === "pi"
        ? "Pi"
        : lineage.harnessKind === "antigravity"
          ? "Antigravity"
          : "Test Harness",
    state: lineage.sessionState,
    capabilities: {
      can_attach_terminal: capability.canAttachTerminal,
      can_send_input: capability.canSendInput,
      can_interrupt: capability.canInterrupt,
      can_detect_attention: capability.canDetectAttention,
      can_resume: capability.canResume,
      can_observe_structured_events: capability.canObserveStructuredEvents,
      structured_confirmation: capability.structuredConfirmation,
      structured_text_response: capability.structuredTextResponse,
      structured_choice_response: capability.structuredChoiceResponse,
      structured_multiline_response: capability.structuredMultilineResponse,
      native_prompt_control: capability.nativePromptControl,
      conversational_takeover: capability.conversationalTakeover,
      automation_resume: capability.automationResume,
    },
    terminal,
    native_session_id:
      lineage.nativeSession?.kind === "id" ? lineage.nativeSession.value : null,
    attention: lineage.attention
      ? {
          attention_id: lineage.attention.attentionId,
          category: lineage.attention.category,
          message: lineage.attention.message,
          requested_at: lineage.attention.requestedAt,
          ...(lineage.attention.interaction
            ? {
                interaction: {
                  kind: lineage.attention.interaction.kind,
                  control_state: lineage.attention.interaction.controlState,
                  ...(lineage.attention.interaction.resumeCommand
                    ? {
                        resume_command:
                          lineage.attention.interaction.resumeCommand,
                      }
                    : {}),
                },
              }
            : {}),
        }
      : null,
    intervention: lineage.intervention
      ? {
          attention_id: lineage.intervention.attentionId,
          kind: lineage.intervention.kind,
          state: lineage.intervention.state,
          requested_at: lineage.intervention.requestedAt,
          ...(lineage.intervention.handedBackAt
            ? { handed_back_at: lineage.intervention.handedBackAt }
            : {}),
          ...(lineage.intervention.automationResumedAt
            ? {
                automation_resumed_at: lineage.intervention.automationResumedAt,
              }
            : {}),
        }
      : null,
    started_at: lineage.startedAt,
    last_activity_at: lineage.lastActivityAt,
  };
}

function discoverGitRoots(
  root: string,
  depth: number,
  excludedRoot: string,
): string[] {
  const found: string[] = [];
  const visit = (path: string, remaining: number) => {
    if (
      resolve(path) === resolve(excludedRoot) ||
      contained(excludedRoot, path)
    )
      return;
    if (existsSync(join(path, ".git"))) {
      found.push(resolve(path));
      return;
    }
    if (remaining === 0) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = join(path, entry.name);
      try {
        if (statSync(child).isDirectory()) visit(child, remaining - 1);
      } catch {
        /* disappeared during bounded discovery */
      }
    }
  };
  visit(root, depth);
  return found;
}
function contained(parent: string, child: string): boolean {
  const value = relative(resolve(parent), resolve(child));
  return value === "" || (!value.startsWith("..") && !value.startsWith("/"));
}
async function publicationMetadata(path: string): Promise<{
  fingerprint: string | null;
  remoteName: string | null;
  repositoryIdentity: string | null;
}> {
  const namesProcess = Bun.spawn(["git", "-C", path, "remote"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const names = (await new Response(namesProcess.stdout).text())
    .trim()
    .split("\n")
    .filter(Boolean);
  if ((await namesProcess.exited) !== 0)
    return { fingerprint: null, remoteName: null, repositoryIdentity: null };
  const remoteName = names.includes("origin")
    ? "origin"
    : names.length === 1
      ? names[0]
      : null;
  if (!remoteName)
    return { fingerprint: null, remoteName: null, repositoryIdentity: null };
  const process = Bun.spawn(
    ["git", "-C", path, "remote", "get-url", remoteName],
    { stdout: "pipe", stderr: "ignore" },
  );
  const output = (await new Response(process.stdout).text()).trim();
  if ((await process.exited) !== 0 || !output)
    return { fingerprint: null, remoteName, repositoryIdentity: null };
  const fingerprint = credentialFreeRemote(output);
  return {
    fingerprint,
    remoteName,
    repositoryIdentity: githubRepository(output),
  };
}
function credentialFreeRemote(output: string): string {
  try {
    const url = new URL(output);
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return output
      .replace(/^([^@]+@)/, "")
      .replace(/\.git$/, "")
      .toLowerCase();
  }
}
function githubRepository(output: string): string | null {
  const clean = output
    .replace(/\?.*$/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const match = clean.match(
    /(?:https?:\/\/|ssh:\/\/git@|git@)github\.com(?::|\/)([^/]+)\/([^/]+)$/i,
  );
  return match ? `${match[1]}/${match[2]}` : null;
}

function safeDeliveryMessage(code: string): string {
  const messages: Record<string, string> = {
    git_identity_missing: "Git commit identity is not configured.",
    git_identity_invalid: "Git commit identity configuration is incomplete.",
    remote_branch_conflict: "The remote Run branch differs from this Delivery.",
    delivery_content_changed:
      "Run workspace content changed after Delivery inspection.",
    cross_repository_pull_request_not_supported:
      "v0.13 supports same-repository GitHub Pull Requests only.",
    base_branch_unresolved: "The Run base branch is unavailable.",
    base_branch_missing_on_remote:
      "The persisted base branch is unavailable on the publication remote.",
  };
  return messages[code] ?? "Publishing requires attention.";
}

function identityMessage(
  workerId: string,
  dispatch: DispatchRecord,
  type: string,
): Record<string, unknown> {
  return {
    type,
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: workerId,
    action_id: dispatch.action.action_id,
    occurrence_id: dispatch.action.occurrence_id,
    attempt_id: dispatch.action.attempt_id,
  };
}
type DispatchReportType = "step_completed" | "step_failed" | "dispatch_state";

export function dispatchReportMessage(
  workerId: string,
  dispatch: ReconcileDispatch,
  type: DispatchReportType,
): Record<string, unknown> {
  const reportsState = type === "dispatch_state";
  const reportsCompletion =
    type === "step_completed" ||
    (reportsState && dispatch.state === "completed");
  const reportsFailure =
    type === "step_failed" ||
    (reportsState &&
      (dispatch.state === "failed" || dispatch.state === "uncertain"));
  return {
    type,
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: workerId,
    action_id: dispatch.action_id,
    occurrence_id: dispatch.occurrence_id,
    attempt_id: dispatch.attempt_id,
    ...(reportsState ? { state: dispatch.state } : {}),
    ...(reportsCompletion ? { outputs: dispatch.outputs ?? {} } : {}),
    ...(reportsFailure
      ? {
          failure: dispatch.failure ?? {
            reason:
              dispatch.state === "uncertain"
                ? "execution_uncertain"
                : "execution_failed",
          },
        }
      : {}),
  };
}

async function writeRecoveryResult(
  path: string,
  request: Record<string, unknown>,
  state: "authorized" | "rejected",
  fields: Record<string, unknown>,
): Promise<void> {
  if (!existsSync(path)) return;
  try {
    const current = JSON.parse(await Bun.file(path).text()) as Record<
      string,
      unknown
    >;
    if (
      current.state !== "requested" ||
      current.requestId !== request.requestId
    )
      return;
  } catch {
    return;
  }
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({ ...request, ...fields, state })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  await rename(temporary, path);
}

function dispatchPayload(
  dispatch: DispatchRecord,
  state: "running" | "completed" | "failed" | "uncertain",
): ReconcileDispatch {
  return {
    action_id: dispatch.action.action_id,
    occurrence_id: dispatch.action.occurrence_id,
    attempt_id: dispatch.action.attempt_id,
    state,
    ...(state === "completed" && dispatch.outputs
      ? { outputs: dispatch.outputs }
      : {}),
    ...(state === "failed" || state === "uncertain"
      ? { failure: dispatch.failure ?? { reason: "execution_uncertain" } }
      : {}),
  };
}
