import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { WorkerConfig } from "../../config.ts";
import type {
  DispatchRecord,
  HarnessLineage,
} from "../../dispatch/registry.ts";
import {
  type ClaudeCodeAccountRuntime,
  claudeAccountEnvironment,
  type ProviderAccountEnvironmentManager,
} from "../../execution-environment/provider-account.ts";
import {
  SBX_CLAUDE_ACCOUNT_MOD_PROTOCOL,
  SBX_CLAUDE_CODE_VERSION,
  SBX_CLAUDE_EXECUTABLE,
} from "../../execution-environment/sbx-profile.ts";
import type {
  PreparedSbxHarnessExecution,
  SbxRunExecutionManager,
} from "../../execution-environment/sbx-run.ts";
import type { StreamedProcess } from "../../execution-environment/types.ts";
import type { JsonValue } from "../../protocol/types.ts";
import {
  CLAUDE_SUBSCRIPTION_CONFIGURATION,
  classifyClaudeSubscriptionAuthStatus,
  isProviderAuthenticationReady,
} from "../../provider-auth.ts";
import { materializeExecutionArtifacts } from "../../workspace/execution-artifacts.ts";
import type {
  BoundWorkspaceToolClient,
  WorkspaceToolBroker,
} from "../../workspace-tool-broker.ts";
import { controlDescriptorPath } from "../control/authority.ts";
import { HarnessControlClient } from "../control/client.ts";
import { collectStepResult } from "../control/result-envelope.ts";
import { nativeSessionRef } from "../native-session.ts";
import { harnessPromptFor } from "../prompt.ts";
import type { HarnessTransportBinding } from "../transport-binding.ts";
import { structuredResultExists } from "../turn-lifecycle.ts";
import type {
  AgentHarness,
  HarnessCapabilities,
  HarnessDiscovery,
  HarnessEvent,
  HarnessExecutionHandle,
  HarnessInspection,
  HarnessPreparedExecution,
  HarnessRecoveredExecution,
} from "../types.ts";
import { OperationalExecutionError } from "../types.ts";
import { ClaudeAccountCellRelay, newBridgeToken } from "./account-relay.ts";
import {
  attestClaudeEffort,
  CLAUDE_CODE_EFFORT,
  supportsClaudeReasoning,
} from "./effort-readiness.ts";
import {
  decodeClaudeOutputTag,
  hasClaudeRoot,
  isClaudeInit,
  isClaudeResultSuccess,
} from "./output-tags.ts";
import {
  AsyncFrameQueue,
  ClaudeProtocolTimeout,
  cancelClaudePreparation,
  observeClaudeProtocol,
  rejectServerToolEvidence,
  sendMessage,
  waitForInit,
} from "./protocol.ts";
import {
  type ProbeCancellationScope,
  QueuedProbeCancellation,
} from "./queued-probe-cancellation.ts";
import {
  type ClaudeCodeSessionRecord,
  ClaudeCodeSessionStore,
} from "./session-store.ts";

export { CLAUDE_CODE_EFFORT } from "./effort-readiness.ts";

export const CLAUDE_CODE_HARNESS_KIND = "claude_code" as const;
export const CLAUDE_CODE_MODEL = "claude-opus-4-6" as const;
export const CLAUDE_CODE_PLUGIN_NAME = "qe-account-cell" as const;
export const CLAUDE_CODE_PLUGIN_PATH =
  "/opt/qe/claude-plugins/plugins/qe-account-cell" as const;

export const CLAUDE_CODE_TOOLS = Object.freeze([
  "mcp__qe-account-cell__qe_workspace_read",
  "mcp__qe-account-cell__qe_workspace_list",
  "mcp__qe-account-cell__qe_workspace_write",
  "mcp__qe-account-cell__qe_workspace_edit",
  "mcp__qe-account-cell__qe_workspace_search",
  "mcp__qe-account-cell__qe_run_shell",
  "mcp__qe-account-cell__qe_complete_step",
  "mcp__qe-account-cell__qe_request_human_assistance_and_wait",
]);

const CAPABILITIES: HarnessCapabilities = Object.freeze({
  structuredResult: true,
  continuation: true,
  retainedSessionRecovery: true,
  structuredAttention: true,
  nativeBlocking: true,
  canAttachTerminal: false,
  canSendInput: false,
  canInterrupt: true,
  canDetectAttention: true,
  canResume: true,
  canObserveStructuredEvents: true,
  structuredConfirmation: true,
  structuredTextResponse: true,
  structuredChoiceResponse: true,
  structuredMultilineResponse: true,
  nativePromptControl: true,
  conversationalTakeover: false,
  automationResume: false,
});

interface ActiveClaudeCodeExecution {
  dispatch: DispatchRecord;
  lineageId: string;
  account: ClaudeCodeAccountRuntime;
  runPrepared: PreparedSbxHarnessExecution;
  accountId: string;
  session: ClaudeCodeSessionRecord;
  process: StreamedProcess;
  broker: BoundWorkspaceToolClient;
  control: HarnessControlClient;
  relay: ClaudeAccountCellRelay;
  frames: AsyncFrameQueue;
  inspection: HarnessInspection;
  initialized: boolean;
  promptSubmitted: boolean;
  promptAccepted: boolean;
  continuationCount: number;
  fatal: Error | null;
  disconnected: boolean;
  queuedProbeCancellation: QueuedProbeCancellation | null;
}

