export const WORKER_PROTOCOL_VERSION = 8 as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ArtifactInstance {
  id: string;
  kind: string;
  output_name?: string;
  producer_occurrence_id: string;
  value: JsonValue;
  version?: number | null;
  supersedes_artifact_id?: string | null;
  content_hash?: string | null;
  media_type?: string | null;
  filename?: string | null;
  title?: string | null;
}

export interface ArtifactOutputDeclaration {
  name: string;
  kind: string;
}

export interface AcceptanceContract {
  output: string;
  gate_key: string;
  subject_kind: string;
  subject_artifact_id: string;
}

export type Reasoning = string;
export type ReasoningCapability =
  | { kind: "enumerated"; values: string[] }
  | { kind: "unsupported" };
/** User-authored execution intent, independent of a harness's authorization decisions. */
export type ToolPolicy =
  | { kind: "exact"; tools: string[] }
  | { kind: "native_permissions" };
/** The execution guarantee provided by the matched harness adapter. */
export type ToolEnforcement = "exact" | "native_permissions";
/**
 * Exact QE semantic capability profile resolved by the adapter for one execution.
 * These IDs are QE capability evidence, not necessarily a raw inventory of every
 * internal native harness tool.
 */
export interface ResolvedToolProfile {
  tools: string[];
}
export type WorkspaceAccess = "none" | "read_only" | "read_write";

export interface ResolvedExecution {
  identity: {
    launch_id: string;
    action_id: string;
    run_id: string;
    occurrence_id: string;
    attempt_id: string;
    semantic_step_key: string;
  };
  performer: {
    member_key: string;
    member_name: string;
    class_key: string;
    class_name: string;
  };
  work: {
    quest_objective: string;
    class_instructions: string;
    step_instruction: string;
    inputs: Record<string, ArtifactInstance>;
    declared_outputs: ArtifactOutputDeclaration[];
    acceptance_contract?: AcceptanceContract | null;
  };
  configuration: {
    harness_kind: string;
    model: { provider: string; model: string };
    reasoning: Reasoning | null;
    reasoning_capability: ReasoningCapability;
    tool_policy: ToolPolicy;
    tool_enforcement: ToolEnforcement;
    resolved_tool_profile: ResolvedToolProfile;
  };
  logical_workspace: {
    workspace_id: string;
    workspace_key: string;
  };
  execution_workspace: {
    worktree_id: string;
    workspace_binding_id: string;
    canonical_root: string;
    access: WorkspaceAccess;
  };
  context: {
    mode: "fresh" | "continue_from";
    source_occurrence_id: string | null;
    logical_lineage_id: string;
  };
}

/** v6 wire message plus normalized identity aliases used by durable internals. */
export interface OperationalRecoveryExecution {
  epoch_number: number;
  attempt_in_epoch: number;
  attempt_allowance: number | null;
  authorization_kind: "initial" | "human";
  continuation_mode: "fresh" | "retained";
  retained_lineage_id: string | null;
  source_attempt_id: string | null;
  request_id: string | null;
}

export interface ExecuteAction {
  type: "execute_action";
  protocol_version: typeof WORKER_PROTOCOL_VERSION;
  worker_id: string;
  execution: ResolvedExecution;
  action_id: string;
  run_id: string;
  occurrence_id: string;
  attempt_id: string;
  semantic_step_key: string;
  instruction: string;
  inputs: Record<string, ArtifactInstance>;
  declared_outputs: string[];
  context_requirement: { selector: "fresh" | "continue_from"; value: null };
  context_lineage_occurrence_id: string | null;
  operational_recovery?: OperationalRecoveryExecution;
}

export type DispatchState =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "uncertain";
export type LocalDispatchState = DispatchState;

export type ExecutionTurnPhase =
  | "preparing"
  | "prompt_intent"
  | "waiting_for_activity"
  | "working"
  | "awaiting_result"
  | "blocked"
  | "stalled"
  | "settled"
  | "uncertain";

