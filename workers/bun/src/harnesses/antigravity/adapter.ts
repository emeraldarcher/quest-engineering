import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { QE_TOOL_CAPABILITIES } from "../../capabilities.ts";
import type { WorkerConfig } from "../../config.ts";
import {
  type DispatchRecord,
  type HarnessLineage,
  physicalConfiguration,
} from "../../dispatch/registry.ts";
import type { JsonValue, ReasoningCapability } from "../../protocol/types.ts";
import { findAgent, HerdrApiError } from "../../session-host/herdr/client.ts";
import type {
  HostedAgent,
  HostedExecutionRef,
  HostedPane,
  TerminalSessionBackend,
} from "../../session-host/types.ts";
import {
  executionArtifactRoot,
  materializeExecutionArtifacts,
} from "../../workspace/execution-artifacts.ts";
import { controlDescriptorPath } from "../control/authority.ts";
import { HarnessControlClient } from "../control/client.ts";
import { HARNESS_CONTROL_PATH_ENV } from "../control/descriptor.ts";
import { QE_MCP_STARTUP_EVIDENCE_ENV } from "../control/mcp-server.ts";
import {
  collectStepResult,
  readControl,
  writeControlAtomic,
} from "../control/result-envelope.ts";
import { harnessPromptFor } from "../prompt.ts";
import type {
  AgentHarness,
  HarnessAdoptionCandidate,
  HarnessCapabilities,
  HarnessDiscovery,
  HarnessEvent,
  HarnessInspection,
  HarnessPreparedExecution,
  HarnessRecoveredExecution,
  HumanAttention,
} from "../types.ts";
import {
  ANTIGRAVITY_MODEL_PROVIDER,
  discoverAntigravityModels,
  type NativeCommandRunner,
  SUPPORTED_ANTIGRAVITY_VERSION,
} from "./discovery.ts";
import {
  type AntigravityCommandHookSpec,
  inspectAntigravityCommandHook,
  installAntigravityCommandHook,
  proveAntigravityStopHookReadiness,
  removeAntigravityCommandHook,
  waitForAntigravityHookDiscovery,
} from "./hook-readiness.ts";

const HOOK_NAME = "qe-worker-stop-v1";

interface AntigravityDependencies {
  discoverModels?: typeof discoverAntigravityModels;
  runNativeCommand?: NativeCommandRunner;
  proveReadiness?: typeof proveAntigravityStopHookReadiness;
  now?: () => string;
}

