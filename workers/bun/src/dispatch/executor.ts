import type { HarnessControlAuthority } from "../harnesses/control/authority.ts";
import { HarnessRegistry } from "../harnesses/registry.ts";
import type {
  AgentHarness,
  HarnessEvent,
  HarnessPreparedExecution,
  HarnessRecoveredExecution,
} from "../harnesses/types.ts";
import { OperationalExecutionError } from "../harnesses/types.ts";
import type {
  ExecuteAction,
  JsonValue,
  ReconcileDispatch,
} from "../protocol/types.ts";
import type {
  HostedAgent,
  TerminalAttachmentDescriptor,
} from "../session-host/types.ts";
import {
  type DispatchRecord,
  type DispatchRegistry,
  type HarnessLineage,
  isRecoverableObservationUncertainty,
} from "./registry.ts";

export type StateReporter = (
  dispatch: ReconcileDispatch,
  terminalMessage: "step_completed" | "step_failed" | "dispatch_state",
) => Promise<boolean>;
export type SessionReporter = (
  dispatch: DispatchRecord,
  lineage: HarnessLineage,
) => Promise<boolean>;
export type TerminalFailureObserver = (
  dispatch: DispatchRecord,
) => Promise<void>;

export class DispatchExecutor {
  private readonly active = new Map<string, Promise<void>>();
  private readonly promptGateMonitors = new Map<
    string,
    { cancelled: boolean; operation: Promise<void> }
  >();
  private readonly harnesses: HarnessRegistry;

  constructor(
    readonly registry: DispatchRegistry,
    harnesses: HarnessRegistry | AgentHarness,
    private readonly report: StateReporter,
    private readonly reportSession: SessionReporter = async () => false,
    private readonly control: HarnessControlAuthority | null = null,
    private readonly backendRetryDelayMs = 1_000,
    private readonly onTerminalFailure: TerminalFailureObserver = async () =>
      undefined,
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
    const operation = this.executeWithBackendRecovery(actionId).finally(() =>
      this.active.delete(actionId),
    );
    this.active.set(actionId, operation);
    return operation;
  }

