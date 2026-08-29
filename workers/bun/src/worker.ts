import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
  type ProvisionRunWorktree,
  type RunWorktreeRecord,
  RunWorktreeRegistry,
} from "./workspace/run-worktrees.ts";

export class QuestEngineeringWorker {
  readonly registry: DispatchRegistry;
  readonly executor: DispatchExecutor;
  readonly worktrees: RunWorktreeRegistry;
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
    }
  >();

  constructor(private readonly config: WorkerConfig) {
    this.worktrees = new RunWorktreeRegistry(config);
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
        onRegistered: () => this.onRegistered(),
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
      await this.bindWorkspaceSource(
        message.binding as Record<string, unknown>,
      );
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
          const observed =
            record.state === "ready" || record.state === "retained"
              ? await this.worktrees.verify(id)
              : record;
          await this.reportWorktree(observed);
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

  private async onRegistered(): Promise<void> {
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
        const fingerprint = await remoteFingerprint(path);
        this.sourceCandidates.set(candidateId, {
          rootKey: root.key,
          path,
          maxAccess: root.max_access,
          allowShell: root.allow_unconfined_shell,
          fingerprint,
        });
        candidates.push({
          candidate_id: candidateId,
          name: basename(path),
          source_kind: fingerprint ? "git_remote" : "local_git",
          source_fingerprint: fingerprint,
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
    const configuredIds = new Set(
      (process.env.QE_WORKSPACE_BINDINGS_JSON
        ? JSON.parse(process.env.QE_WORKSPACE_BINDINGS_JSON)
        : []
      ).map((item: { binding_id?: string }) => item.binding_id),
    );
    const persisted = this.config.workspaceBindings.filter(
      (item) => !configuredIds.has(item.binding_id),
    );
    const path = join(this.config.dataRoot, "workspace-bindings.json");
    const temporary = `${path}.tmp`;
    writeFileSync(temporary, JSON.stringify(persisted, null, 2), {
      mode: 0o600,
    });
    renameSync(temporary, path);
    await this.channel.sendProtocol({
      type: "workspace_binding_ready",
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: this.config.workerId,
      binding,
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
          branch_name: record.branchName,
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
async function remoteFingerprint(path: string): Promise<string | null> {
  const process = Bun.spawn(
    ["git", "-C", path, "config", "--get", "remote.origin.url"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const output = (await new Response(process.stdout).text()).trim();
  if ((await process.exited) !== 0 || !output) return null;
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
