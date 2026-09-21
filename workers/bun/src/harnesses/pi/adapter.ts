import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { WorkerConfig } from "../../config.ts";
import {
  type DispatchRecord,
  type HarnessLineage,
  physicalConfiguration,
} from "../../dispatch/registry.ts";
import type {
  PreparedSbxPiExecution,
  SbxRunExecutionManager,
} from "../../execution-environment/sbx-run.ts";
import type { JsonValue } from "../../protocol/types.ts";
import { HerdrApiError } from "../../session-host/herdr/client.ts";
import type {
  HostedAgent,
  HostedExecutionRef,
  HostedPane,
  NativeSessionRef,
  TerminalSessionBackend,
} from "../../session-host/types.ts";
import {
  executionArtifactRoot,
  type MaterializedArtifact,
  materializeExecutionArtifacts,
} from "../../workspace/execution-artifacts.ts";
import { controlDescriptorPath } from "../control/authority.ts";
import { HARNESS_CONTROL_PATH_ENV } from "../control/descriptor.ts";
import { HumanAttentionCorrelator } from "../control/human-attention.ts";
import {
  collectStepResult,
  readControl,
  writeControlAtomic,
} from "../control/result-envelope.ts";
import { harnessPromptFor } from "../prompt.ts";
import {
  ambiguousPromptError,
  errorProvesPromptSubmission,
  observePiNativeActivity,
  persistedPromptEvidence,
  promptActivityStallMs,
  promptEvidenceCursor,
  reconcileAmbiguousPrompt,
  structuredResultExists,
  uncertainPrompt,
  waitingForActivitySince,
} from "../turn-lifecycle.ts";
import type {
  AgentHarness,
  HarnessAdoptionCandidate,
  HarnessCapabilities,
  HarnessEvent,
  HarnessInspection,
  HarnessKnownDispatch,
  HarnessPreparedExecution,
  HarnessRecoveredExecution,
  HumanAttention,
  HumanAttentionCategory,
  HumanInterventionLifecycle,
  PromptEvidenceCursor,
} from "../types.ts";
import { discoverPiModels } from "./discovery.ts";
import { mappedPiTools } from "./tools.ts";

export { mappedPiTools } from "./tools.ts";

export class PiHarness implements AgentHarness {
  readonly kind = "pi";
  readonly displayName = "Pi";
  readonly integrationStrategy = "native_extension" as const;
  readonly capabilities: HarnessCapabilities = {
    structuredResult: true,
    continuation: true,
    retainedSessionRecovery: true,
    structuredAttention: true,
    nativeBlocking: true,
    canAttachTerminal: true,
    canSendInput: true,
    canInterrupt: true,
    canDetectAttention: true,
    canResume: true,
    canObserveStructuredEvents: true,
    structuredConfirmation: true,
    structuredTextResponse: false,
    structuredChoiceResponse: false,
    structuredMultilineResponse: false,
    nativePromptControl: true,
    conversationalTakeover: true,
    automationResume: true,
  };
  private readonly integrationPath: string;
  private readonly resultExtensionPath: string;
  private readonly permissionExtensionPath: string;
  private readonly assistanceExtensionPath: string;
  private readonly attentionCorrelator = new HumanAttentionCorrelator();
  private readonly discoverModels: typeof discoverPiModels;
  private readonly executionManager: SbxRunExecutionManager | undefined;
  private readonly sbxExecutions = new Map<string, PreparedSbxPiExecution>();
  private readonly sbxExecutionsByPane = new Map<
    string,
    PreparedSbxPiExecution
  >();
  private stopped = false;

  constructor(
    private readonly host: TerminalSessionBackend,
    private readonly config: WorkerConfig,
    paths: {
      integrationPath?: string;
      resultExtensionPath?: string;
      permissionExtensionPath?: string;
      assistanceExtensionPath?: string;
      discoverModels?: typeof discoverPiModels;
      executionManager?: SbxRunExecutionManager;
    } = {},
  ) {
    this.discoverModels = paths.discoverModels ?? discoverPiModels;
    this.executionManager = paths.executionManager;
    this.integrationPath = resolve(
      paths.integrationPath ??
        join(
          process.env.PI_CODING_AGENT_DIR?.trim() ||
            join(process.env.HOME || "", ".pi", "agent"),
          "extensions",
          "herdr-agent-state.ts",
        ),
    );
    this.resultExtensionPath = resolve(
      paths.resultExtensionPath ??
        join(import.meta.dir, "step-result-extension.ts"),
    );
    this.permissionExtensionPath = resolve(
      paths.permissionExtensionPath ??
        join(import.meta.dir, "workspace-permission-extension.ts"),
    );
    this.assistanceExtensionPath = resolve(
      paths.assistanceExtensionPath ??
        join(import.meta.dir, "human-assistance-extension.ts"),
    );
  }

