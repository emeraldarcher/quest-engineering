import {
  SBX_CODING_EXECUTION_PROFILE_V1,
  SBX_CODING_PROFILE,
  type SbxExecutionProfile,
} from "./sbx-profile.ts";

export type CodingHarnessCapability = "pi" | "antigravity";

export interface ResolvedRunExecutionProfile {
  profile: SbxExecutionProfile;
  harnesses: readonly CodingHarnessCapability[];
}

/**
 * Resolve one immutable Run environment before physical creation. The first
 * composed profile deliberately contains both current coding harnesses, so a
 * later Step never switches/recreates the VM or installs a floating runtime.
 */
export function resolveRunExecutionProfile(
  requiredHarnesses: readonly string[],
): ResolvedRunExecutionProfile {
  const requested = [...new Set(requiredHarnesses)].sort();
  if (requested.length === 0)
    throw new Error("A coding Run must require at least one harness runtime.");
  const unsupported = requested.filter(
    (kind) => kind !== "pi" && kind !== "antigravity",
  );
  if (unsupported.length > 0)
    throw new Error(
      `No immutable execution profile provides: ${unsupported.join(", ")}.`,
    );
  return {
    profile: SBX_CODING_PROFILE,
    harnesses: ["antigravity", "pi"],
  };
}

export function profileSupportsHarness(
  profileId: string,
  harness: string,
): boolean {
  return (
    profileId === SBX_CODING_EXECUTION_PROFILE_V1.id &&
    (harness === "pi" || harness === "antigravity")
  );
}
