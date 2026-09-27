import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkerConfig } from "../../config.ts";
import {
  type DispatchRecord,
  type HarnessLineage,
  physicalConfiguration,
} from "../../dispatch/registry.ts";
import {
  InitialAntigravityConversationDispatchError,
  type PreparedSbxHarnessExecution,
  type SbxRunExecutionManager,
} from "../../execution-environment/sbx-run.ts";
import type { JsonValue, ReasoningCapability } from "../../protocol/types.ts";
import { HerdrApiError } from "../../session-host/herdr/client.ts";
import type {
  HostedAgent,
  HostedExecutionRef,
  HostedPane,
  TerminalSessionBackend,
} from "../../session-host/types.ts";
import { materializeExecutionArtifacts } from "../../workspace/execution-artifacts.ts";
import { controlDescriptorPath } from "../control/authority.ts";
import { HarnessControlClient } from "../control/client.ts";
import { assertCurrentBridgeAuthority } from "../control/mcp-readiness.ts";
import {
  collectStepResult,
  readControl,
  writeControlAtomic,
} from "../control/result-envelope.ts";
import { harnessPromptFor } from "../prompt.ts";
import {
  ambiguousPromptError,
  errorProvesPromptSubmission,
  type NativeTurnActivity,
  observeAntigravityNativeActivity,
  observeAntigravityPromptDispatch,
  observeLatestAntigravityConversation,
  persistedPromptEvidence,
  promptActivityStallMs,
  promptEvidenceCursor,
  reconcileAmbiguousPrompt,
  structuredResultExists,
  uncertainPrompt,
  waitingForActivitySince,
} from "../turn-lifecycle.ts";
import {
  type AgentHarness,
  type HarnessAdoptionCandidate,
  type HarnessCapabilities,
  type HarnessDiscovery,
  type HarnessEvent,
  type HarnessInspection,
  type HarnessKnownDispatch,
  type HarnessPreparedExecution,
  type HarnessRecoveredExecution,
  type HumanAttention,
  OperationalExecutionError,
  type PreAuthorizationActivity,
  type PromptEvidenceCursor,
} from "../types.ts";
import {
  ANTIGRAVITY_MODEL_PROVIDER,
  discoverAntigravityModels,
  type NativeCommandRunner,
} from "./discovery.ts";
import type { AntigravityCommandHookSpec } from "./hook-readiness.ts";

const HOOK_NAME = "qe-worker-stop-v1";

interface AntigravityDependencies {
  discoverModels?: typeof discoverAntigravityModels;
  runNativeCommand?: NativeCommandRunner;
  now?: () => string;
  executionManager?: SbxRunExecutionManager;
}

/** Interactive-first Antigravity adapter. MCP transports payloads only. */
export class AntigravityHarness implements AgentHarness {
  readonly kind = "antigravity";
  readonly displayName = "Antigravity";
  readonly integrationStrategy = "hooks_plus_structured_tool" as const;
  readonly capabilities: HarnessCapabilities = {
    structuredResult: true,
    continuation: true,
    retainedSessionRecovery: true,
    structuredAttention: false,
    nativeBlocking: true,
    canAttachTerminal: true,
    canSendInput: true,
    canInterrupt: true,
    canDetectAttention: true,
    canResume: true,
    canObserveStructuredEvents: true,
    structuredConfirmation: false,
    structuredTextResponse: false,
    structuredChoiceResponse: false,
    structuredMultilineResponse: false,
    nativePromptControl: true,
    conversationalTakeover: true,
    automationResume: true,
  };

  private readonly discoverModels: typeof discoverAntigravityModels;
  private readonly runNativeCommand: NativeCommandRunner | undefined;
  private readonly now: () => string;
  private readonly executionManager: SbxRunExecutionManager | undefined;
  private lastReadyDiscovery: HarnessDiscovery | null = null;
  private readonly sbxExecutions = new Map<
    string,
    PreparedSbxHarnessExecution
  >();
  private readonly promptReadiness = new Map<
    string,
    { conversation: "none" | "active"; initialConversationDispatch: boolean }
  >();
  private stopped = false;

  constructor(
    private readonly host: TerminalSessionBackend,
    private readonly config: WorkerConfig,
    dependencies: AntigravityDependencies = {},
  ) {
    this.discoverModels =
      dependencies.discoverModels ?? discoverAntigravityModels;
    this.runNativeCommand = dependencies.runNativeCommand;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.executionManager = dependencies.executionManager;
  }

  async discover(): Promise<HarnessDiscovery> {
    const backend = await this.host.readiness();
    const onlyBackendIntegrationMissing =
      backend.missingCapabilities.length > 0 &&
      backend.missingCapabilities.every(
        (capability) => capability === "integration.antigravity.current",
      );
    if (!backend.ready && !onlyBackendIntegrationMissing)
      return {
        kind: this.kind,
        displayName: this.displayName,
        strategy: this.integrationStrategy,
        integration: {
          status:
            backend.status === "unavailable"
              ? "unavailable"
              : "incompatible_version",
          detail: backendReadinessDetail(backend),
          installed: true,
          authenticated: false,
        },
        models: [],
        capabilities: { ...this.capabilities, structuredResult: false },
      };
    const native = this.executionManager
      ? await this.executionManager.discoverAntigravity()
      : await this.discoverModels(this.runNativeCommand);
    const registration = native.installed
      ? this.executionManager
        ? {
            ready: true,
            detail:
              "The immutable mixed SBX profile owns QE MCP registration and the guest Stop bridge.",
          }
        : {
            ready: false,
            detail:
              "Antigravity execution requires the immutable mixed SBX profile.",
          }
      : { ready: false, detail: "Antigravity CLI is unavailable." };
    const ready =
      backend.ready &&
      native.installed &&
      native.authenticated &&
      native.compatible &&
      registration.ready;
    const discovery: HarnessDiscovery = {
      kind: this.kind,
      displayName: this.displayName,
      strategy: this.integrationStrategy,
      integration: {
        status: ready
          ? "ready"
          : !backend.ready
            ? backend.status === "unavailable"
              ? "unavailable"
              : onlyBackendIntegrationMissing
                ? "missing_control_bridge"
                : "incompatible_version"
            : !native.installed
              ? "missing_dependency"
              : !native.compatible &&
                  native.missingCapabilities.some(
                    (capability) => capability !== "native.model_catalog",
                  )
                ? "incompatible_version"
                : !native.authenticated
                  ? "auth_required"
                  : "missing_control_bridge",
        detail: [
          backendReadinessDetail(backend),
          ...native.diagnostics,
          registration.detail,
        ]
          .filter(Boolean)
          .join(" "),
        installed: native.installed,
        authenticated: native.authenticated,
      },
      models: native.models,
      capabilities: { ...this.capabilities, structuredResult: ready },
    };
    if (ready) this.lastReadyDiscovery = discovery;
    return discovery;
  }

