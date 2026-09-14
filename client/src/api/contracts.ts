export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ApiErrorDetail {
  code: string;
  path: Array<string | number>;
  details: JsonValue;
  instance_path?: string[];
  definition_path?: string[];
}

export interface ApiErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: ApiErrorDetail[];
    meta: Record<string, JsonValue>;
  };
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: ApiErrorDetail[] = [],
    readonly meta: Record<string, JsonValue> = {},
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ClassDefinition {
  id: string;
  key: string;
  name: string;
  description: string;
  instructions: string;
  archived_at: string | null;
}
export interface Loadout {
  id: string;
  key: string;
  name: string;
  description: string;
  harness: string;
  model: { provider: string; model: string };
  reasoning: Reasoning | null;
  tool_policy: ToolPolicy;
  workspace_access: WorkspaceAccess;
  archived_at: string | null;
}
export interface SquadMember {
  member_key: string;
  name: string;
  class_id: string;
  loadout_id: string;
}
export interface Squad {
  id: string;
  key: string;
  name: string;
  description: string;
  members: SquadMember[];
  archived_at: string | null;
}
export interface ArtifactRefContract {
  producer: string;
  output: string;
}
export interface TacticInputPortContract {
  key: string;
  label: string;
  kind: string;
  required: boolean;
}
export interface TacticOutputPortContract {
  key: string;
  label: string;
  kind: string;
  source:
    | { type: "binding"; binding: ArtifactRefContract }
    | { type: "accepted_subject"; gate_key: string };
}
export interface TacticInterfaceContract {
  inputs: TacticInputPortContract[];
  outputs: TacticOutputPortContract[];
}
export interface Tactic {
  id: string;
  key: string;
  name: string;
  description: string;
  body: JsonValue;
  interface: TacticInterfaceContract;
  archived_at: string | null;
}
export interface SemanticStepIdentity {
  name: string | null;
  local_key: string;
  definition: { key: string; name: string | null } | null;
  instance_path: Array<{
    instance_key: string;
    definition_key: string | null;
    definition_name: string | null;
  }>;
}
export interface SemanticArtifactBinding {
  artifact_type: string;
  input_name: string;
  consumer: SemanticStepIdentity;
  selection: "inferred" | "explicit";
  source:
    | { kind: "step"; step: SemanticStepIdentity }
    | {
        kind: "remediation";
        initial_step: SemanticStepIdentity | null;
        remediation_step: SemanticStepIdentity | null;
      };
}
export interface TacticPreview {
  resolved_tactic: JsonValue;
  artifact_bindings?: SemanticArtifactBinding[];
  provenance?: JsonValue;
  step_origins?: JsonValue[];
}
export interface TacticSourceDefinition {
  type: "definition";
  tactic_definition_id: string;
}
export interface TacticSourceInline {
  type: "inline";
  body: JsonValue;
}
export type TacticSource = TacticSourceDefinition | TacticSourceInline;
export type QuestLifecycleState =
  | "ready"
  | "working"
  | "preparing_review"
  | "awaiting_review"
  | "complete"
  | "needs_attention";
export interface Quest {
  id: string;
  title: string;
  objective: string;
  workspace_id: string;
  squad_id: string;
  tactic_source: TacticSource;
  completion: {
    completed_at: string | null;
    completed_by_run_id: string | null;
  };
  lifecycle: {
    state: QuestLifecycleState;
    label: string;
    current_run_id: string | null;
    primary_action:
      | "launch"
      | "run_again"
      | "retry_publishing"
      | "open_pull_request"
      | null;
    delivery?: DeliveryProjection;
    issue?: { code: string; message: string };
  };
  archived_at: string | null;
}
export interface Workspace {
  id: string;
  key: string;
  name: string;
  source_kind: "git_remote" | "local_git";
  source_fingerprint: string | null;
  binding: {
    state: "unbound" | "preparing" | "ready" | "attention_required" | "offline";
    message: string;
    issue?: { code: string };
  };
  archived_at: string | null;
}
export interface WorkspaceSource {
  candidate_id: string;
  name: string;
  source_kind: "git_remote" | "local_git";
  source_fingerprint: string | null;
  publication_repository_identity: string | null;
  max_access: WorkspaceAccess;
  shell_available: boolean;
}
export type Reasoning = string;
export type ReasoningCapability =
  | { kind: "enumerated"; values: Reasoning[] }
  | { kind: "unsupported" };