export interface ReconcileSession {
  session_id: string;
  action_id: string;
  run_id: string;
  occurrence_id: string;
  attempt_id: string;
  member_key: string;
  harness_kind: string;
  harness_display_name: string;
  state:
    | "starting"
    | "waiting_for_activity"
    | "running"
    | "waiting_for_human"
    | "stalled"
    | "recovering"
    | "retained"
    | "closed"
    | "unavailable";
  capabilities: {
    can_attach_terminal: boolean;
    can_send_input: boolean;
    can_interrupt: boolean;
    can_detect_attention: boolean;
    can_resume: boolean;
    can_observe_structured_events: boolean;
    structured_confirmation: boolean;
    structured_text_response: boolean;
    structured_choice_response: boolean;
    structured_multiline_response: boolean;
    native_prompt_control: boolean;
    conversational_takeover: boolean;
    automation_resume: boolean;
  };
  terminal: {
    attachment_mode: "local_native_terminal";
    backend_kind: string;
    terminal_session_id: string;
    terminal_target_id: string;
    terminal_id?: string;
    supports_observation: boolean;
    supports_takeover: boolean;
  } | null;
  native_session_id: string | null;
  attention: {
    attention_id: string;
    category: string;
    message: string;
    requested_at: string;
    interaction?: {
      kind: string;
      control_state: string;
      resume_command?: string;
    };
  } | null;
  intervention: {
    attention_id: string;
    kind: "conversational_intervention";
    state: "intervention_pending" | "resuming_automation" | "resumed";
    requested_at: string;
    handed_back_at?: string;
    automation_resumed_at?: string;
  } | null;
  started_at: string;
  last_activity_at: string;
  turn: {
    phase: ExecutionTurnPhase;
    prompt_intent_at: string | null;
    prompt_accepted_at: string | null;
    native_activity_at: string | null;
    provider_turn_settled_at: string | null;
    native_idle_at: string | null;
    structured_result_received_at: string | null;
    stalled_at: string | null;
    settled_at: string | null;
    completion: {
      structured_result_required: true;
      outputs: Array<{ name: string; kind: string }>;
      physical_export_required: boolean;
    };
    physical_process?: {
      mode: "prepared_process_adopted" | "fresh_process_fallback";
      source_action_id: string;
      source_attempt_id: string;
      target_action_id: string;
      target_attempt_id: string;
      source_lineage_id: string;
      target_lineage_id: string;
      herdr_session: string | null;
      herdr_session_incarnation: string | null;
      workspace_id: string | null;
      pane_id: string | null;
      terminal_id: string | null;
      agent_name: string | null;
      recorded_at: string;
    };
  };
}

export interface ReconcileDispatch {
  action_id: string;
  occurrence_id: string;
  attempt_id: string;
  state: DispatchState;
  outputs?: Record<string, JsonValue>;
  failure?: Record<string, JsonValue>;
}

export type AccountAvailability =
  | "verified_available"
  | "verified_unavailable"
  | "unknown";

export interface ExecutorCapability {
  harness_kind: string;
  models: Array<{
    provider: string;
    model: string;
    display_name: string;
    account_availability: AccountAvailability;
    reasoning_capability: ReasoningCapability;
  }>;
  supported_tool_policies: Array<ToolPolicy["kind"]>;
  tool_enforcement: ToolEnforcement;
  tool_profile: ResolvedToolProfile;
}

export interface WorkerCapabilities {
  os: string;
  arch: string;
  max_concurrency: number;
  dispatch_availability?: "active" | "maintenance";
  tags: string[];
  executors: ExecutorCapability[];
  features?: Array<
    | "run_delivery_v1"
    | "run_worktree_retention_v1"
    | "run_worktree_cleanup_v1"
    | "workspace_binding_status_v1"
    | "live_execution_sessions_v1"
  >;
  workspace_bindings: Array<{
    binding_id: string;
    workspace_id: string;
    authorized_root_key: string;
    source_repository_root: string;
    source_fingerprint?: string | null;
    publication_remote_name?: string | null;
    publication_repository_identity?: string | null;
    max_access: WorkspaceAccess;
    allow_unconfined_shell: boolean;
  }>;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, nested]) => key.length > 0 && isJsonValue(nested),
  );
}