  async start(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    await this.assertExactConfiguration(dispatch);
    if (!this.executionManager)
      throw new Error(
        "Antigravity execution requires the Run-owned mixed SBX boundary.",
      );
    const sessionIncarnation = requireSessionIncarnation(this.host);
    const physicalLineage = {
      ...lineage,
      herdrSession: this.host.sessionName,
      herdrSessionIncarnation: sessionIncarnation,
    };
    const sbx = await this.executionManager.prepare(
      dispatch,
      physicalLineage,
      materializeExecutionArtifacts(this.config, dispatch),
    );
    this.sbxExecutions.set(lineage.lineageId, sbx);
    const cwd = sbx.hostCwd;
    await sbx.installAntigravityHook(this.stopHookSpec(sbx));
    const workspaceId = await this.ensureWorkspace(sbx.paneEnvironment, cwd);
    assertCurrentSessionIncarnation(this.host, sessionIncarnation);
    const pane = await this.host.createTab({
      workspaceId,
      cwd,
      label: displayLabel(dispatch),
      environment: sbx.paneEnvironment,
    });
    assertCurrentSessionIncarnation(this.host, sessionIncarnation);
    const agentName = agentNameFor(lineage.lineageId);
    const launchTokens = provenance(
      this.config.workerId,
      dispatch,
      physicalLineage,
      true,
    );
    await writeControlAtomic(physicalLineage.resultControlPath, {
      protocolVersion: 1,
      workerId: dispatch.action.worker_id,
      lineageId: physicalLineage.lineageId,
      action: dispatch.action,
      nonce: dispatch.resultNonce,
      resultDirectory: dispatch.resultDirectory,
    });
    await sbx.syncControl();
    await this.host.reportMetadata({
      paneId: pane.paneId,
      title: displayLabel(dispatch),
      tokens: launchTokens,
    });
    const args = this.args(dispatch, lineage);
    const command = await sbx.launchDescriptor(args);
    sbx.startRelay(this.host, pane.paneId);
    let agent: HostedAgent;
    try {
      agent = await this.host.startAgent({
        paneId: pane.paneId,
        name: agentName,
        integrationKind: "agy",
        args,
        command,
        expectedTokens: launchTokens,
      });
      await sbx.awaitAttestation();
    } catch (error) {
      await sbx.stopRelay().catch(() => undefined);
      await sbx.removeAntigravityHook(HOOK_NAME).catch(() => undefined);
      this.sbxExecutions.delete(lineage.lineageId);
      await this.host.closePane(pane.paneId).catch(() => undefined);
      throw error;
    }
    assertCurrentSessionIncarnation(this.host, sessionIncarnation);
    return {
      lineage: physicalLineage,
      ref: refFor(
        this.host.sessionName,
        sessionIncarnation,
        agentName,
        pane,
        agent,
      ),
      agent,
    };
  }

