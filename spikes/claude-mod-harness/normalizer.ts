/**
 * Minimal structural fixtures for the current generic QE NativeSessionRef,
 * HarnessInspection, and HarnessEvent contracts. They are intentionally local
 * so the spike compiles only against Claude's generated Mod declarations.
 */
export interface FixtureNativeSessionRef {
  schemaVersion: 1;
  harnessKind: "claude-code";
  payload: { identityKind: "id"; opaqueId: string };
}

export type FixtureHarnessInspection = Readonly<Record<string, unknown>>;

export type FixtureHarnessEvent =
  | {
      type: "prompt_accepted";
      acceptedAt: string;
      inspection: FixtureHarnessInspection;
    }
  | {
      type:
        | "native_activity"
        | "structured_result_received"
        | "provider_turn_settled"
        | "native_idle";
      observedAt: string;
      inspection: FixtureHarnessInspection;
    }
  | { type: "inspection"; inspection: FixtureHarnessInspection };

/**
 * Provider-native facts that the future adapter would receive from stream-json
 * and the Mod. The fixture deliberately maps only into today's generic QE
 * HarnessEvent vocabulary; semantic authority remains in the control bridge.
 */
export type ClaudeHarnessObservation =
  | { kind: "prompt_accepted"; observedAt: string }
  | {
      kind: "native_activity";
      source: "turn_start" | "turn_step" | "tool_call";
      observedAt: string;
    }
  | { kind: "human_attention_changed"; observedAt: string }
  | { kind: "structured_result_received"; observedAt: string }
  | { kind: "turn_complete"; observedAt: string };

/** Build an opaque continuation reference directly from Claude's session id. */
export function claudeNativeSessionRef(
  sessionId: string,
): FixtureNativeSessionRef {
  if (sessionId.length === 0) throw new Error("Claude session id is empty.");
  return {
    schemaVersion: 1,
    harnessKind: "claude-code",
    payload: { identityKind: "id", opaqueId: sessionId },
  };
}

/** Deterministic provider-to-generic event normalization with no terminal id. */
export function normalizeClaudeObservation(
  observation: ClaudeHarnessObservation,
  inspection: FixtureHarnessInspection,
): readonly FixtureHarnessEvent[] {
  switch (observation.kind) {
    case "prompt_accepted":
      return [
        {
          type: "prompt_accepted",
          acceptedAt: observation.observedAt,
          inspection,
        },
      ];
    case "native_activity":
      return [
        {
          type: "native_activity",
          observedAt: observation.observedAt,
          inspection,
        },
      ];
    case "human_attention_changed":
      return [{ type: "inspection", inspection }];
    case "structured_result_received":
      return [
        {
          type: "structured_result_received",
          observedAt: observation.observedAt,
          inspection,
        },
      ];
    case "turn_complete":
      return [
        {
          type: "provider_turn_settled",
          observedAt: observation.observedAt,
          inspection,
        },
        {
          type: "native_idle",
          observedAt: observation.observedAt,
          inspection,
        },
      ];
  }
}
