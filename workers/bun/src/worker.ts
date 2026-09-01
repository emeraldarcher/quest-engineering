import { createHash } from "node:crypto";
import { existsSync, readdirSync, statSync } from "node:fs";
import { arch, platform } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import {
  assertExecutionSupported,
  workerCapabilities,
} from "./capabilities.ts";
import type { WorkerConfig } from "./config.ts";
import { DispatchExecutor } from "./dispatch/executor.ts";
import { type DispatchRecord, DispatchRegistry } from "./dispatch/registry.ts";
import { decodeExecuteAction } from "./protocol/codec.ts";
import { PhoenixWorkerChannel } from "./protocol/phoenix-channel.ts";
import type {
  ReconcileDispatch,
  WorkerCapabilities,
} from "./protocol/types.ts";
import { WORKER_PROTOCOL_VERSION } from "./protocol/types.ts";
import { FakeAgentProvider } from "./providers/fake/provider.ts";
import { PiProvider } from "./providers/pi/provider.ts";
import type { AgentProvider } from "./providers/types.ts";
import { LocalHerdrConnectionProvider } from "./session-host/herdr/connection.ts";
import { HerdrSessionHost } from "./session-host/herdr/session-host.ts";
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
  private readonly channel: PhoenixWorkerChannel;
  private readonly capabilities: WorkerCapabilities;
  private stopping = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
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
    this.registry = new DispatchRegistry(
      join(config.dataRoot, "dispatches.sqlite"),
      config.dataRoot,
    );
    const provider: AgentProvider =
      config.provider === "fake"
        ? new FakeAgentProvider(config.fakeOutputs, config.fakeDelayMs)
        : new PiProvider(
            new HerdrSessionHost(
              new LocalHerdrConnectionProvider(config.herdrSession),
            ),
            config,
          );
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
      provider,
      (dispatch, type) => this.report(dispatch, type),
    );
  }

  async run(): Promise<void> {
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

  attachInfo(actionId: string) {
    return this.executor.attachInfo(actionId);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.channel.close();
    this.executor.disconnect();
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
      const acceptance = this.executor.accept(action);
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
      const response = await this.channel.sendProtocol({
        type: "reconcile_state",
        protocol_version: WORKER_PROTOCOL_VERSION,
        worker_id: this.config.workerId,
        dispatches,
      });
      if (response.result === "reconciled") {
        for (const dispatch of this.registry.list()) {
          if (dispatch.state === "completed")
            this.registry.acknowledgeServerCompletion(
              dispatch.action.action_id,
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
    }, this.config.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private async reportWorkspaceSources(): Promise<void> {
    this.sourceCandidates.clear();
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
        this.sourceCandidates.set(candidateId, {
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

  private async report(
    dispatch: ReconcileDispatch,
    type: "step_completed" | "step_failed" | "dispatch_state",
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
      const message: Record<string, unknown> = {
        type,
        protocol_version: WORKER_PROTOCOL_VERSION,
        worker_id: this.config.workerId,
        action_id: dispatch.action_id,
        occurrence_id: dispatch.occurrence_id,
        attempt_id: dispatch.attempt_id,
        ...(type === "dispatch_state" ? { state: dispatch.state } : {}),
        ...(type === "step_completed"
          ? { outputs: dispatch.outputs ?? {} }
          : {}),
        ...(type === "step_failed"
          ? { failure: dispatch.failure ?? { reason: "execution_failed" } }
          : {}),
      };
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
