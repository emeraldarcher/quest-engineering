import type { HarnessControlAuthority } from "../harnesses/control/authority.ts";
import { HarnessRegistry } from "../harnesses/registry.ts";
import type {
  AgentHarness,
  HarnessEvent,
  HarnessPreparedExecution,
  HarnessRecoveredExecution,
} from "../harnesses/types.ts";
import { OperationalExecutionError } from "../harnesses/types.ts";
import type { JsonValue, ReconcileDispatch } from "../protocol/types.ts";
import type {
  HostedAgent,
  TerminalAttachmentDescriptor,
} from "../session-host/types.ts";
import type {
  DispatchRecord,
  DispatchRegistry,
  HarnessLineage,
} from "./registry.ts";

export type StateReporter = (
  dispatch: ReconcileDispatch,
  terminalMessage: "step_completed" | "step_failed" | "dispatch_state",
) => Promise<boolean>;
export type SessionReporter = (
  dispatch: DispatchRecord,
  lineage: HarnessLineage,
) => Promise<boolean>;

export class DispatchExecutor {
  private readonly active = new Map<string, Promise<void>>();
  private readonly harnesses: HarnessRegistry;

  constructor(
    readonly registry: DispatchRegistry,
    harnesses: HarnessRegistry | AgentHarness,
    private readonly report: StateReporter,
    private readonly reportSession: SessionReporter = async () => false,
    private readonly control: HarnessControlAuthority | null = null,
  ) {
    this.harnesses =
      harnesses instanceof HarnessRegistry
        ? harnesses
        : new HarnessRegistry([harnesses]);
  }

  accept(action: Parameters<DispatchRegistry["accept"]>[0]) {
    return this.registry.accept(action);
  }

  start(actionId: string): Promise<void> {
    const existing = this.active.get(actionId);
    if (existing) return existing;
    const operation = this.execute(actionId).finally(() =>
      this.active.delete(actionId),
    );
    this.active.set(actionId, operation);
    return operation;
  }

  async recoverAll(): Promise<void> {
    for (const harness of this.harnesses.list()) {
      try {
        for (const candidate of await harness.discoverAdoptionCandidates())
          this.registry.adopt(candidate);
      } catch (error) {
        if (!backendUnavailable(error)) throw error;
      }
    }
    for (const dispatch of this.registry.list()) {
      if (["completed", "failed"].includes(dispatch.state)) {
        const lineage = dispatch.lineageId
          ? this.registry.getLineage(dispatch.lineageId)
          : null;
        if (lineage) {
          const harness = this.harnessForLineage(lineage);
          await harness.clearActiveMetadata(dispatch, lineage);
          const inspection = await harness.inspect(lineage);
          const current = this.registry.updateSession(
            lineage.lineageId,
            inspection.state === "unavailable" ? "unavailable" : "retained",
            null,
            inspection.lastActivityAt,
            inspection.intervention,
          );
          await this.reportSession(dispatch, current);
        }
        continue;
      }
      await this.recoverOne(dispatch);
    }
  }

  attachment(actionId: string): TerminalAttachmentDescriptor {
    const dispatch = this.registry.get(actionId);
    if (!dispatch.lineageId)
      throw new Error(`Dispatch ${actionId} has no harness session.`);
    const lineage = this.registry.getLineage(dispatch.lineageId);
    const harness = this.harnessForLineage(lineage);
    if (!harness.attachment)
      throw new Error(
        `Harness ${harness.kind} does not support terminal attachment.`,
      );
    return harness.attachment(lineage);
  }

  disconnect(): void {
    this.harnesses.disconnect();
  }

