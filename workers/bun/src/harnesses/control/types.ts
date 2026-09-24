import type { JsonValue } from "../../protocol/types.ts";
import type {
  HarnessSessionState,
  HumanAttention,
  HumanAttentionCategory,
  HumanInterventionLifecycle,
} from "../types.ts";

export const HARNESS_CONTROL_PROTOCOL_VERSION = 1 as const;

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
      interaction?: "confirmation" | "conversational_intervention";
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

export interface HarnessControlResult {
  accepted: true;
  duplicate?: boolean;
  completed?: boolean;
  contractViolation?: string;
  attention?: HumanAttention;
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
