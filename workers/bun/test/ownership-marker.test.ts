import { expect, test } from "bun:test";
import {
  assertRunOwnershipMarkerV2,
  createOwnershipMarkerV2,
  decodeOwnershipMarkerV2,
  encodeOwnershipMarkerV2,
} from "../src/execution-environment/ownership-marker.ts";

const sandbox = {
  id: "00000000-0000-4000-8000-000000000321",
  name: "qe-run-marker-contract",
};
const record = {
  workerId: "worker-marker-contract",
  owner: { kind: "run" as const, runId: "run-marker-contract" },
  environmentId: sandbox.id,
  state: "running" as const,
  incarnation: "incarnation-marker-contract",
  profileId: "qe-claude-broker-run-v1",
  profileDigest: "sha256:profile-marker-contract",
  specDigest: "spec-marker-contract",
};
const expected = {
  workerId: record.workerId,
  runId: record.owner.runId,
  environmentId: sandbox.id,
  incarnation: record.incarnation,
  profileId: record.profileId,
  profileDigest: record.profileDigest,
};

function canonical() {
  return createOwnershipMarkerV2(record, sandbox);
}

function rejects(value: unknown, message?: string) {
  const decode = () => decodeOwnershipMarkerV2(value);
  if (message) expect(decode).toThrow(message);
  else expect(decode).toThrow();
}

test("production writer emits the one exact schema-v2 owner.runId shape", () => {
  const marker = canonical();
  expect(marker).toEqual({
    schemaVersion: 2,
    backendKind: "sbx",
    workerId: record.workerId,
    owner: { kind: "run", runId: record.owner.runId },
    environmentId: sandbox.id,
    displayName: sandbox.name,
    incarnation: record.incarnation,
    profileId: record.profileId,
    profileDigest: record.profileDigest,
    specDigest: record.specDigest,
  });
  expect(marker).not.toHaveProperty("runId");
});

test("production writer, encoder, strict decoder, and Run validator round trip", () => {
  const written = canonical();
  const decoded = decodeOwnershipMarkerV2(
    new TextEncoder().encode(encodeOwnershipMarkerV2(written)),
  );
  expect(decoded).toEqual(written);
  expect(() => assertRunOwnershipMarkerV2(decoded, expected)).not.toThrow();
});

test("strict schema-v2 decoder rejects missing owner and owner.runId", () => {
  const marker = canonical() as unknown as Record<string, unknown>;
  const { owner: _owner, ...missingOwner } = marker;
  rejects(missingOwner, "unexpected or missing fields");
  rejects(
    { ...marker, owner: { kind: "run" } },
    "unexpected or missing fields",
  );
  rejects(
    { ...marker, owner: { kind: "run", runId: 42 } },
    "must be a non-empty string",
  );
});

test("wrong nested Run identity fails exact authority validation", () => {
  const marker = decodeOwnershipMarkerV2({
    ...canonical(),
    owner: { kind: "run", runId: "run-forged" },
  });
  expect(() => assertRunOwnershipMarkerV2(marker, expected)).toThrow(
    "owner.runId",
  );
});

test("top-level runId-only accidental shape is rejected", () => {
  const { owner: _owner, ...marker } = canonical();
  rejects({ ...marker, runId: record.owner.runId });
});

test("forged top-level runId is rejected even when owner.runId is correct", () => {
  rejects({ ...canonical(), runId: "run-forged" }, "unexpected or missing");
});

test("correct Run ID cannot mask wrong environment or incarnation", () => {
  const wrongEnvironment = decodeOwnershipMarkerV2({
    ...canonical(),
    environmentId: "environment-forged",
  });
  expect(() => assertRunOwnershipMarkerV2(wrongEnvironment, expected)).toThrow(
    "environmentId",
  );

  const wrongIncarnation = decodeOwnershipMarkerV2({
    ...canonical(),
    incarnation: "incarnation-forged",
  });
  expect(() => assertRunOwnershipMarkerV2(wrongIncarnation, expected)).toThrow(
    "incarnation",
  );
});

test("missing, malformed, and unknown schema versions fail closed", () => {
  const marker = canonical() as unknown as Record<string, unknown>;
  const { schemaVersion: _schemaVersion, ...missing } = marker;
  rejects(missing);
  for (const schemaVersion of [1, 3, "2", null])
    rejects({ ...marker, schemaVersion }, "schema version is not 2");
});

test("old top-level Run ownership shape and duplicate owner fields fail closed", () => {
  const marker = canonical();
  rejects({
    schemaVersion: 1,
    backendKind: "sbx",
    workerId: marker.workerId,
    runId: record.owner.runId,
    environmentId: marker.environmentId,
    displayName: marker.displayName,
    incarnation: marker.incarnation,
    profileId: marker.profileId,
    profileDigest: marker.profileDigest,
    specDigest: marker.specDigest,
  });
  rejects({
    ...marker,
    owner: {
      kind: "run",
      runId: record.owner.runId,
      providerAccountId: "account-forged",
    },
  });
});

test("schema-v2 ProviderAccount owner remains exact and typed", () => {
  const marker = createOwnershipMarkerV2(
    {
      ...record,
      owner: {
        kind: "provider_account" as const,
        providerAccountId: "account-marker-contract",
        credentialGeneration: 2,
      },
    },
    sandbox,
  );
  expect(
    decodeOwnershipMarkerV2(encodeOwnershipMarkerV2(marker)).owner,
  ).toEqual({
    kind: "provider_account",
    providerAccountId: "account-marker-contract",
    credentialGeneration: 2,
  });
  rejects({
    ...marker,
    owner: {
      kind: "provider_account",
      providerAccountId: "account-marker-contract",
      credentialGeneration: 2,
      runId: "run-forged",
    },
  });
});