/** User-authored execution intent. */
export type ToolPolicy =
  | { kind: "exact"; tools: string[] }
  | { kind: "native_permissions" };
/** Execution guarantee provided by the matched harness adapter. */
export type ToolEnforcement = "exact" | "native_permissions";
/**
 * QE semantic capability profile advertised/resolved by an adapter. On a
 * ResolvedExecution this is exact for the Attempt, but is not necessarily every
 * internal native harness tool.
 */
export interface ResolvedToolProfile {
  tools: string[];
}
export type WorkspaceAccess = "none" | "read_only" | "read_write";
export type StepState =
  | "pending"
  | "waiting"
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "uncertain";

export type StarterCrewState =
  | "empty"
  | "recoverable_partial"
  | "complete"
  | "conflict"
  | "manual_configuration";
export interface StarterCrewStatus {
  state: StarterCrewState;
  conflict: {
    entity_type: "class" | "loadout" | "squad" | "tactic";
    key: string;
  } | null;
}
export interface StarterCrewResult {
  status: "ready";
  classes: ClassDefinition[];
  loadouts: Loadout[];
  squad: Squad;
  tactic: Tactic;
}

export interface ExecutionOption {
  harness: string;
  model: {
    provider: string;
    model: string;
    display_name: string;
  };
  reasoning_capability: ReasoningCapability;
  tool_policy: { kind: ToolPolicy["kind"] };
  tool_enforcement: ToolEnforcement;
  current_tool_profile: ResolvedToolProfile;
  workspaces: Array<{
    workspace_id: string;
    workspace_access: WorkspaceAccess[];
  }>;
  available: boolean;
}

export interface SnapshotMember {
  member_key: string;
  name: string;
  class: { id: string; key: string; name: string };
  loadout: { id: string; key: string; name: string };
}
export interface ArtifactRef {
  name: string;
  type: string;
  artifact_id: string;
}
export type HarnessSessionState =
  | "starting"
  | "running"
  | "waiting_for_human"
  | "recovering"
  | "retained"
  | "closed"
  | "unavailable";
export interface HumanAttention {
  attention_id: string;
  category: string;
  message: string;
  requested_at: string;
  interaction?: {
    kind:
      | "confirmation"
      | "text"
      | "choice"
      | "multiline_response"
      | "conversational_intervention";
    control_state:
      | "intervention_pending"
      | "human_control"
      | "resuming_automation";
    resume_command?: string;
  };
}
export interface HarnessSessionProjection {
  id: string;
  harness: { kind: string; display_name: string };
  worker: {
    id: string;
    display_name: string;
    state: "connected" | "disconnected";
  };
  state: HarnessSessionState;
  native_identity: {
    conversation_id: string | null;
    terminal_id: string | null;
  };
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
  attachment: {
    mode: "local_native_terminal";
    available: boolean;
    reason: string | null;
    can_observe: boolean;
    can_takeover: boolean;
    can_recover?: boolean;
  };
  attention: HumanAttention | null;
  started_at: string;
  last_activity_at: string;
  events: Array<{
    id: string;
    type: string;
    attention_id: string | null;
    metadata: Record<string, JsonValue>;
    occurred_at: string;
  }>;
}
export interface LocalSessionAttachmentDescriptor {
  descriptor_token: string;
  expires_at: string;
  mode: "local_native_terminal";
  worker_id: string;
  worker_generation: number;
  session_id: string;
  state: HarnessSessionState;
  takeover_allowed: boolean;
  recovery_allowed?: boolean;
  terminal: {
    attachment_mode: "local_native_terminal";
    backend_kind: "herdr";
    terminal_session_id: string;
    terminal_target_id: string;
    terminal_id: string | null;
    supports_observation: boolean;
    supports_takeover: boolean;
  };
}

