// Reviewed against SDK 0.3.292 / Claude Code 2.1.292 sdk.d.ts:
// StdoutMessage → SDKMessage and its control/keep-alive members. This is a
// CLOSED diagnostic allowlist, not a protocol validator or dynamic schema.
export const CLAUDE_OUTPUT_SIMPLE_TYPES = [
  "active_goal",
  "assistant",
  "user",
  "stream_event",
  "auth_status",
  "prompt_suggestion",
  "rate_limit_event",
  "tool_progress",
  "tool_use_summary",
  "conversation_reset",
  "control_request",
  "control_response",
  "control_cancel_request",
  "keep_alive",
] as const;
export const CLAUDE_OUTPUT_SYSTEM_SUBTYPES = [
  "api_retry",
  "background_tasks_changed",
  "commands_changed",
  "compact_boundary",
  "control_request_progress",
  "elicitation_complete",
  "files_persisted",
  "hook_progress",
  "hook_response",
  "hook_started",
  "informational",
  "local_command_output",
  "memory_recall",
  "mirror_error",
  "model_refusal_fallback",
  "model_refusal_no_fallback",
  "notification",
  "permission_denied",
  "plugin_install",
  "session_state_changed",
  "status",
  "init",
  "task_notification",
  "task_progress",
  "task_started",
  "task_updated",
  "thinking_tokens",
  "worker_shutting_down",
] as const;
export const CLAUDE_OUTPUT_RESULT_SUBTYPES = [
  "success",
  "error_during_execution",
  "error_max_turns",
  "error_max_budget_usd",
  "error_max_structured_output_retries",
] as const;
export const MAX_CLAUDE_CENSUS_COUNT = 2_147_483_647;
export const MAX_CLAUDE_CENSUS_BUCKETS =
  CLAUDE_OUTPUT_SIMPLE_TYPES.length +
  CLAUDE_OUTPUT_SYSTEM_SUBTYPES.length +
  CLAUDE_OUTPUT_RESULT_SUBTYPES.length +
  6;

type Category =
  | (typeof CLAUDE_OUTPUT_SIMPLE_TYPES)[number]
  | `system/${(typeof CLAUDE_OUTPUT_SYSTEM_SUBTYPES)[number] | "unknown"}`
  | `result/${(typeof CLAUDE_OUTPUT_RESULT_SUBTYPES)[number] | "unknown"}`
  | "unknown"
  | "non_object_json"
  | "non_json"
  | "empty";
/** Native values exist only in this transient parser callback, never in a snapshot. */
export type ClaudeOutputUnit =
  | { kind: "json"; value: unknown }
  | { kind: "non_json"; decodedUtf8Bytes: number }
  | { kind: "empty" }
  | { kind: "incomplete_eof"; decodedUtf8Bytes: number }
  | { kind: "invalid_utf8" }
  | { kind: "buffer_limit" };
interface Bucket {
  count: number;
  firstObservedAt: string;
  lastObservedAt: string;
}
const COUNTERS = [
  "totalOutputUnits",
  "validJsonUnits",
  "jsonObjectUnits",
  "nonObjectJsonUnits",
  "nonJsonUnits",
  "nonJsonDecodedUtf8Bytes",
  "emptyUnits",
  "recognizedDiscriminatorUnits",
  "unknownDiscriminatorUnits",
  "systemInitCandidateCount",
  "sessionIdPresentCount",
  "reservedSessionMatchCount",
  "reservedSessionMismatchCount",
  "sessionIdMissingCount",
  "invalidUtf8Count",
  "bufferLimitCount",
  "incompleteEofCount",
  "incompleteEofDecodedUtf8Bytes",
] as const;
type Counter = (typeof COUNTERS)[number];
export interface ClaudeOutputCensusSnapshot {
  schemaVersion: 1;
  protocol: "claude_output_census_v1";
  observation: "not_registered" | "observing" | "unavailable";
  unavailableReason: "counter_overflow" | "observer_failed" | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  counters: Record<Counter, number>;
  /** Keys are only static categories; recognized tags do not mean valid frames. */
  categories: Partial<Record<Category, Bucket>>;
}