  async ready(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
  ): Promise<void> {
    const lineage = execution.lineage;
    const sbx = this.sbxExecutions.get(lineage.lineageId);
    if (!sbx)
      throw new Error("Antigravity readiness has no exact SBX execution.");
    const binding = expectedControlBinding(dispatch, lineage);
    await assertCurrentBridgeAuthority(controlDescriptorPath(lineage), binding);
    await sbx.proveAntigravityReadiness({
      spec: this.stopHookSpec(sbx),
      binding,
      timeoutMs: Math.min(this.config.resultTimeoutMs, 30_000),
    });
    const nativeSession =
      lineage.nativeSession ?? execution.agent.nativeSession;
    if (!lineage.nativeSession && nativeSession)
      throw new OperationalExecutionError(
        "Fresh Antigravity readiness unexpectedly found an active native conversation before prompt authorization.",
        "operator_recovery_required",
        "pre_authorization_native_activity",
        { native_conversation_id: nativeSession.value },
      );
    if (
      lineage.nativeSession &&
      (!execution.agent.nativeSession ||
        !nativeIdentityMatches(lineage, execution.agent))
    )
      throw new OperationalExecutionError(
        "Retained Antigravity readiness could not prove the exact native conversation.",
        "operator_recovery_required",
        "antigravity_conversation_identity_mismatch",
      );
    const readiness = {
      conversation: nativeSession ? ("active" as const) : ("none" as const),
      initialConversationDispatch: !nativeSession,
    };
    this.promptReadiness.set(lineage.lineageId, readiness);
    await writeFile(
      join(dirname(nativeLogPath(lineage)), "pre-inference-readiness.json"),
      `${JSON.stringify(
        {
          version: 2,
          kind: "antigravity_pre_inference_readiness",
          actionId: dispatch.action.action_id,
          attemptId: dispatch.action.attempt_id,
          workspaceRoot: sbx.hostCwd,
          argv: this.args(dispatch, lineage),
          conversationState: readiness.conversation,
          initialConversationDispatchReady:
            readiness.initialConversationDispatch,
          initialConversationDispatchMechanism:
            readiness.initialConversationDispatch
              ? "native_prompt_interactive"
              : null,
          stopHookReady: true,
          mcpChildReady: true,
          bridgeContextValid: true,
          recordedAt: this.now(),
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }

  async provePreparedProcessAdoption(
    source: DispatchRecord,
    target: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void> {
    await this.assertExactConfiguration(target);
    const reject = rejectPreparedProcessAdoption;
    if (
      source.state !== "failed" ||
      source.lineageId !== lineage.lineageId ||
      source.promptIntentAt ||
      source.promptAcceptedAt ||
      source.nativeActivityAt ||
      source.stalledAt ||
      source.settledAt ||
      lineage.nativeSession
    )
      reject(
        "The retained Antigravity process is not a conversation-free terminal pre-prompt execution.",
      );
    const sessionIncarnation = requireSessionIncarnation(this.host);
    if (
      !lineage.herdrSessionIncarnation ||
      lineage.herdrSessionIncarnation !== sessionIncarnation
    )
      reject(
        "The retained Antigravity process belongs to another Herdr session incarnation.",
      );
    const agent = await this.findExactLiveAgent(lineage);
    if (!agent)
      rejectPreparedProcessAdoption(
        "The exact retained Antigravity process is unavailable.",
      );
    if (agent.status !== "idle" || agent.nativeSession)
      reject(
        "The retained Antigravity process is not idle and conversation-free.",
      );
    const sbx = this.sbxExecutions.get(lineage.lineageId);
    if (!sbx)
      reject("The retained Antigravity process has no exact SBX execution.");
    const cwd = (sbx as PreparedSbxHarnessExecution).hostCwd;
    if (
      !samePath(agent.cwd ?? agent.foregroundCwd, cwd) ||
      agent.workspaceId !== lineage.workspaceId ||
      (lineage.terminalId && agent.terminalId !== lineage.terminalId)
    )
      reject(
        "The retained Antigravity process does not match the exact workspace, terminal, and pane provenance.",
      );
    const readiness = await readPreparedProcessReadiness(lineage);
    const expectedArgs = this.args(target, lineage);
    if (
      readiness.kind !== "antigravity_pre_inference_readiness" ||
      readiness.actionId !== source.action.action_id ||
      readiness.attemptId !== source.action.attempt_id ||
      readiness.workspaceRoot !== cwd ||
      readiness.stopHookReady !== true ||
      readiness.mcpChildReady !== true ||
      readiness.bridgeContextValid !== true ||
      !sameStringArray(readiness.argv, expectedArgs)
    )
      reject(
        "The retained Antigravity launch and readiness evidence do not match the requested Attempt policy.",
      );
    await assertCurrentBridgeAuthority(
      controlDescriptorPath(lineage),
      expectedControlBinding(target, lineage),
    );
  }

  async continue(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    await this.assertExactConfiguration(dispatch);
    if (!this.executionManager)
      throw new Error(
        "Antigravity continuation requires the Run-owned mixed SBX boundary.",
      );
    if (
      !lineage.herdrSessionIncarnation ||
      lineage.herdrSessionIncarnation !== this.host.sessionIncarnation()
    )
      throw new Error(
        "The continued Antigravity TUI belongs to another Herdr session incarnation.",
      );
    const sbx = await this.executionManager.prepare(
      dispatch,
      lineage,
      materializeExecutionArtifacts(this.config, dispatch),
    );
    this.sbxExecutions.set(lineage.lineageId, sbx);
    await sbx.installAntigravityHook(this.stopHookSpec(sbx));
    await writeControlAtomic(lineage.resultControlPath, {
      protocolVersion: 1,
      workerId: dispatch.action.worker_id,
      lineageId: lineage.lineageId,
      action: dispatch.action,
      nonce: dispatch.resultNonce,
      resultDirectory: dispatch.resultDirectory,
    });
    await sbx.syncControl();
    const liveAgent = await this.findExactLiveAgent(lineage);
    const agent = liveAgent
      ? await this.reconcileNativeIdentity(lineage, liveAgent)
      : null;
    if (!agent)
      throw new Error(
        "The exact continued Antigravity TUI is missing or has incompatible provenance.",
      );
    sbx.startRelay(this.host, agent.paneId);
    await sbx.awaitAttestation();
    await this.host.reportMetadata({
      paneId: agent.paneId,
      title: displayLabel(dispatch),
      tokens: provenance(this.config.workerId, dispatch, lineage, true),
    });
    return {
      lineage,
      ref: refFor(
        this.host.sessionName,
        lineage.herdrSessionIncarnation,
        lineage.agentName as string,
        paneFor(agent, lineage),
        agent,
      ),
      agent,
    };
  }

  async sendInputAndCollect(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    await writeControlAtomic(execution.lineage.resultControlPath, {
      protocolVersion: 1,
      workerId: dispatch.action.worker_id,
      lineageId: execution.lineage.lineageId,
      action: dispatch.action,
      nonce: dispatch.resultNonce,
      resultDirectory: dispatch.resultDirectory,
    });
    const sbx = this.sbxExecutions.get(execution.lineage.lineageId);
    if (!sbx) throw new Error("Antigravity prompt has no exact SBX execution.");
    await sbx.syncControl();
    const prompt = antigravityPromptFor(dispatch, sbx.materializedArtifacts);
    const baseline = await promptEvidenceCursor(
      "antigravity_log",
      nativeLogPath(execution.lineage),
      prompt,
    );
    // The native first-message process has its own log generation. Cursor zero
    // remains valid across Worker restart even if the preauthorization log was
    // larger than the new process log before the relay observed the switch.
    const evidence = execution.lineage.nativeSession
      ? baseline
      : { ...baseline, cursor: 0 };
    onEvent({
      type: "prompt_baseline",
      evidence,
      inspection: this.inspectionFor(execution.lineage, execution.agent),
    });
    return this.submitAndCollect(
      dispatch,
      execution.lineage,
      execution.ref.paneId,
      execution.agent,
      prompt,
      evidence,
      onEvent,
    );
  }

  async waitAndCollect(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    agent: HostedAgent,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    const sbx = this.sbxExecutions.get(lineage.lineageId);
    if (!sbx) throw new Error("Antigravity wait has no exact SBX execution.");
    const prompt = antigravityPromptFor(dispatch, sbx.materializedArtifacts);
    const evidence =
      persistedPromptEvidence(dispatch, "antigravity_log", prompt) ??
      (await promptEvidenceCursor(
        "antigravity_log",
        nativeLogPath(lineage),
        prompt,
      ));
    return this.waitForAuthorizedResult(
      dispatch,
      lineage,
      agent,
      evidence,
      onEvent,
    );
  }

  async recover(
    lineage: HarnessLineage,
    dispatch?: DispatchRecord,
  ): Promise<HarnessRecoveredExecution> {
    const sessionIncarnation = requireSessionIncarnation(this.host);
    if (
      !lineage.herdrSessionIncarnation ||
      lineage.herdrSessionIncarnation !== sessionIncarnation
    )
      return {
        found: false,
        detail:
          "The original Antigravity execution belongs to another Herdr session incarnation.",
      };
    if (!this.executionManager || !dispatch)
      return {
        found: false,
        detail:
          "Antigravity recovery requires the exact Run-owned SBX dispatch context.",
      };
    const found = await this.findExactLiveAgent(lineage);
    if (!found)
      return {
        found: false,
        detail:
          "Herdr cannot verify the original Antigravity TUI; fresh recovery may resume its verified conversation in the lineage-private SBX HOME.",
      };
    const live = await this.reconcileNativeIdentity(
      lineage,
      found,
      Boolean(dispatch.promptIntentAt),
    );
    if (!live)
      return {
        found: false,
        detail:
          "The surviving Antigravity TUI has an unverifiable native conversation identity.",
      };
    const recoveredLineage =
      live.nativeSession && !lineage.nativeSession
        ? { ...lineage, nativeSession: live.nativeSession }
        : lineage;
    const sbx = await this.executionManager.prepare(
      dispatch,
      recoveredLineage,
      materializeExecutionArtifacts(this.config, dispatch),
    );
    this.sbxExecutions.set(lineage.lineageId, sbx);
    await sbx.installAntigravityHook(this.stopHookSpec(sbx));
    await sbx.syncControl();
    sbx.startRelay(this.host, live.paneId);
    await sbx.awaitAttestation();
    return {
      found: true,
      agent: live,
      detail: `Herdr found the original Antigravity TUI in ${live.status} state.`,
    };
  }

  async proveInactiveForFreshRecovery(
    lineage: HarnessLineage,
  ): Promise<boolean> {
    if (
      !lineage.agentName ||
      !lineage.paneId ||
      !lineage.herdrSessionIncarnation ||
      lineage.herdrSessionIncarnation !== this.host.sessionIncarnation()
    )
      throw new Error(
        "The source Antigravity session lacks current physical provenance.",
      );
    try {
      await this.host.inspectAgentState(lineage.paneId);
      return false;
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === "agent_not_found")
        return true;
      throw error;
    }
  }

  async inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    if (!lineage.paneId) return unavailableInspection(lineage, this.now());
    try {
      return await this.currentInspectionFor(
        lineage,
        await this.host.inspectAgentState(lineage.paneId),
      );
    } catch {
      return unavailableInspection(lineage, this.now());
    }
  }

  async observePreAuthorizationActivity(
    lineage: HarnessLineage,
  ): Promise<PreAuthorizationActivity | null> {
    const agent = await this.findExactLiveAgent(lineage);
    if (agent?.nativeSession)
      return {
        observedAt: this.now(),
        nativeSession: agent.nativeSession,
        evidence: "native_session",
      };
    const activity = await observeAntigravityPromptDispatch({
      logPath: nativeLogPath(lineage),
      evidence: {
        kind: "antigravity_log",
        cursor: 0,
        promptHash: "pre-authorization-gate",
      },
    });
    if (activity.state === "pending") return null;
    return {
      observedAt: activity.observedAt,
      nativeSession:
        activity.state === "accepted" ? activity.nativeSession : null,
      evidence: "native_user_message",
    };
  }

  async retire(lineage: HarnessLineage): Promise<void> {
    if (!lineage.paneId)
      throw new Error("Antigravity session has no live pane to retire.");
    await this.host.closePane(lineage.paneId);
    const sbx = this.sbxExecutions.get(lineage.lineageId);
    await sbx?.stopRelay();
    await sbx?.removeAntigravityHook(HOOK_NAME).catch(() => undefined);
    this.sbxExecutions.delete(lineage.lineageId);
    this.promptReadiness.delete(lineage.lineageId);
  }

  async interrupt(lineage: HarnessLineage): Promise<void> {
    if (!lineage.paneId)
      throw new Error("Antigravity session has no live agent target.");
    await this.host.sendKeys(lineage.paneId, ["esc"]);
  }

  async close(lineage: HarnessLineage): Promise<void> {
    if (lineage.paneId)
      await this.host.sendKeys(lineage.paneId, ["ctrl+c", "ctrl+c"]);
    const sbx = this.sbxExecutions.get(lineage.lineageId);
    await sbx?.stopRelay();
    await sbx?.removeAntigravityHook(HOOK_NAME).catch(() => undefined);
    this.sbxExecutions.delete(lineage.lineageId);
    this.promptReadiness.delete(lineage.lineageId);
  }

  attachment(lineage: HarnessLineage) {
    if (
      !lineage.workspaceId ||
      !lineage.paneId ||
      !lineage.agentName ||
      !lineage.herdrSession
    )
      throw new Error(
        "Antigravity lineage has no attachable live terminal execution.",
      );
    return this.host.attachment({
      sessionName: lineage.herdrSession,
      workspaceId: lineage.workspaceId,
      ...(lineage.tabId ? { tabId: lineage.tabId } : {}),
      paneId: lineage.paneId,
      ...(lineage.terminalId ? { terminalId: lineage.terminalId } : {}),
      agentName: lineage.agentName,
      ...(lineage.nativeSession
        ? { nativeSession: lineage.nativeSession }
        : {}),
    });
  }

  async clearActiveMetadata(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void> {
    if (lineage.paneId) {
      try {
        await this.host.reportMetadata({
          paneId: lineage.paneId,
          title: displayLabel(dispatch),
          tokens: provenance(this.config.workerId, dispatch, lineage, false),
        });
      } catch {
        // Durable QE state outranks stale terminal metadata.
      }
    }
    await this.sbxExecutions
      .get(lineage.lineageId)
      ?.removeAntigravityHook(HOOK_NAME);
  }

  async discoverAdoptionCandidates(
    known: readonly HarnessKnownDispatch[] = [],
  ): Promise<HarnessAdoptionCandidate[]> {
    const snapshot = await this.host.snapshot();
    const candidates: HarnessAdoptionCandidate[] = [];
    for (const agent of snapshot.agents) {
      const tokens = agent.tokens;
      if (
        tokens?.qe_owner !== "quest-engineering-worker/v1" ||
        tokens.qe_worker_id !== this.config.workerId ||
        tokens.qe_harness_kind !== this.kind ||
        tokens.qe_active_state !== "active" ||
        !tokens.qe_lineage_id ||
        !tokens.qe_active_action_id ||
        !tokens.qe_ownership_token ||
        !tokens.qe_session_incarnation ||
        tokens.qe_session_incarnation !== this.host.sessionIncarnation() ||
        !tokens.qe_result_nonce
      )
        continue;
      const resultControlPath = join(
        this.config.dataRoot,
        "lineages",
        tokens.qe_lineage_id,
        "result-control.json",
      );
      try {
        const persisted = known.find(
          (item) =>
            item.lineage.lineageId === tokens.qe_lineage_id &&
            item.lineage.ownershipToken === tokens.qe_ownership_token &&
            item.dispatch.resultNonce === tokens.qe_result_nonce &&
            (!item.lineage.herdrSessionIncarnation ||
              item.lineage.herdrSessionIncarnation ===
                tokens.qe_session_incarnation),
        );
        const control = existsSync(resultControlPath)
          ? await readControl(resultControlPath)
          : persisted
            ? {
                workerId: persisted.dispatch.action.worker_id,
                lineageId: persisted.lineage.lineageId,
                action: persisted.dispatch.action,
                nonce: persisted.dispatch.resultNonce,
                resultDirectory: persisted.dispatch.resultDirectory,
              }
            : null;
        if (!control) continue;
        const baseAgentName = agentNameFor(control.lineageId);
        const expectedAgentName = tokens.qe_agent_name ?? baseAgentName;
        if (
          ![baseAgentName, `${baseAgentName}-recovery`].includes(
            expectedAgentName,
          ) ||
          control.workerId !== this.config.workerId ||
          control.lineageId !== tokens.qe_lineage_id ||
          control.action.run_id !== tokens.qe_run_id ||
          control.action.execution.configuration.harness_kind !== this.kind ||
          control.nonce !== tokens.qe_result_nonce ||
          (tokens.qe_action_hash
            ? tokens.qe_action_hash !== identityHash(control.action.action_id)
            : !tokens.qe_active_action_id ||
              !control.action.action_id.startsWith(
                tokens.qe_active_action_id,
              )) ||
          (tokens.qe_occurrence_hash !== undefined &&
            tokens.qe_occurrence_hash !==
              identityHash(control.action.occurrence_id)) ||
          (tokens.qe_attempt_hash !== undefined &&
            tokens.qe_attempt_hash !==
              identityHash(control.action.attempt_id)) ||
          (agent.name !== undefined && agent.name !== expectedAgentName)
        )
          continue;
        const nativeSession =
          agent.nativeSession ??
          (await observeLatestAntigravityConversation({
            logPath: join(dirname(resultControlPath), "antigravity.log"),
          }));
        candidates.push({
          action: control.action,
          state: ["working", "blocked", "unknown"].includes(agent.status)
            ? "running"
            : "accepted",
          resultNonce: control.nonce,
          resultDirectory: control.resultDirectory,
          lineage: {
            lineageId: control.lineageId,
            logicalLineageId:
              control.action.execution.context.logical_lineage_id,
            configurationJson: physicalConfiguration(control.action),
            provider: control.action.execution.configuration.model.provider,
            harnessKind: this.kind,
            sessionState:
              agent.status === "blocked" ? "waiting_for_human" : "recovering",
            capabilities: this.capabilities,
            attention: null,
            intervention: null,
            startedAt: this.now(),
            lastActivityAt: this.now(),
            resultControlPath,
            ownershipToken: tokens.qe_ownership_token,
            activeActionId: control.action.action_id,
            herdrSession: this.host.sessionName,
            herdrSessionIncarnation: tokens.qe_session_incarnation,
            workspaceId: agent.workspaceId,
            tabId: agent.tabId ?? null,
            paneId: agent.paneId,
            terminalId: agent.terminalId ?? null,
            agentName: expectedAgentName,
            nativeSession,
          },
        });
      } catch {
        // Only exact complete provenance is safe to adopt.
      }
    }
    return candidates;
  }

  disconnect(): void {
    this.stopped = true;
    this.host.disconnect();
  }

  private async submitAndCollect(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    target: string,
    initial: HostedAgent,
    prompt: string,
    evidence: PromptEvidenceCursor,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    const sbx = this.sbxExecutions.get(lineage.lineageId);
    if (!sbx) throw new Error("Antigravity prompt has no exact SBX execution.");
    const readiness = this.promptReadiness.get(lineage.lineageId);
    if (!readiness)
      throw new Error(
        "Antigravity prompt dispatch has no current preauthorization readiness proof.",
      );
    const retainedConversation = lineage.nativeSession;
    if (retainedConversation) {
      if (
        readiness.conversation !== "active" ||
        retainedConversation.agent !== "agy" ||
        retainedConversation.kind !== "id" ||
        !initial.nativeSession ||
        initial.nativeSession.agent !== "agy" ||
        initial.nativeSession.kind !== "id" ||
        initial.nativeSession.value !== retainedConversation.value
      )
        throw new OperationalExecutionError(
          "The retained Antigravity conversation does not match the exact PhysicalLineage.",
          "operator_recovery_required",
          "antigravity_conversation_identity_mismatch",
        );
      try {
        await this.host.prompt(target, prompt);
      } catch (error) {
        if (!errorProvesPromptSubmission(error) && !ambiguousPromptError(error))
          throw new OperationalExecutionError(
            `Antigravity continuation transport failed before native acceptance: ${error instanceof Error ? error.message : String(error)}`,
            "operator_recovery_required",
            "antigravity_continuation_dispatch_failed",
          );
      }
    } else {
      if (
        readiness.conversation !== "none" ||
        !readiness.initialConversationDispatch ||
        initial.nativeSession
      )
        throw new OperationalExecutionError(
          "Fresh Antigravity dispatch is not conversation-free.",
          "operator_recovery_required",
          "antigravity_initial_dispatch_not_fresh",
        );
      try {
        await sbx.dispatchInitialAntigravityPrompt(prompt);
      } catch (error) {
        if (
          !(
            error instanceof InitialAntigravityConversationDispatchError &&
            error.outcome === "uncertain"
          )
        )
          throw new OperationalExecutionError(
            `Antigravity initial conversation could not start before native prompt acceptance: ${error instanceof Error ? error.message : String(error)}`,
            "operator_recovery_required",
            "antigravity_initial_dispatch_failed",
            { provider_cycles: 0 },
          );
        // Request delivery may have succeeded. Native log acceptance/rejection
        // remains authoritative and no second prompt may be submitted.
      }
    }

    const accepted = await this.awaitNativePromptAcceptance(
      lineage,
      evidence,
      retainedConversation?.value,
    );
    let current = initial;
    try {
      current = await this.host.inspectAgentState(target);
    } catch {
      // The native append-only log remains authoritative for conversation identity.
    }
    current = { ...current, nativeSession: accepted.nativeSession };
    onEvent({
      type: "prompt_accepted",
      acceptedAt: accepted.observedAt,
      inspection: withState(
        this.inspectionFor(lineage, current),
        "waiting_for_activity",
      ),
    });
    onEvent({
      type: "native_activity",
      observedAt: accepted.observedAt,
      inspection: withState(this.inspectionFor(lineage, current), "running"),
    });
    return this.waitForAuthorizedResult(
      dispatch,
      { ...lineage, nativeSession: accepted.nativeSession },
      current,
      evidence,
      onEvent,
      accepted.observedAt,
      accepted.observedAt,
    );
  }

  private async awaitNativePromptAcceptance(
    lineage: HarnessLineage,
    evidence: PromptEvidenceCursor,
    expectedConversationId?: string,
  ): Promise<{
    observedAt: string;
    nativeSession: NonNullable<HostedAgent["nativeSession"]>;
  }> {
    const deadline = Date.now() + promptActivityStallMs(this.config);
    while (Date.now() < deadline) {
      const observation = await this.observeNativePromptDispatch(
        lineage,
        evidence,
        expectedConversationId,
      );
      if (observation.working && observation.nativeSession)
        return {
          observedAt: observation.observedAt ?? this.now(),
          nativeSession: observation.nativeSession,
        };
      await Bun.sleep(50);
    }
    throw uncertainPrompt(
      new Error(
        expectedConversationId
          ? "Antigravity continuation produced no authoritative native acceptance or rejection evidence."
          : "Antigravity initial dispatch produced no authoritative native acceptance or rejection evidence.",
      ),
    );
  }

  private async observeNativePromptDispatch(
    lineage: HarnessLineage,
    evidence: PromptEvidenceCursor,
    expectedConversationId?: string,
  ): Promise<NativeTurnActivity> {
    const observation = await observeAntigravityPromptDispatch({
      logPath: nativeLogPath(lineage),
      evidence,
    });
    if (observation.state === "rejected")
      throw new OperationalExecutionError(
        `Antigravity rejected the authorized prompt before provider activity: ${observation.message}`,
        "operator_recovery_required",
        expectedConversationId
          ? "antigravity_continuation_dispatch_failed"
          : "antigravity_initial_dispatch_failed",
        { provider_cycles: 0 },
      );
    if (observation.state !== "accepted")
      return { working: false, observedAt: null };
    if (
      expectedConversationId &&
      observation.nativeSession.value !== expectedConversationId
    )
      throw new OperationalExecutionError(
        "Antigravity accepted the continuation into a different native conversation.",
        "operator_recovery_required",
        "antigravity_conversation_identity_mismatch",
        {
          expected_conversation_id: expectedConversationId,
          observed_conversation_id: observation.nativeSession.value,
        },
      );
    return {
      working: true,
      observedAt: observation.observedAt,
      nativeSession: observation.nativeSession,
    };
  }

  private async waitForAuthorizedResult(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    initial: HostedAgent,
    evidence: PromptEvidenceCursor,
    onEvent: (event: HarnessEvent) => void,
    acceptedAt = dispatch.promptAcceptedAt,
    nativeActivityObservedAt?: string,
  ): Promise<Record<string, JsonValue>> {
    let current = initial;
    const target = current.paneId || lineage.paneId;
    let previous = "";
    let nativeActivity = Boolean(
      dispatch.nativeActivityAt || nativeActivityObservedAt,
    );
    let stalled = Boolean(dispatch.stalledAt && !nativeActivity);
    if (!acceptedAt) {
      const resolution = await reconcileAmbiguousPrompt({
        observe: () =>
          this.observeNativePromptDispatch(
            lineage,
            evidence,
            lineage.nativeSession?.value,
          ),
        resultExists: () => structuredResultExists(dispatch.resultDirectory),
        timeoutMs: promptActivityStallMs(this.config),
      });
      if (resolution === "settled") {
        const outputs = (await collectStepResult(dispatch)).envelope.outputs;
        acceptedAt = this.now();
        const inspection = this.inspectionFor(lineage, current);
        onEvent({
          type: "prompt_accepted",
          acceptedAt,
          inspection: withState(inspection, "waiting_for_activity"),
        });
        onEvent({
          type: "structured_result_received",
          observedAt: this.now(),
          inspection,
        });
        return outputs;
      }
      if (!resolution)
        throw uncertainPrompt(
          new Error("restart found prompt intent without submission evidence"),
        );
      acceptedAt = resolution.observedAt ?? this.now();
      nativeActivity = true;
      onEvent({
        type: "prompt_accepted",
        acceptedAt,
        inspection: withState(
          this.inspectionFor(lineage, current),
          "waiting_for_activity",
        ),
      });
      onEvent({
        type: "native_activity",
        observedAt: resolution.observedAt ?? this.now(),
        inspection: withState(this.inspectionFor(lineage, current), "running"),
      });
    }
    while (true) {
      if (this.stopped)
        throw new HerdrApiError(
          "controller_disconnected",
          "Worker detached while Herdr retained the Antigravity TUI.",
        );
      if (await structuredResultExists(dispatch.resultDirectory)) {
        const outputs = (await collectStepResult(dispatch)).envelope.outputs;
        onEvent({
          type: "structured_result_received",
          observedAt: this.now(),
          inspection: this.inspectionFor(lineage, current),
        });
        return outputs;
      }
      const status = await new HarnessControlClient(
        controlDescriptorPath(lineage),
      ).completionStatus();
      if (status.contractViolation)
        throw new HerdrApiError(
          "harness_contract_violation",
          status.contractViolation,
        );
      const activity = await observeAntigravityNativeActivity({
        logPath: nativeLogPath(lineage),
        evidence,
      });
      if (!nativeActivity && (activity.working || status.attention)) {
        nativeActivity = true;
        onEvent({
          type: "native_activity",
          observedAt: activity.observedAt ?? this.now(),
          inspection: withState(
            this.inspectionFor(lineage, current),
            "running",
          ),
        });
      }
      if (
        status.attention &&
        !status.attention.attentionId.startsWith("agy-")
      ) {
        const inspection: HarnessInspection = {
          state: "waiting_for_human",
          agent: current,
          attention: status.attention,
          intervention: status.intervention ?? lineage.intervention,
          lastActivityAt: this.now(),
        };
        const fingerprint = `waiting_for_human:${status.attention.attentionId}`;
        if (fingerprint !== previous) {
          onEvent({ type: "inspection", inspection });
          previous = fingerprint;
        }
        await Bun.sleep(100);
        continue;
      }
      if (!target) throw new Error("Antigravity lineage has no agent target.");
      const observed = await this.host.inspectAgentState(target);
      current = {
        ...observed,
        ...(observed.nativeSession
          ? { nativeSession: observed.nativeSession }
          : lineage.nativeSession
            ? { nativeSession: lineage.nativeSession }
            : {}),
      };
      let inspection = await this.currentInspectionFor(lineage, current);
      if (!nativeActivity) {
        const state = waitingForActivitySince(
          acceptedAt,
          promptActivityStallMs(this.config),
          Date.parse(this.now()),
        );
        inspection = withState(inspection, state);
        if (state === "stalled" && !stalled) {
          stalled = true;
          onEvent({
            type: "stalled",
            observedAt: this.now(),
            inspection,
          });
        }
      }
      const fingerprint = `${inspection.state}:${current.status}:${inspection.attention?.attentionId ?? ""}`;
      if (fingerprint !== previous) {
        onEvent({ type: "inspection", inspection });
        previous = fingerprint;
      }
      await Bun.sleep(100);
    }
  }

  private async currentInspectionFor(
    lineage: HarnessLineage,
    agent: HostedAgent,
  ): Promise<HarnessInspection> {
    return this.inspectionFor(lineage, agent);
  }

  private inspectionFor(
    lineage: HarnessLineage,
    agent: HostedAgent,
  ): HarnessInspection {
    const attention =
      agent.status === "blocked"
        ? nativeAttention(lineage, agent, this.now())
        : null;
    return {
      state: attention
        ? "waiting_for_human"
        : agent.status === "working"
          ? "running"
          : agent.status === "unknown"
            ? "recovering"
            : "retained",
      agent,
      attention,
      intervention: lineage.intervention,
      lastActivityAt: this.now(),
    };
  }

  private async findExactLiveAgent(
    lineage: HarnessLineage,
  ): Promise<HostedAgent | null> {
    if (
      !lineage.agentName ||
      !lineage.paneId ||
      !lineage.herdrSessionIncarnation ||
      lineage.herdrSessionIncarnation !== this.host.sessionIncarnation()
    )
      return null;
    let agent: HostedAgent;
    try {
      agent = await this.host.inspectAgentState(lineage.paneId);
    } catch (error) {
      if (error instanceof HerdrApiError && error.code === "agent_not_found")
        return null;
      throw error;
    }
    if (
      lineage.herdrSessionIncarnation !== this.host.sessionIncarnation() ||
      agent.agent !== "agy" ||
      agent.paneId !== lineage.paneId ||
      (lineage.terminalId &&
        agent.terminalId !== undefined &&
        agent.terminalId !== lineage.terminalId) ||
      (agent.name !== undefined && agent.name !== lineage.agentName) ||
      agent.tokens?.qe_lineage_id !== lineage.lineageId ||
      agent.tokens.qe_ownership_token !== lineage.ownershipToken ||
      agent.tokens.qe_session_incarnation !== lineage.herdrSessionIncarnation ||
      agent.tokens.qe_harness_kind !== this.kind
    )
      return null;
    return agent;
  }

  private async reconcileNativeIdentity(
    lineage: HarnessLineage,
    agent: HostedAgent,
    discoverAfterPromptIntent = false,
  ): Promise<HostedAgent | null> {
    const observed =
      agent.nativeSession ??
      (await observeLatestAntigravityConversation({
        logPath: nativeLogPath(lineage),
      }));
    if (!lineage.nativeSession) {
      if (!observed) return agent;
      return discoverAfterPromptIntent
        ? { ...agent, nativeSession: observed }
        : null;
    }
    return observed?.agent === lineage.nativeSession.agent &&
      observed.kind === lineage.nativeSession.kind &&
      observed.value === lineage.nativeSession.value
      ? { ...agent, nativeSession: observed }
      : null;
  }

  private args(dispatch: DispatchRecord, lineage: HarnessLineage): string[] {
    const configuration = dispatch.action.execution.configuration;
    const sbx = this.sbxExecutions.get(lineage.lineageId);
    if (!sbx?.guestLogPath)
      throw new Error("Antigravity launch has no exact guest log binding.");
    const native = lineage.nativeSession;
    return [
      ...(native?.agent === "agy" && native.kind === "id"
        ? ["--conversation", native.value]
        : []),
      "--model",
      configuration.model.model,
      ...effortArgs(configuration.reasoning),
      "--dangerously-skip-permissions",
      "--log-file",
      sbx.guestLogPath,
    ];
  }

  private stopHookSpec(
    sbx: PreparedSbxHarnessExecution,
  ): AntigravityCommandHookSpec {
    return {
      name: HOOK_NAME,
      event: "Stop",
      command: `/usr/bin/node '${sbx.lease.paths.state}/antigravity-control/bridge-cli.mjs' hook stop`,
      timeoutSeconds: 10,
    };
  }

  private async assertExactConfiguration(
    dispatch: DispatchRecord,
  ): Promise<void> {
    const configuration = dispatch.action.execution.configuration;
    if (configuration.harness_kind !== this.kind)
      throw new Error("Resolved execution selected another harness.");
    if (
      configuration.tool_policy.kind !== "native_permissions" ||
      configuration.tool_enforcement !== "native_permissions" ||
      !Array.isArray(configuration.resolved_tool_profile.tools)
    )
      throw new Error(
        "Antigravity requires its native-permissions policy and resolved QE semantic capability profile.",
      );
    if (configuration.model.provider !== ANTIGRAVITY_MODEL_PROVIDER)
      throw new Error(
        "Antigravity models must use the antigravity provider namespace.",
      );
    const discovery = this.lastReadyDiscovery ?? (await this.discover());
    if (discovery.integration.status !== "ready")
      throw new Error(discovery.integration.detail);
    const model = discovery.models.find(
      (candidate) =>
        candidate.provider === configuration.model.provider &&
        candidate.model === configuration.model.model,
    );
    if (
      !model ||
      !reasoningMatches(model.reasoningCapability, configuration.reasoning)
    )
      throw new Error(
        "The exact Antigravity model/effort pair is not available; fallback is forbidden.",
      );
  }

  private async ensureWorkspace(
    environment: Record<string, string>,
    cwd: string,
  ): Promise<string> {
    const snapshot = await this.host.snapshot();
    const matching = snapshot.panes.filter((pane) =>
      samePath(pane.cwd ?? pane.foregroundCwd, cwd),
    );
    const ids = [...new Set(matching.map((pane) => pane.workspaceId))];
    if (ids.length > 1)
      throw new Error(
        "Multiple Herdr workspaces match the resolved workspace; refusing to guess.",
      );
    if (ids.length === 1) return ids[0] as string;
    return (
      await this.host.createWorkspace({
        cwd,
        label: `${basename(cwd)} · Quest Engineering Worker`,
        environment,
      })
    ).workspaceId;
  }
}

export function antigravityPromptFor(
  dispatch: Pick<DispatchRecord, "action">,
  materialized = {},
): string {
  return harnessPromptFor(dispatch, materialized, {
    completionTool: "qe_complete_step",
    humanAssistanceInstruction:
      "- The Run-owned SBX filesystem is the workspace authority. If Antigravity requests non-permission human input, leave the interactive prompt visible for takeover; do not invent a response.",
  });
}

function nativeLogPath(lineage: HarnessLineage): string {
  return join(dirname(lineage.resultControlPath), "antigravity.log");
}
function displayLabel(dispatch: DispatchRecord): string {
  return `Antigravity · ${dispatch.action.semantic_step_key.replace(/[-_]/g, " ").slice(0, 60)}`;
}
function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function agentNameFor(lineageId: string): string {
  return `qe-agy-${createHash("sha256").update(lineageId).digest("hex").slice(0, 16)}`;
}
function provenance(
  workerId: string,
  dispatch: DispatchRecord,
  lineage: HarnessLineage,
  active: boolean,
): Record<string, string> {
  return {
    qe_owner: "quest-engineering-worker/v1",
    qe_worker_id: workerId,
    qe_lineage_id: lineage.lineageId,
    qe_harness_kind: "antigravity",
    qe_agent_name: lineage.agentName ?? agentNameFor(lineage.lineageId),
    qe_ownership_token: lineage.ownershipToken,
    ...(lineage.herdrSessionIncarnation
      ? { qe_session_incarnation: lineage.herdrSessionIncarnation }
      : {}),
    ...(active
      ? {
          qe_active_state: "active",
          qe_active_action_id: dispatch.action.action_id,
          qe_action_hash: identityHash(dispatch.action.action_id),
          qe_run_id: dispatch.action.run_id,
          qe_occurrence_hash: identityHash(dispatch.action.occurrence_id),
          qe_attempt_hash: identityHash(dispatch.action.attempt_id),
          qe_result_nonce: dispatch.resultNonce,
        }
      : {
          qe_active_state: "inactive",
          qe_active_action_id: "",
          qe_result_nonce: "",
        }),
  };
}
function refFor(
  sessionName: string,
  sessionIncarnation: string,
  agentName: string,
  pane: HostedPane,
  agent: HostedAgent,
): HostedExecutionRef {
  return {
    sessionName,
    sessionIncarnation,
    workspaceId: pane.workspaceId,
    tabId: pane.tabId,
    paneId: pane.paneId,
    ...((pane.terminalId ?? agent.terminalId)
      ? { terminalId: pane.terminalId ?? agent.terminalId }
      : {}),
    agentName,
    ...(agent.nativeSession ? { nativeSession: agent.nativeSession } : {}),
  };
}
function requireSessionIncarnation(host: TerminalSessionBackend): string {
  const incarnation = host.sessionIncarnation();
  if (!incarnation)
    throw new Error(
      "QE-owned Herdr infrastructure has no session incarnation.",
    );
  return incarnation;
}
function assertCurrentSessionIncarnation(
  host: TerminalSessionBackend,
  expected: string,
): void {
  if (host.sessionIncarnation() !== expected)
    throw new HerdrApiError(
      "backend_unavailable",
      "The Herdr session changed physical incarnation during Antigravity startup.",
    );
}
function paneFor(agent: HostedAgent, lineage: HarnessLineage): HostedPane {
  return {
    workspaceId: agent.workspaceId,
    paneId: agent.paneId,
    tabId: agent.tabId ?? lineage.tabId ?? "",
    ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
  };
}
function nativeIdentityMatches(
  lineage: HarnessLineage,
  agent: HostedAgent,
): boolean {
  if (!lineage.nativeSession) return true;
  return Boolean(
    agent.nativeSession &&
      agent.nativeSession.kind === lineage.nativeSession.kind &&
      agent.nativeSession.agent === lineage.nativeSession.agent &&
      agent.nativeSession.value === lineage.nativeSession.value,
  );
}
function nativeAttention(
  lineage: HarnessLineage,
  agent: HostedAgent,
  requestedAt: string,
): HumanAttention {
  return {
    attentionId: `agy-${createHash("sha256")
      .update(
        `${lineage.lineageId}:${agent.paneId}:${agent.message ?? "blocked"}`,
      )
      .digest("hex")
      .slice(0, 24)}`,
    category: "unknown_interactive_block",
    message:
      agent.message?.slice(0, 240) ||
      "Antigravity is waiting at a native interactive prompt.",
    requestedAt: lineage.attention?.requestedAt ?? requestedAt,
    interaction: {
      kind: "conversational_intervention",
      controlState: "intervention_pending",
    },
  };
}
function unavailableInspection(
  lineage: HarnessLineage,
  lastActivityAt: string,
): HarnessInspection {
  return {
    state: "unavailable",
    agent: null,
    attention: lineage.attention,
    intervention: lineage.intervention,
    lastActivityAt,
  };
}
function effortArgs(reasoning: unknown): string[] {
  return typeof reasoning === "string" ? ["--effort", reasoning] : [];
}
function reasoningMatches(
  capability: ReasoningCapability | { kind: "unknown"; detail: string },
  requested: unknown,
): boolean {
  return capability.kind === "unsupported"
    ? requested === null
    : capability.kind === "enumerated" &&
        typeof requested === "string" &&
        capability.values.includes(requested);
}
function withState(
  inspection: HarnessInspection,
  state: "waiting_for_activity" | "running" | "stalled",
): HarnessInspection {
  return { ...inspection, state };
}
function expectedControlBinding(
  dispatch: DispatchRecord,
  lineage: HarnessLineage,
) {
  return {
    actionId: dispatch.action.action_id,
    attemptId: dispatch.action.attempt_id,
    lineageId: lineage.lineageId,
    resultNonce: dispatch.resultNonce,
  };
}
function samePath(left: string | undefined, right: string): boolean {
  return Boolean(left && resolve(left) === resolve(right));
}
async function readPreparedProcessReadiness(
  lineage: HarnessLineage,
): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(
      await readFile(
        join(dirname(nativeLogPath(lineage)), "pre-inference-readiness.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
  } catch {
    return rejectPreparedProcessAdoption(
      "The retained Antigravity pre-inference readiness proof is unavailable.",
    );
  }
}
function rejectPreparedProcessAdoption(message: string): never {
  throw new OperationalExecutionError(
    message,
    "operator_recovery_required",
    "prepared_process_adoption_rejected",
  );
}
function sameStringArray(value: unknown, expected: string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}
function backendReadinessDetail(
  readiness: Awaited<ReturnType<TerminalSessionBackend["readiness"]>>,
): string {
  return (
    readiness.diagnostics.map((diagnostic) => diagnostic.message).join(" ") ||
    `Herdr backend contract is ready for ${readiness.harnessKind}.`
  );
}
