import type {
  DispatchRecord,
  HarnessLineage,
} from "../../dispatch/registry.ts";
import type { JsonValue } from "../../protocol/types.ts";
import type {
  AgentHarness,
  AgentHarnessSetup,
  HarnessCapabilities,
  HarnessDiscovery,
  HarnessEvent,
  HarnessExecutionHandle,
  HarnessInspection,
  HarnessPreparedExecution,
  HarnessRecoveredExecution,
  HarnessSetupContext,
  HarnessSetupInspection,
  HarnessSetupPrepared,
  HumanAttentionCategory,
} from "../types.ts";
import { OperationalExecutionError } from "../types.ts";

/** Deterministic headless test harness. Never enabled without QE_ENABLE_TEST_PROVIDER=1. */
export class FakeHarness implements AgentHarness {
  readonly kind = "fake";
  readonly displayName = "Test Harness";
  readonly integrationStrategy = "native_rpc" as const;
  readonly capabilities: HarnessCapabilities;
  private readonly inspections = new Map<string, HarnessInspection>();
  private readonly waiters = new Map<string, () => void>();
  private readonly listeners = new Map<string, (event: HarnessEvent) => void>();
  private nextFailure: Error | null = null;
  recoveryCount = 0;
  private readonly setupReady = new Set<string>();
  readonly setup: AgentHarnessSetup = {
    kind: "provider_authentication",
    prepare: async (context) => {
      const prepared: HarnessSetupPrepared = {
        context,
        inspection: this.inspectSetup(context),
        native: { fake: true },
      };
      return prepared;
    },
    inspect: async (prepared) => this.inspectSetup(prepared.context),
    begin: async (prepared, _authorization, onEvent) => {
      const context = prepared.context;
      const attentionId = `fake-setup-${context.setupId}-${context.setupGeneration}`;
      let settle!: (inspection: HarnessSetupInspection) => void;
      let settled = false;
      const completion = new Promise<HarnessSetupInspection>((resolve) => {
        settle = resolve;
      });
      onEvent({ type: "invocation_acknowledged" });
      if (this.setupReady.has(context.physicalLineageId)) {
        const inspection = this.inspectSetup(context);
        onEvent({ type: "ready", inspection });
        settle(inspection);
      } else {
        onEvent({
          type: "human_interaction_required",
          attentionId,
          message: "Deterministic fake setup requires an explicit response.",
          ephemeralOutput:
            "FAKE SETUP — no provider process or network request",
        });
      }
      return {
        completion,
        respond: async (candidateAttentionId) => {
          if (candidateAttentionId !== attentionId || settled)
            throw new Error("Stale fake setup interaction.");
          settled = true;
          this.setupReady.add(context.physicalLineageId);
          const inspection = this.inspectSetup(context);
          onEvent({ type: "ready", inspection });
          settle(inspection);
        },
        cancel: async () => {
          if (settled) return;
          settled = true;
          const inspection = this.cancelledSetup(context);
          onEvent({ type: "cancelled" });
          settle(inspection);
        },
      };
    },
  };

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
      structuredResult: true,
      continuation: true,
      retainedSessionRecovery: true,
      structuredAttention: true,
      nativeBlocking: true,
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

  private inspectSetup(context: HarnessSetupContext): HarnessSetupInspection {
    const authenticated = this.setupReady.has(context.physicalLineageId);
    return {
      state: authenticated ? "ready" : "preparing",
      authenticated,
      detail: authenticated
        ? "Deterministic fake setup is ready."
        : "Deterministic fake setup is not ready.",
      environment: {
        environmentId: `fake-environment-${context.physicalLineageId}`,
        incarnation: `fake-incarnation-${context.setupGeneration}`,
        profile: context.profile,
      },
      configIdentity: `fake-config-${context.physicalLineageId}`,
    };
  }

  private cancelledSetup(context: HarnessSetupContext): HarnessSetupInspection {
    return {
      ...this.inspectSetup(context),
      state: "cancelled",
      authenticated: false,
    };
  }

  async discover(): Promise<HarnessDiscovery> {
    return {
      kind: this.kind,
      displayName: this.displayName,
      strategy: this.integrationStrategy,
      integration: {
        status: "ready",
        detail: "Deterministic test harness is enabled.",
        installed: true,
        authenticated: true,
      },
      models: [
        {
          provider: "fake",
          model: "test",
          displayName: "Deterministic Test Model",
          accountAvailability: "verified_available",
          reasoningCapability: {
            kind: "enumerated",
            values: ["low", "medium", "high"],
          },
        },
      ],
      capabilities: this.capabilities,
    };
  }

  async start(
    _dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    return headlessPreparedExecution(lineage);
  }

  async continue(
    _dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    return headlessPreparedExecution(lineage);
  }

