// Structural tags ONLY. No vendor runtime import, payload validation, origin
// proof, mode admission or readiness authority. Never return unreviewed strings.
// Public catalog: SDK 0.3.292 sdk.d.ts StdoutMessage (Claude 2.1.292).
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

// Source-reviewed raw native schema, NOT public SDK additions or enabled modes.
// Pinned binary segment-0080 ylo/co/CF; producers/mode gates in segment-1705.
// Evidence: docs/claude-protocol-schema-investigation.md N6/N7/N11.
export const CLAUDE_NATIVE_PRIVATE_ROOT_TYPES = [
  "command_lifecycle",
  "transcript_mirror",
  "autocompact_state",
] as const;
export const CLAUDE_NATIVE_PRIVATE_ROOT_CATALOG = {
  command_lifecycle: {
    rawNativeSchema: true,
    publicSdkSchema: false,
    qeInvocation: "local_stdio_source_supported",
  },
  transcript_mirror: {
    rawNativeSchema: true,
    publicSdkSchema: false,
    qeInvocation: "not_configured_session_mirror",
  },
  autocompact_state: {
    rawNativeSchema: true,
    publicSdkSchema: false,
    qeInvocation: "not_configured_remote_mode",
  },
} as const;
// Raw schema membership only; individual producer conditions/reachability under
// QE are NOT established by this list (including UI/peer/cloud/hook conditions).
export const CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES = [
  "code_change_published",
  "vcs_state_changed",
  "feedback_draft_queued",
  "ui_invalidate",
  "ui_log",
  "ui_toast",
  "ui_status",
  "cloud_session_delta",
  "dev_intent",
  "session_title_changed",
  "turn_handoff_available",
  "turn_preempted",
  "peer_message_hold",
  "per_turn_effort_changed",
  "permission_check_status",
  "ui_panes",
  "ui_scroll",
  "ui_focus",
  "instruction_size_warning",
  "file_attachments_missing",
  "post_turn_summary",
  "task_summary",
  "session_metadata",
] as const;
export const CLAUDE_NATIVE_PRIVATE_SYSTEM_REVIEW = {
  rawNativeSchema: true,
  publicSdkSchema: false,
  qeInvocation: "producer_conditions_not_established",
} as const;
// No additional result discriminator is established in the pinned raw schema.
export const CLAUDE_NATIVE_PRIVATE_RESULT_SUBTYPES = [] as const;
export const CLAUDE_COMMAND_LIFECYCLE_STATES = [
  "queued",
  "started",
  "completed",
  "cancelled",
  "discarded",
  "refused",
] as const;
export const CLAUDE_JSON_KINDS = [
  "null",
  "boolean",
  "number",
  "string",
  "array",
  "object",
  "not_json",
] as const;
export type ClaudeJsonKind = (typeof CLAUDE_JSON_KINDS)[number];
export const CLAUDE_ROOT_KINDS = [
  "non_object",
  "missing_type",
  "non_string_type",
  "known_public_root",
  "known_native_private_root",
  "unknown_string_root",
] as const;
export const CLAUDE_SUBTYPE_KINDS = [
  "missing_subtype",
  "non_string_subtype",
  "known_public_subtype",
  "known_native_private_subtype",
  "unknown_string_subtype",
] as const;

type PublicSimple = (typeof CLAUDE_OUTPUT_SIMPLE_TYPES)[number];
type PrivateRoot = (typeof CLAUDE_NATIVE_PRIVATE_ROOT_TYPES)[number];
type SubtypeTag<P extends string, N extends string> =
  | { kind: "missing_subtype" }
  | { kind: "non_string_subtype"; valueKind: ClaudeJsonKind }
  | { kind: "known_public_subtype"; value: P }
  | { kind: "known_native_private_subtype"; value: N }
  | { kind: "unknown_string_subtype" };
export type ClaudeOutputTag =
  | { kind: "non_object"; valueKind: ClaudeJsonKind }
  | { kind: "missing_type" }
  | { kind: "non_string_type"; valueKind: ClaudeJsonKind }
  | { kind: "unknown_string_root" }
  | { kind: "known_native_private_root"; type: PrivateRoot }
  | { kind: "known_public_root"; type: PublicSimple }
  | {
      kind: "known_public_root";
      type: "system";
      subtype: SubtypeTag<
        (typeof CLAUDE_OUTPUT_SYSTEM_SUBTYPES)[number],
        (typeof CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES)[number]
      >;
    }
  | {
      kind: "known_public_root";
      type: "result";
      subtype: SubtypeTag<
        (typeof CLAUDE_OUTPUT_RESULT_SUBTYPES)[number],
        (typeof CLAUDE_NATIVE_PRIVATE_RESULT_SUBTYPES)[number]
      >;
    };