  private async execute(actionId: string): Promise<void> {
    let dispatch = this.registry.get(actionId);
    const harness = this.harnessForDispatch(dispatch);
    if (dispatch.state === "completed") {
      await this.reportCompletion(dispatch);
      return;
    }
    if (dispatch.state === "failed" || dispatch.state === "uncertain") {
      await this.reportFailure(dispatch);
      return;
    }

    try {
      let lineage: HarnessLineage;
      let execution: HarnessPreparedExecution;
      if (
        dispatch.action.operational_recovery?.continuation_mode ===
          "retained" &&
        dispatch.lineageId
      ) {
        lineage = this.registry.getLineage(dispatch.lineageId);
        this.registry.occupy(lineage.lineageId, actionId);
        lineage = this.registry.getLineage(lineage.lineageId);
        await this.control?.bind(dispatch, lineage);
        execution = await this.continueExecution(dispatch, lineage);
      } else if (dispatch.action.execution.context.mode === "fresh") {
        if (!dispatch.lineageId)
          throw new Error("Fresh dispatch has no harness lineage.");
        lineage = this.registry.getLineage(dispatch.lineageId);
        this.registry.occupy(lineage.lineageId, actionId);
        lineage = this.registry.getLineage(lineage.lineageId);
        await this.control?.bind(dispatch, lineage);
        execution = await harness.start(dispatch, lineage);
      } else if (dispatch.action.execution.context.mode === "continue_from") {
        const occurrenceId = dispatch.action.context_lineage_occurrence_id;
        if (!occurrenceId)
          throw new Error(
            "Continued dispatch has no resolved lineage occurrence.",
          );
        lineage = this.registry.resolveContinuation(dispatch.action);
        dispatch = this.registry.assignLineage(actionId, lineage.lineageId);
        this.registry.occupy(lineage.lineageId, actionId);
        lineage = this.registry.getLineage(lineage.lineageId);
        await this.control?.bind(dispatch, lineage);
        execution = await this.continueExecution(dispatch, lineage);
      } else {
        throw new Error(
          `Unsupported context requirement: ${dispatch.action.execution.context.mode}`,
        );
      }

      if (harness.ready) {
        await harness.ready(dispatch, execution);
        await this.control?.bind(dispatch, lineage);
      }
      this.registry.recordHost(lineage.lineageId, {
        herdrSession: execution.ref.sessionName,
        workspaceId: execution.ref.workspaceId,
        ...(execution.ref.tabId ? { tabId: execution.ref.tabId } : {}),
        paneId: execution.ref.paneId,
        ...(execution.ref.terminalId
          ? { terminalId: execution.ref.terminalId }
          : {}),
        agentName: execution.ref.agentName,
        ...(execution.ref.nativeSession
          ? { nativeSession: execution.ref.nativeSession }
          : {}),
      });
      lineage = this.registry.updateSession(
        lineage.lineageId,
        "starting",
        null,
      );
      await this.reportSession(dispatch, lineage);
      this.registry.markPromptIntent(actionId);
      dispatch = this.registry.get(actionId);
      const outputs = await harness.sendInputAndCollect(
        dispatch,
        { ...execution, lineage },
        (event) => this.handleHarnessEvent(actionId, lineage.lineageId, event),
      );
      dispatch = this.registry.complete(actionId, outputs);
      // The completion transaction above clears physical occupancy before any network send.
      await harness.clearActiveMetadata(
        dispatch,
        this.registry.getLineage(lineage.lineageId),
      );
      this.control?.invalidate(lineage.lineageId);
      await this.reportCompletion(dispatch);
    } catch (error) {
      if (backendUnavailable(error)) return;
      const failure = failureValue(error);
      const current = this.registry.get(actionId);
      if (current.state !== "completed") {
        dispatch = this.registry.fail(
          actionId,
          failure,
          isUncertain(current, error),
        );
        if (dispatch.lineageId && dispatch.state !== "uncertain")
          await harness.clearActiveMetadata(
            dispatch,
            this.registry.getLineage(dispatch.lineageId),
          );
        await this.reportFailure(dispatch);
      }
    }
  }