  async sendInputAndCollect(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    assertHeadlessHandle(execution.handle, execution.lineage);
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
        inspection: runningInspection(execution.lineage),
      });
      onEvent({ type: "inspection", inspection: existing });
      await new Promise<void>((resolve) =>
        this.waiters.set(lineageId, resolve),
      );
    } else {
      onEvent({ type: "running", inspection: this.running(execution.lineage) });
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
    lineage: HarnessLineage,
    category: HumanAttentionCategory = "needs_input",
    message = "Test harness needs input.",
  ): HarnessInspection {
    const inspection: HarnessInspection = {
      ...baseInspection(lineage, "waiting_for_human", "blocked"),
      attention: {
        attentionId: crypto.randomUUID(),
        category,
        message,
        requestedAt: new Date().toISOString(),
      },
    };
    this.publish(lineage, inspection);
    return inspection;
  }

  requestConversationalIntervention(
    lineage: HarnessLineage,
    message = "Test harness needs a conversation.",
  ): HarnessInspection {
    const requestedAt = new Date().toISOString();
    const attentionId = crypto.randomUUID();
    const inspection: HarnessInspection = {
      ...baseInspection(lineage, "waiting_for_human", "blocked", requestedAt),
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
    };
    this.publish(lineage, inspection);
    return inspection;
  }

  provideInput(lineage: HarnessLineage): HarnessInspection {
    const inspection = this.running(lineage);
    this.listeners.get(lineage.lineageId)?.({ type: "inspection", inspection });
    this.release(lineage.lineageId);
    return inspection;
  }

  resumeAutomation(lineage: HarnessLineage): HarnessInspection {
    const previous = this.inspections.get(lineage.lineageId)?.intervention;
    const inspection = this.running(lineage);
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
    this.listeners.get(lineage.lineageId)?.({ type: "inspection", inspection });
    this.release(lineage.lineageId);
    return inspection;
  }

  emitOutput(lineage: HarnessLineage): void {
    this.listeners.get(lineage.lineageId)?.({
      type: "output",
      inspection: this.running(lineage),
    });
  }

  failNext(message = "Fake harness failed."): void {
    this.nextFailure = new OperationalExecutionError(
      message,
      "operator_recovery_required",
      "fake_execution_failed",
      undefined,
      { sideEffectCertainty: "ambiguous", phase: "execute" },
    );
  }

  failNextTransient(message = "Transient fake harness failure."): void {
    this.nextFailure = new OperationalExecutionError(
      message,
      "auto_retryable",
      "fake_execution_transient",
      undefined,
      { sideEffectCertainty: "not_submitted", phase: "execute" },
    );
  }

  async interrupt(lineage: HarnessLineage): Promise<void> {
    this.inspections.set(
      lineage.lineageId,
      baseInspection(lineage, "retained", "idle"),
    );
    this.release(lineage.lineageId);
  }

  async inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    return (
      this.inspections.get(lineage.lineageId) ??
      baseInspection(lineage, "recovering", "unknown")
    );
  }

  async close(lineage: HarnessLineage): Promise<void> {
    this.inspections.set(
      lineage.lineageId,
      baseInspection(lineage, "closed", "completed"),
    );
  }

  async recover(lineage: HarnessLineage): Promise<HarnessRecoveredExecution> {
    this.recoveryCount += 1;
    const inspection = await this.inspect(lineage);
    return inspection.state === "closed"
      ? { found: false, detail: "Fake harness session is closed." }
      : {
          found: true,
          handle: headlessHandle(lineage),
          inspection,
          detail: "Fake harness execution recovered.",
        };
  }

  async waitAndCollect(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    handle: HarnessExecutionHandle,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    assertHeadlessHandle(handle, lineage);
    onEvent({ type: "inspection", inspection: this.running(lineage) });
    return outputsFor(dispatch, this.outputs);
  }

  async clearActiveMetadata(): Promise<void> {}
  async discoverAdoptionCandidates() {
    return [];
  }
  disconnect(): void {}

  private running(lineage: HarnessLineage): HarnessInspection {
    const inspection = runningInspection(lineage);
    this.inspections.set(lineage.lineageId, inspection);
    return inspection;
  }

  private publish(
    lineage: HarnessLineage,
    inspection: HarnessInspection,
  ): void {
    this.inspections.set(lineage.lineageId, inspection);
    this.listeners.get(lineage.lineageId)?.({ type: "inspection", inspection });
  }

  private release(lineageId: string): void {
    this.waiters.get(lineageId)?.();
    this.waiters.delete(lineageId);
  }
}

function headlessPreparedExecution(
  lineage: HarnessLineage,
): HarnessPreparedExecution {
  const handle = headlessHandle(lineage);
  return { lineage: { ...lineage, executionHandle: handle }, handle };
}

function headlessHandle(lineage: HarnessLineage): HarnessExecutionHandle {
  return {
    schemaVersion: 1,
    harnessKind: "fake",
    executionId: lineage.lineageId,
    ...(lineage.nativeSession ? { nativeSession: lineage.nativeSession } : {}),
  };
}

function assertHeadlessHandle(
  handle: HarnessExecutionHandle,
  lineage: HarnessLineage,
): void {
  if (
    handle.harnessKind !== "fake" ||
    handle.executionId !== lineage.lineageId ||
    handle.transportBinding
  )
    throw new Error("Fake headless execution handle is invalid.");
}

function runningInspection(lineage: HarnessLineage): HarnessInspection {
  return baseInspection(lineage, "running", "active");
}

function baseInspection(
  lineage: HarnessLineage,
  state: HarnessInspection["state"],
  activity: HarnessInspection["activity"]["state"],
  lastActivityAt = new Date().toISOString(),
): HarnessInspection {
  return {
    state,
    activity: { state: activity },
    nativeSession: lineage.nativeSession,
    health: state === "unavailable" ? "unavailable" : "healthy",
    attention: null,
    intervention: lineage.intervention,
    lastActivityAt,
    interactive: null,
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
