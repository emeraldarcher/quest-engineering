import type { DispatchRecord, HarnessLineage } from "../dispatch/registry.ts";
import type {
  ExecuteAction,
  JsonValue,
  LocalDispatchState,
  ReasoningCapability,
} from "../protocol/types.ts";
import type { TerminalAttachmentDescriptor } from "../session-host/types.ts";
import {
  type NativeSessionRef,
  validateNativeSessionRef,
} from "./native-session.ts";
import {
  type HarnessTransportBinding,
  validateTransportBinding,
} from "./transport-binding.ts";

export type HarnessKind = "pi" | "antigravity" | "fake" | (string & {});
export type AccountAvailability =
  | "verified_available"
  | "verified_unavailable"
  | "unknown";
export type HarnessIntegrationStrategy =
  | "native_extension"
  | "native_rpc"
  | "hooks_plus_structured_tool"
  | "structured_headless"
  | "terminal_only";
export type IntegrationStatusKind =
  | "ready"
  | "missing_dependency"
  | "auth_required"
  | "missing_control_bridge"
  | "incompatible_version"
  | "degraded"
  | "unavailable";

export interface HarnessModelCapability {
  provider: string;
  model: string;
  displayName: string;
  accountAvailability: AccountAvailability;
  reasoningCapability:
    | ReasoningCapability
    | { kind: "unknown"; detail: string };
}

export interface HarnessDiscovery {
  kind: HarnessKind;
  displayName: string;
  strategy: HarnessIntegrationStrategy;
  integration: {
    status: IntegrationStatusKind;
    detail: string;
    installed: boolean;
    authenticated: boolean;
  };
  models: HarnessModelCapability[];
  capabilities: HarnessCapabilities;
}
export type HarnessSessionState =
  | "starting"
  | "waiting_for_activity"
  | "running"
  | "waiting_for_human"
  | "stalled"
  | "recovering"
  | "retained"
  | "closed"
  | "unavailable";
export const HUMAN_ESCALATION_POLICY = `Human escalation policy:
- Request human assistance when meaningful forward progress requires material user information or a consequential decision missing from the Quest, repository, artifacts, and responsible engineering judgment; when authentication, credentials, external approval, or manual action is required; or when a genuine blocker cannot be safely resolved from available evidence.
- Do not invent material user requirements merely to keep execution moving. If the task says instructions or a choice will come from the human and they are absent, request assistance rather than inventing them.
- Do not interrupt for internal naming, equivalent implementation techniques, normal investigation/debugging, an ordinary test failure you can fix, or another choice you can responsibly make yourself.
- Use the richest reliable interaction supported by the active harness. Never pretend conversational takeover exists when it is unavailable.`;

export type OperationalFailureClassification =
  | "auto_retryable"
  | "operator_recovery_required"
  | "terminal_not_recoverable"
  | "uncertain";
export type SideEffectCertainty =
  | "not_submitted"
  | "submitted"
  | "ambiguous"
  | "native_accepted";
export type HarnessOperationPhase =
  | "discovery"
  | "prepare"
  | "readiness"
  | "execute"
  | "observe"
  | "recover"
  | "interrupt"
  | "retire";

export class OperationalExecutionError extends Error {
  readonly name = "OperationalExecutionError";

  constructor(
    message: string,
    readonly classification: OperationalFailureClassification,
    readonly code?: string,
    readonly evidence?: Record<string, JsonValue>,
    readonly outcome?: {
      sideEffectCertainty?: SideEffectCertainty;
      phase?: HarnessOperationPhase;
      capability?: string;
    },
  ) {
    super(message);
  }

  get sideEffectCertainty(): SideEffectCertainty | undefined {
    return this.outcome?.sideEffectCertainty;
  }

  get phase(): HarnessOperationPhase | undefined {
    return this.outcome?.phase;
  }

  get capability(): string | undefined {
    return this.outcome?.capability;
  }
}