  async discover() {
    const missing = this.missingIntegration();
    if (missing)
      return {
        kind: this.kind,
        displayName: this.displayName,
        strategy: this.integrationStrategy,
        integration: {
          status: "missing_dependency" as const,
          detail: missing,
          installed: false,
          authenticated: false,
        },
        models: [],
        capabilities: { ...this.capabilities, structuredResult: false },
      };
    const backend = await this.host.readiness();
    const guestRelaySatisfiesIntegration =
      Boolean(this.executionManager) &&
      backend.missingCapabilities.length > 0 &&
      backend.missingCapabilities.every(
        (capability) => capability === "integration.pi.current",
      );
    if (!backend.ready && !guestRelaySatisfiesIntegration)
      return {
        kind: this.kind,
        displayName: this.displayName,
        strategy: this.integrationStrategy,
        integration: {
          status:
            backend.status === "unavailable"
              ? ("unavailable" as const)
              : backend.missingCapabilities.every(
                    (capability) => capability === "integration.pi.current",
                  )
                ? ("missing_control_bridge" as const)
                : ("incompatible_version" as const),
          detail: backendReadinessDetail(backend),
          installed: true,
          authenticated: false,
        },
        models: [],
        capabilities: { ...this.capabilities, structuredResult: false },
      };
    try {
      const discovered = this.executionManager
        ? await this.executionManager.discover()
        : await this.discoverModels();
      return {
        kind: this.kind,
        displayName: this.displayName,
        strategy: this.integrationStrategy,
        integration: {
          status: discovered.authenticated
            ? ("ready" as const)
            : ("auth_required" as const),
          detail: [
            backendReadinessDetail(backend),
            discovered.diagnostics.join(" ") ||
              (discovered.authenticated
                ? "Pi native extension integration and configured model scope are ready."
                : "Pi has no authenticated models in its configured scope."),
          ]
            .filter(Boolean)
            .join(" "),
          installed: true,
          authenticated: discovered.authenticated,
        },
        models: discovered.models,
        capabilities: {
          ...this.capabilities,
          structuredResult: discovered.authenticated,
        },
      };
    } catch (error) {
      return {
        kind: this.kind,
        displayName: this.displayName,
        strategy: this.integrationStrategy,
        integration: {
          status: "unavailable" as const,
          detail: error instanceof Error ? error.message : String(error),
          installed: true,
          authenticated: false,
        },
        models: [],
        capabilities: { ...this.capabilities, structuredResult: false },
      };
    }
  }

