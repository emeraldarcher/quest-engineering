import { createHash } from "node:crypto";
import type { SbxSandboxSummary } from "./sbx-client.ts";
import type { DurableEnvironmentRecord } from "./store.ts";
import type { EnvironmentOwner } from "./types.ts";
import { EnvironmentBackendError } from "./types.ts";

export const OWNERSHIP_MARKER_SCHEMA_VERSION = 2 as const;

export interface OwnershipMarkerV2 {
  schemaVersion: typeof OWNERSHIP_MARKER_SCHEMA_VERSION;
  backendKind: "sbx";
  workerId: string;
  owner: EnvironmentOwner;
  environmentId: string;
  displayName: string;
  incarnation: string;
  profileId: string;
  profileDigest: string;
  specDigest: string;
}

export interface RunOwnershipExpectationV2 {
  workerId: string;
  runId: string;
  environmentId: string;
  incarnation: string;
  profileId: string;
  profileDigest: string;
}

const MARKER_FIELDS = [
  "backendKind",
  "displayName",
  "environmentId",
  "incarnation",
  "owner",
  "profileDigest",
  "profileId",
  "schemaVersion",
  "specDigest",
  "workerId",
] as const;
const RUN_OWNER_FIELDS = ["kind", "runId"] as const;
const PROVIDER_ACCOUNT_OWNER_FIELDS = [
  "credentialGeneration",
  "kind",
  "providerAccountId",
] as const;

/** Builds the one canonical schema-v2 ownership marker emitted by SBX. */
export function createOwnershipMarkerV2(
  record: Pick<
    DurableEnvironmentRecord,
    | "workerId"
    | "owner"
    | "environmentId"
    | "state"
    | "incarnation"
    | "profileId"
    | "profileDigest"
    | "specDigest"
  >,
  sandbox: Pick<SbxSandboxSummary, "id" | "name">,
): OwnershipMarkerV2 {
  if (!record.environmentId && record.state !== "creating")
    throw invalid("Durable environment record has no physical ID.");
  return {
    schemaVersion: OWNERSHIP_MARKER_SCHEMA_VERSION,
    backendKind: "sbx",
    workerId: record.workerId,
    owner: structuredClone(record.owner),
    environmentId: sandbox.id,
    displayName: sandbox.name,
    incarnation: record.incarnation,
    profileId: record.profileId,
    profileDigest: record.profileDigest,
    specDigest: record.specDigest,
  };
}

export function encodeOwnershipMarkerV2(marker: OwnershipMarkerV2): string {
  return JSON.stringify(marker);
}

/** Strictly decodes the current marker contract. No legacy shape is accepted. */
export function decodeOwnershipMarkerV2(value: unknown): OwnershipMarkerV2 {
  const marker = object(
    parseJson(value, "ownership marker"),
    "ownership marker",
  );
  exactFields(marker, MARKER_FIELDS, "ownership marker");
  if (marker.schemaVersion !== OWNERSHIP_MARKER_SCHEMA_VERSION)
    throw invalid("Ownership marker schema version is not 2.");
  if (marker.backendKind !== "sbx")
    throw invalid("Ownership marker backend kind is not sbx.");
  const owner = decodeOwner(marker.owner);
  return {
    schemaVersion: OWNERSHIP_MARKER_SCHEMA_VERSION,
    backendKind: "sbx",
    workerId: text(marker.workerId, "ownership marker.workerId"),
    owner,
    environmentId: text(marker.environmentId, "ownership marker.environmentId"),
    displayName: text(marker.displayName, "ownership marker.displayName"),
    incarnation: text(marker.incarnation, "ownership marker.incarnation"),
    profileId: text(marker.profileId, "ownership marker.profileId"),
    profileDigest: text(marker.profileDigest, "ownership marker.profileDigest"),
    specDigest: text(marker.specDigest, "ownership marker.specDigest"),
  };
}

export function mismatchedRunOwnershipMarkerFieldsV2(
  marker: OwnershipMarkerV2,
  expected: RunOwnershipExpectationV2,
): string[] {
  const observedRunId = marker.owner.kind === "run" ? marker.owner.runId : null;
  return [
    ["workerId", marker.workerId, expected.workerId],
    ["owner.runId", observedRunId, expected.runId],
    ["environmentId", marker.environmentId, expected.environmentId],
    ["incarnation", marker.incarnation, expected.incarnation],
    ["profileId", marker.profileId, expected.profileId],
    ["profileDigest", marker.profileDigest, expected.profileDigest],
  ]
    .filter(([, observed, authoritative]) => observed !== authoritative)
    .map(([field]) => field as string);
}

export function assertRunOwnershipMarkerV2(
  marker: OwnershipMarkerV2,
  expected: RunOwnershipExpectationV2,
): void {
  const mismatches = mismatchedRunOwnershipMarkerFieldsV2(marker, expected);
  if (mismatches.length > 0)
    throw invalid(
      `Ownership marker does not match authoritative Run fields: ${mismatches.join(", ")}.`,
    );
}

export function sameOwnershipMarkerV2(
  left: OwnershipMarkerV2,
  right: OwnershipMarkerV2,
): boolean {
  return encodeOwnershipMarkerV2(left) === encodeOwnershipMarkerV2(right);
}

export function ownershipMarkerV2Digest(marker: OwnershipMarkerV2): string {
  return createHash("sha256")
    .update(encodeOwnershipMarkerV2(marker))
    .digest("hex");
}

function decodeOwner(value: unknown): EnvironmentOwner {
  const owner = object(value, "ownership marker.owner");
  if (owner.kind === "run") {
    exactFields(owner, RUN_OWNER_FIELDS, "ownership marker.owner");
    return {
      kind: "run",
      runId: text(owner.runId, "ownership marker.owner.runId"),
    };
  }
  if (owner.kind === "provider_account") {
    exactFields(owner, PROVIDER_ACCOUNT_OWNER_FIELDS, "ownership marker.owner");
    return {
      kind: "provider_account",
      providerAccountId: text(
        owner.providerAccountId,
        "ownership marker.owner.providerAccountId",
      ),
      credentialGeneration: positiveInteger(
        owner.credentialGeneration,
        "ownership marker.owner.credentialGeneration",
      ),
    };
  }
  throw invalid("Ownership marker owner kind is invalid.");
}

function parseJson(value: unknown, label: string): unknown {
  if (value instanceof Uint8Array) {
    try {
      value = new TextDecoder("utf-8", { fatal: true }).decode(value);
    } catch {
      throw invalid(`${label} is not valid UTF-8.`);
    }
  }
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalid(`${label} is not valid JSON.`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw invalid(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  fields: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (
    actual.length !== expected.length ||
    actual.some((field, index) => field !== expected[index])
  )
    throw invalid(`${label} has unexpected or missing fields.`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0)
    throw invalid(`${label} must be a non-empty string.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw invalid(`${label} must be a positive integer.`);
  return value as number;
}

function invalid(message: string): EnvironmentBackendError {
  return new EnvironmentBackendError("environment_identity_mismatch", message);
}