export function claudeJsonKind(value: unknown): ClaudeJsonKind {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "boolean":
      return "boolean";
    case "number":
      return "number";
    case "string":
      return "string";
    case "object":
      return "object";
    default:
      return "not_json"; // Defensive for callers outside JSON.parse.
  }
}

function subtype<P extends string, N extends string>(
  frame: Record<string, unknown>,
  publicNames: readonly P[],
  privateNames: readonly N[],
): SubtypeTag<P, N> {
  if (!Object.hasOwn(frame, "subtype")) return { kind: "missing_subtype" };
  const value = frame.subtype;
  if (typeof value !== "string")
    return { kind: "non_string_subtype", valueKind: claudeJsonKind(value) };
  const publicName = publicNames.find((x) => x === value);
  if (publicName !== undefined)
    return { kind: "known_public_subtype", value: publicName };
  const privateName = privateNames.find((x) => x === value);
  if (privateName !== undefined)
    return { kind: "known_native_private_subtype", value: privateName };
  return { kind: "unknown_string_subtype" };
}

/** Already-parsed JSON only. Output contains fixed literals/kinds, never input references. */
export function decodeClaudeOutputTag(value: unknown): ClaudeOutputTag {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "non_object", valueKind: claudeJsonKind(value) };
  if (!Object.hasOwn(value, "type")) return { kind: "missing_type" };
  const frame = value as Record<string, unknown>,
    type = frame.type;
  if (typeof type !== "string")
    return { kind: "non_string_type", valueKind: claudeJsonKind(type) };
  if (type === "system")
    return {
      kind: "known_public_root",
      type: "system",
      subtype: subtype(
        frame,
        CLAUDE_OUTPUT_SYSTEM_SUBTYPES,
        CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES,
      ),
    };
  if (type === "result")
    return {
      kind: "known_public_root",
      type: "result",
      subtype: subtype(
        frame,
        CLAUDE_OUTPUT_RESULT_SUBTYPES,
        CLAUDE_NATIVE_PRIVATE_RESULT_SUBTYPES,
      ),
    };
  const publicName = CLAUDE_OUTPUT_SIMPLE_TYPES.find((x) => x === type);
  if (publicName !== undefined)
    return { kind: "known_public_root", type: publicName };
  const privateName = CLAUDE_NATIVE_PRIVATE_ROOT_TYPES.find((x) => x === type);
  if (privateName !== undefined)
    return { kind: "known_native_private_root", type: privateName };
  return { kind: "unknown_string_root" };
}

export function hasClaudeRoot(
  tag: ClaudeOutputTag,
  type: PublicSimple | PrivateRoot | "system" | "result",
): boolean {
  return (
    (tag.kind === "known_public_root" ||
      tag.kind === "known_native_private_root") &&
    tag.type === type
  );
}
export function isClaudeInit(tag: ClaudeOutputTag): boolean {
  return (
    tag.kind === "known_public_root" &&
    tag.type === "system" &&
    tag.subtype.kind === "known_public_subtype" &&
    tag.subtype.value === "init"
  );
}
export function isClaudeResultSuccess(tag: ClaudeOutputTag): boolean {
  return (
    tag.kind === "known_public_root" &&
    tag.type === "result" &&
    tag.subtype.kind === "known_public_subtype" &&
    tag.subtype.value === "success"
  );
}

export type ClaudeOutputCategory =
  | PublicSimple
  | PrivateRoot
  | `system/${(typeof CLAUDE_OUTPUT_SYSTEM_SUBTYPES)[number] | (typeof CLAUDE_NATIVE_PRIVATE_SYSTEM_SUBTYPES)[number] | "unknown"}`
  | `result/${(typeof CLAUDE_OUTPUT_RESULT_SUBTYPES)[number] | "unknown"}`
  | "unknown"
  | "non_object_json"
  | "non_json"
  | "empty";
export function claudeOutputCategory(
  tag: ClaudeOutputTag,
): ClaudeOutputCategory {
  if (tag.kind === "non_object") return "non_object_json";
  if (tag.kind === "known_native_private_root") return tag.type;
  if (tag.kind !== "known_public_root") return "unknown";
  if (tag.type === "system") {
    const s = tag.subtype;
    return s.kind === "known_public_subtype" ||
      s.kind === "known_native_private_subtype"
      ? `system/${s.value}`
      : "system/unknown";
  }
  if (tag.type === "result") {
    const s = tag.subtype;
    return s.kind === "known_public_subtype" ||
      s.kind === "known_native_private_subtype"
      ? `result/${s.value}`
      : "result/unknown";
  }
  return tag.type;
}
