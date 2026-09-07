import type {
  DispatchRecord,
  ProviderLineage,
} from "../../dispatch/registry.ts";
import type { JsonValue } from "../../protocol/types.ts";
import type { HostedAgent } from "../../session-host/types.ts";
import type {
  AgentHarness,
  HarnessCapabilities,
  HarnessEvent,
  HarnessInspection,
  HarnessPreparedExecution,
  HarnessRecoveredExecution,
  HumanAttentionCategory,
} from "../types.ts";
import { OperationalExecutionError } from "../types.ts";

/** Deterministic test harness. Never enabled without QE_ENABLE_TEST_PROVIDER=1. */
export class FakeHarness implements AgentHarness {
  readonly kind = "fake";
  readonly displayName = "Test Harness";
  readonly capabilities: HarnessCapabilities;
  private readonly inspections = new Map<string, HarnessInspection>();
  private readonly waiters = new Map<string, () => void>();
  private readonly listeners = new Map<string, (event: HarnessEvent) => void>();
  private nextFailure: Error | null = null;

  constructor(
    private readonly outputs: Record<string, JsonValue> = {},
    private readonly delayMs = 0,
    private readonly behavior: {
      autoEscalateMaterialMissingDecision?: boolean;
      conversationalTakeover?: boolean;
      structuredConfirmation?: boolean;
    } = {},
  ) {
    this.capabilities = {
      canAttachTerminal: false,
      canSendInput: true,
      canInterrupt: true,
      canDetectAttention: true,
      canResume: true,
      canObserveStructuredEvents: true,
      structuredConfirmation: behavior.structuredConfirmation ?? false,
      structuredTextResponse: false,
      structuredChoiceResponse: false,
      structuredMultilineResponse: false,
      nativePromptControl: behavior.conversationalTakeover ?? false,
      conversationalTakeover: behavior.conversationalTakeover ?? false,
      automationResume: behavior.conversationalTakeover ?? false,
    };
  }