/** One preparation/attachment. No payload references, strings, IDs or hashes retained. */
export class ClaudeOutputCensus {
  private readonly counts = Object.fromEntries(
    COUNTERS.map((k) => [k, 0]),
  ) as Record<Counter, number>;
  private readonly buckets = new Map<Category, Bucket>();
  private first: string | null = null;
  private last: string | null = null;
  private unavailable: ClaudeOutputCensusSnapshot["unavailableReason"] = null;

  observe(unit: ClaudeOutputUnit, reservedSessionId: string): void {
    if (this.unavailable) return;
    try {
      const now = new Date().toISOString();
      this.first ??= now;
      this.last = now;
      if (unit.kind === "invalid_utf8") {
        this.add("invalidUtf8Count");
        return;
      }
      if (unit.kind === "buffer_limit") {
        this.add("bufferLimitCount");
        return;
      }
      if (unit.kind === "incomplete_eof") {
        this.add("incompleteEofCount");
        this.add("incompleteEofDecodedUtf8Bytes", unit.decodedUtf8Bytes);
        return; // A partial EOF is not an invalid complete JSON unit.
      }
      this.add("totalOutputUnits");
      let category: Category;
      if (unit.kind === "empty") {
        this.add("emptyUnits");
        category = "empty";
      } else if (unit.kind === "non_json") {
        this.add("nonJsonUnits");
        this.add("nonJsonDecodedUtf8Bytes", unit.decodedUtf8Bytes);
        category = "non_json";
      } else {
        this.add("validJsonUnits");
        const value = unit.value;
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          this.add("nonObjectJsonUnits");
          category = "non_object_json";
        } else {
          this.add("jsonObjectUnits");
          const frame = value as Record<string, unknown>;
          category = classify(frame);
          if (category === "unknown" || category.endsWith("/unknown"))
            this.add("unknownDiscriminatorUnits");
          else this.add("recognizedDiscriminatorUnits");
          if (frame.type === "system" && frame.subtype === "init") {
            this.add("systemInitCandidateCount");
            if (Object.hasOwn(frame, "session_id")) {
              this.add("sessionIdPresentCount");
              this.add(
                typeof frame.session_id === "string" &&
                  frame.session_id === reservedSessionId
                  ? "reservedSessionMatchCount"
                  : "reservedSessionMismatchCount",
              );
            } else this.add("sessionIdMissingCount");
          }
        }
      }
      const prior = this.buckets.get(category);
      if (prior) {
        if (prior.count >= MAX_CLAUDE_CENSUS_COUNT) throw new RangeError();
        prior.count++;
        prior.lastObservedAt = now;
      } else {
        if (this.buckets.size >= MAX_CLAUDE_CENSUS_BUCKETS)
          throw new RangeError();
        this.buckets.set(category, {
          count: 1,
          firstObservedAt: now,
          lastObservedAt: now,
        });
      }
    } catch (error) {
      this.unavailable =
        error instanceof RangeError ? "counter_overflow" : "observer_failed";
    }
  }

  snapshot(registered: boolean): ClaudeOutputCensusSnapshot {
    return {
      schemaVersion: 1,
      protocol: "claude_output_census_v1",
      observation: this.unavailable
        ? "unavailable"
        : registered
          ? "observing"
          : "not_registered",
      unavailableReason: this.unavailable,
      firstObservedAt: this.first,
      lastObservedAt: this.last,
      counters: { ...this.counts },
      categories: Object.fromEntries(
        [...this.buckets].map(([key, value]) => [key, { ...value }]),
      ),
    };
  }

  private add(key: Counter, amount = 1): void {
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      this.counts[key] + amount > MAX_CLAUDE_CENSUS_COUNT
    )
      throw new RangeError();
    this.counts[key] += amount;
  }
}

function classify(frame: Record<string, unknown>): Category {
  if (frame.type === "system") {
    const subtype = CLAUDE_OUTPUT_SYSTEM_SUBTYPES.find(
      (x) => x === frame.subtype,
    );
    return subtype ? `system/${subtype}` : "system/unknown";
  }
  if (frame.type === "result") {
    const subtype = CLAUDE_OUTPUT_RESULT_SUBTYPES.find(
      (x) => x === frame.subtype,
    );
    return subtype ? `result/${subtype}` : "result/unknown";
  }
  return CLAUDE_OUTPUT_SIMPLE_TYPES.find((x) => x === frame.type) ?? "unknown";
}
