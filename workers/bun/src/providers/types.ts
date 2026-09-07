import type { DispatchRecord, ProviderLineage } from "../dispatch/registry.ts";
import type {
  ExecuteAction,
  JsonValue,
  LocalDispatchState,
} from "../protocol/types.ts";
import type {
  HostedAgent,
  HostedExecutionRef,
  TerminalAttachmentDescriptor,
} from "../session-host/types.ts";

export type HarnessKind = "pi" | "fake" | (string & {});
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
  lineage: ProviderLineage;
  ref: HostedExecutionRef;
  agent: HostedAgent;
}

export interface HarnessRecoveredExecution {
  found: boolean;
  agent?: HostedAgent;
  detail: string;
}

export interface HarnessAdoptionCandidate {
  action: ExecuteAction;
  lineage: ProviderLineage;
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
  readonly capabilities: HarnessCapabilities;

  start(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<HarnessPreparedExecution>;
  continue(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<HarnessPreparedExecution>;
  sendInputAndCollect(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>>;
  interrupt(lineage: ProviderLineage): Promise<void>;
  inspect(lineage: ProviderLineage): Promise<HarnessInspection>;
  close(lineage: ProviderLineage): Promise<void>;

  recover(lineage: ProviderLineage): Promise<HarnessRecoveredExecution>;
  waitAndCollect(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
    agent: HostedAgent,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>>;
  clearActiveMetadata(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<void>;
  discoverAdoptionCandidates(): Promise<HarnessAdoptionCandidate[]>;
  attachment(lineage: ProviderLineage): TerminalAttachmentDescriptor;
  disconnect(): void;
}