/** Converts backend/provider exceptions before they cross AgentHarness orchestration. */
export function operationalHarnessError(
  error: unknown,
  phase: HarnessOperationPhase,
): OperationalExecutionError {
  if (error instanceof OperationalExecutionError) {
    if (error.phase && error.sideEffectCertainty) return error;
    return new OperationalExecutionError(
      error.message,
      error.classification,
      error.code,
      error.evidence,
      {
        ...error.outcome,
        phase: error.phase ?? phase,
        sideEffectCertainty:
          error.sideEffectCertainty ??
          (error.classification === "uncertain"
            ? "ambiguous"
            : sideEffectCertainty(error.code, phase)),
      },
    );
  }
  const value = error as {
    code?: unknown;
    capability?: unknown;
    message?: unknown;
  };
  const rawCode =
    typeof value?.code === "string" && value.code ? value.code : null;
  const code = rawCode ?? `harness_${phase}_failed`;
  const transient = [
    "timeout",
    "wait_timeout",
    "shell_not_ready",
    "agent_not_ready",
    "agent_pane_busy",
    "backend_unavailable",
    "controller_disconnected",
    "stream_closed",
  ].includes(code);
  const nonRecoverable = [
    "backend_incompatible",
    "provenance_mismatch",
    "ownership_mismatch",
    "environment_launch_mismatch",
    "environment_attestation_failed",
    "agent_explicit_launch_failed",
    "incompatible_continuation_configuration",
    "harness_contract_violation",
  ].includes(code);
  const uncertain = [
    "agent_launch_uncertain",
    "agent_prompt_uncertain",
  ].includes(code);
  const classification: OperationalFailureClassification = uncertain
    ? "uncertain"
    : transient
      ? "auto_retryable"
      : nonRecoverable
        ? "terminal_not_recoverable"
        : "operator_recovery_required";
  const certainty = sideEffectCertainty(code, phase);
  const capability =
    typeof value?.capability === "string" && value.capability
      ? value.capability
      : undefined;
  return new OperationalExecutionError(
    error instanceof Error ? error.message : `Harness ${phase} failed.`,
    classification,
    code,
    undefined,
    {
      sideEffectCertainty: certainty,
      phase,
      ...(capability ? { capability } : {}),
    },
  );
}

function sideEffectCertainty(
  code: string | undefined,
  phase: HarnessOperationPhase,
): SideEffectCertainty {
  if (["agent_launch_uncertain", "agent_prompt_uncertain"].includes(code ?? ""))
    return "ambiguous";
  return ["execute", "observe", "interrupt", "retire"].includes(phase)
    ? "ambiguous"
    : "not_submitted";
}

export type HumanAttentionCategory =
  | "needs_input"
  | "needs_permission"
  | "needs_authentication"
  | "needs_confirmation"
  | "blocked_external"
  | "interactive_prompt"
  | "unknown_interactive_block";

export type HumanInteractionKind =
  | "confirmation"
  | "text"
  | "choice"
  | "multiline_response"
  | "conversational_intervention";
export type HumanControlState =
  | "intervention_pending"
  | "human_control"
  | "resuming_automation";

export interface HumanAttention {
  attentionId: string;
  category: HumanAttentionCategory;
  message: string;
  requestedAt: string;
  interaction?: {
    kind: HumanInteractionKind;
    controlState: HumanControlState;
    resumeCommand?: string;
  };
  /** Bounded provider-neutral rendering data for a structured response. */
  responseSchema?: JsonValue;
}

export interface HumanInterventionLifecycle {
  attentionId: string;
  kind: "conversational_intervention";
  state: "intervention_pending" | "resuming_automation" | "resumed";
  requestedAt: string;
  handedBackAt?: string;
  automationResumedAt?: string;
}

