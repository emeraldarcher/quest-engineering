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
  model: { provider: string; model: string };
  reasoning: Reasoning;
  tools: string[];
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
export interface Tactic {
  id: string;
  key: string;
  name: string;
  description: string;
  body: JsonValue;
  archived_at: string | null;
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
  max_access: WorkspaceAccess;
  shell_available: boolean;
}
export type Reasoning = "low" | "medium" | "high";
export type WorkspaceAccess = "none" | "read_only" | "read_write";
export type StepState =
  | "pending"
  | "waiting"
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "uncertain";

export interface ExecutionOption {
  model: { provider: string; model: string };
  reasoning: Reasoning[];
  tools: string[];
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
  type: string;
  artifact_id: string;
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
}
export interface ArtifactSummary {
  id: string;
  type: string;
  producer_occurrence_id: string;
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