  async start(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    this.assertIntegration();
    const sessionIncarnation = requireSessionIncarnation(this.host);
    const physicalLineage = {
      ...lineage,
      herdrSession: this.host.sessionName,
      herdrSessionIncarnation: sessionIncarnation,
    };
    const hostArtifacts = materializeExecutionArtifacts(this.config, dispatch);
    const sbx = this.executionManager
      ? await this.executionManager.prepare(
          dispatch,
          physicalLineage,
          hostArtifacts,
        )
      : null;
    if (sbx) this.sbxExecutions.set(lineage.lineageId, sbx);
    const cwd = sbx?.hostCwd ?? executionCwd(this.config, dispatch);
    mkdirSync(cwd, { recursive: true });
    const executionWorkspace = dispatch.action.execution.execution_workspace;
    const environment = sbx?.paneEnvironment ?? {
      [HARNESS_CONTROL_PATH_ENV]: controlDescriptorPath(lineage),
      QE_RESULT_CONTROL_PATH: lineage.resultControlPath,
      QE_ATTENTION_CONTROL_PATH: attentionControlPath(lineage),
      QE_RECOVERY_CONTROL_PATH: recoveryControlPath(lineage),
      QE_WORKSPACE_ACCESS: executionWorkspace.access,
      QE_WORKSPACE_ROOT:
        executionWorkspace.access === "none"
          ? cwd
          : executionWorkspace.canonical_root,
      QE_ALLOWED_PI_TOOLS: mappedPiTools(dispatch).join(","),
      QE_ARTIFACT_ROOT: executionArtifactRoot(this.config),
    };
    const workspaceId = await this.ensureWorkspace(environment, cwd);
    assertCurrentSessionIncarnation(this.host, sessionIncarnation);
    const snapshot = await this.host.snapshot();
    assertCurrentSessionIncarnation(this.host, sessionIncarnation);
    const workspaceAgents = snapshot.agents.filter(
      (agent) => agent.workspaceId === workspaceId,
    );
    const workspacePanes = snapshot.panes.filter(
      (pane) => pane.workspaceId === workspaceId,
    );
    let pane: HostedPane;
    if (workspaceAgents.length === 0 && workspacePanes.length === 1) {
      pane = workspacePanes[0] as HostedPane;
    } else {
      pane = await this.host.createTab({
        workspaceId,
        cwd,
        label: displayLabel(dispatch),
        environment,
      });
    }
    assertCurrentSessionIncarnation(this.host, sessionIncarnation);
    const agentName = agentNameFor(
      lineage.lineageId,
      dispatch.action.semantic_step_key,
    );
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
    await sbx?.syncControl();
    await this.host.reportMetadata({
      paneId: pane.paneId,
      title: displayLabel(dispatch),
      tokens: launchTokens,
    });
    const piArgs = this.piArgs(dispatch, agentName, sbx);
    const command = sbx ? await sbx.launchDescriptor(piArgs) : undefined;
    sbx?.startRelay(this.host, pane.paneId);
    let agent: HostedAgent;
    try {
      agent = await this.host.startAgent({
        paneId: pane.paneId,
        name: agentName,
        integrationKind: "pi",
        args: piArgs,
        ...(command ? { command } : {}),
        expectedTokens: launchTokens,
      });
      await sbx?.awaitAttestation();
    } catch (error) {
      await sbx?.stopRelay().catch(() => undefined);
      if (sbx) await this.host.closePane(pane.paneId).catch(() => undefined);
      throw error;
    }
    if (sbx) this.sbxExecutionsByPane.set(agent.paneId, sbx);
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

  async continue(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    if (
      !lineage.agentName ||
      !lineage.paneId ||
      !lineage.workspaceId ||
      lineage.herdrSession !== this.host.sessionName ||
      !lineage.herdrSessionIncarnation ||
      lineage.herdrSessionIncarnation !== this.host.sessionIncarnation()
    ) {
      throw new Error(
        "Continuation lineage has no complete Herdr execution reference.",
      );
    }
    const sbx = this.executionManager
      ? await this.executionManager.prepare(
          dispatch,
          lineage,
          materializeExecutionArtifacts(this.config, dispatch),
        )
      : null;
    if (sbx) {
      this.sbxExecutions.set(lineage.lineageId, sbx);
      await sbx.syncControl();
    }
    const agent = await this.findExactLiveAgent(lineage);
    if (agent) {
      sbx?.startRelay(this.host, agent.paneId);
      await sbx?.awaitAttestation();
      if (sbx) this.sbxExecutionsByPane.set(agent.paneId, sbx);
    }
    assertCurrentSessionIncarnation(this.host, lineage.herdrSessionIncarnation);
    if (!agent) {
      throw new Error(
        "The exact continued Herdr/Pi execution is missing or has incompatible provenance.",
      );
    }
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
        lineage.agentName,
        {
          workspaceId: agent.workspaceId,
          paneId: agent.paneId,
          tabId: agent.tabId ?? lineage.tabId ?? "",
          ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
        },
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
    rmSync(recoveryControlPath(execution.lineage), { force: true });
    await writeControlAtomic(execution.lineage.resultControlPath, {
      protocolVersion: 1,
      workerId: dispatch.action.worker_id,
      lineageId: execution.lineage.lineageId,
      action: dispatch.action,
      nonce: dispatch.resultNonce,
      resultDirectory: dispatch.resultDirectory,
    });
    const sbx = this.sbxExecutions.get(execution.lineage.lineageId);
    await sbx?.syncControl();
    const prompt = piPromptFor(
      dispatch,
      sbx?.materializedArtifacts ??
        materializeExecutionArtifacts(this.config, dispatch),
    );
    const transcriptPath = piTranscriptPath(
      execution.agent.nativeSession ?? execution.ref.nativeSession ?? undefined,
    );
    const evidence = sbx
      ? {
          kind: "pi_runtime_state" as const,
          cursor: await sbx.activityCursor(),
          promptHash: createHash("sha256").update(prompt).digest("hex"),
        }
      : await promptEvidenceCursor(
          "pi_transcript",
          transcriptPath ?? "",
          prompt,
        );
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

  async recover(
    lineage: HarnessLineage,
    dispatch?: DispatchRecord,
  ): Promise<HarnessRecoveredExecution> {
    if (
      !lineage.herdrSessionIncarnation ||
      lineage.herdrSessionIncarnation !== this.host.sessionIncarnation()
    )
      return {
        found: false,
        detail:
          "The original Pi execution belongs to another Herdr session incarnation.",
      };
    if (!lineage.agentName || !lineage.paneId)
      return {
        found: false,
        detail: "Lineage has no launched agent reference.",
      };
    const sbx =
      this.executionManager && dispatch
        ? await this.executionManager.prepare(
            dispatch,
            lineage,
            materializeExecutionArtifacts(this.config, dispatch),
          )
        : null;
    if (sbx) {
      this.sbxExecutions.set(lineage.lineageId, sbx);
      await sbx.syncControl();
    }
    const agent = await this.findExactLiveAgent(lineage);
    if (agent) {
      sbx?.startRelay(this.host, agent.paneId);
      await sbx?.awaitAttestation();
      if (sbx) this.sbxExecutionsByPane.set(agent.paneId, sbx);
    }
    if (!agent)
      return {
        found: false,
        detail:
          "Herdr cannot verify the original Pi agent with its durable lineage provenance.",
      };
    return {
      found: true,
      agent,
      detail: `Herdr found the original Pi agent in ${agent.status} state.`,
    };
  }

  async waitAndCollect(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    agent: HostedAgent,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    if (!lineage.paneId)
      throw new Error("Recovered lineage has no agent pane.");
    const sbx = this.sbxExecutions.get(lineage.lineageId);
    const prompt = piPromptFor(
      dispatch,
      sbx?.materializedArtifacts ??
        materializeExecutionArtifacts(this.config, dispatch),
    );
    const evidence = sbx
      ? (persistedPromptEvidence(dispatch, "pi_runtime_state", prompt) ?? {
          kind: "pi_runtime_state" as const,
          cursor: await sbx.activityCursor(),
          promptHash: createHash("sha256").update(prompt).digest("hex"),
        })
      : (persistedPromptEvidence(dispatch, "pi_transcript", prompt) ??
        (await promptEvidenceCursor(
          "pi_transcript",
          piTranscriptPath(
            agent.nativeSession ?? lineage.nativeSession ?? undefined,
          ) ?? "",
          prompt,
        )));
    return this.collectPromptLifecycle(
      dispatch,
      lineage,
      lineage.paneId,
      agent,
      prompt,
      evidence,
      onEvent,
    );
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
        !tokens.qe_lineage_id ||
        tokens.qe_active_state !== "active" ||
        !tokens.qe_active_action_id ||
        !tokens.qe_ownership_token ||
        !tokens.qe_session_incarnation ||
        tokens.qe_session_incarnation !== this.host.sessionIncarnation()
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
        const expectedAgentName =
          tokens.qe_agent_name ??
          persisted?.lineage.agentName ??
          agentNameFor(control.lineageId, control.action.semantic_step_key);
        const agentNamePrefix = `qe-${createHash("sha256")
          .update(control.lineageId)
          .digest("hex")
          .slice(0, 12)}-`;
        if (
          !expectedAgentName.startsWith(agentNamePrefix) ||
          control.workerId !== this.config.workerId ||
          control.lineageId !== tokens.qe_lineage_id ||
          control.action.run_id !== tokens.qe_run_id ||
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
            provider: "pi",
            harnessKind: "pi",
            sessionState:
              agent.status === "blocked" ? "waiting_for_human" : "recovering",
            capabilities: this.capabilities,
            attention: null,
            intervention: null,
            startedAt: new Date().toISOString(),
            lastActivityAt: new Date().toISOString(),
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
            nativeSession: agent.nativeSession ?? null,
          },
        });
      } catch {
        // Incomplete or mismatched provenance is not safe to adopt.
      }
    }
    return candidates;
  }

  async clearActiveMetadata(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void> {
    await this.sbxExecutions.get(lineage.lineageId)?.stopRelay();
    this.sbxExecutions.delete(lineage.lineageId);
    if (lineage.paneId) this.sbxExecutionsByPane.delete(lineage.paneId);
    if (!lineage.paneId) return;
    try {
      await this.host.reportMetadata({
        paneId: lineage.paneId,
        title: displayLabel(dispatch),
        tokens: provenance(this.config.workerId, dispatch, lineage, false),
      });
    } catch {
      // Durable completed dispatch state is authoritative over stale Herdr metadata.
    }
  }

  attachment(lineage: HarnessLineage) {
    if (
      !lineage.workspaceId ||
      !lineage.paneId ||
      !lineage.agentName ||
      !lineage.herdrSession
    ) {
      throw new Error("Harness lineage has no attachable Herdr execution.");
    }
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

  async interrupt(lineage: HarnessLineage): Promise<void> {
    if (!lineage.paneId)
      throw new Error("Harness session has no live agent target.");
    await this.host.sendKeys(lineage.paneId, ["esc"]);
  }

  async inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    if (!lineage.paneId)
      return {
        state: "unavailable",
        agent: null,
        attention: lineage.attention,
        intervention: lineage.intervention,
        lastActivityAt: new Date().toISOString(),
      };
    try {
      return this.inspectionFor(
        lineage,
        await this.host.inspectAgentState(lineage.paneId),
      );
    } catch {
      return {
        state: "unavailable",
        agent: null,
        attention: lineage.attention,
        intervention: lineage.intervention,
        lastActivityAt: new Date().toISOString(),
      };
    }
  }

  async close(lineage: HarnessLineage): Promise<void> {
    await this.sbxExecutions.get(lineage.lineageId)?.stopRelay();
    this.sbxExecutions.delete(lineage.lineageId);
    if (lineage.paneId) this.sbxExecutionsByPane.delete(lineage.paneId);
    if (!lineage.paneId) return;
    await this.host.sendKeys(lineage.paneId, ["ctrl+c", "ctrl+c"]);
  }

  disconnect(): void {
    this.stopped = true;
    for (const execution of this.sbxExecutions.values())
      void execution.stopRelay();
    this.sbxExecutions.clear();
    this.sbxExecutionsByPane.clear();
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
    let current = initial;
    let acceptedAt: string;
    try {
      // No `until` clause: Herdr acknowledges submission without imposing its
      // five-second terminal-state heuristic on QE's semantic lifecycle.
      current = await this.host.prompt(target, prompt);
      acceptedAt = new Date().toISOString();
    } catch (error) {
      if (errorProvesPromptSubmission(error)) {
        acceptedAt = new Date().toISOString();
        current = await this.host.inspectAgentState(target);
      } else if (ambiguousPromptError(error)) {
        const resolution = await reconcileAmbiguousPrompt({
          observe: () =>
            this.nativeActivity(target, current, prompt, evidence).then(
              (value) => value.activity,
            ),
          resultExists: () => structuredResultExists(dispatch.resultDirectory),
          timeoutMs: promptActivityStallMs(this.config),
        });
        if (resolution === "settled") {
          const outputs = (await collectStepResult(dispatch)).envelope.outputs;
          acceptedAt = new Date().toISOString();
          onEvent({
            type: "prompt_accepted",
            acceptedAt,
            inspection: waitingInspection(
              this.inspectionFor(lineage, current),
              "waiting_for_activity",
            ),
          });
          onEvent({
            type: "settled",
            observedAt: new Date().toISOString(),
            inspection: this.inspectionFor(lineage, current),
          });
          return outputs;
        }
        if (!resolution) throw uncertainPrompt(error);
        acceptedAt = resolution.observedAt ?? new Date().toISOString();
      } else throw error;
    }
    onEvent({
      type: "prompt_accepted",
      acceptedAt,
      inspection: waitingInspection(
        this.inspectionFor(lineage, current),
        "waiting_for_activity",
      ),
    });
    return this.collectPromptLifecycle(
      dispatch,
      lineage,
      target,
      current,
      prompt,
      evidence,
      onEvent,
      acceptedAt,
    );
  }

  private async collectPromptLifecycle(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    target: string,
    initial: HostedAgent,
    prompt: string,
    evidence: PromptEvidenceCursor,
    onEvent: (event: HarnessEvent) => void,
    acceptedAt = dispatch.promptAcceptedAt,
  ): Promise<Record<string, JsonValue>> {
    let current = initial;
    let nativeActivity = Boolean(dispatch.nativeActivityAt);
    let stalled = Boolean(dispatch.stalledAt && !nativeActivity);
    let previousInspection = "";
    if (!acceptedAt) {
      const resolution = await reconcileAmbiguousPrompt({
        observe: () =>
          this.nativeActivity(target, current, prompt, evidence).then(
            (value) => value.activity,
          ),
        resultExists: () => structuredResultExists(dispatch.resultDirectory),
        timeoutMs: promptActivityStallMs(this.config),
      });
      if (resolution === "settled") {
        const outputs = (await collectStepResult(dispatch)).envelope.outputs;
        const inspection = this.inspectionFor(lineage, current);
        acceptedAt = new Date().toISOString();
        onEvent({
          type: "prompt_accepted",
          acceptedAt,
          inspection: waitingInspection(inspection, "waiting_for_activity"),
        });
        onEvent({
          type: "settled",
          observedAt: new Date().toISOString(),
          inspection,
        });
        return outputs;
      }
      if (!resolution)
        throw uncertainPrompt(
          new Error("restart found prompt intent without submission evidence"),
        );
      acceptedAt = resolution.observedAt ?? new Date().toISOString();
      onEvent({
        type: "prompt_accepted",
        acceptedAt,
        inspection: waitingInspection(
          this.inspectionFor(lineage, current),
          "waiting_for_activity",
        ),
      });
    }
    while (true) {
      if (this.stopped)
        throw new HerdrApiError(
          "controller_disconnected",
          "Worker detached while Herdr retained the Pi execution.",
        );
      if (await structuredResultExists(dispatch.resultDirectory)) {
        const outputs = (await collectStepResult(dispatch)).envelope.outputs;
        const inspection = this.inspectionFor(lineage, current);
        onEvent({
          type: "settled",
          observedAt: new Date().toISOString(),
          inspection,
        });
        return outputs;
      }
      const observation = await this.nativeActivity(
        target,
        current,
        prompt,
        evidence,
      );
      current = observation.agent;
      let inspection = this.inspectionFor(lineage, current);
      const structuredActivity =
        readAttentionControl(lineage).structured.state === "requested";
      if (
        !nativeActivity &&
        (observation.activity.working || structuredActivity)
      ) {
        nativeActivity = true;
        const running = waitingInspection(inspection, "running");
        onEvent({
          type: "native_activity",
          observedAt:
            observation.activity.observedAt ?? new Date().toISOString(),
          inspection: running,
        });
        previousInspection = inspectionFingerprint(running);
      }
      if (nativeActivity) {
        if (
          ["idle", "done"].includes(current.status) &&
          !interventionIsPending(inspection.intervention)
        ) {
          const outputs = (await collectStepResult(dispatch)).envelope.outputs;
          onEvent({
            type: "settled",
            observedAt: new Date().toISOString(),
            inspection,
          });
          return outputs;
        }
        const fingerprint = inspectionFingerprint(inspection);
        if (fingerprint !== previousInspection) {
          onEvent({ type: "inspection", inspection });
          previousInspection = fingerprint;
        }
      } else {
        const state = waitingForActivitySince(
          acceptedAt,
          promptActivityStallMs(this.config),
        );
        inspection = waitingInspection(inspection, state);
        if (state === "stalled" && !stalled) {
          stalled = true;
          onEvent({
            type: "stalled",
            observedAt: new Date().toISOString(),
            inspection,
          });
          previousInspection = inspectionFingerprint(inspection);
        } else {
          const fingerprint = inspectionFingerprint(inspection);
          if (fingerprint !== previousInspection) {
            onEvent({ type: "inspection", inspection });
            previousInspection = fingerprint;
          }
        }
      }
      await Bun.sleep(100);
    }
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
      agent.agent !== "pi" ||
      agent.paneId !== lineage.paneId ||
      (lineage.terminalId &&
        agent.terminalId !== undefined &&
        agent.terminalId !== lineage.terminalId) ||
      (agent.name !== undefined && agent.name !== lineage.agentName) ||
      agent.tokens?.qe_lineage_id !== lineage.lineageId ||
      agent.tokens.qe_ownership_token !== lineage.ownershipToken ||
      agent.tokens.qe_session_incarnation !== lineage.herdrSessionIncarnation
    )
      return null;
    return agent;
  }

  private async nativeActivity(
    target: string,
    fallback: HostedAgent,
    prompt: string,
    evidence: PromptEvidenceCursor,
  ): Promise<{
    agent: HostedAgent;
    activity: Awaited<ReturnType<typeof observePiNativeActivity>>;
  }> {
    const agent = await this.host
      .inspectAgentState(target)
      .catch(() => fallback);
    if (evidence.kind === "pi_runtime_state") {
      const relayed = this.sbxExecutionsByPane
        .get(target)
        ?.observedActivityAfter(evidence.cursor);
      return {
        agent,
        activity: {
          working:
            Boolean(relayed) ||
            agent.status === "working" ||
            agent.status === "blocked",
          observedAt:
            relayed ??
            (agent.status === "working" || agent.status === "blocked"
              ? new Date().toISOString()
              : null),
        },
      };
    }
    const path = piTranscriptPath(agent.nativeSession);
    return {
      agent,
      activity: path
        ? await observePiNativeActivity({
            transcriptPath: path,
            evidence,
            prompt,
          })
        : { working: false, observedAt: null },
    };
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
    const pane = await this.host.createWorkspace({
      cwd,
      label: `${basename(cwd)} · Quest Engineering Worker`,
      environment,
    });
    return pane.workspaceId;
  }

  private piArgs(
    dispatch: DispatchRecord,
    agentName: string,
    sbx?: PreparedSbxPiExecution | null,
  ): string[] {
    const configuration = dispatch.action.execution.configuration;
    if (
      configuration.tool_policy.kind !== "exact" ||
      configuration.tool_enforcement !== "exact"
    )
      throw new Error("Pi requires an exactly enforced tool policy.");
    return [
      "--model",
      `${configuration.model.provider}/${configuration.model.model}`,
      ...(configuration.reasoning === null
        ? []
        : ["--thinking", configuration.reasoning]),
      "--no-extensions",
      ...(sbx
        ? sbx.extensionPaths.flatMap((path) => ["--extension", path])
        : [
            "--extension",
            this.integrationPath,
            "--extension",
            this.resultExtensionPath,
            "--extension",
            this.permissionExtensionPath,
            "--extension",
            this.assistanceExtensionPath,
          ]),
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--name",
      agentName,
      "--tools",
      mappedPiTools(dispatch).join(","),
    ];
  }

  private assertIntegration(): void {
    const missing = this.missingIntegration();
    if (missing) throw new Error(missing);
  }

  private missingIntegration(): string | null {
    if (this.executionManager) return null;
    if (!existsSync(this.integrationPath))
      return "Official Herdr Pi integration is missing; run 'herdr integration install pi' manually.";
    if (!existsSync(this.resultExtensionPath))
      return "Quest Engineering Pi result extension is missing.";
    if (!existsSync(this.permissionExtensionPath))
      return "Quest Engineering Pi permission extension is missing.";
    if (!existsSync(this.assistanceExtensionPath))
      return "Quest Engineering Pi assistance extension is missing.";
    return null;
  }

  private inspectionFor(
    lineage: HarnessLineage,
    agent: HostedAgent,
  ): HarnessInspection {
    const control = readAttentionControl(lineage);
    const attention = this.attentionCorrelator.observe({
      lineageId: lineage.lineageId,
      harnessDisplayName: this.displayName,
      terminalState: agent.status,
      structured: control.structured,
      persistedAttention: lineage.attention,
    });
    const infrastructureFailure = this.executionManager?.failureCode(
      lineage.lineageId,
    );
    const state = infrastructureFailure
      ? "unavailable"
      : attention
        ? "waiting_for_human"
        : agent.status === "working"
          ? "running"
          : agent.status === "unknown"
            ? "recovering"
            : "retained";
    return {
      state,
      agent,
      attention,
      intervention: control.intervention ?? lineage.intervention,
      lastActivityAt: new Date().toISOString(),
    };
  }
}