export interface HarnessCapabilities {
  /** A harness without this capability cannot execute QE Attempts. */
  structuredResult: boolean;
  continuation: boolean;
  retainedSessionRecovery: boolean;
  structuredAttention: boolean;
  nativeBlocking: boolean;
  canAttachTerminal: boolean;
  canSendInput: boolean;
  canInterrupt: boolean;
  canDetectAttention: boolean;
  canResume: boolean;
  canObserveStructuredEvents: boolean;
  structuredConfirmation: boolean;
  structuredTextResponse: boolean;
  structuredChoiceResponse: boolean;
  structuredMultilineResponse: boolean;
  nativePromptControl: boolean;
  conversationalTakeover: boolean;
  automationResume: boolean;
}

export interface InteractiveHarnessSession {
  kind: "terminal" | (string & {});
  attachment: {
    available: boolean;
    supportsObservation: boolean;
    supportsTakeover: boolean;
  } | null;
  literalInput: boolean;
  processIdentity: "verified" | "unverified" | "not_applicable";
}

export function validateInteractiveHarnessSession(
  value: unknown,
): InteractiveHarnessSession {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Interactive harness session must be an object.");
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, [
      "kind",
      "attachment",
      "literalInput",
      "processIdentity",
    ]) ||
    typeof record.kind !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(record.kind) ||
    typeof record.literalInput !== "boolean" ||
    !["verified", "unverified", "not_applicable"].includes(
      String(record.processIdentity),
    )
  )
    throw new Error("Interactive harness session is invalid.");
  let attachment: InteractiveHarnessSession["attachment"] = null;
  if (record.attachment !== null) {
    if (!record.attachment || typeof record.attachment !== "object")
      throw new Error("Interactive harness attachment is invalid.");
    const candidate = record.attachment as Record<string, unknown>;
    if (
      !hasExactKeys(candidate, [
        "available",
        "supportsObservation",
        "supportsTakeover",
      ]) ||
      typeof candidate.available !== "boolean" ||
      typeof candidate.supportsObservation !== "boolean" ||
      typeof candidate.supportsTakeover !== "boolean"
    )
      throw new Error("Interactive harness attachment is invalid.");
    attachment = {
      available: candidate.available,
      supportsObservation: candidate.supportsObservation,
      supportsTakeover: candidate.supportsTakeover,
    };
  }
  return {
    kind: record.kind,
    attachment,
    literalInput: record.literalInput,
    processIdentity:
      record.processIdentity as InteractiveHarnessSession["processIdentity"],
  };
}

export const HARNESS_EXECUTION_HANDLE_SCHEMA_VERSION = 1 as const;
export const MAX_HARNESS_EXECUTION_HANDLE_BYTES = 48 * 1024;
export const MAX_PERSISTED_HARNESS_EXECUTION_HANDLE_BYTES = 12 * 1024;

export interface HarnessExecutionHandle {
  schemaVersion: typeof HARNESS_EXECUTION_HANDLE_SCHEMA_VERSION;
  harnessKind: HarnessKind;
  /** Harness-owned execution identity. It has no terminal-topology semantics. */
  executionId: string;
  nativeSession?: NativeSessionRef;
  /** Opaque to Worker orchestration and owned by `harnessKind`. */
  transportBinding?: HarnessTransportBinding;
}

export function validateHarnessExecutionHandle(
  value: unknown,
  expectedHarnessKind?: string,
  expectedExecutionId?: string,
): HarnessExecutionHandle {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Harness execution handle must be an object.");
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "harnessKind",
    "executionId",
    "nativeSession",
    "transportBinding",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key)))
    throw new Error("Harness execution handle has unexpected fields.");
  if (
    record.schemaVersion !== 1 ||
    typeof record.harnessKind !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(record.harnessKind) ||
    (expectedHarnessKind && record.harnessKind !== expectedHarnessKind) ||
    typeof record.executionId !== "string" ||
    record.executionId.length === 0 ||
    Buffer.byteLength(record.executionId, "utf8") > 8 * 1024 ||
    (expectedExecutionId && record.executionId !== expectedExecutionId)
  )
    throw new Error("Harness execution handle ownership is invalid.");
  const harnessKind = record.harnessKind;
  const nativeSession =
    record.nativeSession !== undefined
      ? validateNativeSessionRef(record.nativeSession, harnessKind)
      : undefined;
  const transportBinding =
    record.transportBinding !== undefined
      ? validateTransportBinding(record.transportBinding, harnessKind)
      : undefined;
  if (
    Buffer.byteLength(JSON.stringify(record), "utf8") >
    MAX_HARNESS_EXECUTION_HANDLE_BYTES
  )
    throw new Error("Harness execution handle exceeds the durable size limit.");
  return {
    schemaVersion: HARNESS_EXECUTION_HANDLE_SCHEMA_VERSION,
    harnessKind,
    executionId: record.executionId,
    ...(nativeSession ? { nativeSession } : {}),
    ...(transportBinding ? { transportBinding } : {}),
  };
}