export class ClaudeCodeHarness implements AgentHarness {
  readonly kind = CLAUDE_CODE_HARNESS_KIND;
  readonly displayName = "Claude Code (managed QE account cell)";
  readonly integrationStrategy = "structured_headless" as const;
  readonly capabilities = CAPABILITIES;
  readonly humanAttentionWaitRecoverability = "wait_not_recoverable" as const;
  private readonly active = new Map<string, ActiveClaudeCodeExecution>();
  private readonly sessions: ClaudeCodeSessionStore;

  constructor(
    private readonly config: WorkerConfig,
    private readonly runManager: SbxRunExecutionManager,
    private readonly accounts: ProviderAccountEnvironmentManager,
    private readonly brokerProvider: () => WorkspaceToolBroker,
    sessionStore?: ClaudeCodeSessionStore,
    private readonly currentDispatch?: (
      actionId: string,
    ) => DispatchRecord | null,
  ) {
    this.sessions =
      sessionStore ?? new ClaudeCodeSessionStore(this.config.dataRoot);
  }

  async discover(): Promise<HarnessDiscovery> {
    const configured = (this.config.executorModels ?? []).filter(
      (candidate) =>
        candidate.provider === "anthropic" &&
        candidate.model === CLAUDE_CODE_MODEL,
    );
    return {
      kind: this.kind,
      displayName: this.displayName,
      strategy: this.integrationStrategy,
      integration: {
        status: configured.length > 0 ? "ready" : "missing_dependency",
        detail:
          configured.length > 0
            ? `Claude Code ${SBX_CLAUDE_CODE_VERSION} is pinned to the immutable managed-Mod account profile.`
            : `Configure exact model anthropic/${CLAUDE_CODE_MODEL}.`,
        installed: true,
        authenticated: false,
        setupAvailable: true,
      },
      models: configured.map((candidate) => ({
        provider: candidate.provider,
        model: candidate.model,
        displayName: `${candidate.provider}/${candidate.model}`,
        accountAvailability: "unknown",
        reasoningCapability: {
          kind: "enumerated",
          values: [CLAUDE_CODE_EFFORT],
        },
      })),
      capabilities: this.capabilities,
    };
  }

  start(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    return this.prepare(dispatch, lineage, false);
  }

  continue(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    this.active.get(lineage.lineageId)?.queuedProbeCancellation?.invalidate();
    return this.prepare(dispatch, lineage, true);
  }

  async ready(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
  ): Promise<void> {
    const active = this.required(execution.lineage.lineageId);
    assertDispatch(active, dispatch);
    if (!active.initialized || active.fatal)
      throw claudeError(
        "environment_attestation_failed",
        active.fatal?.message ??
          "Claude Code zero-inference readiness is incomplete.",
        "readiness",
        "not_submitted",
      );
    active.account.assertCurrent();
  }

  async sendInputAndCollect(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    const active = this.required(execution.lineage.lineageId);
    assertDispatch(active, dispatch);
    return this.accounts.withSerializedAccount(active.accountId, async () => {
      active.account.assertCurrent();
      const prompt = harnessPromptFor(
        dispatch,
        active.runPrepared.materializedArtifacts,
        {
          completionTool: "qe_complete_step",
          humanAssistanceInstruction:
            "Use qe_request_human_assistance_and_wait for a durable blocking request. Wait for its exact response and never infer one.",
          recoveryContext: "QE-owned Claude Code native session",
        },
      );
      onEvent({
        type: "prompt_baseline",
        evidence: {
          kind: "claude_stream",
          cursor: active.frames.cursor,
          promptHash: digest(prompt),
        },
        inspection: inspection(active, "waiting_for_activity", "idle"),
      });
      active.promptSubmitted = true;
      active.promptAccepted = false;
      this.sessions.transition(
        active.session.nativeSessionId,
        ["prepared", "idle"],
        "active",
      );
      active.session = this.sessions.get(
        active.session.nativeSessionId,
      ) as ClaudeCodeSessionRecord;
      try {
        await sendMessage(
          active.process,
          active.session.nativeSessionId,
          prompt,
          true,
        );
      } catch (error) {
        this.markUncertain(active);
        throw claudeError(
          "agent_prompt_uncertain",
          error instanceof Error
            ? error.message
            : "Claude prompt submission is uncertain.",
          "execute",
          "ambiguous",
        );
      }
      return this.collect(dispatch, active, onEvent);
    });
  }

  async waitAndCollect(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    _handle: HarnessExecutionHandle,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    if (await structuredResultExists(dispatch.resultDirectory))
      return (await collectStepResult(dispatch)).envelope.outputs;
    const active = this.required(lineage.lineageId);
    return this.accounts.withSerializedAccount(active.accountId, async () => {
      if (!active.promptSubmitted) {
        active.promptSubmitted = true;
        this.sessions.transition(
          active.session.nativeSessionId,
          ["prepared", "idle", "uncertain"],
          "active",
        );
        await sendMessage(
          active.process,
          active.session.nativeSessionId,
          "Quest Engineering recovery: continue the already-authorized Step from the exact retained Claude session. Inspect current Run workspace state through QE broker tools, avoid repeating completed mutations, and call qe_complete_step with exactly the declared outputs.",
          true,
        );
      }
      return this.collect(dispatch, active, onEvent);
    });
  }

