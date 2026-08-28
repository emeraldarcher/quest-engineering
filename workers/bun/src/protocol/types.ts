export const WORKER_PROTOCOL_VERSION = 2 as const;

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

export interface Requirement {
  selector: string;
  value: string | null;
}

export interface ExecuteAction {
  type: "execute_action";
  protocol_version: typeof WORKER_PROTOCOL_VERSION;
  worker_id: string;
  action_id: string;
  run_id: string;
  occurrence_id: string;
  attempt_id: string;
  semantic_step_key: string;
  instruction: string;
  performer_requirement: Requirement;
  performer_affinity_occurrence_id: string | null;
  context_requirement: Requirement;
  context_lineage_occurrence_id: string | null;
  inputs: Record<string, ArtifactInstance>;
  declared_outputs: string[];
}

export type DispatchState = "accepted" | "running" | "completed" | "failed";
export type LocalDispatchState = DispatchState | "uncertain";

export interface ReconcileDispatch {
  action_id: string;
  occurrence_id: string;
  attempt_id: string;
  state: DispatchState;
  outputs?: Record<string, JsonValue>;
  failure?: Record<string, JsonValue>;
}

export interface WorkerCapabilities {
  os: string;
  arch: string;
  max_concurrency: number;
  tags: string[];
  capabilities: string[];
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
