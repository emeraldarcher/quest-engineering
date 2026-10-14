import {
  SBX_CLAUDE_BROKER_RUN_PROFILE,
  SBX_CLAUDE_BROKER_RUN_PROFILE_V1,
  SBX_CODING_EXECUTION_PROFILE_V3,
  SBX_CODING_PROFILE,
  type SbxExecutionProfile,
} from "./sbx-profile.ts";

export type CodingHarnessCapability =
  | "pi"
  | "antigravity"
  | "claude_agent_sdk"
  | "claude_code";

export interface ResolvedRunExecutionProfile {
  profile: SbxExecutionProfile;
  harnesses: readonly CodingHarnessCapability[];
}

/**
 * Resolve one immutable Run environment before physical creation. The current
 * composed profile deliberately contains every production coding harness, so
 * a later Step never switches/recreates the VM or installs a floating runtime.
 */
export function resolveRunExecutionProfile(
  requiredHarnesses: readonly string[],
): ResolvedRunExecutionProfile {
  const requested = [...new Set(requiredHarnesses)].sort();
  if (requested.length === 0)
    throw new Error("A coding Run must require at least one harness runtime.");
  const supported = new Set([
    "pi",
    "antigravity",
    "claude_agent_sdk",
    "claude_code",
  ]);
  const unsupported = requested.filter((kind) => !supported.has(kind));
  if (unsupported.length > 0)
    throw new Error(
      `No immutable execution profile provides: ${unsupported.join(", ")}.`,
    );
  if (requested.includes("claude_code")) {
    if (requested.length !== 1)
      throw new Error(
        "The credential-free Claude Code Run profile cannot be combined with credential-bearing Run harnesses.",
      );
    return {
      profile: SBX_CLAUDE_BROKER_RUN_PROFILE,
      harnesses: ["claude_code"],
    };
  }
  return {
    profile: SBX_CODING_PROFILE,
    harnesses: ["antigravity", "claude_agent_sdk", "pi"],
  };
}

export function profileSupportsHarness(
  profileId: string,
  harness: string,
): boolean {
  return (
    (profileId === SBX_CODING_EXECUTION_PROFILE_V3.id &&
      (harness === "pi" ||
        harness === "antigravity" ||
        harness === "claude_agent_sdk")) ||
    (profileId === SBX_CLAUDE_BROKER_RUN_PROFILE_V1.id &&
      harness === "claude_code")
  );
}