function attentionControlPath(lineage: HarnessLineage): string {
  return join(dirname(lineage.resultControlPath), "attention-control.json");
}

function recoveryControlPath(lineage: HarnessLineage): string {
  return join(dirname(lineage.resultControlPath), "recovery-control.json");
}

function readAttentionControl(lineage: HarnessLineage): {
  structured:
    | { state: "requested"; attention: HumanAttention }
    | { state: "resolved" }
    | { state: "unavailable" };
  intervention: HumanInterventionLifecycle | null;
} {
  try {
    const value = JSON.parse(
      readFileSync(attentionControlPath(lineage), "utf8"),
    ) as Record<string, unknown>;
    if (![1, 2].includes(Number(value.version)))
      return { structured: { state: "unavailable" }, intervention: null };
    const intervention = interventionLifecycle(value);
    if (value.state === "resolved" || value.state === "resuming")
      return { structured: { state: "resolved" }, intervention };
    if (
      value.state === "requested" &&
      typeof value.attentionId === "string" &&
      typeof value.category === "string" &&
      attentionCategory(value.category) &&
      typeof value.message === "string" &&
      typeof value.requestedAt === "string"
    ) {
      const conversational =
        value.interaction === "conversational_intervention";
      return {
        structured: {
          state: "requested",
          attention: {
            attentionId: value.attentionId,
            category: value.category,
            message: value.message.slice(0, 240),
            requestedAt: value.requestedAt,
            ...(conversational
              ? {
                  interaction: {
                    kind: "conversational_intervention" as const,
                    controlState: "intervention_pending" as const,
                    resumeCommand: "/qe-resume",
                  },
                }
              : {}),
          },
        },
        intervention,
      };
    }
  } catch {
    // Missing/incomplete control data is not evidence of an explicit QE prompt.
  }
  return { structured: { state: "unavailable" }, intervention: null };
}

