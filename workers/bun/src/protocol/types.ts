export const WORKER_PROTOCOL_VERSION = 4 as const;

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ArtifactInstance {
  id: string;
  type: string;
  producer_occurrence_id: string;
  value: JsonValue;
}

export type Reasoning = "low" | "medium" | "high";
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
    declared_outputs: string[];
  };
  configuration: {
    model: { provider: string; model: string };
    reasoning: Reasoning;
    tools: string[];
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

/** v4 wire message plus normalized identity aliases used by durable internals. */
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
}

export type DispatchState =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "uncertain";
export type LocalDispatchState = DispatchState;

export interface ReconcileDispatch {
  action_id: string;
  occurrence_id: string;
  attempt_id: string;
  state: DispatchState;
  outputs?: Record<string, JsonValue>;
  failure?: Record<string, JsonValue>;
}

export interface ExecutorCapability {
  adapter: string;
  models: Array<{ provider: string; model: string }>;
  reasoning: Reasoning[];
  tools: string[];
}

export interface WorkerCapabilities {
  os: string;
  arch: string;
  max_concurrency: number;
  tags: string[];
  executors: ExecutorCapability[];
  workspace_bindings: Array<{
    binding_id: string;
    workspace_id: string;
    authorized_root_key: string;
    source_repository_root: string;
    source_fingerprint?: string | null;
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
