import type { EnvironmentOwner, EnvironmentRef } from "./types.ts";
import { EnvironmentBackendError } from "./types.ts";

export function copyEnvironmentOwner(
  owner: EnvironmentOwner,
): EnvironmentOwner {
  return structuredClone(owner);
}

export function environmentOwnerKey(owner: EnvironmentOwner): string {
  return owner.kind === "run"
    ? `run\0${owner.runId}`
    : `provider_account\0${owner.providerAccountId}\0${owner.credentialGeneration}`;
}

export function environmentOwnerId(owner: EnvironmentOwner): string {
  return owner.kind === "run" ? owner.runId : owner.providerAccountId;
}

export function environmentOwnerGeneration(
  owner: EnvironmentOwner,
): number | null {
  return owner.kind === "provider_account" ? owner.credentialGeneration : null;
}

export function environmentOwnerLabel(owner: EnvironmentOwner): string {
  return owner.kind === "run"
    ? `Run ${owner.runId}`
    : `ProviderAccount ${owner.providerAccountId} generation ${owner.credentialGeneration}`;
}

export function sameEnvironmentOwner(
  left: EnvironmentOwner,
  right: EnvironmentOwner,
): boolean {
  return environmentOwnerKey(left) === environmentOwnerKey(right);
}

export function runOwner(
  runId: string,
): Extract<EnvironmentOwner, { kind: "run" }> {
  return { kind: "run", runId };
}

export function providerAccountOwner(
  providerAccountId: string,
  credentialGeneration: number,
): Extract<EnvironmentOwner, { kind: "provider_account" }> {
  return { kind: "provider_account", providerAccountId, credentialGeneration };
}

export function runIdFromRef(ref: EnvironmentRef): string {
  if (ref.owner?.kind === "run") return ref.owner.runId;
  // Compatibility for persisted pre-v15 harness test fixtures only. Current
  // constructors and protocol records always emit typed ownership.
  const legacyRunId = (ref as EnvironmentRef & { runId?: unknown }).runId;
  if (typeof legacyRunId === "string" && legacyRunId.length > 0)
    return legacyRunId;
  throw new EnvironmentBackendError(
    "invalid_environment_ref",
    "A Run-owned environment was required.",
  );
}

export function validateEnvironmentOwner(owner: EnvironmentOwner): void {
  if (owner.kind === "run") {
    if (!owner.runId)
      throw new EnvironmentBackendError(
        "invalid_environment_spec",
        "owner.runId is required.",
      );
    return;
  }
  if (
    owner.kind !== "provider_account" ||
    !owner.providerAccountId ||
    !Number.isSafeInteger(owner.credentialGeneration) ||
    owner.credentialGeneration < 1
  )
    throw new EnvironmentBackendError(
      "invalid_environment_spec",
      "ProviderAccount ownership requires an ID and positive credential generation.",
    );
}