  async recover(
    lineage: HarnessLineage,
    dispatch?: DispatchRecord,
  ): Promise<HarnessRecoveredExecution> {
    this.active.get(lineage.lineageId)?.queuedProbeCancellation?.invalidate();
    if (!dispatch)
      return {
        found: false,
        detail: "Claude recovery requires the exact Dispatch.",
      };
    if (
      dispatch.promptIntentAt &&
      !(await structuredResultExists(dispatch.resultDirectory))
    )
      return {
        found: false,
        detail:
          "Claude prompt submission crossed the side-effect boundary without a recoverable attached stream; QE refuses to resubmit or infer the provider outcome.",
      };
    try {
      const prepared = await this.prepare(dispatch, lineage, true, true);
      const active = this.required(lineage.lineageId);
      return {
        found: true,
        handle: prepared.handle,
        inspection: active.inspection,
        detail:
          "Rebound the exact QE-owned Claude session after retiring stale account-cell process attachments.",
      };
    } catch (error) {
      return {
        found: false,
        detail:
          error instanceof Error ? error.message : "Claude recovery failed.",
      };
    }
  }

  async interrupt(lineage: HarnessLineage): Promise<void> {
    const active = this.active.get(lineage.lineageId);
    if (!active) return;
    active.queuedProbeCancellation?.invalidate();
    active.disconnected = true;
    await Promise.allSettled([
      active.process.cancel(),
      active.relay.stop(),
      active.broker.close(),
    ]);
    this.markUncertain(active);
    this.active.delete(lineage.lineageId);
  }

  revokeDiagnosticCapabilities(actionId: string): void {
    for (const active of this.active.values())
      if (active.dispatch.action.action_id === actionId)
        active.queuedProbeCancellation?.invalidate();
  }

  async retire(lineage: HarnessLineage): Promise<void> {
    await this.close(lineage);
  }

  async close(lineage: HarnessLineage): Promise<void> {
    const active = this.active.get(lineage.lineageId);
    if (active) {
      active.queuedProbeCancellation?.invalidate();
      active.disconnected = true;
      await Promise.allSettled([
        active.process.cancel(),
        active.relay.stop(),
        active.broker.close(),
      ]);
      this.active.delete(lineage.lineageId);
    }
    this.sessions.closeLineage(lineage.lineageId);
  }

  inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    const active = this.active.get(lineage.lineageId);
    if (active) return Promise.resolve(structuredClone(active.inspection));
    const record = this.sessions.forLineage(lineage.lineageId);
    return Promise.resolve({
      state: record?.state === "idle" ? "retained" : "unavailable",
      activity: {
        state: record?.state === "idle" ? "idle" : "unknown",
        detail: record
          ? `Claude session is durably recorded in ${record.state} state.`
          : "No QE-owned Claude session record exists.",
      },
      nativeSession: record
        ? nativeSessionRef(this.kind, "id", record.nativeSessionId)
        : null,
      health: record?.state === "idle" ? "healthy" : "unavailable",
      attention: lineage.attention,
      intervention: lineage.intervention,
      lastActivityAt: record?.updatedAt ?? new Date().toISOString(),
      interactive: null,
    });
  }

  async proveInactiveForFreshRecovery(
    lineage: HarnessLineage,
  ): Promise<boolean> {
    const active = this.active.get(lineage.lineageId);
    return !active || active.session.state === "idle";
  }

  clearActiveMetadata(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void> {
    const active = this.active.get(lineage.lineageId);
    if (
      active &&
      active.dispatch.action.action_id === dispatch.action.action_id
    ) {
      active.queuedProbeCancellation?.invalidate();
      active.promptSubmitted = false;
      active.promptAccepted = false;
      active.session = this.sessions.transition(
        active.session.nativeSessionId,
        ["active", "idle"],
        "idle",
      );
      active.inspection = inspection(active, "retained", "completed");
    }
    return Promise.resolve();
  }

  discoverAdoptionCandidates(): Promise<[]> {
    return Promise.resolve([]);
  }

  disconnect(): void {
    for (const active of this.active.values()) {
      active.queuedProbeCancellation?.invalidate();
      active.disconnected = true;
      this.markUncertain(active);
      void active.process.cancel();
      void active.relay.stop();
      void active.broker.close();
    }
    this.active.clear();
  }

  private async prepare(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    continuation: boolean,
    recovering = false,
  ): Promise<HarnessPreparedExecution> {
    assertExactConfiguration(dispatch);
    const runPrepared = await this.runManager.prepare(
      dispatch,
      lineage,
      materializeExecutionArtifacts(this.config, dispatch),
    );
    const admitted = await waitForBroker(
      this.brokerProvider(),
      dispatch.action.action_id,
    );
    const binding = admitted.binding;
    assertBrokerBinding(dispatch, binding);
    const acquireAccountRuntime = () =>
      this.accounts.claudeCodeRuntime({
        providerAccountId: binding.providerAccountId,
        credentialGeneration: binding.credentialGeneration,
        authority: admitted.accountAuthority,
      });
    const existing = this.active.get(lineage.lineageId);
    if (existing) {
      if (!continuation)
        throw new Error(
          "Fresh Claude execution cannot reuse an active session.",
        );
      assertSessionBinding(existing.session, lineage, binding);
      // Continuation may replace the admitted broker session. Reacquire its
      // live authority instead of retaining the previous Action's revoked one.
      const account = await acquireAccountRuntime();
      const priorBroker = existing.broker;
      existing.queuedProbeCancellation?.invalidate();
      existing.queuedProbeCancellation = null;
      existing.account = account;
      existing.dispatch = dispatch;
      existing.runPrepared = runPrepared;
      existing.broker = admitted.client;
      existing.relay.rebind(admitted.client, existing.account.assertCurrent);
      if (priorBroker.sessionId !== admitted.client.sessionId)
        await priorBroker.close();
      existing.initialized = false;
      try {
        await this.accounts.withSerializedAccount(
          binding.providerAccountId,
          async () => {
            account.assertCurrent();
            await attestClaudeEffort(
              existing.process,
              existing.frames,
              {
                sessionId: existing.session.nativeSessionId,
                model: CLAUDE_CODE_MODEL,
                effort: CLAUDE_CODE_EFFORT,
              },
              Date.now() + 30_000,
            );
            account.assertCurrent();
          },
        );
        existing.initialized = true;
      } catch {
        await this.interrupt(lineage);
        throw claudeError(
          "environment_attestation_failed",
          "Claude Code effective model/effort readiness was not proven.",
          "readiness",
          "not_submitted",
        );
      }
      existing.inspection = inspection(existing, "starting", "idle");
      return prepared(lineage, existing);
    }
    const durable = this.sessions.forLineage(lineage.lineageId);
    if (continuation && !durable)
      throw new Error(
        "Claude continuation has no exact QE-owned session record.",
      );
    if (continuation && durable?.state === "closed")
      throw new Error(
        "Claude continuation cannot resume a closed native session.",
      );
    if (!continuation && durable)
      throw new Error(
        "Fresh Claude execution cannot reuse any prior native session record.",
      );
    const nativeSessionId =
      continuation && durable ? durable.nativeSessionId : randomUUID();
    if (durable) assertSessionBinding(durable, lineage, binding);
    const account = await acquireAccountRuntime();
    return this.accounts.withSerializedAccount(
      binding.providerAccountId,
      async () => {
        account.assertCurrent();
        if (recovering)
          await this.accounts.retireClaudeAccountProcesses(account.ref);
        await assertAuthenticated(account);
        account.assertCurrent();
        const mailboxRoot = posix.join(
          account.lease.paths.control,
          "claude",
          digest(lineage.lineageId).slice(0, 32),
        );
        const bridgeToken = newBridgeToken();
        const control = new HarnessControlClient(
          controlDescriptorPath(lineage),
        );
        const relay = new ClaudeAccountCellRelay(
          account.lease,
          mailboxRoot,
          bridgeToken,
          admitted.client,
          control,
          account.assertCurrent,
          (error) => {
            const current = this.active.get(lineage.lineageId);
            if (!current) return;
            current.queuedProbeCancellation?.invalidate();
            current.fatal = error;
            current.inspection = inspection(current, "unavailable", "unknown");
            void current.process.cancel();
          },
        );
        await relay.start();
        const diagnostics = this.sessions.lifecycle.begin({
          lineageId: lineage.lineageId,
          harnessKind: this.kind,
          harnessProtocol: SBX_CLAUDE_ACCOUNT_MOD_PROTOCOL,
          reservedNativeSessionId: nativeSessionId,
          environment: account.ref,
        });
        let process: StreamedProcess;
        try {
          account.assertCurrent();
          diagnostics?.record("process_launch_requested");
          process = await account.lease.spawnStreamed(
            claudeCodeCommand(
              account,
              nativeSessionId,
              continuation || Boolean(durable),
              mailboxRoot,
              bridgeToken,
            ),
            { bufferBytes: 1024 * 1024, acknowledgementTimeoutMs: 30_000 },
          );
        } catch (error) {
          await relay.stop();
          throw error;
        }
        diagnostics?.bindProcess(process.handle);
        const session =
          durable ??
          this.sessions.create({
            nativeSessionId,
            lineageId: lineage.lineageId,
            logicalLineageId: lineage.logicalLineageId,
            providerAccountId: binding.providerAccountId,
            credentialGeneration: binding.credentialGeneration,
            accountEnvironmentId: binding.accountEnvironment.environmentId,
            accountEnvironmentIncarnation:
              binding.accountEnvironment.incarnation,
            model: CLAUDE_CODE_MODEL,
            effort: CLAUDE_CODE_EFFORT,
          });
        const frames = new AsyncFrameQueue();
        const active: ActiveClaudeCodeExecution = {
          dispatch,
          lineageId: lineage.lineageId,
          account,
          runPrepared,
          accountId: binding.providerAccountId,
          session,
          process,
          broker: admitted.client,
          control,
          relay,
          frames,
          inspection: emptyInspection(nativeSessionId),
          initialized: false,
          promptSubmitted: false,
          promptAccepted: false,
          continuationCount: 0,
          fatal: null,
          disconnected: false,
          queuedProbeCancellation: null,
        };
        this.active.set(lineage.lineageId, active);
        const scope: ProbeCancellationScope = {
          runId: dispatch.action.run_id,
          attemptId: dispatch.action.attempt_id,
          actionId: dispatch.action.action_id,
          lineageId: lineage.lineageId,
          sessionId: nativeSessionId,
          process,
        };
        try {
          // Establish ownership once BEFORE the probe/budget. No store lookup
          // is permitted in the later timeout dispatch or response path. ACKs
          // after this synchronous check revoke via the executor's hook.
          const canonical =
            !continuation &&
            !recovering &&
            !dispatch.action.operational_recovery
              ? this.currentDispatch?.(scope.actionId)
              : null;
          if (
            !continuation &&
            !recovering &&
            !dispatch.action.operational_recovery &&
            canonical &&
            ["accepted", "running"].includes(canonical.state) &&
            !canonical.serverAcknowledgedAt &&
            !canonical.settledAt &&
            !canonical.action.operational_recovery &&
            canonical.action.action_id === scope.actionId &&
            canonical.action.run_id === scope.runId &&
            canonical.action.attempt_id === scope.attemptId &&
            canonical.lineageId === scope.lineageId
          ) {
            active.queuedProbeCancellation = new QueuedProbeCancellation(
              scope,
              () => {
                const current = active.dispatch;
                if (
                  !current ||
                  current.action.operational_recovery ||
                  current.serverAcknowledgedAt ||
                  current.settledAt ||
                  ["completed", "failed"].includes(current.state) ||
                  current.lineageId !== scope.lineageId ||
                  this.active.get(scope.lineageId) !== active ||
                  active.dispatch !== dispatch ||
                  active.lineageId !== scope.lineageId ||
                  active.fatal !== null ||
                  active.account !== account ||
                  active.process !== process ||
                  active.session.nativeSessionId !== nativeSessionId
                )
                  return null;
                // Pure in-memory ownership fence: no SQLite/namespace wait
                // may be introduced at the physical cancellation boundary.
                return {
                  ...scope,
                  runId: current.action.run_id,
                  attemptId: current.action.attempt_id,
                  actionId: current.action.action_id,
                };
              },
              (value) =>
                diagnostics?.recordQueuedProbeCancellation(
                  value,
                  process.handle,
                ),
            );
          }
        } catch {
          /* No capability is safer than uncertain identity; probe still proceeds. */
        }
        const queuedCancellation = active.queuedProbeCancellation ?? undefined;
        let readinessTimedOut = false;
        observeClaudeProtocol(
          process,
          frames,
          diagnostics,
          () => active.disconnected,
          queuedCancellation,
        );
        try {
          await sendMessage(
            process,
            nativeSessionId,
            "Quest Engineering fixed zero-inference initialization probe.",
            false,
            diagnostics,
            active.queuedProbeCancellation ?? undefined,
          );
          // Native settings proof shares the existing 30s post-probe budget;
          // it never extends the init timeout or introduces a second 30s wait.
          const deadline = Date.now() + 30_000;
          active.queuedProbeCancellation?.arm(deadline);
          const init = await waitForInit(frames, 30_000, () => {
            readinessTimedOut = true;
            diagnostics?.record("attestation_timeout_fired", process.handle);
            diagnostics?.captureIo("attestation_timeout_fired", process);
          });
          active.queuedProbeCancellation?.invalidate();
          try {
            attestClaudeInit(init, {
              sessionId: nativeSessionId,
              cwd: account.cwd,
              model: CLAUDE_CODE_MODEL,
            });
            account.assertCurrent();
            await attestClaudeEffort(
              process,
              frames,
              {
                sessionId: nativeSessionId,
                model: CLAUDE_CODE_MODEL,
                effort: CLAUDE_CODE_EFFORT,
              },
              deadline,
            );
            account.assertCurrent();
          } catch (error) {
            diagnostics?.record("protocol_frame_rejected", process.handle);
            throw error;
          }
          diagnostics?.record("protocol_frame_validated", process.handle);
          active.initialized = true;
          if (
            active.session.state === "uncertain" &&
            !dispatch.promptIntentAt &&
            !dispatch.promptAcceptedAt &&
            !dispatch.nativeActivityAt
          )
            active.session = this.sessions.transition(
              active.session.nativeSessionId,
              ["uncertain"],
              "prepared",
            );
          active.inspection = inspection(active, "starting", "idle");
          return prepared(lineage, active);
        } catch (error) {
          active.disconnected = true;
          await Promise.allSettled([
            cancelClaudePreparation(
              process,
              diagnostics,
              readinessTimedOut ? (queuedCancellation ?? null) : undefined,
            ),
            relay.stop(),
            admitted.client.close(),
          ]);
          active.queuedProbeCancellation?.invalidate();
          this.active.delete(lineage.lineageId);
          this.markUncertain(active);
          throw claudeError(
            "environment_attestation_failed",
            error instanceof ClaudeProtocolTimeout
              ? `Claude Code attestation timed out; last proven Worker stage: ${diagnostics?.snapshot().lastProvenStage ?? "unknown"}; native interval unknown. See Worker-local lifecycle evidence.`
              : "Claude Code zero-inference init attestation failed.",
            "readiness",
            "not_submitted",
          );
        }
      },
    );
  }

  private async collect(
    dispatch: DispatchRecord,
    active: ActiveClaudeCodeExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    for (;;) {
      if (active.fatal) throw active.fatal;
      const frame = await active.frames.next(null);
      const tag = decodeClaudeOutputTag(frame);
      if (isClaudeInit(tag)) {
        attestClaudeInit(frame, {
          sessionId: active.session.nativeSessionId,
          cwd: active.account.cwd,
          model: CLAUDE_CODE_MODEL,
        });
        continue;
      }
      rejectServerToolEvidence(frame);
      if (
        frame.session_id &&
        frame.session_id !== active.session.nativeSessionId
      )
        throw new Error("Claude stream crossed native-session ownership.");
      if (hasClaudeRoot(tag, "assistant")) {
        const message =
          frame.message && typeof frame.message === "object"
            ? (frame.message as Record<string, unknown>)
            : null;
        if (message?.model !== CLAUDE_CODE_MODEL)
          throw new Error("Claude assistant frame used an unapproved model.");
        active.inspection = inspection(active, "running", "active");
        if (!active.promptAccepted) {
          active.promptAccepted = true;
          onEvent({
            type: "prompt_accepted",
            acceptedAt: new Date().toISOString(),
            inspection: active.inspection,
          });
        }
        onEvent({
          type: "native_activity",
          observedAt: new Date().toISOString(),
          inspection: active.inspection,
        });
        continue;
      }
      if (!hasClaudeRoot(tag, "result")) continue;
      assertExactModelUsage(frame);
      onEvent({
        type: "provider_turn_settled",
        observedAt: new Date().toISOString(),
        inspection: inspection(active, "running", "completed"),
      });
      onEvent({
        type: "native_idle",
        observedAt: new Date().toISOString(),
        inspection: inspection(active, "running", "completed"),
      });
      if (frame.is_error === true || !isClaudeResultSuccess(tag)) {
        this.markUncertain(active);
        throw claudeError(
          "claude_turn_failed",
          typeof frame.result === "string"
            ? frame.result
            : "Claude Code reported a failed provider turn.",
          "observe",
          "submitted",
        );
      }
      const decision = await active.control.nativeStop(
        "claude_code_turn_settled",
        true,
        CLAUDE_CODE_MODEL,
      );
      if (decision.nativeStop?.decision === "allow") {
        await waitForResult(dispatch);
        const outputs = (await collectStepResult(dispatch)).envelope.outputs;
        active.inspection = inspection(active, "retained", "completed");
        onEvent({
          type: "structured_result_received",
          observedAt: new Date().toISOString(),
          inspection: active.inspection,
        });
        return outputs;
      }
      if (decision.nativeStop?.decision === "contract_violation")
        throw claudeError(
          "harness_contract_violation",
          decision.nativeStop.reason,
          "observe",
          "submitted",
        );
      if (decision.nativeStop?.decision !== "continue")
        throw new Error("Claude completion authority returned no decision.");
      active.continuationCount += 1;
      if (active.continuationCount > 2)
        throw claudeError(
          "harness_contract_violation",
          "Claude exceeded the bounded completion correction contract.",
          "execute",
          "submitted",
        );
      await sendMessage(
        active.process,
        active.session.nativeSessionId,
        `Quest Engineering completion correction: ${decision.nativeStop.reason} Call qe_complete_step exactly once with the declared output keys.`,
        true,
      );
    }
  }

  private required(lineageId: string): ActiveClaudeCodeExecution {
    const active = this.active.get(lineageId);
    if (!active) throw new Error("Claude Code execution is not active.");
    return active;
  }

  private markUncertain(active: ActiveClaudeCodeExecution): void {
    try {
      active.session = this.sessions.transition(
        active.session.nativeSessionId,
        ["prepared", "active", "idle", "uncertain"],
        "uncertain",
      );
    } catch {
      // A terminal close remains authoritative.
    }
  }
}