function interventionLifecycle(
  value: Record<string, unknown>,
): HumanInterventionLifecycle | null {
  if (
    value.version !== 2 ||
    value.interaction !== "conversational_intervention" ||
    typeof value.attentionId !== "string" ||
    typeof value.requestedAt !== "string"
  )
    return null;
  if (value.state === "requested")
    return {
      attentionId: value.attentionId,
      kind: "conversational_intervention",
      state: "intervention_pending",
      requestedAt: value.requestedAt,
    };
  if (value.state === "resuming")
    return {
      attentionId: value.attentionId,
      kind: "conversational_intervention",
      state: "resuming_automation",
      requestedAt: value.requestedAt,
      ...(typeof value.handedBackAt === "string"
        ? { handedBackAt: value.handedBackAt }
        : {}),
    };
  if (value.state === "resolved")
    return {
      attentionId: value.attentionId,
      kind: "conversational_intervention",
      state: "resumed",
      requestedAt: value.requestedAt,
      ...(typeof value.handedBackAt === "string"
        ? { handedBackAt: value.handedBackAt }
        : {}),
      ...(typeof value.automationResumedAt === "string"
        ? { automationResumedAt: value.automationResumedAt }
        : {}),
    };
  return null;
}

function attentionCategory(value: string): value is HumanAttentionCategory {
  return [
    "needs_input",
    "needs_permission",
    "needs_authentication",
    "needs_confirmation",
    "blocked_external",
    "interactive_prompt",
    "unknown_interactive_block",
  ].includes(value);
}