/** Interactive-first Antigravity 1.2.2 adapter. MCP transports payloads only. */
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
  private readonly proveReadiness: typeof proveAntigravityStopHookReadiness;
  private readonly now: () => string;
  private readonly bridgeCliPath = resolve(
    import.meta.dir,
    "..",
    "control",
    "bridge-cli.ts",
  );
  private readonly mcpServerPath = resolve(
    import.meta.dir,
    "..",
    "control",
    "mcp-server.ts",
  );
  private stopped = false;
  private readonly activeHookWorkspaces = new Map<string, string>();
  private readonly originalHookContents = new Map<string, string | null>();

  constructor(
    private readonly host: TerminalSessionBackend,
    private readonly config: WorkerConfig,
    dependencies: AntigravityDependencies = {},
  ) {
    this.discoverModels =
      dependencies.discoverModels ?? discoverAntigravityModels;
    this.runNativeCommand = dependencies.runNativeCommand;
    this.proveReadiness =
      dependencies.proveReadiness ?? proveAntigravityStopHookReadiness;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async discover(): Promise<HarnessDiscovery> {
    const native = await this.discoverModels(this.runNativeCommand);
    const registration = native.installed
      ? await this.inspectMcpRegistration()
      : { ready: false, detail: "Antigravity CLI is unavailable." };
    const ready =
      native.installed &&
      native.authenticated &&
      native.version === SUPPORTED_ANTIGRAVITY_VERSION &&
      registration.ready;
    return {
      kind: this.kind,
      displayName: this.displayName,
      strategy: this.integrationStrategy,
      integration: {
        status: ready
          ? "ready"
          : !native.installed
            ? "missing_dependency"
            : native.version !== SUPPORTED_ANTIGRAVITY_VERSION
              ? "incompatible_version"
              : !native.authenticated
                ? "auth_required"
                : "missing_control_bridge",
        detail: [...native.diagnostics, registration.detail].join(" "),
        installed: native.installed,
        authenticated: native.authenticated,
      },
      models: native.models,
      capabilities: { ...this.capabilities, structuredResult: ready },
    };
  }

  async start(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    await this.assertExactConfiguration(dispatch);
    const cwd = executionCwd(this.config, dispatch);
    mkdirSync(cwd, { recursive: true });
    await this.activateHook(lineage, cwd);
    const environment = this.environment(dispatch, lineage);
    const workspaceId = await this.ensureWorkspace(environment, cwd);
    // A dedicated tab guarantees this process receives its immutable session
    // environment even when the Herdr workspace already existed.
    const pane = await this.host.createTab({
      workspaceId,
      cwd,
      label: displayLabel(dispatch),
      environment,
    });
    const agentName = agentNameFor(lineage.lineageId);
    await this.host.reportMetadata({
      paneId: pane.paneId,
      title: displayLabel(dispatch),
      tokens: provenance(this.config.workerId, dispatch, lineage, true),
    });
    await prepareStartupEvidence(lineage);
    const agent = await this.host.startAgent({
      paneId: pane.paneId,
      name: agentName,
      integrationKind: "agy",
      args: this.args(dispatch, lineage),
    });
    return {
      lineage,
      ref: refFor(this.host.sessionName, agentName, pane, agent),
      agent,
    };
  }

  async ready(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
  ): Promise<void> {
    const cwd = executionCwd(this.config, dispatch);
    const lineage = execution.lineage;
    const descriptorPath = controlDescriptorPath(lineage);
    await waitForMcpStartup(
      startupEvidencePath(lineage),
      descriptorPath,
      this.config.resultTimeoutMs,
    );
    await this.proveReadiness({
      hookConfigPath: hookConfigPath(cwd),
      spec: this.stopHookSpec(),
      logPath: nativeLogPath(lineage),
      syntheticArgv: [process.execPath, this.bridgeCliPath, "hook", "stop"],
      syntheticPayload: {
        conversationId: "00000000-0000-4000-8000-000000000001",
        executionNum: 0,
        terminationReason: "qe_zero_inference_readiness",
        fullyIdle: true,
        modelName: "synthetic-no-inference",
      },
      env: {
        ...process.env,
        [HARNESS_CONTROL_PATH_ENV]: descriptorPath,
      },
      timeoutMs: Math.min(this.config.resultTimeoutMs, 30_000),
    });
  }

  async continue(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    await this.assertExactConfiguration(dispatch);
    await this.activateHook(lineage, executionCwd(this.config, dispatch));
    const agent = await this.findExactLiveAgent(lineage);
    if (!agent || !nativeIdentityMatches(lineage, agent))
      throw new Error(
        "The exact continued Antigravity TUI is missing or has incompatible provenance.",
      );
    await this.host.reportMetadata({
      paneId: agent.paneId,
      title: displayLabel(dispatch),
      tokens: provenance(this.config.workerId, dispatch, lineage, true),
    });
    return {
      lineage,
      ref: refFor(
        this.host.sessionName,
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
    const working = await this.host.prompt(
      execution.ref.agentName,
      antigravityPromptFor(
        dispatch,
        materializeExecutionArtifacts(this.config, dispatch),
      ),
      { until: ["working", "blocked", "unknown"], timeoutMs: 30_000 },
    );
    onEvent({
      type: "running",
      inspection: this.inspectionFor(execution.lineage, working),
    });
    return this.waitForAuthorizedResult(
      dispatch,
      execution.lineage,
      working,
      onEvent,
    );
  }

  async waitAndCollect(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    agent: HostedAgent,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    return this.waitForAuthorizedResult(dispatch, lineage, agent, onEvent);
  }

  async recover(lineage: HarnessLineage): Promise<HarnessRecoveredExecution> {
    const live = await this.findExactLiveAgent(lineage);
    if (live) {
      if (!nativeIdentityMatches(lineage, live))
        return {
          found: false,
          detail:
            "The surviving Antigravity TUI has an unverifiable native conversation identity.",
        };
      const configuration = persistedConfiguration(lineage);
      const cwd = persistedExecutionCwd(this.config, lineage, configuration);
      if (cwd) await this.activateHook(lineage, cwd);
      return {
        found: true,
        agent: live,
        detail: `Herdr found the original Antigravity TUI in ${live.status} state.`,
      };
    }
    const native = lineage.nativeSession;
    if (!native || native.kind !== "id" || native.agent !== "agy")
      return {
        found: false,
        detail:
          "The Antigravity TUI is gone and no verified native conversation ID is available.",
      };
    const configuration = persistedConfiguration(lineage);
    await this.assertPersistedConfigurationAvailable(configuration);
    const cwd = persistedExecutionCwd(this.config, lineage, configuration);
    if (!cwd)
      return {
        found: false,
        detail: "Recovery workspace provenance is invalid.",
      };
    await this.activateHook(lineage, cwd);
    const environment = {
      [HARNESS_CONTROL_PATH_ENV]: controlDescriptorPath(lineage),
      [QE_MCP_STARTUP_EVIDENCE_ENV]: startupEvidencePath(lineage),
    };
    const workspaceId = await this.ensureWorkspace(environment, cwd);
    const pane = await this.host.createTab({
      workspaceId,
      cwd,
      label: "Antigravity recovery",
      environment,
    });
    const agentName = `${agentNameFor(lineage.lineageId)}-${crypto.randomUUID().slice(0, 6)}`;
    await this.host.reportMetadata({
      paneId: pane.paneId,
      title: "Antigravity recovery",
      tokens: retainedProvenance(this.config.workerId, lineage),
    });
    await prepareStartupEvidence(lineage);
    const model = record(configuration.model);
    const agent = await this.host.startAgent({
      paneId: pane.paneId,
      name: agentName,
      integrationKind: "agy",
      args: [
        "--conversation",
        native.value,
        "--model",
        String(model?.model ?? ""),
        ...effortArgs(configuration.reasoning),
        "--log-file",
        nativeLogPath(lineage),
      ],
    });
    if (
      !agent.nativeSession ||
      agent.nativeSession.kind !== "id" ||
      agent.nativeSession.value !== native.value
    )
      return {
        found: false,
        detail:
          "Relaunched Antigravity did not verify the retained conversation identity.",
      };
    return {
      found: true,
      agent,
      ref: refFor(this.host.sessionName, agentName, pane, agent),
      detail:
        "Antigravity resumed the verified conversation in a new terminal/process incarnation.",
    };
  }

  async inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    if (!lineage.agentName) return unavailableInspection(lineage, this.now());
    try {
      return this.inspectionFor(
        lineage,
        await this.host.inspectAgentState(lineage.agentName),
      );
    } catch {
      return unavailableInspection(lineage, this.now());
    }
  }

  async interrupt(lineage: HarnessLineage): Promise<void> {
    if (!lineage.agentName)
      throw new Error("Antigravity session has no live agent target.");
    await this.host.sendKeys(lineage.agentName, ["esc"]);
  }

  async close(lineage: HarnessLineage): Promise<void> {
    if (lineage.agentName)
      await this.host.sendKeys(lineage.agentName, ["ctrl+c", "ctrl+c"]);
    await this.deactivateHook(lineage);
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
    await this.deactivateHook(lineage);
  }

  async discoverAdoptionCandidates(): Promise<HarnessAdoptionCandidate[]> {
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
        !tokens.qe_result_nonce ||
        !agent.name
      )
        continue;
      const resultControlPath = join(
        this.config.dataRoot,
        "lineages",
        tokens.qe_lineage_id,
        "result-control.json",
      );
      if (!existsSync(resultControlPath)) continue;
      try {
        const control = await readControl(resultControlPath);
        if (
          control.workerId !== this.config.workerId ||
          control.lineageId !== tokens.qe_lineage_id ||
          control.action.action_id !== tokens.qe_active_action_id ||
          control.action.execution.configuration.harness_kind !== this.kind ||
          control.nonce !== tokens.qe_result_nonce
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
            workspaceId: agent.workspaceId,
            tabId: agent.tabId ?? null,
            paneId: agent.paneId,
            terminalId: agent.terminalId ?? null,
            agentName: agent.name,
            nativeSession: agent.nativeSession ?? null,
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

  private async proveRecoveredProcessReadiness(
    lineage: HarnessLineage,
  ): Promise<void> {
    const configuration = persistedConfiguration(lineage);
    const cwd = persistedExecutionCwd(this.config, lineage, configuration);
    if (!cwd) throw new Error("Recovery workspace provenance is invalid.");
    await waitForMcpStartup(
      startupEvidencePath(lineage),
      controlDescriptorPath(lineage),
      this.config.resultTimeoutMs,
    );
    const inspection = await inspectAntigravityCommandHook(
      hookConfigPath(cwd),
      this.stopHookSpec(),
    );
    if (
      !inspection.namespacedHookPresent ||
      !inspection.eventRegistered ||
      !inspection.commandMatches ||
      !inspection.timeoutMatches
    )
      throw new Error(
        "Recovered Antigravity Stop hook configuration is invalid.",
      );
    await waitForAntigravityHookDiscovery({
      logPath: nativeLogPath(lineage),
      minimumNamedHooks: inspection.namedHookCount,
      minimumConfigFiles: 1,
      timeoutMs: Math.min(this.config.resultTimeoutMs, 30_000),
    });
  }

  private async activateHook(
    lineage: HarnessLineage,
    cwd: string,
  ): Promise<void> {
    const path = hookConfigPath(cwd);
    if (!this.originalHookContents.has(cwd))
      this.originalHookContents.set(cwd, await optionalFile(path));
    await installAntigravityCommandHook(path, this.stopHookSpec());
    this.activeHookWorkspaces.set(lineage.lineageId, cwd);
  }

  private async deactivateHook(lineage: HarnessLineage): Promise<void> {
    const cwd = this.activeHookWorkspaces.get(lineage.lineageId);
    if (!cwd) return;
    this.activeHookWorkspaces.delete(lineage.lineageId);
    if ([...this.activeHookWorkspaces.values()].includes(cwd)) return;
    const path = hookConfigPath(cwd);
    await removeAntigravityCommandHook(path, HOOK_NAME);
    const original = this.originalHookContents.get(cwd);
    this.originalHookContents.delete(cwd);
    if (original !== undefined) {
      const current = await optionalFile(path);
      if (semanticallySameHookConfig(current, original)) {
        if (original !== null)
          await writeFile(path, original, { encoding: "utf8", mode: 0o600 });
      }
    }
  }

  private async waitForAuthorizedResult(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    initial: HostedAgent,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    const deadline = Date.now() + this.config.resultTimeoutMs;
    let current = initial;
    let target = current.name ?? lineage.agentName;
    let previous = "";
    while (Date.now() < deadline) {
      if (this.stopped)
        throw new HerdrApiError(
          "controller_disconnected",
          "Worker detached while Herdr retained the Antigravity TUI.",
        );
      if (await resultExists(dispatch.resultDirectory))
        return (await collectStepResult(dispatch)).envelope.outputs;
      const status = await new HarnessControlClient(
        controlDescriptorPath(lineage),
      ).completionStatus();
      if (status.contractViolation)
        throw new HerdrApiError(
          "harness_contract_violation",
          status.contractViolation,
        );
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
      try {
        if (!target)
          throw new Error("Antigravity lineage has no agent target.");
        current = await this.host.inspectAgentState(target);
      } catch (error) {
        if (!backendUnavailable(error)) throw error;
        const recovered = await this.recover(lineage);
        if (!recovered.found || !recovered.agent)
          throw new Error(recovered.detail);
        current = recovered.agent;
        if (recovered.ref) await this.proveRecoveredProcessReadiness(lineage);
        target = recovered.ref?.agentName ?? current.name ?? target;
      }
      const inspection = this.inspectionFor(lineage, current);
      const fingerprint = `${inspection.state}:${current.status}:${inspection.attention?.attentionId ?? ""}`;
      if (fingerprint !== previous) {
        onEvent({ type: "inspection", inspection });
        previous = fingerprint;
      }
      await Bun.sleep(100);
    }
    throw new HerdrApiError(
      "timeout",
      "Timed out waiting for an authorized Antigravity structured result.",
    );
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
    if (!lineage.agentName || !lineage.paneId) return null;
    const agent = findAgent(await this.host.snapshot(), {
      paneId: lineage.paneId,
      ...(lineage.terminalId ? { terminalId: lineage.terminalId } : {}),
      agentName: lineage.agentName,
    });
    if (
      !agent ||
      agent.agent !== "agy" ||
      agent.tokens?.qe_lineage_id !== lineage.lineageId ||
      agent.tokens.qe_ownership_token !== lineage.ownershipToken ||
      agent.tokens.qe_harness_kind !== this.kind
    )
      return null;
    return agent;
  }

  private args(dispatch: DispatchRecord, lineage: HarnessLineage): string[] {
    const configuration = dispatch.action.execution.configuration;
    return [
      "--model",
      configuration.model.model,
      ...effortArgs(configuration.reasoning),
      "--log-file",
      nativeLogPath(lineage),
    ];
  }

  private environment(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Record<string, string> {
    return {
      [HARNESS_CONTROL_PATH_ENV]: controlDescriptorPath(lineage),
      [QE_MCP_STARTUP_EVIDENCE_ENV]: startupEvidencePath(lineage),
      QE_WORKSPACE_ACCESS: dispatch.action.execution.execution_workspace.access,
      QE_WORKSPACE_ROOT: executionCwd(this.config, dispatch),
      QE_ARTIFACT_ROOT: executionArtifactRoot(this.config),
    };
  }

  private stopHookSpec(): AntigravityCommandHookSpec {
    return {
      name: HOOK_NAME,
      event: "Stop",
      command: `${process.execPath} '${this.bridgeCliPath}' hook stop`,
      timeoutSeconds: 10,
    };
  }

  private async assertPersistedConfigurationAvailable(
    configuration: Record<string, unknown>,
  ): Promise<void> {
    if (
      configuration.tool_enforcement !== "native_permissions" ||
      !sameStringSet(configuration.tools, QE_TOOL_CAPABILITIES)
    )
      throw new Error(
        "The retained Antigravity execution did not freeze the complete native-permissions tool profile.",
      );
    const model = record(configuration.model);
    const provider = model?.provider;
    const modelId = model?.model;
    const effort = configuration.reasoning;
    const discovery = await this.discover();
    if (
      discovery.integration.status !== "ready" ||
      !discovery.models.some(
        (candidate) =>
          candidate.provider === provider &&
          candidate.model === modelId &&
          reasoningMatches(candidate.reasoningCapability, effort),
      )
    )
      throw new Error(
        "The retained Antigravity model/effort pair is unavailable; recovery fallback is forbidden.",
      );
  }

  private async assertExactConfiguration(
    dispatch: DispatchRecord,
  ): Promise<void> {
    const configuration = dispatch.action.execution.configuration;
    if (configuration.harness_kind !== this.kind)
      throw new Error("Resolved execution selected another harness.");
    if (
      configuration.tool_enforcement !== "native_permissions" ||
      !sameStringSet(configuration.tools, QE_TOOL_CAPABILITIES)
    )
      throw new Error(
        "Antigravity requires its complete native-permissions tool profile; exact subset enforcement is unavailable.",
      );
    if (configuration.model.provider !== ANTIGRAVITY_MODEL_PROVIDER)
      throw new Error(
        "Antigravity models must use the antigravity provider namespace.",
      );
    const discovery = await this.discover();
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

  private async inspectMcpRegistration(): Promise<{
    ready: boolean;
    detail: string;
  }> {
    const result = await (this.runNativeCommand
      ? this.runNativeCommand(["mcp", "list"])
      : nativeCommand(["mcp", "list"]));
    const line = result.stdout
      .split("\n")
      .find((value) => /^qe\s/.test(value.trim()));
    const ready =
      result.exitCode === 0 &&
      Boolean(
        line &&
          /\bstdio\b/.test(line) &&
          /\benabled\b/.test(line) &&
          line.includes(process.execPath) &&
          line.includes(this.mcpServerPath),
      );
    return {
      ready,
      detail: ready
        ? "The qe stdio MCP transport is enabled."
        : "The qe stdio MCP transport is missing or disabled.",
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
      "- Antigravity's native permission prompts remain authoritative. When blocked, leave the interactive prompt visible for human takeover; do not invent approval.",
  });
}

function hookConfigPath(cwd: string): string {
  return join(cwd, ".agents", "hooks.json");
}
function nativeLogPath(lineage: HarnessLineage): string {
  return join(dirname(lineage.resultControlPath), "antigravity.log");
}
function startupEvidencePath(lineage: HarnessLineage): string {
  return join(dirname(lineage.resultControlPath), "mcp-startup.jsonl");
}
function executionCwd(config: WorkerConfig, dispatch: DispatchRecord): string {
  const execution = dispatch.action.execution;
  return execution.execution_workspace.access === "none"
    ? join(config.dataRoot, "isolated", execution.context.logical_lineage_id)
    : execution.execution_workspace.canonical_root;
}
function displayLabel(dispatch: DispatchRecord): string {
  return `Antigravity · ${dispatch.action.semantic_step_key.replace(/[-_]/g, " ").slice(0, 60)}`;
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
    qe_ownership_token: lineage.ownershipToken,
    ...(active
      ? {
          qe_active_state: "active",
          qe_active_action_id: dispatch.action.action_id,
          qe_run_id: dispatch.action.run_id,
          qe_occurrence_id: dispatch.action.occurrence_id,
          qe_attempt_id: dispatch.action.attempt_id,
          qe_result_nonce: dispatch.resultNonce,
        }
      : {
          qe_active_state: "inactive",
          qe_active_action_id: "",
          qe_result_nonce: "",
        }),
  };
}
function retainedProvenance(
  workerId: string,
  lineage: HarnessLineage,
): Record<string, string> {
  return {
    qe_owner: "quest-engineering-worker/v1",
    qe_worker_id: workerId,
    qe_lineage_id: lineage.lineageId,
    qe_harness_kind: "antigravity",
    qe_ownership_token: lineage.ownershipToken,
    qe_active_state: lineage.activeActionId ? "active" : "inactive",
    qe_active_action_id: lineage.activeActionId ?? "",
  };
}
function refFor(
  sessionName: string,
  agentName: string,
  pane: HostedPane,
  agent: HostedAgent,
): HostedExecutionRef {
  return {
    sessionName,
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
function sameStringSet(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item) => typeof item === "string" && expected.includes(item))
  );
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
async function optionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function semanticallySameHookConfig(
  left: string | null,
  right: string | null,
): boolean {
  if (left === null || right === null) return left === right;
  try {
    return (
      JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right))
    );
  } catch {
    return left === right;
  }
}
async function resultExists(directory: string): Promise<boolean> {
  try {
    return (await readdir(directory)).some((name) =>
      /^result-[a-zA-Z0-9_-]+\.json$/.test(name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function waitForMcpStartup(
  path: string,
  descriptorPath: string,
  timeoutMs: number,
): Promise<void> {
  const expected = createHash("sha256").update(descriptorPath).digest("hex");
  const deadline = Date.now() + Math.min(timeoutMs, 30_000);
  while (Date.now() < deadline) {
    try {
      const content = await Bun.file(path).text();
      if (
        content
          .split("\n")
          .filter(Boolean)
          .some((line) => {
            const event = JSON.parse(line) as Record<string, unknown>;
            return (
              event.kind === "qe_harness_mcp_startup" &&
              event.descriptorPathHash === expected &&
              event.bridgeAcceptedContext === true &&
              typeof event.pid === "number" &&
              processAlive(event.pid)
            );
          })
      )
        return;
    } catch {
      // Child startup evidence has not been published yet.
    }
    await Bun.sleep(100);
  }
  throw new Error(
    "Antigravity did not launch the QE MCP child with the active bridge context.",
  );
}
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function persistedConfiguration(
  lineage: HarnessLineage,
): Record<string, unknown> {
  return JSON.parse(lineage.configurationJson) as Record<string, unknown>;
}
function persistedExecutionCwd(
  config: WorkerConfig,
  lineage: HarnessLineage,
  configuration: Record<string, unknown>,
): string | null {
  if (configuration.workspace_access === "none")
    return join(config.dataRoot, "isolated", lineage.logicalLineageId);
  return typeof configuration.workspace_root === "string" &&
    configuration.workspace_root
    ? configuration.workspace_root
    : null;
}
function samePath(left: string | undefined, right: string): boolean {
  return Boolean(left && resolve(left) === resolve(right));
}
function backendUnavailable(error: unknown): boolean {
  return (
    error instanceof HerdrApiError &&
    ["backend_unavailable", "controller_disconnected"].includes(error.code)
  );
}
async function prepareStartupEvidence(lineage: HarnessLineage): Promise<void> {
  const path = startupEvidencePath(lineage);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "", { encoding: "utf8", mode: 0o600 });
}
function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function nativeCommand(args: string[]) {
  const result = Bun.spawnSync(["agy", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}