  async start(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<HarnessPreparedExecution> {
    return prepared(dispatch, lineage);
  }

  async continue(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<HarnessPreparedExecution> {
    return prepared(dispatch, lineage);
  }

  async sendInputAndCollect(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    const lineageId = execution.lineage.lineageId;
    this.listeners.set(lineageId, onEvent);
    let existing = this.inspections.get(lineageId);
    const escalation =
      this.behavior.autoEscalateMaterialMissingDecision &&
      humanEscalationReason(dispatch);
    if (!existing && escalation) {
      if (this.capabilities.conversationalTakeover)
        this.requestConversationalIntervention(execution.lineage, escalation);
      else
        this.requestAttention(
          execution.lineage,
          "needs_input",
          `${escalation} This harness cannot provide conversational takeover.`,
        );
      existing = this.inspections.get(lineageId);
    }
    if (existing?.attention) {
      onEvent({
        type: "running",
        inspection: {
          state: "running",
          agent: { ...execution.agent, status: "working" },
          attention: null,
          intervention: null,
          lastActivityAt: new Date().toISOString(),
        },
      });
      onEvent({ type: "inspection", inspection: existing });
      await new Promise<void>((resolve) =>
        this.waiters.set(lineageId, resolve),
      );
    } else {
      const inspection = this.running(execution.lineage, execution.agent);
      onEvent({ type: "running", inspection });
    }
    if (this.delayMs) await Bun.sleep(this.delayMs);
    this.listeners.delete(lineageId);
    if (this.nextFailure) {
      const failure = this.nextFailure;
      this.nextFailure = null;
      throw failure;
    }
    return outputsFor(dispatch, this.outputs);
  }

  requestAttention(
    lineage: ProviderLineage,
    category: HumanAttentionCategory = "needs_input",
    message = "Test harness needs input.",
  ): HarnessInspection {
    const inspection: HarnessInspection = {
      state: "waiting_for_human",
      agent: fakeAgent(lineage.lineageId, "blocked"),
      attention: {
        attentionId: crypto.randomUUID(),
        category,
        message,
        requestedAt: new Date().toISOString(),
      },
      intervention: null,
      lastActivityAt: new Date().toISOString(),
    };
    this.inspections.set(lineage.lineageId, inspection);
    this.listeners.get(lineage.lineageId)?.({
      type: "inspection",
      inspection,
    });
    return inspection;
  }

  requestConversationalIntervention(
    lineage: ProviderLineage,
    message = "Test harness needs a conversation.",
  ): HarnessInspection {
    const requestedAt = new Date().toISOString();
    const attentionId = crypto.randomUUID();
    const inspection: HarnessInspection = {
      state: "waiting_for_human",
      agent: fakeAgent(lineage.lineageId, "blocked"),
      attention: {
        attentionId,
        category: "needs_input",
        message,
        requestedAt,
        interaction: {
          kind: "conversational_intervention",
          controlState: "intervention_pending",
          resumeCommand: "/qe-resume",
        },
      },
      intervention: {
        attentionId,
        kind: "conversational_intervention",
        state: "intervention_pending",
        requestedAt,
      },
      lastActivityAt: requestedAt,
    };
    this.inspections.set(lineage.lineageId, inspection);
    this.listeners.get(lineage.lineageId)?.({
      type: "inspection",
      inspection,
    });
    return inspection;
  }

  provideInput(lineage: ProviderLineage): HarnessInspection {
    const inspection = this.running(
      lineage,
      fakeAgent(lineage.lineageId, "working"),
    );
    this.listeners.get(lineage.lineageId)?.({
      type: "inspection",
      inspection,
    });
    this.waiters.get(lineage.lineageId)?.();
    this.waiters.delete(lineage.lineageId);
    return inspection;
  }

  resumeAutomation(lineage: ProviderLineage): HarnessInspection {
    const previous = this.inspections.get(lineage.lineageId)?.intervention;
    const inspection = this.running(
      lineage,
      fakeAgent(lineage.lineageId, "working"),
    );
    if (previous) {
      const resumedAt = new Date().toISOString();
      inspection.intervention = {
        ...previous,
        state: "resumed",
        handedBackAt: resumedAt,
        automationResumedAt: resumedAt,
      };
      this.inspections.set(lineage.lineageId, inspection);
    }
    this.listeners.get(lineage.lineageId)?.({
      type: "inspection",
      inspection,
    });
    this.waiters.get(lineage.lineageId)?.();
    this.waiters.delete(lineage.lineageId);
    return inspection;
  }

  emitOutput(lineage: ProviderLineage): void {
    const inspection = this.running(
      lineage,
      fakeAgent(lineage.lineageId, "working"),
    );
    this.listeners.get(lineage.lineageId)?.({ type: "output", inspection });
  }

  failNext(message = "Fake harness failed."): void {
    this.nextFailure = new OperationalExecutionError(
      message,
      "operator_recovery_required",
    );
  }

  failNextTransient(message = "Transient fake harness failure."): void {
    this.nextFailure = new OperationalExecutionError(message, "auto_retryable");
  }

  async interrupt(lineage: ProviderLineage): Promise<void> {
    this.inspections.set(lineage.lineageId, {
      state: "retained",
      agent: fakeAgent(lineage.lineageId, "idle"),
      attention: null,
      intervention: null,
      lastActivityAt: new Date().toISOString(),
    });
    this.waiters.get(lineage.lineageId)?.();
    this.waiters.delete(lineage.lineageId);
  }

  async inspect(lineage: ProviderLineage): Promise<HarnessInspection> {
    return (
      this.inspections.get(lineage.lineageId) ?? {
        state: "recovering",
        agent: fakeAgent(lineage.lineageId, "unknown"),
        attention: lineage.attention,
        intervention: lineage.intervention,
        lastActivityAt: new Date().toISOString(),
      }
    );
  }

  async close(lineage: ProviderLineage): Promise<void> {
    this.inspections.set(lineage.lineageId, {
      state: "closed",
      agent: null,
      attention: null,
      intervention: null,
      lastActivityAt: new Date().toISOString(),
    });
  }

  async recover(lineage: ProviderLineage): Promise<HarnessRecoveredExecution> {
    const inspection = await this.inspect(lineage);
    return inspection.agent
      ? {
          found: true,
          agent: inspection.agent,
          detail: "Fake harness execution recovered.",
        }
      : { found: false, detail: "Fake harness session is closed." };
  }

  async waitAndCollect(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
    agent: HostedAgent,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    onEvent({ type: "inspection", inspection: this.running(lineage, agent) });
    return outputsFor(dispatch, this.outputs);
  }

  async clearActiveMetadata(): Promise<void> {}
  async discoverAdoptionCandidates() {
    return [];
  }
  attachment(lineage: ProviderLineage) {
    return {
      mode: "local_native_terminal" as const,
      backendKind: "fake",
      terminalSessionId: "fake",
      terminalTargetId: `fake-${lineage.lineageId}`,
      supportsObservation: false,
      supportsTakeover: false,
    };
  }
  disconnect(): void {}

  private running(
    lineage: ProviderLineage,
    agent: HostedAgent,
  ): HarnessInspection {
    const inspection: HarnessInspection = {
      state: "running",
      agent: { ...agent, status: "working" },
      attention: null,
      intervention: null,
      lastActivityAt: new Date().toISOString(),
    };
    this.inspections.set(lineage.lineageId, inspection);
    return inspection;
  }
}

function prepared(
  _dispatch: DispatchRecord,
  lineage: ProviderLineage,
): HarnessPreparedExecution {
  const agent = fakeAgent(lineage.lineageId, "idle");
  return {
    lineage,
    ref: {
      sessionName: "fake",
      workspaceId: "fake-workspace",
      tabId: `fake-tab-${lineage.lineageId}`,
      paneId: agent.paneId,
      ...(agent.terminalId ? { terminalId: agent.terminalId } : {}),
      agentName: agent.name as string,
    },
    agent,
  };
}
function fakeAgent(
  lineageId = "recovered",
  status: HostedAgent["status"] = "done",
): HostedAgent {
  return {
    name: `fake-${lineageId}`,
    agent: "fake",
    status,
    paneId: `fake-pane-${lineageId}`,
    terminalId: `fake-terminal-${lineageId}`,
    workspaceId: "fake-workspace",
    tabId: `fake-tab-${lineageId}`,
    interactiveReady: true,
  };
}
function humanEscalationReason(dispatch: DispatchRecord): string | null {
  const work = dispatch.action.execution.work;
  const combined =
    `${work.quest_objective}\n${work.step_instruction}`.toLowerCase();
  if (
    combined.includes("requires human authentication") ||
    combined.includes("requires external approval") ||
    combined.includes("manual action by the human")
  )
    return "Authentication, approval, or manual human action is required.";
  const promisesLaterInstructions =
    combined.includes("instructions you receive during implementation") ||
    combined.includes("human will provide");
  const specifiesFilename = /\b[\w.-]+\.(txt|md|json|ts|ex|exs)\b/.test(
    combined,
  );
  const specifiesContents =
    combined.includes("containing") || combined.includes("contents:");
  return promisesLaterInstructions &&
    !specifiesFilename &&
    !specifiesContents &&
    Object.keys(work.inputs).length === 0
    ? "Required filename and file contents are missing."
    : null;
}

function outputsFor(
  dispatch: DispatchRecord,
  outputs: Record<string, JsonValue>,
): Record<string, JsonValue> {
  return Object.fromEntries(
    dispatch.action.declared_outputs.map((key) => [key, outputs[key] ?? {}]),
  );
}
