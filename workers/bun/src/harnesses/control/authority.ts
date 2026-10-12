import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DispatchRecord,
  DispatchRegistry,
  HarnessLineage,
} from "../../dispatch/registry.ts";
import type { JsonValue } from "../../protocol/types.ts";
import { nativeSessionPublicId } from "../native-session.ts";
import type {
  HumanAttention,
  HumanAttentionWaitRecoverability,
  HumanInterventionLifecycle,
} from "../types.ts";
import { writeControlDescriptor } from "./descriptor.ts";
import {
  prepareStepResultAtomic,
  readStructuredCompletionState,
  STEP_RESULT_PROTOCOL_VERSION,
  type StepResultEnvelope,
  validateOutputs,
  writeStructuredCompletionState,
} from "./result-envelope.ts";
import {
  type CompletionFailure,
  HARNESS_CONTROL_PROTOCOL_VERSION,
  type HarnessControlDescriptor,
  HarnessControlError,
  type HarnessControlOperation,
  type HarnessControlResponse,
  type HarnessControlResult,
  type HumanAttentionDeliveryReceipt,
  type HumanAttentionResponse,
  type HumanAttentionWaitHandle,
  type StructuredCompletionState,
} from "./types.ts";

interface BoundControlContext {
  contextToken: string;
  dispatch: DispatchRecord;
  lineageId: string;
  requests: Map<string, HarnessControlResult>;
  enforcementAttempts: number;
  contractViolation: string | null;
  lastCompletionFailure: CompletionFailure | null;
  completion: StructuredCompletionState;
  completionOperation: Promise<void> | null;
  invalidated: boolean;
  operationTail: Promise<void>;
  attentionWaitRecoverability: HumanAttentionWaitRecoverability;
}

interface HumanAttentionWaiter {
  contextToken: string;
  waitHandle: HumanAttentionWaitHandle;
  resolve(result: HarnessControlResult): void;
  reject(error: Error): void;
  removeAbortListener(): void;
}

export interface HumanAttentionResponseDelivery {
  attentionId: string;
  requestGeneration: number;
  actionId: string;
  runId: string;
  occurrenceId: string;
  attemptId: string;
  lineageId: string;
  nativeSessionId: string | null;
  deliveryAttemptId: string;
  response: HumanAttentionResponse;
}

type HumanAttentionObserver = (
  dispatch: DispatchRecord,
  lineage: HarnessLineage,
) => void | Promise<void>;

type HumanAttentionDeliveryReporter = (
  receipt: HumanAttentionDeliveryReceipt,
  request: ReturnType<DispatchRegistry["getHumanAttentionRequest"]>,
) => void | Promise<void>;

export interface HarnessControlEndpoint {
  host: "127.0.0.1";
  port: number;
}

export interface StructuredCompletionBoundary {
  verifyAndPrepare(input: {
    dispatch: DispatchRecord;
    lineageId: string;
    outputs: Record<string, JsonValue>;
    assertCurrent: () => void;
  }): Promise<{
    outputs: Record<string, JsonValue>;
    commit: () => void;
  }>;
}

/**
 * Single semantic authority for every harness-native integration. Native shims
 * submit only operation payloads; this authority supplies and validates all QE
 * execution identity before changing durable control state.
 */
export class HarnessControlAuthority {
  readonly generation = crypto.randomUUID();
  private endpoint: HarnessControlEndpoint | null = null;
  private readonly contexts = new Map<string, BoundControlContext>();
  private readonly tokenByLineage = new Map<string, string>();
  private readonly attentionWaiters = new Map<string, HumanAttentionWaiter>();
  private attentionObserver: HumanAttentionObserver | null = null;
  private attentionDeliveryReporter: HumanAttentionDeliveryReporter | null =
    null;
  private static readonly MAX_ACTIVE_ATTENTION_WAITS = 64;

  constructor(
    private readonly registry: DispatchRegistry,
    private readonly maxStopEnforcements = 2,
    private readonly completionBoundary?: StructuredCompletionBoundary,
  ) {}

  setEndpoint(endpoint: HarnessControlEndpoint): void {
    this.endpoint = endpoint;
  }

  setHumanAttentionObserver(observer: HumanAttentionObserver): void {
    this.attentionObserver = observer;
  }

  setHumanAttentionDeliveryReporter(
    reporter: HumanAttentionDeliveryReporter,
  ): void {
    this.attentionDeliveryReporter = reporter;
  }

