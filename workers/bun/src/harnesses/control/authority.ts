import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  DispatchRecord,
  DispatchRegistry,
  HarnessLineage,
} from "../../dispatch/registry.ts";
import type { JsonValue } from "../../protocol/types.ts";
import type { HumanAttention, HumanInterventionLifecycle } from "../types.ts";
import { writeControlDescriptor } from "./descriptor.ts";
import {
  STEP_RESULT_PROTOCOL_VERSION,
  type StepResultEnvelope,
  validateOutputs,
  writeStepResultAtomic,
} from "./result-envelope.ts";
import {
  type CompletionFailure,
  HARNESS_CONTROL_PROTOCOL_VERSION,
  type HarnessControlDescriptor,
  HarnessControlError,
  type HarnessControlOperation,
  type HarnessControlResponse,
  type HarnessControlResult,
} from "./types.ts";

interface BoundControlContext {
  contextToken: string;
  dispatch: DispatchRecord;
  lineageId: string;
  requests: Map<string, HarnessControlResult>;
  enforcementAttempts: number;
  contractViolation: string | null;
  lastCompletionFailure: CompletionFailure | null;
  operationTail: Promise<void>;
}

export interface HarnessControlEndpoint {
  host: "127.0.0.1";
  port: number;
}

export interface StructuredCompletionBoundary {
  verifyAndBind(input: {
    dispatch: DispatchRecord;
    lineageId: string;
    outputs: Record<string, JsonValue>;
  }): Promise<Record<string, JsonValue>>;
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

  constructor(
    private readonly registry: DispatchRegistry,
    private readonly maxStopEnforcements = 2,
    private readonly completionBoundary?: StructuredCompletionBoundary,
  ) {}

  setEndpoint(endpoint: HarnessControlEndpoint): void {
    this.endpoint = endpoint;
  }

  async bind(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
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
    if (previous) this.contexts.delete(previous);
    const contextToken = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const context: BoundControlContext = {
      contextToken,
      dispatch,
      lineageId: lineage.lineageId,
      requests: new Map(),
      enforcementAttempts: 0,
      contractViolation: null,
      lastCompletionFailure: null,
      operationTail: Promise.resolve(),
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
    if (token) this.contexts.delete(token);
    this.tokenByLineage.delete(lineageId);
  }

  async handle(input: {
    bridgeGeneration: string;
    contextToken: string;
    requestId: string;
    operation: HarnessControlOperation;
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
        return this.requestAttention(context, operation);
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
        return {
          accepted: true,
          completed: await hasStepResult(context.dispatch),
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
    context.lastCompletionFailure = null;
    if (await hasStepResult(context.dispatch))
      throw new HarnessControlError(
        "replayed_request",
        "This Attempt already has a structured Step result.",
      );
    let boundOutputs = outputs;
    if (this.completionBoundary) {
      try {
        boundOutputs = await this.completionBoundary.verifyAndBind({
          dispatch: context.dispatch,
          lineageId: context.lineageId,
          outputs,
        });
        validateOutputs(context.dispatch.action.declared_outputs, boundOutputs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        context.lastCompletionFailure = {
          kind: "infrastructure",
          code: "invalid_bridge_response",
          message,
        };
        throw new HarnessControlError(
          "invalid_bridge_response",
          `Physical workspace export verification failed: ${message}`,
        );
      }
    }
    const action = context.dispatch.action;
    const envelope: StepResultEnvelope = {
      protocolVersion: STEP_RESULT_PROTOCOL_VERSION,
      kind: "quest_engineering_step_result",
      workerId: action.worker_id,
      actionId: action.action_id,
      runId: action.run_id,
      occurrenceId: action.occurrence_id,
      attemptId: action.attempt_id,
      nonce: context.dispatch.resultNonce,
      createdAt: new Date().toISOString(),
      outputs: boundOutputs,
    };
    await writeStepResultAtomic(
      context.dispatch.resultDirectory,
      requestId,
      envelope,
    );
    return { accepted: true, completed: true };
  }

  private async requestAttention(
    context: BoundControlContext,
    operation: Extract<
      HarnessControlOperation,
      { type: "request_human_assistance" }
    >,
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
    const attention: HumanAttention = {
      attentionId,
      category: operation.category,
      message,
      requestedAt,
      ...(conversational
        ? {
            interaction: {
              kind: "conversational_intervention",
              controlState: "intervention_pending",
              resumeCommand: "/qe-resume",
            },
          }
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
    this.registry.updateSession(
      context.lineageId,
      "waiting_for_human",
      attention,
      requestedAt,
      intervention,
    );
    return { accepted: true, attention, intervention };
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
    void outcome;
    this.registry.updateSession(context.lineageId, "running", null);
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