export function piPromptFor(
  dispatch: Pick<DispatchRecord, "action">,
  materialized: Record<string, MaterializedArtifact> = {},
): string {
  return harnessPromptFor(dispatch, materialized, {
    completionTool: "qe_step_result",
    recoveryContext: "retained session state",
    humanAssistanceInstruction:
      "- In Pi, use qe_request_human_assistance with a stable category and concise message. Use interaction conversational_intervention when normal multi-turn discussion is required; automation resumes only after /qe-resume. Use confirmation only for a simple completed/not-completed gate.",
  });
}

function executionCwd(config: WorkerConfig, dispatch: DispatchRecord): string {
  const execution = dispatch.action.execution;
  return execution.execution_workspace.access === "none"
    ? join(config.dataRoot, "isolated", execution.context.logical_lineage_id)
    : execution.execution_workspace.canonical_root;
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
    qe_provider: "pi",
    qe_agent_name:
      lineage.agentName ??
      agentNameFor(lineage.lineageId, dispatch.action.semantic_step_key),
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
          qe_semantic_step_key: dispatch.action.semantic_step_key,
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
      "The Herdr session changed physical incarnation during Pi startup.",
    );
}
function identityHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function agentNameFor(lineageId: string, semanticStepKey: string): string {
  const slug =
    semanticStepKey
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "")
      .slice(0, 8) || "agent";
  return `qe-${createHash("sha256").update(lineageId).digest("hex").slice(0, 12)}-${slug}`.slice(
    0,
    32,
  );
}
function displayLabel(dispatch: DispatchRecord): string {
  return dispatch.action.semantic_step_key.replace(/[-_]/g, " ").slice(0, 80);
}
function samePath(left: string | undefined, right: string): boolean {
  return Boolean(left && resolve(left) === resolve(right));
}
function piTranscriptPath(
  session: NativeSessionRef | undefined,
): string | null {
  return session?.source === "pi" && session.kind === "path"
    ? session.value
    : null;
}

function waitingInspection(
  inspection: HarnessInspection,
  state: "waiting_for_activity" | "running" | "stalled",
): HarnessInspection {
  return { ...inspection, state };
}

function inspectionFingerprint(inspection: HarnessInspection): string {
  return [
    inspection.state,
    inspection.agent?.status ?? "none",
    inspection.attention?.attentionId ?? "none",
    inspection.intervention?.state ?? "none",
  ].join(":");
}

function backendReadinessDetail(
  readiness: Awaited<ReturnType<TerminalSessionBackend["readiness"]>>,
): string {
  return (
    readiness.diagnostics.map((diagnostic) => diagnostic.message).join(" ") ||
    `Herdr backend contract is ready for ${readiness.harnessKind}.`
  );
}

function interventionIsPending(
  intervention: HumanInterventionLifecycle | null,
): boolean {
  return Boolean(intervention && intervention.state !== "resumed");
}