  async bind(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    attentionWaitRecoverability: HumanAttentionWaitRecoverability = "wait_not_recoverable",
  ): Promise<HarnessControlDescriptor> {
    if (!this.endpoint)
      throw new HarnessControlError(
        "bridge_unavailable",
        "Quest Engineering harness control bridge is not listening.",
      );
    if (dispatch.lineageId !== lineage.lineageId)
      throw new HarnessControlError(
        "stale_control_context",
        "Dispatch and harness lineage do not match.",
      );
    const previous = this.tokenByLineage.get(lineage.lineageId);
    if (previous) this.invalidate(lineage.lineageId);
    await this.reconcileHumanAttentionControllerGeneration(
      dispatch,
      lineage,
      Boolean(previous),
    );
    let completion = await readStructuredCompletionState(dispatch);
    if (await hasStepResult(dispatch))
      completion = {
        ...(completion ?? {}),
        phase: "completed",
        semanticAccepted: true,
        exportCompletedAt:
          completion?.exportCompletedAt ?? new Date().toISOString(),
      };
    else if (
      completion?.semanticAccepted &&
      ["exporting", "completed"].includes(completion.phase)
    ) {
      const failure: CompletionFailure = {
        kind: "infrastructure",
        code: "bridge_unavailable",
        message:
          "The Worker control generation ended before physical completion became authoritative.",
      };
      completion = { ...completion, phase: "failed", failure };
      await writeStructuredCompletionState(dispatch, completion);
    }
    const contextToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const context: BoundControlContext = {
      contextToken,
      dispatch,
      lineageId: lineage.lineageId,
      requests: new Map(),
      enforcementAttempts: 0,
      contractViolation: null,
      lastCompletionFailure: null,
      completion: completion ?? {
        phase: "awaiting_result",
        semanticAccepted: false,
      },
      completionOperation: null,
      invalidated: false,
      operationTail: Promise.resolve(),
      attentionWaitRecoverability,
    };
    this.contexts.set(contextToken, context);
    this.tokenByLineage.set(lineage.lineageId, contextToken);
    const descriptor: HarnessControlDescriptor = {
      protocolVersion: HARNESS_CONTROL_PROTOCOL_VERSION,
      endpoint: this.endpoint,
      bridgeGeneration: this.generation,
      contextToken,
    };
    await writeControlDescriptor(controlDescriptorPath(lineage), descriptor);
    return descriptor;
  }

  invalidate(lineageId: string): void {
    const token = this.tokenByLineage.get(lineageId);
    const context = token ? this.contexts.get(token) : undefined;
    if (context) context.invalidated = true;
    for (const [attentionId, waiter] of this.attentionWaiters) {
      if (waiter.contextToken !== token) continue;
      this.attentionWaiters.delete(attentionId);
      waiter.removeAbortListener();
      waiter.reject(
        new HarnessControlError(
          "human_attention_wait_unavailable",
          "The exact native HumanAttention wait lost its control context.",
        ),
      );
    }
    if (context) {
      const request = this.registry.activeHumanAttentionRequest(
        context.dispatch.action.action_id,
      );
      if (request?.deliveryState === "delivery_requested") {
        const uncertain = this.registry.markHumanAttentionDeliveryUncertain(
          request.attentionId,
          "The control context ended before native delivery acknowledgement.",
        );
        void this.reportDelivery(
          {
            attentionId: uncertain.attentionId,
            requestGeneration: uncertain.requestGeneration,
            deliveryAttemptId: uncertain.deliveryAttemptId,
            state: "delivery_uncertain",
            observedAt:
              uncertain.deliveryUncertainAt ?? new Date().toISOString(),
            reason:
              uncertain.cancellationReason ??
              "The control context ended before native delivery acknowledgement.",
          },
          uncertain,
        );
      }
    }
    if (token) this.contexts.delete(token);
    this.tokenByLineage.delete(lineageId);
  }

