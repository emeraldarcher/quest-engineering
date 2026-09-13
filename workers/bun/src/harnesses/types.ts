import type { DispatchRecord, HarnessLineage } from "../dispatch/registry.ts";
import type {
  ExecuteAction,
  JsonValue,
  LocalDispatchState,
  ReasoningCapability,
} from "../protocol/types.ts";
import type {
  HostedAgent,
  HostedExecutionRef,
  TerminalAttachmentDescriptor,
} from "../session-host/types.ts";

export type HarnessKind = "pi" | "antigravity" | "fake" | (string & {});
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
  | "running"
  | "waiting_for_human"
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
  | "terminal_not_recoverable";

export class OperationalExecutionError extends Error {
  constructor(
    message: string,
    readonly classification: OperationalFailureClassification,
  ) {
    super(message);
  }
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

export interface HarnessInspection {
  state: HarnessSessionState;
  agent: HostedAgent | null;
  attention: HumanAttention | null;
  intervention: HumanInterventionLifecycle | null;
  lastActivityAt: string;
}

export type HarnessEvent =
  | { type: "inspection"; inspection: HarnessInspection }
  | { type: "running"; inspection: HarnessInspection }
  | { type: "output"; inspection: HarnessInspection };

export interface HarnessPreparedExecution {
  lineage: HarnessLineage;
  ref: HostedExecutionRef;
  agent: HostedAgent;
}

export interface HarnessRecoveredExecution {
  found: boolean;
  agent?: HostedAgent;
  /** Present when recovery created a new terminal/process incarnation. */
  ref?: HostedExecutionRef;
  detail: string;
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
  /** Native readiness after interactive launch and before prompt intent. */
  ready?(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
  ): Promise<void>;
  sendInputAndCollect(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>>;
  interrupt?(lineage: HarnessLineage): Promise<void>;
  inspect(lineage: HarnessLineage): Promise<HarnessInspection>;
  close(lineage: HarnessLineage): Promise<void>;

  recover?(lineage: HarnessLineage): Promise<HarnessRecoveredExecution>;
  waitAndCollect?(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
    agent: HostedAgent,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>>;
  clearActiveMetadata(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<void>;
  discoverAdoptionCandidates(): Promise<HarnessAdoptionCandidate[]>;
  attachment?(lineage: HarnessLineage): TerminalAttachmentDescriptor;
  disconnect(): void;
}