export function claudeCodeCommand(
  account: Pick<ClaudeCodeAccountRuntime, "configRoot" | "cwd">,
  nativeSessionId: string,
  resume: boolean,
  mailboxRoot: string,
  bridgeToken: string,
) {
  return {
    executable: SBX_CLAUDE_EXECUTABLE,
    args: [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--restricted",
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--permission-prompts",
      "none",
      "--model",
      CLAUDE_CODE_MODEL,
      "--effort",
      CLAUDE_CODE_EFFORT,
      resume ? "--resume" : "--session-id",
      nativeSessionId,
      "--tools",
      CLAUDE_CODE_TOOLS.join(","),
    ],
    cwd: account.cwd,
    environment: claudeAccountEnvironment(account.configRoot, {
      QE_ACCOUNT_CELL_MOD_PROTOCOL: SBX_CLAUDE_ACCOUNT_MOD_PROTOCOL,
      QE_CLAUDE_MODEL: CLAUDE_CODE_MODEL,
      QE_CLAUDE_EFFORT: CLAUDE_CODE_EFFORT,
      QE_ACCOUNT_CELL_MAILBOX: mailboxRoot,
      QE_ACCOUNT_CELL_BRIDGE_TOKEN: bridgeToken,
      CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
    }),
  };
}

export function attestClaudeInit(
  value: Record<string, unknown>,
  expected: { sessionId: string; cwd: string; model: string },
): void {
  const tools = Array.isArray(value.tools) ? [...value.tools].sort() : [];
  const expectedTools = [...CLAUDE_CODE_TOOLS].sort();
  const plugins = Array.isArray(value.plugins)
    ? (value.plugins as Array<Record<string, unknown>>)
    : [];
  const qePlugins = plugins.filter(
    (plugin) =>
      plugin.name === CLAUDE_CODE_PLUGIN_NAME ||
      plugin.name === `${CLAUDE_CODE_PLUGIN_NAME}@qe-managed`,
  );
  const securityPlugins = plugins.filter(
    (plugin) => plugin.name === "cc-plugin-sec-default",
  );
  if (
    !isClaudeInit(decodeClaudeOutputTag(value)) ||
    value.session_id !== expected.sessionId ||
    value.claude_code_version !== SBX_CLAUDE_CODE_VERSION ||
    value.apiKeySource !== "oauth" ||
    value.cwd !== expected.cwd ||
    value.model !== expected.model ||
    // This optional init field is only a consistency check, never effort proof.
    (value.effort !== undefined && value.effort !== CLAUDE_CODE_EFFORT) ||
    value.permissionMode !== "dontAsk" ||
    JSON.stringify(tools) !== JSON.stringify(expectedTools) ||
    !Array.isArray(value.mcp_servers) ||
    value.mcp_servers.length !== 0 ||
    !Array.isArray(value.skills) ||
    value.skills.length !== 0 ||
    (Array.isArray(value.agents) && value.agents.length !== 0) ||
    plugins.length !== 2 ||
    qePlugins.length !== 1 ||
    securityPlugins.length !== 1 ||
    qePlugins[0]?.path !== CLAUDE_CODE_PLUGIN_PATH ||
    (Array.isArray(value.plugin_errors) && value.plugin_errors.length !== 0)
  )
    throw new Error(
      "Claude Code init does not attest exact OAuth, managed Mod guard, model, optional effort consistency, session, cwd, and tool inventory.",
    );
}

