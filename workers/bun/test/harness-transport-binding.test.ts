import { expect, test } from "bun:test";
import {
  nativeSessionRef,
  validateNativeSessionRef,
} from "../src/harnesses/native-session.ts";
import {
  MAX_HARNESS_TRANSPORT_BINDING_BYTES,
  parseTransportBinding,
  validateTransportBinding,
} from "../src/harnesses/transport-binding.ts";
import {
  OperationalExecutionError,
  operationalHarnessError,
  parseHarnessExecutionHandle,
  serializeHarnessExecutionHandle,
  validateHarnessExecutionHandle,
} from "../src/harnesses/types.ts";

const binding = {
  schemaVersion: 1 as const,
  harnessKind: "example-headless",
  kind: "remote-job",
  payload: { job: "opaque-job-id", generation: 2 },
};

test("opaque harness transport bindings round-trip only for their owning adapter", () => {
  expect(
    parseTransportBinding(JSON.stringify(binding), "example-headless"),
  ).toEqual(binding);
  expect(() => validateTransportBinding(binding, "another-harness")).toThrow(
    "belongs to another harness",
  );
});

test("provider-neutral execution handles validate identity without requiring transport", () => {
  const handle = {
    schemaVersion: 1 as const,
    harnessKind: "example-headless",
    executionId: "remote-execution-1",
  };
  expect(
    validateHarnessExecutionHandle(
      handle,
      "example-headless",
      "remote-execution-1",
    ),
  ).toEqual(handle);
  expect(() =>
    validateHarnessExecutionHandle(handle, "another-harness"),
  ).toThrow("ownership is invalid");
  expect(() =>
    validateHarnessExecutionHandle({ ...handle, paneId: "not-generic" }),
  ).toThrow("unexpected fields");
});

test("persisted execution handles contain only generic identity", () => {
  const handle = {
    schemaVersion: 1 as const,
    harnessKind: "example-headless",
    executionId: "remote-execution-1",
    transportBinding: binding,
    nativeSession: nativeSessionRef("example-headless", "id", "native-job-1"),
  };
  const serialized = serializeHarnessExecutionHandle(
    handle,
    "example-headless",
    "remote-execution-1",
  );
  expect(JSON.parse(serialized)).toEqual({
    schemaVersion: 1,
    harnessKind: "example-headless",
    executionId: "remote-execution-1",
  });
  expect(
    parseHarnessExecutionHandle(
      serialized,
      "example-headless",
      "remote-execution-1",
    ),
  ).toEqual({
    schemaVersion: 1,
    harnessKind: "example-headless",
    executionId: "remote-execution-1",
  });
  expect(() =>
    parseHarnessExecutionHandle(
      JSON.stringify(handle),
      "example-headless",
      "remote-execution-1",
    ),
  ).toThrow("unexpected fields");
});

test("native session references are strict, opaque, and harness-owned", () => {
  const session = nativeSessionRef("example-headless", "id", "native-job-1");
  expect(validateNativeSessionRef(session, "example-headless")).toEqual(
    session,
  );
  expect(() => validateNativeSessionRef(session, "another-harness")).toThrow(
    "belongs to another harness",
  );
  expect(() =>
    validateNativeSessionRef({ ...session, provider: "must-not-leak" }),
  ).toThrow("schema is invalid");
});

test("operational boundaries complete typed outcomes from adapter errors", () => {
  const classified = operationalHarnessError(
    new OperationalExecutionError(
      "The backend contract is incompatible.",
      "terminal_not_recoverable",
      "backend_incompatible",
      { contract: "agent.prompt" },
    ),
    "prepare",
  );
  expect(classified).toMatchObject({
    classification: "terminal_not_recoverable",
    code: "backend_incompatible",
    evidence: { contract: "agent.prompt" },
    phase: "prepare",
    sideEffectCertainty: "not_submitted",
  });
  expect(
    operationalHarnessError(
      new OperationalExecutionError(
        "Submission acknowledgement is ambiguous.",
        "uncertain",
        "custom_submit_uncertain",
      ),
      "prepare",
    ),
  ).toMatchObject({
    phase: "prepare",
    sideEffectCertainty: "ambiguous",
  });
});

test("opaque harness transport bindings reject unknown versions, fields, and oversized payloads", () => {
  expect(() =>
    validateTransportBinding({ ...binding, schemaVersion: 2 }),
  ).toThrow("schema version is unsupported");
  expect(() =>
    validateTransportBinding({ ...binding, providerSecret: "not allowed" }),
  ).toThrow("unexpected fields");
  expect(() =>
    parseTransportBinding(
      JSON.stringify({
        ...binding,
        payload: { value: "x".repeat(MAX_HARNESS_TRANSPORT_BINDING_BYTES) },
      }),
      "example-headless",
    ),
  ).toThrow("exceeds the size limit");
});