  private async recoverOne(initial: DispatchRecord): Promise<void> {
    let dispatch = initial;
    const harness = this.harnessForDispatch(dispatch);
    try {
      if (
        !dispatch.lineageId &&
        dispatch.action.execution.context.mode === "continue_from"
      ) {
        const occurrenceId = dispatch.action.context_lineage_occurrence_id;
        if (!occurrenceId)
          throw new Error(
            "Continued dispatch has no resolved lineage occurrence.",
          );
        const source = this.registry.resolveContinuation(dispatch.action);
        dispatch = this.registry.assignLineage(
          dispatch.action.action_id,
          source.lineageId,
        );
      }
      if (!dispatch.lineageId) {
        if (!dispatch.promptIntentAt) {
          void this.start(dispatch.action.action_id);
          return;
        }
        throw new Error(
          "Accepted dispatch has prompt intent but no harness lineage.",
        );
      }
      const lineage = this.registry.getLineage(dispatch.lineageId);
      if (lineage.activeActionId === dispatch.action.action_id)
        await this.control?.bind(dispatch, lineage);
      if (!lineage.agentName || !lineage.paneId) {
        if (!dispatch.promptIntentAt) {
          void this.start(dispatch.action.action_id);
          return;
        }
        throw new Error(
          "Prompt may have been submitted but no agent reference was persisted.",
        );
      }
      const recovered = await this.recoverExecution(lineage);
      if (!recovered.found || !recovered.agent)
        throw new Error(recovered.detail);
      if (recovered.ref) {
        this.registry.recordHost(lineage.lineageId, {
          herdrSession: recovered.ref.sessionName,
          workspaceId: recovered.ref.workspaceId,
          ...(recovered.ref.tabId ? { tabId: recovered.ref.tabId } : {}),
          paneId: recovered.ref.paneId,
          ...(recovered.ref.terminalId
            ? { terminalId: recovered.ref.terminalId }
            : {}),
          agentName: recovered.ref.agentName,
          ...(recovered.ref.nativeSession
            ? { nativeSession: recovered.ref.nativeSession }
            : {}),
        });
        if (harness.ready) {
          await harness.ready(dispatch, {
            lineage,
            ref: recovered.ref,
            agent: recovered.agent,
          });
          await this.control?.bind(dispatch, lineage);
        }
      }
      if (["working", "blocked", "unknown"].includes(recovered.agent.status)) {
        this.registry.markRunning(dispatch.action.action_id);
        await this.reportRunning(this.registry.get(dispatch.action.action_id));
        const operation = this.observeRecovered(
          this.registry.get(dispatch.action.action_id),
          lineage,
          recovered.agent,
        );
        this.active.set(
          dispatch.action.action_id,
          operation.finally(() =>
            this.active.delete(dispatch.action.action_id),
          ),
        );
        return;
      }
      try {
        const outputs = await this.waitAndCollect(
          dispatch,
          lineage,
          recovered.agent,
          (event) =>
            this.handleHarnessEvent(
              dispatch.action.action_id,
              lineage.lineageId,
              event,
            ),
        );
        const completed = this.registry.complete(
          dispatch.action.action_id,
          outputs,
        );
        await harness.clearActiveMetadata(
          completed,
          this.registry.getLineage(lineage.lineageId),
        );
        await this.reportCompletion(completed);
      } catch (error) {
        if (!dispatch.promptIntentAt) {
          const execution = await this.continueExecution(dispatch, lineage);
          this.registry.occupy(lineage.lineageId, dispatch.action.action_id);
          this.registry.markPromptIntent(dispatch.action.action_id);
          if (harness.ready) {
            await harness.ready(dispatch, execution);
            await this.control?.bind(dispatch, lineage);
          }
          const outputs = await harness.sendInputAndCollect(
            dispatch,
            execution,
            (event) =>
              this.handleHarnessEvent(
                dispatch.action.action_id,
                lineage.lineageId,
                event,
              ),
          );
          const completed = this.registry.complete(
            dispatch.action.action_id,
            outputs,
          );
          await harness.clearActiveMetadata(
            completed,
            this.registry.getLineage(lineage.lineageId),
          );
          await this.reportCompletion(completed);
          return;
        }
        throw error;
      }
    } catch (error) {
      if (backendUnavailable(error)) return;
      const failed = this.registry.fail(
        dispatch.action.action_id,
        failureValue(error),
        true,
      );
      if (failed.lineageId && failed.state !== "uncertain")
        await harness.clearActiveMetadata(
          failed,
          this.registry.getLineage(failed.lineageId),
        );
      await this.reportFailure(failed);
    }
  }

  private async observeRecovered(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    agent: HostedAgent,
  ): Promise<void> {
    const harness = this.harnessForLineage(lineage);
    try {
      const outputs = await this.waitAndCollect(
        dispatch,
        lineage,
        agent,
        (event) =>
          this.handleHarnessEvent(
            dispatch.action.action_id,
            lineage.lineageId,
            event,
          ),
      );
      const completed = this.registry.complete(
        dispatch.action.action_id,
        outputs,
      );
      await harness.clearActiveMetadata(
        completed,
        this.registry.getLineage(lineage.lineageId),
      );
      await this.reportCompletion(completed);
    } catch (error) {
      const failed = this.registry.fail(
        dispatch.action.action_id,
        failureValue(error),
        true,
      );
      if (failed.state !== "uncertain")
        await harness.clearActiveMetadata(
          failed,
          this.registry.getLineage(lineage.lineageId),
        );
      await this.reportFailure(failed);
    }
  }

  private continueExecution(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    const harness = this.harnessForLineage(lineage);
    if (!harness.capabilities.continuation || !harness.continue)
      throw new Error(`Harness ${harness.kind} does not support continuation.`);
    return harness.continue(dispatch, lineage);
  }

  private recoverExecution(
    lineage: HarnessLineage,
  ): Promise<HarnessRecoveredExecution> {
    const harness = this.harnessForLineage(lineage);
    if (!harness.capabilities.retainedSessionRecovery || !harness.recover)
      throw new Error(
        `Harness ${harness.kind} does not support retained-session recovery.`,
      );
    return harness.recover(lineage);
  }

