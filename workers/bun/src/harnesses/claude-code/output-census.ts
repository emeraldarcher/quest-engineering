import {
  CLAUDE_COMMAND_LIFECYCLE_STATES,
  CLAUDE_JSON_KINDS,
  CLAUDE_NATIVE_PRIVATE_RESULT_SUBTYPES,
  CLAUDE_NATIVE_PRIVATE_ROOT_TYPES,
  CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES,
  CLAUDE_OUTPUT_RESULT_SUBTYPES,
  CLAUDE_OUTPUT_SIMPLE_TYPES,
  CLAUDE_OUTPUT_SYSTEM_SUBTYPES,
  CLAUDE_ROOT_KINDS,
  CLAUDE_SUBTYPE_KINDS,
  type ClaudeJsonKind,
  type ClaudeOutputCategory,
  claudeOutputCategory,
  decodeClaudeOutputTag,
  hasClaudeRoot,
  isClaudeInit,
} from "./output-tags.ts";

// Compatibility exports; the catalog and all tag interpretation live in output-tags.
export {
  CLAUDE_OUTPUT_RESULT_SUBTYPES,
  CLAUDE_OUTPUT_SIMPLE_TYPES,
  CLAUDE_OUTPUT_SYSTEM_SUBTYPES,
} from "./output-tags.ts";
export const MAX_CLAUDE_CENSUS_COUNT = 2_147_483_647;
export const MAX_CLAUDE_CENSUS_BUCKETS =
  CLAUDE_OUTPUT_SIMPLE_TYPES.length +
  CLAUDE_OUTPUT_SYSTEM_SUBTYPES.length +
  CLAUDE_OUTPUT_RESULT_SUBTYPES.length +
  CLAUDE_NATIVE_PRIVATE_ROOT_TYPES.length +
  CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES.length +
  CLAUDE_NATIVE_PRIVATE_RESULT_SUBTYPES.length +
  6;

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
function zeros<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}
const STATES = [
  ...CLAUDE_COMMAND_LIFECYCLE_STATES,
  "unknown_or_malformed",
] as const;
const CORRELATIONS = [
  "match",
  "mismatch",
  "missing_or_invalid",
  "unavailable",
] as const;
export interface ClaudeOutputCensusSnapshot {
  schemaVersion: 1;
  protocol: "claude_output_census_v1";
  observation: "not_registered" | "observing" | "unavailable";
  unavailableReason: "counter_overflow" | "observer_failed" | null;
  firstObservedAt: string | null;
  lastObservedAt: string | null;
  counters: Record<Counter, number>;
  structure: {
    roots: Record<(typeof CLAUDE_ROOT_KINDS)[number], number>;
    nonObjectKinds: Record<ClaudeJsonKind, number>;
    nonStringTypeKinds: Record<ClaudeJsonKind, number>;
    systemSubtypes: Record<(typeof CLAUDE_SUBTYPE_KINDS)[number], number>;
    resultSubtypes: Record<(typeof CLAUDE_SUBTYPE_KINDS)[number], number>;
  };
  commandLifecycle: {
    total: number;
    states: Record<(typeof STATES)[number], number>;
    probeCorrelation: Record<(typeof CORRELATIONS)[number], number>;
  };
  /** Static categories only. Recognition is not frame validity or enabled mode. */
  categories: Partial<Record<ClaudeOutputCategory, Bucket>>;
}
// Worker generates canonical v4 probe UUIDs. This checks shape only, never authority.
export function isClaudeProbeUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

/** One preparation/attachment. No input references, native strings, IDs or hashes retained. */
export class ClaudeOutputCensus {
  private readonly counts = zeros(COUNTERS);
  private readonly structure: ClaudeOutputCensusSnapshot["structure"] = {
    roots: zeros(CLAUDE_ROOT_KINDS),
    nonObjectKinds: zeros(CLAUDE_JSON_KINDS),
    nonStringTypeKinds: zeros(CLAUDE_JSON_KINDS),
    systemSubtypes: zeros(CLAUDE_SUBTYPE_KINDS),
    resultSubtypes: zeros(CLAUDE_SUBTYPE_KINDS),
  };
  private readonly commandLifecycle: ClaudeOutputCensusSnapshot["commandLifecycle"] =
    {
      total: 0,
      states: zeros(STATES),
      probeCorrelation: zeros(CORRELATIONS),
    };
  private readonly buckets = new Map<ClaudeOutputCategory, Bucket>();
  private first: string | null = null;
  private last: string | null = null;
  private unavailable: ClaudeOutputCensusSnapshot["unavailableReason"] = null;

  observe(
    unit: ClaudeOutputUnit,
    reservedSessionId: string,
    probeCommandId: string | null = null,
  ): void {
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
      let category: ClaudeOutputCategory;
      if (unit.kind === "empty") {
        this.add("emptyUnits");
        category = "empty";
      } else if (unit.kind === "non_json") {
        this.add("nonJsonUnits");
        this.add("nonJsonDecodedUtf8Bytes", unit.decodedUtf8Bytes);
        category = "non_json";
      } else {
        this.add("validJsonUnits");
        const tag = decodeClaudeOutputTag(unit.value);
        increment(this.structure.roots, tag.kind);
        category = claudeOutputCategory(tag);
        if (tag.kind === "non_object") {
          this.add("nonObjectJsonUnits");
          increment(this.structure.nonObjectKinds, tag.valueKind);
        } else {
          this.add("jsonObjectUnits");
          if (tag.kind === "non_string_type")
            increment(this.structure.nonStringTypeKinds, tag.valueKind);
          if (
            tag.kind === "known_public_root" &&
            (tag.type === "system" || tag.type === "result")
          )
            increment(
              tag.type === "system"
                ? this.structure.systemSubtypes
                : this.structure.resultSubtypes,
              tag.subtype.kind,
            );
          if (category === "unknown" || category.endsWith("/unknown"))
            this.add("unknownDiscriminatorUnits");
          else this.add("recognizedDiscriminatorUnits");
          const frame = unit.value as Record<string, unknown>;
          if (hasClaudeRoot(tag, "command_lifecycle")) {
            increment(this.commandLifecycle, "total");
            const state = CLAUDE_COMMAND_LIFECYCLE_STATES.find(
              (x) => x === frame.state,
            );
            increment(
              this.commandLifecycle.states,
              state ?? "unknown_or_malformed",
            );
            // Neither side escapes this comparison. No field value, ID hash,
            // per-command row or native session is retained by this census.
            const commandId = frame.command_uuid;
            const correlation = !isClaudeProbeUuid(commandId)
              ? "missing_or_invalid"
              : probeCommandId === null
                ? "unavailable"
                : commandId === probeCommandId
                  ? "match"
                  : "mismatch";
            increment(this.commandLifecycle.probeCorrelation, correlation);
          }
          if (isClaudeInit(tag)) {
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
        increment(prior, "count");
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
      structure: structuredClone(this.structure),
      commandLifecycle: structuredClone(this.commandLifecycle),
      categories: Object.fromEntries(
        [...this.buckets].map(([key, value]) => [key, { ...value }]),
      ),
    };
  }
  private add(key: Counter, amount = 1): void {
    increment(this.counts, key, amount);
  }
}
function increment<K extends string>(
  record: Record<K, number>,
  key: K,
  amount = 1,
): void {
  if (
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    record[key] + amount > MAX_CLAUDE_CENSUS_COUNT
  )
    throw new RangeError();
  record[key] += amount;
}
