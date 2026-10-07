import type { JsonValue } from "../protocol/types.ts";

export const HARNESS_TRANSPORT_BINDING_SCHEMA_VERSION = 1 as const;
export const MAX_HARNESS_TRANSPORT_BINDING_BYTES = 32 * 1024;

/**
 * Persisted adapter-owned transport state. Generic orchestration may retain and
 * return this value to its owning harness, but must not interpret the payload.
 */
export interface HarnessTransportBinding {
  schemaVersion: typeof HARNESS_TRANSPORT_BINDING_SCHEMA_VERSION;
  harnessKind: string;
  kind: string;
  payload: Record<string, JsonValue>;
}

export function validateTransportBinding(
  value: unknown,
  expectedHarnessKind?: string,
): HarnessTransportBinding {
  if (!isRecord(value))
    throw new Error("Harness transport binding must be an object.");
  if (!hasExactKeys(value, ["schemaVersion", "harnessKind", "kind", "payload"]))
    throw new Error("Harness transport binding has unexpected fields.");
  if (value.schemaVersion !== HARNESS_TRANSPORT_BINDING_SCHEMA_VERSION)
    throw new Error("Harness transport binding schema version is unsupported.");
  if (!safeToken(value.harnessKind) || !safeToken(value.kind))
    throw new Error("Harness transport binding ownership is invalid.");
  if (expectedHarnessKind && value.harnessKind !== expectedHarnessKind)
    throw new Error("Harness transport binding belongs to another harness.");
  if (!isRecord(value.payload) || !isJsonValue(value.payload))
    throw new Error("Harness transport binding payload is invalid.");
  const serialized = JSON.stringify(value);
  if (
    Buffer.byteLength(serialized, "utf8") > MAX_HARNESS_TRANSPORT_BINDING_BYTES
  )
    throw new Error(
      "Harness transport binding exceeds the durable size limit.",
    );
  return value as unknown as HarnessTransportBinding;
}

export function serializeTransportBinding(
  binding: HarnessTransportBinding | null,
  expectedHarnessKind: string,
): string | null {
  if (!binding) return null;
  return JSON.stringify(validateTransportBinding(binding, expectedHarnessKind));
}

export function parseTransportBinding(
  serialized: string | null,
  expectedHarnessKind: string,
): HarnessTransportBinding | null {
  if (!serialized) return null;
  if (
    Buffer.byteLength(serialized, "utf8") > MAX_HARNESS_TRANSPORT_BINDING_BYTES
  )
    throw new Error(
      "Persisted harness transport binding exceeds the size limit.",
    );
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Persisted harness transport binding is malformed.");
  }
  return validateTransportBinding(value, expectedHarnessKind);
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

function safeToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-zA-Z0-9._:-]+$/.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 16) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return (
      value.length <= 512 && value.every((item) => isJsonValue(item, depth + 1))
    );
  if (!isRecord(value) || Object.keys(value).length > 128) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
}