export interface RunAttempt {
  id: string;
  number: number;
  state: string;
  started_at: string | null;
  finished_at: string | null;
  outputs: ArtifactRef[];
  output_produced: boolean;
  resolution: "retried" | "marked_failed" | null;
  retry_of_attempt_id: string | null;
  execution: {
    harness: string;
    model: { provider: string; model: string };
    reasoning: Reasoning | null;
    reasoning_capability: ReasoningCapability;
    tool_policy: ToolPolicy;
    tool_enforcement: ToolEnforcement;
    resolved_tool_profile: ResolvedToolProfile;
    workspace_permission: WorkspaceAccess;
    worker_id: string;
  } | null;
  operational?: {
    recovery_epoch: number;
    recovery_kind: "initial" | "human";
    attempt_in_epoch: number;
    attempt_allowance: number | null;
    policy_source: "configured" | "legacy_unknown";
    continuation_mode: "fresh" | "retained";
    recovery_authorized_at: string;
  } | null;
  session?: HarnessSessionProjection | null;
}
export interface RunStep {
  occurrence_id: string;
  semantic_step_key: string;
  name: string | null;
  instruction: string | null;
  state: StepState;
  phase: string | null;
  remediation_cycle: number | null;
  control_path: string[];
  attempt: RunAttempt | null;
  attempts: RunAttempt[];
  session?: HarnessSessionProjection | null;
  member: SnapshotMember | null;
  performer: {
    selector: string | null;
    class_key: string | null;
    source_occurrence_id: string | null;
    source_semantic_step_key: string | null;
  };
  context: {
    mode: string | null;
    source_occurrence_id: string | null;
    source_semantic_step_key: string | null;
  };
  inputs: ArtifactRef[];
  outputs: ArtifactRef[];
  issue: { code: string; message: string } | null;
  recovery?: {
    can_retry: boolean;
    can_mark_failed: boolean;
    can_human_retry?: boolean;
    can_retry_fresh?: boolean;
    retained_session_available?: boolean;
    classification?: string;
    epoch_exhausted?: boolean;
    message: string;
  } | null;
}
export interface ArtifactSummary {
  id: string;
  type: string;
  producer_occurrence_id: string;
  producer_attempt_id: string | null;
  version?: number | null;
  supersedes_artifact_id?: string | null;
  content_hash?: string | null;
  media_type?: string | null;
  filename?: string | null;
  title?: string | null;
  preview: JsonValue;
}
export interface DeliveryProjection {
  state:
    | "preparing_review"
    | "awaiting_review"
    | "merged"
    | "closed_unmerged"
    | "no_changes"
    | "attention_required";
  changes: {
    files_changed: number;
    additions: number;
    deletions: number;
  } | null;
  review: {
    provider: "github";
    state: string;
    number: number;
    url: string;
  } | null;
  revisions: { base: string | null; head: string | null };
  issue: { code: string; message: string } | null;
  can_retry: boolean;
}
export interface RunProjection {
  id: string;
  status: StepState | "completed" | "failed";
  launched_at: string;
  revision: number;
  launch: { id: string };
  quest: { id: string; title: string; objective: string };
  execution_environment: {
    workspace: { id: string; key: string; name: string };
    state:
      | "waiting_for_host"
      | "preparing"
      | "ready"
      | "attention_required"
      | "retained"
      | "cleanup_requested"
      | "removed";
    message: string;
    base_revision: string | null;
    branch: string | null;
    source_dirty_changes_excluded: boolean | null;
    issue: { code: string; message: string } | null;
  };
  delivery: DeliveryProjection | null;
  squad: { id: string; key: string; name: string; members: SnapshotMember[] };
  steps: RunStep[];
  artifacts: ArtifactSummary[];
  planning?: {
    accepted_plan: ArtifactSummary | null;
    history: Array<{
      artifact_id: string;
      version: number;
      status: "accepted" | "rejected" | null;
      verdict_artifact_id: string | null;
      findings: JsonValue;
      supersedes_artifact_id: string | null;
    }>;
  };
  operational_recovery?: Array<{
    id: string;
    occurrence_id: string;
    epoch_number: number;
    authorization_kind: "initial" | "human";
    attempt_allowance: number | null;
    policy_source: "configured" | "legacy_unknown";
    continuation_mode: "fresh" | "retained";
    authorized_at: string;
    attempts_scheduled: number;
  }>;
  semantic_remediation?: Array<{
    region_occurrence_id: string;
    semantic_region_id: string;
    remediations_completed: number;
    maximum_remediations: number;
    status: string;
    review_shaped: boolean;
    acceptance_gate_key?: string | null;
    acceptance_subject_kind?: string | null;
    remediation_kind?: "plan_revision" | "implementation_repair" | "generic";
  }>;
  review_gate: {
    required: boolean;
    status: "not_required" | "accepted" | "rejected" | "missing" | "invalid";
    occurrence_id: string | null;
    attempt_id: string | null;
    artifact_id: string | null;
  };
  step_counts: Record<StepState, number>;
  issues: Array<{ code: string; message: string }>;
}
export interface RunSummary {
  id: string;
  status: string;
  quest_title: string;
  launched_at: string;
  step_counts: Record<StepState, number>;
  delivery: DeliveryProjection | null;
  live_session_attention?: Array<{
    session_id: string;
    category: string;
    attention_id: string;
  }>;
}
export interface ArtifactDetail extends ArtifactSummary {
  value: JsonValue;
}
export interface QuestPreview {
  quest: { id: string; title: string; objective: string };
  workspace: { id: string; key: string; name: string; source_kind: string };
  squad: { id: string; key: string; name: string; members: SnapshotMember[] };
  tactic: JsonValue;
  execution_plan: JsonValue;
}