  async handle(input: {
    bridgeGeneration: string;
    contextToken: string;
    requestId: string;
    operation: HarnessControlOperation;
    signal?: AbortSignal;
  }): Promise<HarnessControlResult> {
    if (input.bridgeGeneration !== this.generation)
      throw new HarnessControlError(
        "bridge_generation_mismatch",
        "Harness control request belongs to another Worker controller generation.",
      );
    const context = this.contexts.get(input.contextToken);
    if (!context)
      throw new HarnessControlError(
        "unknown_control_context",
        "Harness control context is unknown or has been invalidated.",
      );
    if (input.operation.type === "wait_for_human_assistance_response") {
      this.assertCurrent(context);
      return await this.waitForHumanAttention(
        context,
        input.operation.waitHandle,
        input.signal,
      );
    }
    const previous = context.operationTail;
    let release: () => void = () => undefined;
    context.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.contexts.get(input.contextToken) !== context)
        throw new HarnessControlError(
          "stale_control_context",
          "Harness control context rotated while the request was pending.",
        );
      const replay = context.requests.get(input.requestId);
      if (replay) return { ...replay, duplicate: true };
      this.assertCurrent(context);
      const result = await this.apply(
        context,
        input.operation,
        input.requestId,
      );
      context.requests.set(input.requestId, result);
      return result;
    } finally {
      release();
    }
  }

  failure(error: unknown): HarnessControlResponse {
    const known =
      error instanceof HarnessControlError
        ? error
        : new HarnessControlError(
            "invalid_request",
            error instanceof Error ? error.message : String(error),
          );
    return {
      protocolVersion: HARNESS_CONTROL_PROTOCOL_VERSION,
      ok: false,
      error: { code: known.code, message: known.message },
    };
  }

  private assertCurrent(context: BoundControlContext): void {
    const dispatch = this.registry.get(context.dispatch.action.action_id);
    const lineage = this.registry.getLineage(context.lineageId);
    if (
      context.invalidated ||
      this.contexts.get(context.contextToken) !== context ||
      dispatch.resultNonce !== context.dispatch.resultNonce ||
      dispatch.lineageId !== context.lineageId ||
      !["accepted", "running"].includes(dispatch.state) ||
      lineage.activeActionId !== dispatch.action.action_id ||
      this.tokenByLineage.get(context.lineageId) !== context.contextToken
    )
      throw new HarnessControlError(
        "stale_control_context",
        "Harness control context is stale for the active Action or Attempt.",
      );
    context.dispatch = dispatch;
  }

  private async apply(
    context: BoundControlContext,
    operation: HarnessControlOperation,
    requestId: string,
  ): Promise<HarnessControlResult> {
    switch (operation.type) {
      case "complete_step":
        return this.complete(context, operation.outputs, requestId);
      case "report_completion_failure":
        context.lastCompletionFailure = operation.failure;
        return { accepted: true, completed: false };
      case "request_human_assistance":
        return this.requestAttention(context, operation, requestId);
      case "wait_for_human_assistance_response":
        throw new HarnessControlError(
          "invalid_request",
          "HumanAttention waits must use the subscription path.",
        );
      case "acknowledge_human_assistance_response":
        return this.acknowledgeAttentionResponse(
          context,
          operation.waitHandle,
          operation.deliveryAttemptId,
        );
      case "resolve_human_assistance":
        return this.resolveAttention(
          context,
          operation.attentionId,
          operation.outcome,
        );
      case "yield_to_human":
        return this.yieldToHuman(context, operation.attentionId);
      case "automation_resumed":
        return this.automationResumed(context, operation.attentionId);
      case "report_state":
        this.registry.updateSession(
          context.lineageId,
          operation.state,
          this.registry.getLineage(context.lineageId).attention,
        );
        return { accepted: true };
      case "completion_status": {
        const lineage = this.registry.getLineage(context.lineageId);
        const completed = await hasStepResult(context.dispatch);
        if (completed && context.completion.phase !== "completed")
          context.completion = {
            ...context.completion,
            phase: "completed",
            semanticAccepted: true,
            exportCompletedAt:
              context.completion.exportCompletedAt ?? new Date().toISOString(),
          };
        return {
          accepted: true,
          completed,
          semanticAccepted: context.completion.semanticAccepted,
          completion: completionState(context),
          binding: {
            actionId: context.dispatch.action.action_id,
            attemptId: context.dispatch.action.attempt_id,
            lineageId: context.lineageId,
            resultNonce: context.dispatch.resultNonce,
          },
          ...(lineage.attention ? { attention: lineage.attention } : {}),
          intervention: lineage.intervention,
          ...(context.contractViolation
            ? { contractViolation: context.contractViolation }
            : {}),
        };
      }
      case "native_stop":
        return this.nativeStop(context, operation);
    }
  }

  private async complete(
    context: BoundControlContext,
    outputs: Record<string, JsonValue>,
    requestId: string,
  ): Promise<HarnessControlResult> {
    try {
      validateOutputs(context.dispatch.action.declared_outputs, outputs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.lastCompletionFailure = {
        kind: "semantic_validation",
        code: "invalid_step_result",
        message,
      };
      throw new HarnessControlError("invalid_step_result", message);
    }
    if (
      context.completion.semanticAccepted ||
      context.completion.phase !== "awaiting_result" ||
      (await hasStepResult(context.dispatch))
    )
      throw new HarnessControlError(
        "replayed_request",
        "This Attempt already accepted a structured Step result.",
      );

    const acceptedAt = new Date().toISOString();
    context.lastCompletionFailure = null;
    context.completion = {
      phase: "exporting",
      semanticAccepted: true,
      acceptedAt,
      exportStartedAt: acceptedAt,
    };
    try {
      await writeStructuredCompletionState(
        context.dispatch,
        context.completion,
      );
    } catch (error) {
      const failure = completionExportFailure(error);
      context.lastCompletionFailure = failure;
      context.completion = {
        phase: "awaiting_result",
        semanticAccepted: false,
        failure,
      };
      throw new HarnessControlError(failure.code, failure.message);
    }
    try {
      this.assertCurrent(context);
    } catch (error) {
      const failure = completionExportFailure(error);
      context.lastCompletionFailure = failure;
      context.completion = { ...context.completion, phase: "failed", failure };
      await writeStructuredCompletionState(
        context.dispatch,
        context.completion,
      ).catch(() => undefined);
      throw error;
    }
    const operation = this.finishCompletion(
      context,
      structuredClone(outputs),
      requestId,
    ).finally(() => {
      if (context.completionOperation === operation)
        context.completionOperation = null;
    });
    context.completionOperation = operation;
    void operation;
    return {
      accepted: true,
      completed: false,
      semanticAccepted: true,
      completion: completionState(context),
    };
  }

  private async finishCompletion(
    context: BoundControlContext,
    outputs: Record<string, JsonValue>,
    requestId: string,
  ): Promise<void> {
    try {
      const preparedCompletion = this.completionBoundary
        ? await this.completionBoundary.verifyAndPrepare({
            dispatch: context.dispatch,
            lineageId: context.lineageId,
            outputs,
            assertCurrent: () => this.assertCurrent(context),
          })
        : { outputs, commit: () => undefined };
      this.assertCurrent(context);
      validateOutputs(
        context.dispatch.action.declared_outputs,
        preparedCompletion.outputs,
      );
      const action = context.dispatch.action;
      const completedAt = new Date().toISOString();
      const envelope: StepResultEnvelope = {
        protocolVersion: STEP_RESULT_PROTOCOL_VERSION,
        kind: "quest_engineering_step_result",
        workerId: action.worker_id,
        actionId: action.action_id,
        runId: action.run_id,
        occurrenceId: action.occurrence_id,
        attemptId: action.attempt_id,
        nonce: context.dispatch.resultNonce,
        createdAt: completedAt,
        outputs: preparedCompletion.outputs,
      };
      const preparedResult = await prepareStepResultAtomic(
        context.dispatch.resultDirectory,
        requestId,
        envelope,
      );
      this.assertCurrent(context);
      preparedCompletion.commit();
      this.assertCurrent(context);
      preparedResult.publish();
      context.completion = {
        ...context.completion,
        phase: "completed",
        exportCompletedAt: completedAt,
      };
      await writeStructuredCompletionState(
        context.dispatch,
        context.completion,
      );
    } catch (error) {
      const failure = completionExportFailure(error);
      context.lastCompletionFailure = failure;
      context.completion = {
        ...context.completion,
        phase: "failed",
        failure,
      };
      await writeStructuredCompletionState(
        context.dispatch,
        context.completion,
      ).catch(() => undefined);
    }
  }

  private async requestAttention(
    context: BoundControlContext,
    operation: Extract<
      HarnessControlOperation,
      { type: "request_human_assistance" }
    >,
    registrationRequestId: string,
  ): Promise<HarnessControlResult> {
    const message = operation.message.trim().slice(0, 240);
    if (!message)
      throw new HarnessControlError(
        "invalid_attention",
        "Human assistance message is required.",
      );
    const requestedAt = new Date().toISOString();
    const attentionId = crypto.randomUUID();
    const conversational =
      operation.interaction === "conversational_intervention";
    const interaction = operation.interaction;
    const attention: HumanAttention = {
      attentionId,
      requestGeneration: 1,
      category: operation.category,
      message,
      requestedAt,
      responseState: "pending",
      deliveryState: "response_not_delivered",
      ...(operation.origin
        ? { origin: structuredClone(operation.origin) }
        : {}),
      ...(interaction
        ? {
            interaction: {
              kind: interaction,
              controlState: "intervention_pending",
              ...(conversational ? { resumeCommand: "/qe-resume" } : {}),
            },
          }
        : {}),
      ...(operation.responseSchema !== undefined
        ? { responseSchema: structuredClone(operation.responseSchema) }
        : {}),
    };
    const intervention: HumanInterventionLifecycle | null = conversational
      ? {
          attentionId,
          kind: "conversational_intervention",
          state: "intervention_pending",
          requestedAt,
        }
      : null;
    const request = this.registry.registerHumanAttention({
      dispatch: context.dispatch,
      lineage: this.registry.getLineage(context.lineageId),
      registrationRequestId,
      attention,
      intervention,
      request: {
        category: operation.category,
        message,
        ...(operation.interaction
          ? { interaction: operation.interaction }
          : {}),
        ...(operation.responseSchema !== undefined
          ? { responseSchema: structuredClone(operation.responseSchema) }
          : {}),
        ...(operation.origin
          ? { origin: structuredClone(operation.origin) }
          : {}),
      },
      recoverability: context.attentionWaitRecoverability,
      controllerGeneration: this.generation,
    });
    const current = this.registry.getLineage(context.lineageId);
    const persistedAttention = current.attention;
    if (
      !persistedAttention ||
      persistedAttention.attentionId !== request.attentionId
    )
      throw new HarnessControlError(
        "human_attention_request_rejected",
        "The durable HumanAttention request is no longer active.",
      );
    await this.reportAttention(context.dispatch, current);
    return {
      accepted: true,
      attention: persistedAttention,
      attentionWaitHandle: {
        attentionId: request.attentionId,
        requestGeneration: request.requestGeneration,
      },
      intervention,
    };
  }

  private async waitForHumanAttention(
    context: BoundControlContext,
    waitHandle: HumanAttentionWaitHandle,
    signal?: AbortSignal,
  ): Promise<HarnessControlResult> {
    const request = this.assertAttentionWaitBinding(context, waitHandle);
    if (
      request.responseState === "cancelled" ||
      request.responseState === "obsolete"
    )
      return {
        accepted: true,
        humanAttentionWait: {
          outcome: "cancelled",
          reason:
            request.cancellationReason ?? "HumanAttention request cancelled.",
          cancelledAt: request.cancelledAt ?? new Date().toISOString(),
        },
      };
    if (request.responseState === "responded")
      return this.deliverCommittedAttentionResponse(request.attentionId);
    if (this.attentionWaiters.has(request.attentionId))
      throw new HarnessControlError(
        "human_attention_wait_unavailable",
        "The exact HumanAttention request already has an active native wait.",
      );
    if (
      this.attentionWaiters.size >=
      HarnessControlAuthority.MAX_ACTIVE_ATTENTION_WAITS
    )
      throw new HarnessControlError(
        "human_attention_wait_unavailable",
        "The Worker has reached its bounded active HumanAttention wait limit.",
      );
    if (signal?.aborted)
      throw new HarnessControlError(
        "human_attention_wait_unavailable",
        "The native HumanAttention wait disconnected before subscription.",
      );
    return new Promise<HarnessControlResult>((resolve, reject) => {
      const abort = () => {
        const waiter = this.attentionWaiters.get(request.attentionId);
        if (waiter?.contextToken !== context.contextToken) return;
        this.attentionWaiters.delete(request.attentionId);
        waiter.removeAbortListener();
        reject(
          new HarnessControlError(
            "human_attention_wait_unavailable",
            "The native HumanAttention wait disconnected; the durable request remains pending.",
          ),
        );
      };
      const removeAbortListener = () =>
        signal?.removeEventListener("abort", abort);
      signal?.addEventListener("abort", abort, { once: true });
      this.attentionWaiters.set(request.attentionId, {
        contextToken: context.contextToken,
        waitHandle,
        resolve,
        reject,
        removeAbortListener,
      });
    });
  }

  private assertAttentionWaitBinding(
    context: BoundControlContext,
    waitHandle: HumanAttentionWaitHandle,
  ) {
    let request: ReturnType<DispatchRegistry["getHumanAttentionRequest"]>;
    try {
      request = this.registry.getHumanAttentionRequest(waitHandle.attentionId);
    } catch {
      throw new HarnessControlError(
        "stale_human_attention_response",
        "HumanAttention wait handle is unknown.",
      );
    }
    const lineage = this.registry.getLineage(context.lineageId);
    if (
      request.requestGeneration !== waitHandle.requestGeneration ||
      request.actionId !== context.dispatch.action.action_id ||
      request.attemptId !== context.dispatch.action.attempt_id ||
      request.lineageId !== context.lineageId ||
      request.harnessExecutionId !== lineage.lineageId ||
      request.nativeSessionId !== nativeSessionPublicId(lineage.nativeSession)
    )
      throw new HarnessControlError(
        "stale_human_attention_response",
        "HumanAttention wait handle does not match the exact current execution.",
      );
    if (
      request.controllerGeneration !== this.generation &&
      request.recoverability !== "rebind_exact"
    )
      throw new HarnessControlError(
        "human_attention_wait_unavailable",
        "This adapter declares that its native HumanAttention wait cannot be rebound after Worker loss.",
      );
    return request;
  }

  async receiveHumanAttentionResponse(
    input: HumanAttentionResponseDelivery,
  ): Promise<void> {
    const request = this.registry.recordHumanAttentionResponse(input);
    const dispatch = this.registry.get(request.actionId);
    await this.reportAttention(
      dispatch,
      this.registry.getLineage(request.lineageId),
    );
    const waiter = this.attentionWaiters.get(request.attentionId);
    if (!waiter) return;
    this.attentionWaiters.delete(request.attentionId);
    waiter.removeAbortListener();
    try {
      waiter.resolve(
        this.deliverCommittedAttentionResponse(request.attentionId),
      );
      await this.reportAttention(
        dispatch,
        this.registry.getLineage(request.lineageId),
      );
    } catch (error) {
      waiter.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private deliverCommittedAttentionResponse(
    attentionId: string,
  ): HarnessControlResult {
    const current = this.registry.getHumanAttentionRequest(attentionId);
    if (current.deliveryState !== "response_not_delivered")
      throw new HarnessControlError(
        "human_attention_delivery_uncertain",
        "HumanAttention response delivery was already requested and will not be replayed automatically.",
      );
    const request = this.registry.beginHumanAttentionDelivery(
      attentionId,
      current.requestGeneration,
    );
    if (!request.response || !request.deliveryAttemptId)
      throw new HarnessControlError(
        "human_attention_response_invalid",
        "The committed HumanAttention response is incomplete.",
      );
    return {
      accepted: true,
      humanAttentionWait: {
        outcome: "responded",
        response: structuredClone(request.response),
        deliveryAttemptId: request.deliveryAttemptId,
      },
    };
  }

  private async acknowledgeAttentionResponse(
    context: BoundControlContext,
    waitHandle: HumanAttentionWaitHandle,
    deliveryAttemptId: string,
  ): Promise<HarnessControlResult> {
    this.assertAttentionWaitBinding(context, waitHandle);
    let request: ReturnType<DispatchRegistry["getHumanAttentionRequest"]>;
    try {
      request = this.registry.acknowledgeHumanAttentionDelivery({
        attentionId: waitHandle.attentionId,
        requestGeneration: waitHandle.requestGeneration,
        deliveryAttemptId,
      });
    } catch (error) {
      throw new HarnessControlError(
        "human_attention_delivery_uncertain",
        error instanceof Error ? error.message : String(error),
      );
    }
    const observedAt =
      request.deliveryAcknowledgedAt ?? new Date().toISOString();
    await this.reportDelivery(
      {
        attentionId: request.attentionId,
        requestGeneration: request.requestGeneration,
        deliveryAttemptId: request.deliveryAttemptId,
        state: "delivery_acknowledged",
        observedAt,
      },
      request,
    );
    await this.reportAttention(
      context.dispatch,
      this.registry.getLineage(context.lineageId),
    );
    return { accepted: true };
  }

  async cancelPendingHumanAttention(
    lineageId: string,
    reason: string,
    state: "cancelled" | "obsolete" = "cancelled",
    exactActionId?: string,
  ): Promise<void> {
    const lineage = this.registry.getLineage(lineageId);
    const actionId = exactActionId ?? lineage.activeActionId;
    if (!actionId) return;
    const active = this.registry.activeHumanAttentionRequest(actionId);
    if (!active) return;
    const request = this.registry.cancelHumanAttention(
      active.attentionId,
      reason,
      state,
    );
    const waiter = this.attentionWaiters.get(request.attentionId);
    if (waiter) {
      this.attentionWaiters.delete(request.attentionId);
      waiter.removeAbortListener();
      waiter.resolve({
        accepted: true,
        humanAttentionWait: {
          outcome: "cancelled",
          reason: request.cancellationReason ?? reason,
          cancelledAt: request.cancelledAt ?? new Date().toISOString(),
        },
      });
    }
    const observedAt = request.cancelledAt ?? new Date().toISOString();
    await this.reportDelivery(
      {
        attentionId: request.attentionId,
        requestGeneration: request.requestGeneration,
        deliveryAttemptId: request.deliveryAttemptId,
        state,
        observedAt,
        reason: request.cancellationReason ?? reason,
      },
      request,
    );
    await this.reportAttention(
      this.registry.get(actionId),
      this.registry.getLineage(lineageId),
    );
  }

  private async reconcileHumanAttentionControllerGeneration(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    priorContextInvalidated: boolean,
  ): Promise<void> {
    const active = this.registry.activeHumanAttentionRequest(
      dispatch.action.action_id,
    );
    if (!active) return;
    if (active.deliveryState === "delivery_requested") {
      const request = this.registry.markHumanAttentionDeliveryUncertain(
        active.attentionId,
        "The Worker restarted after native delivery was requested but before exact acknowledgement.",
      );
      await this.reportDelivery(
        {
          attentionId: request.attentionId,
          requestGeneration: request.requestGeneration,
          deliveryAttemptId: request.deliveryAttemptId,
          state: "delivery_uncertain",
          observedAt: request.deliveryUncertainAt ?? new Date().toISOString(),
          ...(request.cancellationReason
            ? { reason: request.cancellationReason }
            : {}),
        },
        request,
      );
      await this.reportAttention(
        dispatch,
        this.registry.getLineage(lineage.lineageId),
      );
      return;
    }
    if (
      active.deliveryState === "delivery_uncertain" ||
      active.recoverability === "rebind_exact" ||
      (!priorContextInvalidated &&
        active.controllerGeneration === this.generation)
    )
      return;
    await this.cancelPendingHumanAttention(
      lineage.lineageId,
      "The adapter declared that its native HumanAttention wait cannot be recovered after Worker restart.",
      "obsolete",
      dispatch.action.action_id,
    );
  }

  private async reportAttention(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void> {
    await Promise.resolve(this.attentionObserver?.(dispatch, lineage)).catch(
      () => undefined,
    );
  }

  private async reportDelivery(
    receipt: HumanAttentionDeliveryReceipt,
    request: ReturnType<DispatchRegistry["getHumanAttentionRequest"]>,
  ): Promise<void> {
    await Promise.resolve(
      this.attentionDeliveryReporter?.(receipt, request),
    ).catch(() => undefined);
  }

  private async resolveAttention(
    context: BoundControlContext,
    attentionId: string,
    outcome: "completed" | "cannot_complete",
  ): Promise<HarnessControlResult> {
    const lineage = this.registry.getLineage(context.lineageId);
    if (!lineage.attention || lineage.attention.attentionId !== attentionId)
      throw new HarnessControlError(
        "invalid_attention",
        "Human attention request is stale.",
      );
    const active = this.registry.activeHumanAttentionRequest(
      context.dispatch.action.action_id,
    );
    if (active?.attentionId === attentionId)
      this.registry.cancelHumanAttention(
        attentionId,
        outcome === "completed"
          ? "The native harness resolved the request without a Product response."
          : "The native harness could not complete the requested human action.",
        "obsolete",
      );
    else this.registry.updateSession(context.lineageId, "running", null);
    await this.reportAttention(
      context.dispatch,
      this.registry.getLineage(context.lineageId),
    );
    return { accepted: true };
  }

  private async yieldToHuman(
    context: BoundControlContext,
    attentionId: string,
  ): Promise<HarnessControlResult> {
    const lineage = this.registry.getLineage(context.lineageId);
    if (!lineage.attention || lineage.attention.attentionId !== attentionId)
      throw new HarnessControlError(
        "invalid_attention",
        "Human intervention is stale.",
      );
    return {
      accepted: true,
      attention: lineage.attention,
      intervention: lineage.intervention,
    };
  }

  private async automationResumed(
    context: BoundControlContext,
    attentionId: string,
  ): Promise<HarnessControlResult> {
    const lineage = this.registry.getLineage(context.lineageId);
    if (
      !lineage.intervention ||
      lineage.intervention.attentionId !== attentionId
    )
      throw new HarnessControlError(
        "invalid_attention",
        "Human intervention is stale.",
      );
    const resumedAt = new Date().toISOString();
    const intervention: HumanInterventionLifecycle = {
      ...lineage.intervention,
      state: "resumed",
      handedBackAt: lineage.intervention.handedBackAt ?? resumedAt,
      automationResumedAt: resumedAt,
    };
    this.registry.updateSession(
      context.lineageId,
      "running",
      null,
      resumedAt,
      intervention,
    );
    return { accepted: true, intervention };
  }

  private async nativeStop(
    context: BoundControlContext,
    operation: Extract<HarnessControlOperation, { type: "native_stop" }>,
  ): Promise<HarnessControlResult> {
    const expectedModel = context.dispatch.action.execution.configuration.model;
    if (
      context.dispatch.action.execution.configuration.harness_kind ===
        "antigravity" &&
      operation.terminationReason !== "qe_zero_inference_readiness" &&
      operation.observedModel &&
      operation.observedModel !== expectedModel.model
    ) {
      const reason = `Antigravity stopped with model ${operation.observedModel}, but this PhysicalLineage is fenced to ${expectedModel.provider}/${expectedModel.model}. Continue only through a fresh compatible Attempt.`;
      context.contractViolation = reason;
      return {
        accepted: true,
        completed: false,
        contractViolation: reason,
        nativeStop: {
          decision: "contract_violation",
          enforcementAttempt: context.enforcementAttempts,
          reason,
        },
      };
    }
    if (
      context.dispatch.action.execution.configuration.harness_kind ===
        "antigravity" &&
      operation.terminationReason === "qe_zero_inference_readiness"
    )
      return {
        accepted: true,
        completed: false,
        nativeStop: {
          decision: "continue",
          cause: "readiness_probe",
          reason:
            "Quest Engineering verified the Antigravity Stop-hook transport without authorizing a provider turn.",
        },
      };
    if (await hasStepResult(context.dispatch))
      return {
        accepted: true,
        completed: true,
        semanticAccepted: true,
        completion: completionState(context),
        nativeStop: { decision: "allow" },
      };
    if (
      context.completion.phase === "exporting" ||
      context.completion.phase === "failed"
    )
      return {
        accepted: true,
        completed: false,
        semanticAccepted: true,
        completion: completionState(context),
        nativeStop: { decision: "allow" },
      };
    const lineage = this.registry.getLineage(context.lineageId);
    if (lineage.sessionState === "waiting_for_human" || lineage.attention)
      return {
        accepted: true,
        completed: false,
        ...(lineage.attention ? { attention: lineage.attention } : {}),
        intervention: lineage.intervention,
        nativeStop: { decision: "allow" },
      };
    if (context.lastCompletionFailure) {
      const semantic =
        context.lastCompletionFailure.kind === "semantic_validation";
      return {
        accepted: true,
        completed: false,
        nativeStop: {
          decision: "continue",
          cause: semantic
            ? "completion_semantic_validation"
            : "completion_infrastructure",
          reason: semantic
            ? `Quest Engineering rejected the submitted Step result (${context.lastCompletionFailure.code}): ${context.lastCompletionFailure.message} Correct the declared outputs and call qe_complete_step again; do not repeat completed implementation work.`
            : `Quest Engineering completion infrastructure rejected the submission (${context.lastCompletionFailure.code}): ${context.lastCompletionFailure.message} Preserve the completed work and retry qe_complete_step after the local bridge recovers.`,
        },
      };
    }
    context.enforcementAttempts += 1;
    if (context.enforcementAttempts <= this.maxStopEnforcements)
      return {
        accepted: true,
        completed: false,
        nativeStop: {
          decision: "continue",
          cause: "completion_omitted",
          enforcementAttempt: context.enforcementAttempts,
          reason:
            "Quest Engineering has not received a structured Step result. Submit the already-completed work's declared outputs through qe_complete_step before stopping; do not repeat implementation work.",
        },
      };
    const reason =
      "The native harness repeatedly stopped without a valid structured Quest Engineering Step result.";
    context.contractViolation = reason;
    return {
      accepted: true,
      completed: false,
      contractViolation: reason,
      nativeStop: {
        decision: "contract_violation",
        enforcementAttempt: context.enforcementAttempts,
        reason,
      },
    };
  }
}

export function controlDescriptorPath(lineage: HarnessLineage): string {
  return join(dirname(lineage.resultControlPath), "harness-control.json");
}

async function hasStepResult(dispatch: DispatchRecord): Promise<boolean> {
  try {
    return (await readdir(dispatch.resultDirectory)).some((name) =>
      /^result-[a-zA-Z0-9_-]+\.json$/.test(name),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function completionState(
  context: BoundControlContext,
): StructuredCompletionState {
  return structuredClone(context.completion);
}

function completionExportFailure(error: unknown): CompletionFailure {
  if (error instanceof HarnessControlError)
    return {
      kind: [
        "bridge_generation_mismatch",
        "unknown_control_context",
        "stale_control_context",
      ].includes(error.code)
        ? "stale_context"
        : "infrastructure",
      code: error.code,
      message: error.message,
    };
  return {
    kind: "infrastructure",
    code: "invalid_bridge_response",
    message: `Physical workspace export verification failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}