  private waitAndCollect(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    agent: HostedAgent,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    const harness = this.harnessForLineage(lineage);
    if (!harness.waitAndCollect)
      throw new Error(
        `Harness ${harness.kind} cannot collect a recovered result.`,
      );
    return harness.waitAndCollect(dispatch, lineage, agent, onEvent);
  }

  private harnessForDispatch(dispatch: DispatchRecord): AgentHarness {
    return this.harnesses.get(
      dispatch.action.execution.configuration.harness_kind,
    );
  }

  private harnessForLineage(lineage: HarnessLineage): AgentHarness {
    return this.harnesses.get(lineage.harnessKind);
  }

  private handleHarnessEvent(
    actionId: string,
    lineageId: string,
    event: HarnessEvent,
  ): void {
    const inspection = event.inspection;
    const observedAgent = inspection.agent;
    const persisted = this.registry.getLineage(lineageId);
    if (observedAgent?.name && persisted.herdrSession)
      this.registry.recordHost(lineageId, {
        herdrSession: persisted.herdrSession,
        workspaceId: observedAgent.workspaceId,
        ...(observedAgent.tabId ? { tabId: observedAgent.tabId } : {}),
        paneId: observedAgent.paneId,
        ...(observedAgent.terminalId
          ? { terminalId: observedAgent.terminalId }
          : {}),
        agentName: observedAgent.name,
        ...(observedAgent.nativeSession
          ? { nativeSession: observedAgent.nativeSession }
          : {}),
      });
    if (observedAgent?.nativeSession)
      this.registry.recordNativeSession(lineageId, observedAgent.nativeSession);
    const lineage = this.registry.updateSession(
      lineageId,
      inspection.state,
      inspection.attention,
      inspection.lastActivityAt,
      inspection.intervention,
    );
    if (event.type === "running") {
      this.registry.markRunning(actionId);
      void this.report(
        payload(this.registry.get(actionId), "running"),
        "dispatch_state",
      );
    }
    void this.reportSession(this.registry.get(actionId), lineage);
  }

  private async reportRunning(dispatch: DispatchRecord): Promise<void> {
    await this.report(payload(dispatch, "running"), "dispatch_state");
  }
  private async reportCompletion(dispatch: DispatchRecord): Promise<void> {
    if (dispatch.lineageId) {
      await this.reportSession(
        dispatch,
        this.registry.getLineage(dispatch.lineageId),
      );
      this.control?.invalidate(dispatch.lineageId);
    }
    const acknowledged = await this.report(
      payload(dispatch, "completed"),
      "step_completed",
    );
    if (acknowledged)
      this.registry.acknowledgeServerCompletion(dispatch.action.action_id);
  }
  private async reportFailure(dispatch: DispatchRecord): Promise<void> {
    if (dispatch.lineageId) {
      await this.reportSession(
        dispatch,
        this.registry.getLineage(dispatch.lineageId),
      );
      if (dispatch.state === "failed")
        this.control?.invalidate(dispatch.lineageId);
    }
    if (dispatch.state === "uncertain")
      await this.report(payload(dispatch, "uncertain"), "dispatch_state");
    else await this.report(payload(dispatch, "failed"), "step_failed");
  }
}

function payload(
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
      ? { failure: dispatch.failure ?? { reason: "execution_failed" } }
      : {}),
  };
}
function failureValue(error: unknown): Record<string, JsonValue> {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  return {
    reason:
      code === "harness_contract_violation"
        ? "harness_contract_violation"
        : "harness_execution_failed",
    classification: operationalFailureClassification(error),
    message: error instanceof Error ? error.message : String(error),
  };
}
function operationalFailureClassification(error: unknown) {
  if (error instanceof OperationalExecutionError) return error.classification;
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  if (
    [
      "timeout",
      "shell_not_ready",
      "agent_not_ready",
      "agent_pane_busy",
    ].includes(code ?? "")
  )
    return "auto_retryable" as const;
  if (
    [
      "provenance_mismatch",
      "ownership_mismatch",
      "incompatible_continuation_configuration",
      "harness_contract_violation",
    ].includes(code ?? "")
  )
    return "terminal_not_recoverable" as const;
  return "operator_recovery_required" as const;
}
function isUncertain(dispatch: DispatchRecord, _error: unknown): boolean {
  return Boolean(dispatch.promptIntentAt && dispatch.state !== "completed");
}
function backendUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ["backend_unavailable", "controller_disconnected"].includes(
      String((error as { code: unknown }).code),
    )
  );
}