function assertExactConfiguration(dispatch: DispatchRecord): void {
  const configuration = dispatch.action.execution.configuration;
  if (
    configuration.harness_kind !== CLAUDE_CODE_HARNESS_KIND ||
    configuration.model.provider !== "anthropic" ||
    configuration.model.model !== CLAUDE_CODE_MODEL ||
    !supportsClaudeReasoning(
      configuration.reasoning,
      configuration.reasoning_capability,
    ) ||
    configuration.tool_enforcement !== "exact"
  )
    throw claudeError(
      "incompatible_continuation_configuration",
      `Claude Code requires exact anthropic/${CLAUDE_CODE_MODEL}, effort ${CLAUDE_CODE_EFFORT}, and exact tool enforcement.`,
      "prepare",
      "not_submitted",
    );
}

function assertBrokerBinding(
  dispatch: DispatchRecord,
  binding: ReturnType<WorkspaceToolBroker["boundClientForAction"]>["binding"],
): void {
  const action = dispatch.action;
  const execution = action.execution;
  if (
    binding.actionId !== action.action_id ||
    binding.runId !== action.run_id ||
    binding.occurrenceId !== action.occurrence_id ||
    binding.attemptId !== action.attempt_id ||
    binding.workspaceId !== execution.logical_workspace.workspace_id ||
    binding.worktreeId !== execution.execution_workspace.worktree_id ||
    binding.workspaceBindingId !==
      execution.execution_workspace.workspace_binding_id ||
    binding.workspaceAccess !== execution.execution_workspace.access ||
    binding.physicalLineageId.length === 0
  )
    throw new Error(
      "WorkspaceToolBroker authority does not match Claude dispatch.",
    );
}

