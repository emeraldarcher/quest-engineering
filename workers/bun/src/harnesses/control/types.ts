import type { JsonValue } from "../../protocol/types.ts";
import type {
  HarnessSessionState,
  HumanAttention,
  HumanAttentionCategory,
  HumanAttentionWaitRecoverability,
  HumanInterventionLifecycle,
} from "../types.ts";

export const HARNESS_CONTROL_PROTOCOL_VERSION = 2 as const;

export interface HumanAttentionWaitHandle {
  attentionId: string;
  requestGeneration: number;
}

export interface HumanAttentionResponse {
  attentionId: string;
  requestGeneration: number;
  approved: boolean;
  value: JsonValue;
  respondedAt: string;
}

export type HumanAttentionWaitResult =
  | {
      outcome: "responded";
      response: HumanAttentionResponse;
      deliveryAttemptId: string;
    }
  | {
      outcome: "cancelled";
      reason: string;
      cancelledAt: string;
    };

export interface HumanAttentionDeliveryReceipt {
  attentionId: string;
  requestGeneration: number;
  deliveryAttemptId: string | null;
  state:
    | "delivery_acknowledged"
    | "delivery_uncertain"
    | "cancelled"
    | "obsolete";
  observedAt: string;
  reason?: string;
}

/** Identity is held by the Worker authority and deliberately absent here. */
export type HarnessControlOperation =
  | {
      type: "complete_step";
      outputs: Record<string, JsonValue>;
    }
  | {
      type: "report_completion_failure";
      failure: CompletionFailure;
    }
  | {
      type: "request_human_assistance";
      category: HumanAttentionCategory;
      message: string;
      interaction?:
        | "confirmation"
        | "text"
        | "choice"
        | "multiline_response"
        | "conversational_intervention";
      responseSchema?: JsonValue;
      origin?: {
        kind: "main_agent" | "internal_agent";
        nativeAgentRef?: string;
      };
    }
  | {
      type: "wait_for_human_assistance_response";
      waitHandle: HumanAttentionWaitHandle;
    }
  | {
      type: "acknowledge_human_assistance_response";
      waitHandle: HumanAttentionWaitHandle;
      deliveryAttemptId: string;
    }
  | {
      type: "resolve_human_assistance";
      attentionId: string;
      outcome: "completed" | "cannot_complete";
    }
  | {
      type: "yield_to_human";
      attentionId: string;
      nativeSessionId?: string;
    }
  | {
      type: "automation_resumed";
      attentionId: string;
      nativeSessionId?: string;
    }
  | {
      type: "report_state";
      state: HarnessSessionState;
      detail?: string;
    }
  | { type: "completion_status" }
  | {
      type: "native_stop";
      terminationReason: string;
      fullyIdle: boolean;
      observedModel?: string;
    };

export interface HarnessControlRequest {
  protocolVersion: typeof HARNESS_CONTROL_PROTOCOL_VERSION;
  bridgeGeneration: string;
  contextToken: string;
  requestId: string;
  operation: HarnessControlOperation;
}

export type CompletionFailureKind =
  | "semantic_validation"
  | "stale_context"
  | "infrastructure";

export interface CompletionFailure {
  kind: CompletionFailureKind;
  code: HarnessControlErrorCode;
  message: string;
}

export type StructuredCompletionPhase =
  | "awaiting_result"
  | "exporting"
  | "completed"
  | "failed";

export interface StructuredCompletionState {
  phase: StructuredCompletionPhase;
  semanticAccepted: boolean;
  acceptedAt?: string;
  exportStartedAt?: string;
  exportCompletedAt?: string;
  failure?: CompletionFailure;
}

export type NativeStopDecision =
  | { decision: "allow" }
  | {
      decision: "continue";
      reason: string;
      cause:
        | "completion_omitted"
        | "completion_semantic_validation"
        | "completion_infrastructure"
        | "readiness_probe";
      enforcementAttempt?: number;
    }
  | {
      decision: "contract_violation";
      reason: string;
      enforcementAttempt: number;
    };

export interface HarnessControlBinding {
  actionId: string;
  attemptId: string;
  lineageId: string;
  resultNonce: string;
}

export interface DurableHumanAttentionRequest {
  attentionId: string;
  requestGeneration: number;
  registrationRequestId: string;
  actionId: string;
  runId: string;
  occurrenceId: string;
  attemptId: string;
  lineageId: string;
  harnessExecutionId: string;
  nativeSessionId: string | null;
  recoverability: HumanAttentionWaitRecoverability;
  controllerGeneration: string;
  request: Omit<
    Extract<HarnessControlOperation, { type: "request_human_assistance" }>,
    "type"
  >;
  responseState: "pending" | "responded" | "cancelled" | "obsolete";
  response: HumanAttentionResponse | null;
  deliveryState:
    | "response_not_delivered"
    | "delivery_requested"
    | "delivery_acknowledged"
    | "delivery_uncertain";
  deliveryAttemptId: string | null;
  createdAt: string;
  responseCommittedAt: string | null;
  deliveryRequestedAt: string | null;
  deliveryAcknowledgedAt: string | null;
  deliveryUncertainAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
}

export interface HarnessControlResult {
  accepted: true;
  duplicate?: boolean;
  completed?: boolean;
  semanticAccepted?: boolean;
  completion?: StructuredCompletionState;
  contractViolation?: string;
  attention?: HumanAttention;
  attentionWaitHandle?: HumanAttentionWaitHandle;
  humanAttentionWait?: HumanAttentionWaitResult;
  intervention?: HumanInterventionLifecycle | null;
  nativeStop?: NativeStopDecision;
  binding?: HarnessControlBinding;
}

export interface HarnessControlSuccess {
  protocolVersion: typeof HARNESS_CONTROL_PROTOCOL_VERSION;
  ok: true;
  result: HarnessControlResult;
}

export type HarnessControlErrorCode =
  | "invalid_request"
  | "bridge_generation_mismatch"
  | "unknown_control_context"
  | "stale_control_context"
  | "replayed_request"
  | "invalid_step_result"
  | "invalid_attention"
  | "human_attention_request_rejected"
  | "human_attention_wait_unavailable"
  | "human_attention_cancelled"
  | "human_attention_response_invalid"
  | "human_attention_delivery_uncertain"
  | "stale_human_attention_response"
  | "bridge_unavailable"
  | "bridge_timeout"
  | "invalid_bridge_response"
  | "harness_contract_violation";

export interface HarnessControlFailure {
  protocolVersion: typeof HARNESS_CONTROL_PROTOCOL_VERSION;
  ok: false;
  error: {
    code: HarnessControlErrorCode;
    message: string;
  };
}

export type HarnessControlResponse =
  | HarnessControlSuccess
  | HarnessControlFailure;

/** Opaque capability handed to one native harness process; it carries no QE identity. */
export interface HarnessControlDescriptor {
  protocolVersion: typeof HARNESS_CONTROL_PROTOCOL_VERSION;
  endpoint: { host: "127.0.0.1"; port: number };
  bridgeGeneration: string;
  contextToken: string;
}

export class HarnessControlError extends Error {
  constructor(
    readonly code: HarnessControlErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export class HarnessCompletionError extends HarnessControlError {
  constructor(
    readonly kind: CompletionFailureKind,
    code: HarnessControlErrorCode,
    message: string,
  ) {
    super(code, message);
  }
}
