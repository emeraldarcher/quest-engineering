import type { JsonValue, ReconcileDispatch } from "../protocol/types.ts";
import type {
  AgentProvider,
  ProviderPreparedExecution,
} from "../providers/types.ts";
import type { AttachDescriptor } from "../session-host/types.ts";
import type {
  DispatchRecord,
  DispatchRegistry,
  ProviderLineage,
} from "./registry.ts";

export type StateReporter = (
  dispatch: ReconcileDispatch,
  terminalMessage: "step_completed" | "step_failed" | "dispatch_state",
) => Promise<boolean>;

export class DispatchExecutor {
  private readonly active = new Map<string, Promise<void>>();

  constructor(
    readonly registry: DispatchRegistry,
    private readonly provider: AgentProvider,
    private readonly report: StateReporter,
  ) {}

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
    try {
      for (const candidate of await this.provider.discoverAdoptionCandidates()) {
        this.registry.adopt(candidate);
      }
    } catch (error) {
      if (!backendUnavailable(error)) throw error;
      return;
    }
    for (const dispatch of this.registry.list()) {
      if (dispatch.state === "completed") {
        const lineage = dispatch.lineageId
          ? this.registry.getLineage(dispatch.lineageId)
          : null;
        if (lineage) await this.provider.clearActiveMetadata(dispatch, lineage);
        continue;
      }
      if (dispatch.state === "failed" || dispatch.state === "uncertain")
        continue;
      await this.recoverOne(dispatch);
    }
  }

  attachInfo(actionId: string): AttachDescriptor {
    const dispatch = this.registry.get(actionId);
    if (!dispatch.lineageId)
      throw new Error(`Dispatch ${actionId} has no provider lineage.`);
    return this.provider.attachInfo(
      this.registry.getLineage(dispatch.lineageId),
    );
  }

  disconnect(): void {
    this.provider.disconnect();
  }

  private async execute(actionId: string): Promise<void> {
    let dispatch = this.registry.get(actionId);
    if (dispatch.state === "completed") {
      await this.reportCompletion(dispatch);
      return;
    }
    if (dispatch.state === "failed" || dispatch.state === "uncertain") {
      await this.reportFailure(dispatch);
      return;
    }

    try {
      let lineage: ProviderLineage;
      let execution: ProviderPreparedExecution;
      if (dispatch.action.context_requirement.selector === "fresh") {
        if (!dispatch.lineageId)
          throw new Error("Fresh dispatch has no provider lineage.");
        lineage = this.registry.getLineage(dispatch.lineageId);
        this.registry.occupy(lineage.lineageId, actionId);
        execution = await this.provider.prepareFresh(dispatch, lineage);
      } else if (
        dispatch.action.context_requirement.selector === "continue_from"
      ) {
        const occurrenceId = dispatch.action.context_lineage_occurrence_id;
        if (!occurrenceId)
          throw new Error(
            "Continued dispatch has no resolved lineage occurrence.",
          );
        lineage = this.registry.resolveContinuation(occurrenceId);
        dispatch = this.registry.assignLineage(actionId, lineage.lineageId);
        this.registry.occupy(lineage.lineageId, actionId);
        execution = await this.provider.prepareContinuation(dispatch, lineage);
      } else {
        throw new Error(
          `Unsupported context requirement: ${dispatch.action.context_requirement.selector}`,
        );
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
      lineage = this.registry.getLineage(lineage.lineageId);
      this.registry.markPromptIntent(actionId);
      dispatch = this.registry.get(actionId);
      const outputs = await this.provider.submitAndCollect(
        dispatch,
        { ...execution, lineage },
        () => {
          this.registry.markRunning(actionId);
          void this.report(
            this.registry
              .reconcilePayloads()
              .find((item) => item.action_id === actionId) as ReconcileDispatch,
            "dispatch_state",
          );
        },
      );
      dispatch = this.registry.complete(actionId, outputs);
      // The completion transaction above clears physical occupancy before any network send.
      await this.provider.clearActiveMetadata(
        dispatch,
        this.registry.getLineage(lineage.lineageId),
      );
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
        if (dispatch.lineageId)
          await this.provider.clearActiveMetadata(
            dispatch,
            this.registry.getLineage(dispatch.lineageId),
          );
        await this.reportFailure(dispatch);
      }
    }
  }

  private async recoverOne(initial: DispatchRecord): Promise<void> {
    let dispatch = initial;
    try {
      if (
        !dispatch.lineageId &&
        dispatch.action.context_requirement.selector === "continue_from"
      ) {
        const occurrenceId = dispatch.action.context_lineage_occurrence_id;
        if (!occurrenceId)
          throw new Error(
            "Continued dispatch has no resolved lineage occurrence.",
          );
        const source = this.registry.resolveContinuation(occurrenceId);
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
          "Accepted dispatch has prompt intent but no provider lineage.",
        );
      }
      const lineage = this.registry.getLineage(dispatch.lineageId);
      if (!lineage.agentName || !lineage.paneId) {
        if (!dispatch.promptIntentAt) {
          void this.start(dispatch.action.action_id);
          return;
        }
        throw new Error(
          "Prompt may have been submitted but no agent reference was persisted.",
        );
      }
      const recovered = await this.provider.recover(lineage);
      if (!recovered.found || !recovered.agent)
        throw new Error(recovered.detail);
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
        const outputs = await this.provider.waitAndCollect(
          dispatch,
          lineage,
          recovered.agent,
        );
        const completed = this.registry.complete(
          dispatch.action.action_id,
          outputs,
        );
        await this.provider.clearActiveMetadata(
          completed,
          this.registry.getLineage(lineage.lineageId),
        );
        await this.reportCompletion(completed);
      } catch (error) {
        if (!dispatch.promptIntentAt) {
          const execution = await this.provider.prepareContinuation(
            dispatch,
            lineage,
          );
          this.registry.occupy(lineage.lineageId, dispatch.action.action_id);
          this.registry.markPromptIntent(dispatch.action.action_id);
          const outputs = await this.provider.submitAndCollect(
            dispatch,
            execution,
            () => this.registry.markRunning(dispatch.action.action_id),
          );
          const completed = this.registry.complete(
            dispatch.action.action_id,
            outputs,
          );
          await this.provider.clearActiveMetadata(
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
      if (failed.lineageId)
        await this.provider.clearActiveMetadata(
          failed,
          this.registry.getLineage(failed.lineageId),
        );
      await this.reportFailure(failed);
    }
  }

  private async observeRecovered(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
    agent: NonNullable<Awaited<ReturnType<AgentProvider["recover"]>>["agent"]>,
  ): Promise<void> {
    try {
      const outputs = await this.provider.waitAndCollect(
        dispatch,
        lineage,
        agent,
      );
      const completed = this.registry.complete(
        dispatch.action.action_id,
        outputs,
      );
      await this.provider.clearActiveMetadata(
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
      await this.provider.clearActiveMetadata(
        failed,
        this.registry.getLineage(lineage.lineageId),
      );
      await this.reportFailure(failed);
    }
  }

  private async reportRunning(dispatch: DispatchRecord): Promise<void> {
    await this.report(payload(dispatch, "running"), "dispatch_state");
  }
  private async reportCompletion(dispatch: DispatchRecord): Promise<void> {
    const acknowledged = await this.report(
      payload(dispatch, "completed"),
      "step_completed",
    );
    if (acknowledged)
      this.registry.acknowledgeServerCompletion(dispatch.action.action_id);
  }
  private async reportFailure(dispatch: DispatchRecord): Promise<void> {
    await this.report(payload(dispatch, "failed"), "step_failed");
  }
}

function payload(
  dispatch: DispatchRecord,
  state: "running" | "completed" | "failed",
): ReconcileDispatch {
  return {
    action_id: dispatch.action.action_id,
    occurrence_id: dispatch.action.occurrence_id,
    attempt_id: dispatch.action.attempt_id,
    state,
    ...(state === "completed" && dispatch.outputs
      ? { outputs: dispatch.outputs }
      : {}),
    ...(state === "failed"
      ? { failure: dispatch.failure ?? { reason: "execution_failed" } }
      : {}),
  };
}
function failureValue(error: unknown): Record<string, JsonValue> {
  return {
    reason: "provider_execution_failed",
    message: error instanceof Error ? error.message : String(error),
  };
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