export function asRecord(
  value: unknown,
  context: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid ${context} response.`);
  return value as Record<string, unknown>;
}
export function asArray(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${context} response.`);
  return value;
}
export function asString(value: unknown, context: string): string {
  if (typeof value !== "string")
    throw new Error(`Invalid ${context} response.`);
  return value;
}
export function nullableString(value: unknown, context: string): string | null {
  return value === null ? null : asString(value, context);
}
export function asBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`Invalid ${context} response.`);
  return value;
}
export function asNumber(value: unknown, context: string): number {
  if (typeof value !== "number")
    throw new Error(`Invalid ${context} response.`);
  return value;
}
export function strings(value: unknown, context: string): string[] {
  return asArray(value, context).map((item) => asString(item, context));
}

export function decodeApiError(value: unknown, status?: number): ApiError {
  const envelope = asRecord(value, "error");
  const error = asRecord(envelope.error, "error");
  const details = asArray(error.details ?? [], "error details").map(
    (detail) => {
      const item = asRecord(detail, "error detail");
      return {
        code: asString(item.code, "error detail"),
        path: asArray(item.path ?? [], "error path") as Array<string | number>,
        details: (item.details ?? {}) as JsonValue,
        ...(item.instance_path
          ? { instance_path: strings(item.instance_path, "instance path") }
          : {}),
        ...(item.definition_path
          ? {
              definition_path: strings(item.definition_path, "definition path"),
            }
          : {}),
      };
    },
  );
  return new ApiError(
    asString(error.code, "error"),
    asString(error.message, "error"),
    details,
    asRecord(error.meta ?? {}, "error meta") as Record<string, JsonValue>,
    status,
  );
}