/** Persists only generic execution identity; recovery facets have dedicated columns. */
export function serializeHarnessExecutionHandle(
  handle: HarnessExecutionHandle,
  expectedHarnessKind: string,
  expectedExecutionId: string,
): string {
  const valid = validateHarnessExecutionHandle(
    handle,
    expectedHarnessKind,
    expectedExecutionId,
  );
  return JSON.stringify({
    schemaVersion: valid.schemaVersion,
    harnessKind: valid.harnessKind,
    executionId: valid.executionId,
  });
}

export function parseHarnessExecutionHandle(
  serialized: string,
  expectedHarnessKind: string,
  expectedExecutionId: string,
): HarnessExecutionHandle {
  if (
    Buffer.byteLength(serialized, "utf8") >
    MAX_PERSISTED_HARNESS_EXECUTION_HANDLE_BYTES
  )
    throw new Error(
      "Persisted harness execution handle exceeds the size limit.",
    );
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Persisted harness execution handle is malformed.");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, [
      "schemaVersion",
      "harnessKind",
      "executionId",
    ])
  )
    throw new Error(
      "Persisted harness execution handle has unexpected fields.",
    );
  return validateHarnessExecutionHandle(
    value,
    expectedHarnessKind,
    expectedExecutionId,
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

export interface HarnessInspection {
  state: HarnessSessionState;
  activity: {
    state: "idle" | "active" | "blocked" | "completed" | "unknown";
    detail?: string;
  };
  nativeSession: NativeSessionRef | null;
  health: "healthy" | "degraded" | "unavailable" | "unknown";
  attention: HumanAttention | null;
  intervention: HumanInterventionLifecycle | null;
  lastActivityAt: string;
  /** Adapter-private durable transport evidence; valid for headless harnesses. */
  transportBinding?: HarnessTransportBinding;
  interactive:
    | (InteractiveHarnessSession & {
        /** Adapter-private evidence retained for topology-fenced implementations. */
        transportBinding?: HarnessTransportBinding;
      })
    | null;
}

export interface PreAuthorizationActivity {
  observedAt: string;
  nativeSession: NativeSessionRef | null;
  evidence: "native_session" | "native_user_message";
}

export interface PromptEvidenceCursor {
  kind:
    | "pi_transcript"
    | "pi_runtime_state"
    | "antigravity_log"
    | "claude_stream";
  cursor: number;
  /** Guest-native provider completion baseline; present only for Pi/SBX. */
  providerTurnCursor?: number;
  promptHash: string;
}

export type HarnessEvent =
  | {
      type: "prompt_baseline";
      evidence: PromptEvidenceCursor;
      inspection: HarnessInspection;
    }
  | {
      type: "prompt_accepted";
      acceptedAt: string;
      inspection: HarnessInspection;
    }
  | {
      type: "native_activity";
      observedAt: string;
      inspection: HarnessInspection;
    }
  | {
      type: "provider_turn_settled";
      observedAt: string;
      inspection: HarnessInspection;
    }
  | {
      type: "native_idle";
      observedAt: string;
      inspection: HarnessInspection;
    }
  | { type: "stalled"; observedAt: string; inspection: HarnessInspection }
  | {
      type: "structured_result_received";
      observedAt: string;
      inspection: HarnessInspection;
    }
  | { type: "inspection"; inspection: HarnessInspection }
  /** Backward-compatible synthetic-harness event: native work is active. */
  | { type: "running"; inspection: HarnessInspection }
  | { type: "output"; inspection: HarnessInspection };

export interface HarnessPreparedExecution {
  lineage: HarnessLineage;
  handle: HarnessExecutionHandle;
  /** Absent for a valid headless/programmatic execution. */
  interactive?: InteractiveHarnessSession;
}

export type HarnessRecoveredExecution =
  | {
      found: true;
      handle: HarnessExecutionHandle;
      inspection: HarnessInspection;
      detail: string;
    }
  | { found: false; detail: string };

export interface HarnessKnownDispatch {
  dispatch: DispatchRecord;
  lineage: HarnessLineage;
}

export interface HarnessAdoptionCandidate {
  action: ExecuteAction;
  lineage: HarnessLineage;
  state: Extract<LocalDispatchState, "accepted" | "running">;
  resultNonce: string;
  resultDirectory: string;
}

/**
 * Provider-neutral coding-agent contract. Harnesses own coding-agent semantics;
 * terminal creation, recovery, attachment and raw transport stay behind the
 * TerminalSessionBackend contract.
 */
export interface AgentHarness {
  readonly kind: HarnessKind;
  readonly displayName: string;
  readonly integrationStrategy: HarnessIntegrationStrategy;
  readonly capabilities: HarnessCapabilities;

  discover(): Promise<HarnessDiscovery>;
  start(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution>;
  continue?(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution>;
  /** Side-effect-free proof that a prepared execution can change Attempt ownership. */
  provePreparedProcessAdoption?(
    source: DispatchRecord,
    target: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void>;
  /** Harness readiness after preparation and before prompt intent. */
  ready?(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
  ): Promise<void>;
  /** Side-effect-free proof that no native user turn bypassed an authorization gate. */
  observePreAuthorizationActivity?(
    lineage: HarnessLineage,
  ): Promise<PreAuthorizationActivity | null>;
  sendInputAndCollect(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>>;
  /** Execution retirement used only by an authorized recovery transition. */
  retire?(lineage: HarnessLineage): Promise<void>;
  interrupt?(lineage: HarnessLineage): Promise<void>;
  /** Resolve one exact Product-correlated native blocking request. */
  respondToAttention?(
    lineage: HarnessLineage,
    input: {
      attentionId: string;
      approved: boolean;
      value: JsonValue;
    },
  ): Promise<void>;
  /** Side-effect-free, authoritative absence proof required before fresh retained-work recovery. */
  proveInactiveForFreshRecovery?(lineage: HarnessLineage): Promise<boolean>;
  inspect(lineage: HarnessLineage): Promise<HarnessInspection>;
  close(lineage: HarnessLineage): Promise<void>;

  recover?(
    lineage: HarnessLineage,
    dispatch?: DispatchRecord,
  ): Promise<HarnessRecoveredExecution>;
  waitAndCollect?(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    handle: HarnessExecutionHandle,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>>;
  clearActiveMetadata(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void>;
  discoverAdoptionCandidates(
    known?: readonly HarnessKnownDispatch[],
  ): Promise<HarnessAdoptionCandidate[]>;
  disconnect(): void;
}

/** Optional terminal-facing capability, deliberately outside semantic AgentHarness. */
export interface InteractiveAgentHarness extends AgentHarness {
  attachment(lineage: HarnessLineage): TerminalAttachmentDescriptor;
}

export function supportsInteractiveAttachment(
  harness: AgentHarness,
): harness is InteractiveAgentHarness {
  return (
    harness.capabilities.canAttachTerminal &&
    "attachment" in harness &&
    typeof harness.attachment === "function"
  );
}