function assertSessionBinding(
  session: ClaudeCodeSessionRecord,
  lineage: HarnessLineage,
  binding: ReturnType<WorkspaceToolBroker["boundClientForAction"]>["binding"],
): void {
  if (
    session.lineageId !== lineage.lineageId ||
    session.logicalLineageId !== lineage.logicalLineageId ||
    session.providerAccountId !== binding.providerAccountId ||
    session.credentialGeneration !== binding.credentialGeneration ||
    session.accountEnvironmentId !== binding.accountEnvironment.environmentId ||
    session.accountEnvironmentIncarnation !==
      binding.accountEnvironment.incarnation ||
    session.model !== CLAUDE_CODE_MODEL ||
    session.effort !== CLAUDE_CODE_EFFORT
  )
    throw new Error(
      "Cross-project Claude resume was refused because exact QE session ownership does not match.",
    );
}

function assertDispatch(
  active: ActiveClaudeCodeExecution,
  dispatch: DispatchRecord,
): void {
  if (
    active.dispatch.action.action_id !== dispatch.action.action_id ||
    active.dispatch.action.attempt_id !== dispatch.action.attempt_id ||
    active.lineageId !== dispatch.lineageId
  )
    throw new Error("Claude execution ownership is stale.");
}

async function assertAuthenticated(
  account: ClaudeCodeAccountRuntime,
): Promise<void> {
  const result = await account.lease.exec({
    executable: SBX_CLAUDE_EXECUTABLE,
    args: ["auth", "status"],
    cwd: account.cwd,
    environment: claudeAccountEnvironment(account.configRoot),
    timeoutMs: 30_000,
  });
  const owner = account.ref.owner;
  if (owner.kind !== "provider_account")
    throw new Error("Claude authentication requires a ProviderAccount owner.");
  const status = classifyClaudeSubscriptionAuthStatus(
    result,
    account.configRoot,
    {
      providerKey: "anthropic",
      owner: {
        kind: "provider_account",
        id: owner.providerAccountId,
        generation: owner.credentialGeneration,
      },
      backendKind: account.ref.backendKind,
      environmentId: account.ref.environmentId,
      environmentIncarnation: account.ref.incarnation,
      profile: account.ref.profile,
      configuration: CLAUDE_SUBSCRIPTION_CONFIGURATION,
    },
  );
  if (!isProviderAuthenticationReady(status))
    throw new Error(
      "Claude ProviderAccount authentication status is incompatible.",
    );
}

