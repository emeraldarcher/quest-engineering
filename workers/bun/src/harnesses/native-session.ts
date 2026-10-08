export const NATIVE_SESSION_SCHEMA_VERSION = 1 as const;
export const MAX_NATIVE_SESSION_REF_BYTES = 12 * 1024;
const MAX_NATIVE_SESSION_ID_BYTES = 8 * 1024;

/**
 * Harness-owned native continuation identity. Product and generic Worker
 * orchestration retain it opaquely; only the owning adapter interprets it.
 */
export interface NativeSessionRef {
  schemaVersion: typeof NATIVE_SESSION_SCHEMA_VERSION;
  harnessKind: string;
  payload: {
    identityKind: "id" | "path";
    opaqueId: string;
  };
}

export function nativeSessionRef(
  harnessKind: string,
  identityKind: "id" | "path",
  opaqueId: string,
): NativeSessionRef {
  return validateNativeSessionRef({
    schemaVersion: NATIVE_SESSION_SCHEMA_VERSION,
    harnessKind,
    payload: { identityKind, opaqueId },
  });
}

export function validateNativeSessionRef(
  value: unknown,
  expectedHarnessKind?: string,
): NativeSessionRef {
  if (
    !record(value) ||
    !hasExactKeys(value, ["schemaVersion", "harnessKind", "payload"]) ||
    value.schemaVersion !== NATIVE_SESSION_SCHEMA_VERSION
  )
    throw new Error("Native session identity schema is invalid.");
  if (
    typeof value.harnessKind !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/.test(value.harnessKind) ||
    (expectedHarnessKind && value.harnessKind !== expectedHarnessKind)
  )
    throw new Error("Native session identity belongs to another harness.");
  if (
    !record(value.payload) ||
    !hasExactKeys(value.payload, ["identityKind", "opaqueId"]) ||
    !["id", "path"].includes(String(value.payload.identityKind)) ||
    typeof value.payload.opaqueId !== "string" ||
    value.payload.opaqueId.length === 0 ||
    Buffer.byteLength(value.payload.opaqueId, "utf8") >
      MAX_NATIVE_SESSION_ID_BYTES
  )
    throw new Error("Native session identity payload is invalid.");
  return value as unknown as NativeSessionRef;
}

export function serializeNativeSessionRef(
  value: NativeSessionRef | null,
  expectedHarnessKind: string,
): string | null {
  if (!value) return null;
  return JSON.stringify(validateNativeSessionRef(value, expectedHarnessKind));
}

export function parseNativeSessionRef(
  serialized: string | null,
  expectedHarnessKind: string,
): NativeSessionRef | null {
  if (!serialized) return null;
  if (Buffer.byteLength(serialized, "utf8") > MAX_NATIVE_SESSION_REF_BYTES)
    throw new Error(
      "Persisted native session identity exceeds the size limit.",
    );
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Persisted native session identity is malformed.");
  }
  return validateNativeSessionRef(value, expectedHarnessKind);
}

export function nativeSessionIdentity(
  value: NativeSessionRef,
  expectedHarnessKind: string,
): { identityKind: "id" | "path"; opaqueId: string } {
  return validateNativeSessionRef(value, expectedHarnessKind).payload;
}

/** Safe Product-facing ID; path-backed identities intentionally remain private. */
export function nativeSessionPublicId(
  value: NativeSessionRef | null | undefined,
): string | null {
  if (!value) return null;
  const valid = validateNativeSessionRef(value);
  return valid.payload.identityKind === "id" ? valid.payload.opaqueId : null;
}

export function sameNativeSession(
  left: NativeSessionRef | null | undefined,
  right: NativeSessionRef | null | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.schemaVersion === right.schemaVersion &&
      left.harnessKind === right.harnessKind &&
      left.payload.identityKind === right.payload.identityKind &&
      left.payload.opaqueId === right.payload.opaqueId,
  );
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