  async recoverAll(): Promise<void> {
    for (const harness of this.harnesses.list()) {
      try {
        const known = this.registry
          .list()
          .flatMap((dispatch) =>
            dispatch.lineageId
              ? [
                  {
                    dispatch,
                    lineage: this.registry.getLineage(dispatch.lineageId),
                  },
                ]
              : [],
          )
          .filter((item) => item.lineage.harnessKind === harness.kind);
        for (const candidate of await harness.discoverAdoptionCandidates(known))
          this.registry.adopt(candidate);
      } catch (error) {
        if (!backendUnavailable(error)) throw error;
      }
    }
    for (const dispatch of this.registry.list()) {
      if (
        ["completed", "failed"].includes(dispatch.state) ||
        (dispatch.state === "uncertain" &&
          !isRecoverableObservationUncertainty(dispatch))
      ) {
        const lineage = dispatch.lineageId
          ? this.registry.getLineage(dispatch.lineageId)
          : null;
        if (lineage) {
          if (
            lineage.activeActionId &&
            lineage.activeActionId !== dispatch.action.action_id
          )
            continue;
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
      void this.start(dispatch.action.action_id);
    }
  }

  async authorizePrompt(actionId: string): Promise<void> {
    let current = this.registry.get(actionId);
    if (!requiresPromptAuthorization(current.action))
      throw new Error(
        `Dispatch ${actionId} does not require explicit prompt authorization.`,
      );
    if (current.state === "completed" || current.state === "failed") {
      await this.stopPromptGateMonitor(actionId);
      return;
    }
    await this.stopPromptGateMonitor(actionId);
    current = this.registry.get(actionId);
    if (
      current.lineageId &&
      (await this.failIfPreAuthorizationActivity(
        current,
        this.registry.getLineage(current.lineageId),
      ))
    )
      return;
    this.registry.authorizePrompt(actionId);
    if (current.lineageId) {
      const lineage = this.registry.getLineage(current.lineageId);
      this.registry.updateSession(
        lineage.lineageId,
        "starting",
        null,
        new Date().toISOString(),
        lineage.intervention,
      );
    }
    await this.start(actionId);
  }

  async retireForRecovery(
    actionId: string,
    failure: Record<string, JsonValue>,
  ): Promise<void> {
    const current = this.registry.get(actionId);
    if (current.state === "failed") {
      await this.reportFailure(current);
      return;
    }
    if (current.state === "completed" || !current.lineageId)
      throw new Error(`Dispatch ${actionId} cannot be retired for recovery.`);
    const lineage = this.registry.getLineage(current.lineageId);
    const harness = this.harnessForLineage(lineage);
    if (!harness.retire)
      throw new Error(
        `Harness ${harness.kind} has no noninteractive retirement path.`,
      );
    await harness.retire(lineage);
    const failed = this.registry.fail(actionId, failure, false);
    const unavailable = this.registry.updateSession(
      lineage.lineageId,
      "unavailable",
      null,
      new Date().toISOString(),
      lineage.intervention,
    );
    await this.reportSession(failed, unavailable);
    await this.reportFailure(failed);
  }

  async cancel(actionId: string): Promise<void> {
    const current = this.registry.get(actionId);
    if (["completed", "failed"].includes(current.state)) return;
    if (!current.lineageId)
      throw new Error(
        `Dispatch ${actionId} has no cancellable harness lineage.`,
      );
    const lineage = this.registry.getLineage(current.lineageId);
    const harness = this.harnessForLineage(lineage);
    await harness.interrupt?.(lineage);
    const failed = this.registry.fail(
      actionId,
      {
        reason: "execution_cancelled",
        code: "execution_cancelled",
        classification: "terminal_not_recoverable",
        message: "The QE Attempt was explicitly cancelled.",
      },
      false,
    );
    await harness.clearActiveMetadata(
      failed,
      this.registry.getLineage(lineage.lineageId),
    );
    await this.reportFailure(failed);
    await this.onTerminalFailure(failed);
  }

  physicalProcessTransition(actionId: string) {
    return this.registry.physicalProcessTransition(actionId);
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
    for (const monitor of this.promptGateMonitors.values())
      monitor.cancelled = true;
    this.promptGateMonitors.clear();
    this.harnesses.disconnect();
  }

  private async execute(actionId: string): Promise<void> {
    let dispatch = this.registry.get(actionId);
    const harness = this.harnessForDispatch(dispatch);
    if (dispatch.state === "completed") {
      await this.reportCompletion(dispatch);
      return;
    }
    if (
      dispatch.state === "failed" ||
      (dispatch.state === "uncertain" &&
        !isRecoverableObservationUncertainty(dispatch))
    ) {
      await this.reportFailure(dispatch);
      return;
    }

    try {
      let lineage: HarnessLineage;
      let execution: HarnessPreparedExecution | null = null;
      const adoptionSource = this.preparedProcessAdoptionSource(dispatch);
      if (
        dispatch.action.operational_recovery?.continuation_mode ===
          "retained" &&
        dispatch.lineageId
      ) {
        lineage = this.registry.getLineage(dispatch.lineageId);
        const transition = this.registry.physicalProcessTransition(actionId);
        if (adoptionSource && transition?.mode === "fresh_process_fallback") {
          this.registry.occupy(lineage.lineageId, actionId);
          lineage = this.registry.getLineage(lineage.lineageId);
          await this.control?.bind(dispatch, lineage);
          execution = await harness.start(dispatch, lineage);
        } else if (adoptionSource && !transition) {
          try {
            if (!harness.provePreparedProcessAdoption)
              throw new OperationalExecutionError(
                `Harness ${harness.kind} cannot prove prepared-process adoption.`,
                "operator_recovery_required",
                "prepared_process_adoption_rejected",
              );
            await harness.provePreparedProcessAdoption(
              adoptionSource,
              dispatch,
              lineage,
            );
            this.registry.adoptPreparedProcess(
              adoptionSource.action.action_id,
              actionId,
              lineage.lineageId,
            );
          } catch (error) {
            if (!preparedProcessAdoptionRejected(error)) throw error;
            if (!harness.retire)
              throw new Error(
                `Harness ${harness.kind} cannot retire a rejected prepared process.`,
              );
            await harness.retire(lineage);
            this.control?.invalidate(lineage.lineageId);
            lineage = this.registry.replacePreparedProcessWithFresh(
              adoptionSource.action.action_id,
              actionId,
              lineage.lineageId,
            );
            dispatch = this.registry.get(actionId);
            await this.control?.bind(dispatch, lineage);
            execution = await harness.start(dispatch, lineage);
          }
          if (!execution) {
            lineage = this.registry.getLineage(lineage.lineageId);
            dispatch = this.registry.get(actionId);
            await this.control?.bind(dispatch, lineage);
            execution = await this.continueExecution(dispatch, lineage);
          }
        } else {
          this.registry.occupy(lineage.lineageId, actionId);
          lineage = this.registry.getLineage(lineage.lineageId);
          await this.control?.bind(dispatch, lineage);
          execution = await this.continueExecution(dispatch, lineage);
        }
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

      if (!execution)
        throw new Error("Harness execution was not prepared before readiness.");
      if (harness.ready) await harness.ready(dispatch, execution);
      this.registry.recordHost(lineage.lineageId, {
        herdrSession: execution.ref.sessionName,
        ...(execution.ref.sessionIncarnation
          ? { herdrSessionIncarnation: execution.ref.sessionIncarnation }
          : {}),
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
      dispatch = this.registry.get(actionId);
      if (
        requiresPromptAuthorization(dispatch.action) &&
        !dispatch.promptAuthorizedAt
      ) {
        await this.stagePromptAuthorization(dispatch, lineage);
        return;
      }
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
      await this.reportCompletion(dispatch);
    } catch (error) {
      if (backendUnavailable(error)) throw error;
      await this.failAndReport(actionId, error, harness);
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
          await this.execute(dispatch.action.action_id);
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
          await this.execute(dispatch.action.action_id);
          return;
        }
        throw new Error(
          "Prompt may have been submitted but no agent reference was persisted.",
        );
      }
      const recovered = await this.recoverExecution(lineage, dispatch);
      if (!recovered.found || !recovered.agent)
        throw new Error(recovered.detail);
      if (recovered.ref) {
        this.registry.recordHost(lineage.lineageId, {
          herdrSession: recovered.ref.sessionName,
          ...(recovered.ref.sessionIncarnation
            ? { herdrSessionIncarnation: recovered.ref.sessionIncarnation }
            : {}),
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
      if (isRecoverableObservationUncertainty(dispatch))
        dispatch = this.registry.resumeObservationUncertainty(
          dispatch.action.action_id,
        );
      dispatch = this.registry.get(dispatch.action.action_id);
      if (!dispatch.promptIntentAt) {
        if (
          requiresPromptAuthorization(dispatch.action) &&
          !dispatch.promptAuthorizedAt
        ) {
          await this.stagePromptAuthorization(
            dispatch,
            this.registry.getLineage(lineage.lineageId),
          );
          return;
        }
        const execution = await this.continueExecution(dispatch, lineage);
        this.registry.occupy(lineage.lineageId, dispatch.action.action_id);
        if (harness.ready) {
          await harness.ready(dispatch, execution);
        }
        this.registry.markPromptIntent(dispatch.action.action_id);
        const outputs = await harness.sendInputAndCollect(
          this.registry.get(dispatch.action.action_id),
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
      if (dispatch.promptAcceptedAt || dispatch.nativeActivityAt) {
        await this.report(payload(dispatch, "running"), "dispatch_state");
        const currentLineage = this.registry.getLineage(lineage.lineageId);
        const inspection = await harness.inspect(currentLineage);
        const observedLineage = this.registry.updateSession(
          currentLineage.lineageId,
          inspection.state,
          inspection.state === "unavailable"
            ? currentLineage.attention
            : inspection.attention,
          inspection.lastActivityAt,
          inspection.intervention,
        );
        await this.reportSession(dispatch, observedLineage);
      }
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
      if (backendUnavailable(error)) throw error;
      await this.failAndReport(dispatch.action.action_id, error, harness);
    }
  }

  private async executeWithBackendRecovery(actionId: string): Promise<void> {
    let recovery = 0;
    while (true) {
      const dispatch = this.registry.get(actionId);
      try {
        if (
          ["completed", "failed"].includes(dispatch.state) ||
          (dispatch.state === "uncertain" &&
            !isRecoverableObservationUncertainty(dispatch))
        )
          await this.execute(actionId);
        else if (this.shouldRecover(dispatch)) await this.recoverOne(dispatch);
        else await this.execute(actionId);
        return;
      } catch (error) {
        if (!backendUnavailable(error)) throw error;
        if (observationBackendFailure(error))
          this.registry.recordObservationFailure(actionId, failureValue(error));
        await this.reportBackendSession(actionId, "unavailable");
        const maximumRecoveries = observationBackendFailure(error) ? 3 : 1;
        if (recovery < maximumRecoveries) {
          await Bun.sleep(
            this.backendRetryDelayMs * Math.max(1, 2 ** recovery),
          );
          recovery += 1;
          await this.reportBackendSession(actionId, "recovering");
          continue;
        }
        await this.failAndReport(
          actionId,
          error,
          this.harnessForDispatch(this.registry.get(actionId)),
        );
        return;
      }
    }
  }

  private shouldRecover(dispatch: DispatchRecord): boolean {
    if (dispatch.promptIntentAt) return true;
    if (
      this.preparedProcessAdoptionSource(dispatch) &&
      !this.registry.physicalProcessTransition(dispatch.action.action_id)
    )
      return false;
    if (!dispatch.lineageId) return false;
    const lineage = this.registry.getLineage(dispatch.lineageId);
    return Boolean(lineage.agentName && lineage.paneId);
  }

  private async reportBackendSession(
    actionId: string,
    state: "unavailable" | "recovering",
  ): Promise<void> {
    const dispatch = this.registry.get(actionId);
    if (!dispatch.lineageId) return;
    const lineage = this.registry.getLineage(dispatch.lineageId);
    const updated = this.registry.updateSession(
      lineage.lineageId,
      state,
      lineage.attention,
      new Date().toISOString(),
      lineage.intervention,
    );
    await this.reportSession(dispatch, updated);
  }

  private async failAndReport(
    actionId: string,
    error: unknown,
    harness: AgentHarness,
  ): Promise<void> {
    const current = this.registry.get(actionId);
    if (current.state === "completed" || current.state === "failed") return;
    if (
      current.state === "uncertain" &&
      isRecoverableObservationUncertainty(current)
    ) {
      await this.reportFailure(current);
      return;
    }
    const failed = this.registry.fail(
      actionId,
      failureValue(error),
      isUncertain(current, error),
    );
    if (failed.lineageId && failed.state !== "uncertain")
      await harness.clearActiveMetadata(
        failed,
        this.registry.getLineage(failed.lineageId),
      );
    if (failed.lineageId && backendFailure(error)) {
      const lineage = this.registry.getLineage(failed.lineageId);
      this.registry.updateSession(
        lineage.lineageId,
        "unavailable",
        lineage.attention,
        new Date().toISOString(),
        lineage.intervention,
      );
    }
    const terminal = this.registry.get(actionId);
    await this.reportFailure(terminal);
    if (terminal.state === "failed") await this.onTerminalFailure(terminal);
  }

  private preparedProcessAdoptionSource(
    dispatch: DispatchRecord,
  ): DispatchRecord | null {
    const recovery = dispatch.action.operational_recovery;
    if (
      recovery?.authorization_kind !== "human" ||
      recovery.continuation_mode !== "retained" ||
      !recovery.source_attempt_id
    )
      return null;
    const source = this.registry
      .listByOccurrence(dispatch.action.occurrence_id)
      .find(
        (candidate) =>
          candidate.action.attempt_id === recovery.source_attempt_id,
      );
    if (
      !source ||
      source.state !== "failed" ||
      source.lineageId !== recovery.retained_lineage_id ||
      source.promptIntentAt ||
      source.promptAcceptedAt ||
      source.nativeActivityAt ||
      source.stalledAt ||
      source.settledAt ||
      !prePromptControlFailure(source.failure)
    )
      return null;
    const lineage = source.lineageId
      ? this.registry.getLineage(source.lineageId)
      : null;
    return lineage && !lineage.nativeSession ? source : null;
  }

  private async stagePromptAuthorization(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void> {
    if (await this.failIfPreAuthorizationActivity(dispatch, lineage)) return;
    const requestedAt = new Date().toISOString();
    const staged = this.registry.updateSession(
      lineage.lineageId,
      "waiting_for_human",
      {
        attentionId: `qe-prompt-authorization-${dispatch.action.attempt_id}`,
        category: "needs_confirmation",
        message:
          "Execution environment ready. Native worker prepared. Explicit authorization is required to begin Builder inference.",
        requestedAt:
          lineage.attention?.attentionId ===
          `qe-prompt-authorization-${dispatch.action.attempt_id}`
            ? lineage.attention.requestedAt
            : requestedAt,
        interaction: {
          kind: "confirmation",
          controlState: "intervention_pending",
        },
      },
      requestedAt,
      lineage.intervention,
    );
    await this.reportSession(dispatch, staged);
    this.startPromptGateMonitor(dispatch.action.action_id);
  }

  private startPromptGateMonitor(actionId: string): void {
    if (this.promptGateMonitors.has(actionId)) return;
    const dispatch = this.registry.get(actionId);
    if (
      !dispatch.lineageId ||
      !this.harnessForLineage(this.registry.getLineage(dispatch.lineageId))
        .observePreAuthorizationActivity
    )
      return;
    const monitor = {
      cancelled: false,
      operation: Promise.resolve(),
    };
    monitor.operation = (async () => {
      while (!monitor.cancelled) {
        const dispatch = this.registry.get(actionId);
        if (
          dispatch.promptAuthorizedAt ||
          ["completed", "failed"].includes(dispatch.state) ||
          !dispatch.lineageId
        )
          return;
        try {
          if (
            await this.failIfPreAuthorizationActivity(
              dispatch,
              this.registry.getLineage(dispatch.lineageId),
            )
          )
            return;
        } catch {
          // Observation failures cannot authorize inference or invalidate the gate.
        }
        await Bun.sleep(100);
      }
    })().finally(() => {
      if (this.promptGateMonitors.get(actionId) === monitor)
        this.promptGateMonitors.delete(actionId);
    });
    this.promptGateMonitors.set(actionId, monitor);
  }

  private async stopPromptGateMonitor(actionId: string): Promise<void> {
    const monitor = this.promptGateMonitors.get(actionId);
    if (!monitor) return;
    monitor.cancelled = true;
    await monitor.operation;
  }

  private async failIfPreAuthorizationActivity(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<boolean> {
    const harness = this.harnessForLineage(lineage);
    if (!harness.observePreAuthorizationActivity) return false;
    const activity = await harness.observePreAuthorizationActivity(lineage);
    if (!activity) return false;

    if (activity.nativeSession)
      this.registry.recordNativeSession(
        lineage.lineageId,
        activity.nativeSession,
      );
    let retired = false;
    if (harness.retire) {
      await harness.retire(this.registry.getLineage(lineage.lineageId));
      retired = true;
    }
    const failure = failureValue(
      new OperationalExecutionError(
        "Native user input created model activity before QE authorized or submitted the Step prompt. The contaminated process was fenced; use a new append-only recovery Attempt.",
        "operator_recovery_required",
        "pre_authorization_native_activity",
        {
          observed_at: activity.observedAt,
          evidence: activity.evidence,
          ...(activity.nativeSession?.kind === "id"
            ? { native_conversation_id: activity.nativeSession.value }
            : {}),
          process_retired: retired,
        },
      ),
    );
    const failed = this.registry.fail(
      dispatch.action.action_id,
      failure,
      false,
    );
    await harness.clearActiveMetadata(
      failed,
      this.registry.getLineage(lineage.lineageId),
    );
    this.registry.updateSession(
      lineage.lineageId,
      retired ? "unavailable" : "retained",
      null,
      activity.observedAt,
      lineage.intervention,
    );
    await this.reportFailure(this.registry.get(dispatch.action.action_id));
    return true;
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
    dispatch: DispatchRecord,
  ): Promise<HarnessRecoveredExecution> {
    const harness = this.harnessForLineage(lineage);
    if (!harness.capabilities.retainedSessionRecovery || !harness.recover)
      throw new Error(
        `Harness ${harness.kind} does not support retained-session recovery.`,
      );
    return harness.recover(lineage, dispatch);
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
    if (event.type === "prompt_baseline") {
      this.registry.recordPromptEvidence(actionId, { ...event.evidence });
      return;
    }
    const inspection = event.inspection;
    if (event.type === "prompt_accepted")
      this.registry.markPromptAccepted(actionId, event.acceptedAt);
    else if (event.type === "native_activity")
      this.registry.markNativeActivity(actionId, event.observedAt);
    else if (event.type === "provider_turn_settled")
      this.registry.markProviderTurnSettled(actionId, event.observedAt);
    else if (event.type === "native_idle")
      this.registry.markNativeIdle(actionId, event.observedAt);
    else if (event.type === "structured_result_received")
      this.registry.markStructuredResultReceived(actionId, event.observedAt);
    else if (event.type === "stalled")
      this.registry.markStalled(actionId, event.observedAt);
    else if (event.type === "running") {
      // Synthetic harnesses collapse submission and native activity.
      const observedAt = inspection.lastActivityAt;
      this.registry.markPromptAccepted(actionId, observedAt);
      this.registry.markNativeActivity(actionId, observedAt);
    }
    const observedAgent = inspection.agent;
    const persisted = this.registry.getLineage(lineageId);
    if (
      observedAgent?.name &&
      persisted.herdrSession &&
      persisted.herdrSessionIncarnation
    )
      this.registry.recordHost(lineageId, {
        herdrSession: persisted.herdrSession,
        herdrSessionIncarnation: persisted.herdrSessionIncarnation,
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
    if (
      [
        "prompt_accepted",
        "native_activity",
        "provider_turn_settled",
        "native_idle",
        "structured_result_received",
        "running",
      ].includes(event.type)
    ) {
      void this.report(
        payload(this.registry.get(actionId), "running"),
        "dispatch_state",
      );
    }
    void this.reportSession(this.registry.get(actionId), lineage);
  }

  private async reportCompletion(dispatch: DispatchRecord): Promise<void> {
    if (dispatch.lineageId)
      await this.reportSession(
        dispatch,
        this.registry.getLineage(dispatch.lineageId),
      );
    const acknowledged = await this.report(
      payload(dispatch, "completed"),
      "step_completed",
    );
    if (acknowledged)
      this.registry.acknowledgeServerCompletion(dispatch.action.action_id);
    if (dispatch.lineageId) this.control?.invalidate(dispatch.lineageId);
  }
  private async reportFailure(dispatch: DispatchRecord): Promise<void> {
    if (dispatch.lineageId)
      await this.reportSession(
        dispatch,
        this.registry.getLineage(dispatch.lineageId),
      );
    if (dispatch.state === "uncertain")
      await this.report(payload(dispatch, "uncertain"), "dispatch_state");
    else await this.report(payload(dispatch, "failed"), "step_failed");
    if (dispatch.lineageId && dispatch.state === "failed")
      this.control?.invalidate(dispatch.lineageId);
  }
}

function requiresPromptAuthorization(action: ExecuteAction): boolean {
  if (action.execution.configuration.harness_kind === "fake") return false;
  return ["initial", "human"].includes(
    action.operational_recovery?.authorization_kind ?? "",
  );
}

function prePromptControlFailure(
  failure: Record<string, JsonValue> | null,
): boolean {
  return Boolean(
    failure &&
      (failure.code === "execution_control_readiness_failed" ||
        failure.reason === "execution_control_readiness_failed" ||
        failure.message ===
          "Antigravity did not launch the QE MCP child with the active bridge context."),
  );
}

function preparedProcessAdoptionRejected(error: unknown): boolean {
  return Boolean(
    typeof error === "object" &&
      error !== null &&
      "code" in error &&
      String((error as { code: unknown }).code) ===
        "prepared_process_adoption_rejected",
  );
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
  const capability =
    typeof error === "object" && error !== null && "capability" in error
      ? String((error as { capability: unknown }).capability ?? "")
      : "";
  return {
    reason:
      code === "harness_contract_violation"
        ? "harness_contract_violation"
        : code === "execution_control_readiness_failed"
          ? "execution_control_readiness_failed"
          : code === "pre_authorization_native_activity"
            ? "pre_authorization_native_activity"
            : "harness_execution_failed",
    ...(code ? { code } : {}),
    ...(capability ? { capability } : {}),
    ...(error instanceof OperationalExecutionError && error.evidence
      ? error.evidence
      : {}),
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
      "backend_unavailable",
      "controller_disconnected",
    ].includes(code ?? "")
  )
    return "auto_retryable" as const;
  if (
    [
      "provenance_mismatch",
      "ownership_mismatch",
      "environment_launch_mismatch",
      "environment_attestation_failed",
      "agent_explicit_launch_failed",
      "incompatible_continuation_configuration",
      "harness_contract_violation",
    ].includes(code ?? "")
  )
    return "terminal_not_recoverable" as const;
  return "operator_recovery_required" as const;
}
function isUncertain(dispatch: DispatchRecord, error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  return Boolean(
    code === "agent_launch_uncertain" ||
      code === "agent_prompt_uncertain" ||
      ((dispatch.promptAcceptedAt || dispatch.nativeActivityAt) &&
        [
          "backend_unavailable",
          "controller_disconnected",
          "stream_closed",
          "timeout",
          "wait_timeout",
        ].includes(code ?? "") &&
        dispatch.state !== "completed"),
  );
}
function backendFailure(error: unknown): boolean {
  return (
    observationBackendFailure(error) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      [
        "backend_unavailable",
        "backend_incompatible",
        "controller_disconnected",
      ].includes(String((error as { code: unknown }).code)))
  );
}
function backendUnavailable(error: unknown): boolean {
  return (
    observationBackendFailure(error) ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      ["backend_unavailable", "controller_disconnected"].includes(
        String((error as { code: unknown }).code),
      ))
  );
}
function observationBackendFailure(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    String((error as { code: unknown }).code) !== "timeout"
  )
    return false;
  const capability =
    "capability" in error
      ? String((error as { capability: unknown }).capability ?? "")
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    [
      "backend.health",
      "integration.discovery",
      "session.inventory",
      "agent.inspect",
      "agent.state_observation",
      "terminal.shell_readiness",
    ].includes(capability) ||
    message === "Herdr request timed out: session.snapshot"
  );
}