async function waitForBroker(
  broker: WorkspaceToolBroker,
  actionId: string,
): Promise<ReturnType<WorkspaceToolBroker["boundClientForAction"]>> {
  const deadline = Date.now() + 30_000;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return broker.boundClientForAction(actionId);
    } catch (error) {
      last = error;
      await Bun.sleep(50);
    }
  }
  throw new Error(
    last instanceof Error
      ? `WorkspaceToolBroker admission timed out: ${last.message}`
      : "WorkspaceToolBroker admission timed out.",
  );
}

function prepared(
  lineage: HarnessLineage,
  active: ActiveClaudeCodeExecution,
): HarnessPreparedExecution {
  return {
    lineage,
    handle: {
      schemaVersion: 1,
      harnessKind: CLAUDE_CODE_HARNESS_KIND,
      executionId: active.session.nativeSessionId,
      nativeSession: nativeSessionRef(
        CLAUDE_CODE_HARNESS_KIND,
        "id",
        active.session.nativeSessionId,
      ),
      transportBinding: transportBinding(active),
    },
  };
}

function transportBinding(
  active: ActiveClaudeCodeExecution,
): HarnessTransportBinding {
  return {
    schemaVersion: 1,
    harnessKind: CLAUDE_CODE_HARNESS_KIND,
    kind: "claude_code_account_cell_v1",
    payload: {
      nativeSessionId: active.session.nativeSessionId,
      providerAccountId: active.accountId,
      credentialGeneration: active.session.credentialGeneration,
      accountEnvironmentId: active.session.accountEnvironmentId,
      accountEnvironmentIncarnation:
        active.session.accountEnvironmentIncarnation,
      model: active.session.model,
      effort: active.session.effort,
      process: active.process.handle as unknown as JsonValue,
    },
  };
}

function emptyInspection(nativeSessionId: string): HarnessInspection {
  return {
    state: "starting",
    activity: { state: "idle", detail: "Zero-inference init is pending." },
    nativeSession: nativeSessionRef(
      CLAUDE_CODE_HARNESS_KIND,
      "id",
      nativeSessionId,
    ),
    health: "unknown",
    attention: null,
    intervention: null,
    lastActivityAt: new Date().toISOString(),
    interactive: null,
  };
}

function inspection(
  active: ActiveClaudeCodeExecution,
  state: HarnessInspection["state"],
  activity: HarnessInspection["activity"]["state"],
): HarnessInspection {
  return {
    state,
    activity: {
      state: activity,
      detail: `Claude Code ${SBX_CLAUDE_CODE_VERSION}; managed Mod; ${active.session.state}.`,
    },
    nativeSession: nativeSessionRef(
      CLAUDE_CODE_HARNESS_KIND,
      "id",
      active.session.nativeSessionId,
    ),
    health: active.fatal ? "unavailable" : "healthy",
    attention: null,
    intervention: null,
    lastActivityAt: new Date().toISOString(),
    transportBinding: transportBinding(active),
    interactive: null,
  };
}

function assertExactModelUsage(frame: Record<string, unknown>): void {
  if (!frame.modelUsage || typeof frame.modelUsage !== "object")
    throw new Error("Claude result omitted per-model usage provenance.");
  const models = Object.keys(frame.modelUsage as Record<string, unknown>);
  if (
    models.length === 0 ||
    models.some((model) => model !== CLAUDE_CODE_MODEL)
  )
    throw new Error("Claude result includes an unapproved model invocation.");
}

async function waitForResult(dispatch: DispatchRecord): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await structuredResultExists(dispatch.resultDirectory)) return;
    await Bun.sleep(25);
  }
  throw new Error("Structured completion export did not settle.");
}

function claudeError(
  code: string,
  message: string,
  phase: "prepare" | "readiness" | "execute" | "observe",
  certainty: "not_submitted" | "submitted" | "ambiguous",
): OperationalExecutionError {
  return new OperationalExecutionError(
    message,
    certainty === "ambiguous"
      ? "uncertain"
      : code === "harness_contract_violation" ||
          code === "environment_attestation_failed" ||
          code === "incompatible_continuation_configuration"
        ? "terminal_not_recoverable"
        : "operator_recovery_required",
    code,
    undefined,
    { sideEffectCertainty: certainty, phase },
  );
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
