import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import { SBX_PI_EXECUTION_PROFILE_V2 } from "../src/execution-environment/sbx-profile.ts";
import { SbxRunExecutionManager } from "../src/execution-environment/sbx-run.ts";
import {
  ACCOUNT_AVAILABILITY_SCHEMA_VERSION,
  ACCOUNT_AVAILABILITY_TTL_MS,
  AccountAvailabilityEvidenceStore,
  newAccountAvailabilityEvidence,
} from "../src/harnesses/account-availability.ts";
import type { HarnessModelCapability } from "../src/harnesses/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const context = {
  accountScope: "a".repeat(64),
  authGeneration: "b".repeat(64),
  profileId: "qe-pi-execution-v2",
  profileDigest: `sha256:${"c".repeat(64)}`,
};
const models: HarnessModelCapability[] = [
  model("gpt-5.3-codex-spark"),
  model("gpt-5.6-sol"),
  model("gpt-5.6-luna"),
];

test("direct evidence independently annotates available, unavailable, and unknown models", async () => {
  const { store, path } = await evidenceStore();
  const observed = new Date("2026-09-22T00:00:00.000Z");
  await store.record(
    newAccountAvailabilityEvidence(
      context,
      { provider: "openai-codex", model: "gpt-5.6-sol" },
      "verified_available",
      "preserved_execution_success",
      observed,
    ),
  );
  await store.record(
    newAccountAvailabilityEvidence(
      context,
      { provider: "openai-codex", model: "gpt-5.3-codex-spark" },
      "verified_unavailable",
      "preserved_provider_rejection",
      observed,
    ),
  );

  const annotated = await store.annotate(
    models,
    context,
    new Date("2026-09-22T00:01:00.000Z"),
  );
  expect(states(annotated)).toEqual({
    "gpt-5.3-codex-spark": "verified_unavailable",
    "gpt-5.6-luna": "unknown",
    "gpt-5.6-sol": "verified_available",
  });
  const persisted = JSON.parse(await readFile(path, "utf8"));
  expect(persisted.schemaVersion).toBe(ACCOUNT_AVAILABILITY_SCHEMA_VERSION);
  expect(persisted.records).toHaveLength(2);
});

test("evidence is invalidated by account, auth generation, profile generation, expiry, and explicit recheck", async () => {
  const { store } = await evidenceStore();
  const observed = new Date("2026-09-22T00:00:00.000Z");
  await store.record(
    newAccountAvailabilityEvidence(
      context,
      { provider: "openai-codex", model: "gpt-5.6-sol" },
      "verified_available",
      "direct_execution_success",
      observed,
    ),
  );
  const now = new Date("2026-09-22T00:01:00.000Z");
  for (const changed of [
    { ...context, accountScope: "d".repeat(64) },
    { ...context, authGeneration: "d".repeat(64) },
    { ...context, profileId: "qe-pi-execution-v3" },
    { ...context, profileDigest: `sha256:${"d".repeat(64)}` },
  ]) {
    expect(
      (await store.annotate(models, changed, now))[1]?.accountAvailability,
    ).toBe("unknown");
  }
  expect(
    (
      await store.annotate(
        models,
        context,
        new Date(observed.getTime() + ACCOUNT_AVAILABILITY_TTL_MS + 1),
      )
    )[1]?.accountAvailability,
  ).toBe("unknown");

  await store.record(
    newAccountAvailabilityEvidence(
      context,
      { provider: "openai-codex", model: "gpt-5.6-sol" },
      "verified_available",
      "direct_execution_success",
      new Date("2026-09-23T00:00:00.000Z"),
    ),
  );
  await store.recheck(context, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  });
  expect(
    (
      await store.annotate(
        models,
        context,
        new Date("2026-09-23T00:01:00.000Z"),
      )
    )[1]?.accountAvailability,
  ).toBe("unknown");
});

test("production SBX discovery publishes runtime models with evidence annotations before optional QE scope", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "account-discovery-"));
  roots.push(root);
  const seedPath = join(root, "seed.json");
  const productionContext = {
    ...context,
    profileId: SBX_PI_EXECUTION_PROFILE_V2.id,
    profileDigest: SBX_PI_EXECUTION_PROFILE_V2.digest,
  };
  await writeFile(
    seedPath,
    JSON.stringify({
      schemaVersion: ACCOUNT_AVAILABILITY_SCHEMA_VERSION,
      records: [
        newAccountAvailabilityEvidence(
          productionContext,
          { provider: "openai-codex", model: "gpt-5.6-sol" },
          "verified_available",
          "preserved_execution_success",
          new Date("2026-09-22T00:00:00.000Z"),
        ),
        newAccountAvailabilityEvidence(
          productionContext,
          { provider: "openai-codex", model: "gpt-5.3-codex-spark" },
          "verified_unavailable",
          "preserved_provider_rejection",
          new Date("2026-09-22T00:00:00.000Z"),
        ),
      ],
    }),
  );
  let removed = false;
  const backend = {
    ensure: async () => ({
      ref: { environmentId: "discovery" },
      paths: { workspace: "/qe/workspaces/discovery" },
      exec: async () => ({
        exitCode: 0,
        stderr: "",
        stdout: `${JSON.stringify({
          schemaVersion: 3,
          authenticated: true,
          accountScope: productionContext.accountScope,
          authGeneration: productionContext.authGeneration,
          metadata: {
            authority: "advisory",
            conclusive: false,
            status: 200,
            observedAt: "2026-09-22T00:00:00.000Z",
            modelCount: 0,
          },
          diagnostics: ["empty advisory metadata"],
          models: [
            discoveredModel("gpt-5.3-codex-spark"),
            discoveredModel("gpt-5.6-sol"),
            discoveredModel("gpt-5.6-luna"),
          ],
        })}\n`,
      }),
    }),
    remove: async () => {
      removed = true;
    },
    close: () => undefined,
  };
  const config = {
    workerId: "account-discovery-worker",
    dataRoot: root,
    piAccountEvidenceSeedPaths: [seedPath],
  } as unknown as WorkerConfig;
  const manager = new SbxRunExecutionManager(config, {} as never, {
    backend: backend as never,
  });
  try {
    const catalog = await manager.discover();
    expect(states(catalog.models)).toEqual({
      "gpt-5.3-codex-spark": "verified_unavailable",
      "gpt-5.6-luna": "unknown",
      "gpt-5.6-sol": "verified_available",
    });
    expect(catalog.metadata).toMatchObject({
      authority: "advisory",
      conclusive: false,
      modelCount: 0,
    });
    expect(removed).toBe(true);
  } finally {
    await manager.close();
  }
});

test("seed imports require exact bounded evidence and latest direct observation wins", async () => {
  const { root, store } = await evidenceStore();
  const seedPath = join(root, "seed.json");
  const first = newAccountAvailabilityEvidence(
    context,
    { provider: "openai-codex", model: "gpt-5.6-sol" },
    "verified_available",
    "preserved_execution_success",
    new Date("2026-09-22T00:00:00.000Z"),
  );
  const second = newAccountAvailabilityEvidence(
    context,
    { provider: "openai-codex", model: "gpt-5.6-sol" },
    "verified_unavailable",
    "preserved_provider_rejection",
    new Date("2026-09-22T01:00:00.000Z"),
  );
  await writeFile(
    seedPath,
    JSON.stringify({
      schemaVersion: ACCOUNT_AVAILABILITY_SCHEMA_VERSION,
      records: [first, second],
    }),
  );
  await store.importFile(seedPath);
  expect(
    (
      await store.annotate(
        models,
        context,
        new Date("2026-09-22T01:01:00.000Z"),
      )
    )[1]?.accountAvailability,
  ).toBe("verified_unavailable");
  await store.record(first);
  expect(
    (
      await store.annotate(
        models,
        context,
        new Date("2026-09-22T01:01:00.000Z"),
      )
    )[1]?.accountAvailability,
  ).toBe("verified_unavailable");

  await writeFile(
    seedPath,
    JSON.stringify({
      schemaVersion: ACCOUNT_AVAILABILITY_SCHEMA_VERSION,
      records: [{ ...first, expiresAt: "2099-01-01T00:00:00.000Z" }],
    }),
  );
  await expect(store.importFile(seedPath)).rejects.toThrow("lifetime");
});

function discoveredModel(id: string) {
  return {
    provider: "openai-codex",
    model: id,
    displayName: id,
    accountAvailability: "unknown",
    reasoning: ["medium"],
  };
}

function model(id: string): HarnessModelCapability {
  return {
    provider: "openai-codex",
    model: id,
    displayName: id,
    accountAvailability: "unknown",
    reasoningCapability: { kind: "enumerated", values: ["medium"] },
  };
}

function states(values: HarnessModelCapability[]): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => [value.model, value.accountAvailability]),
  );
}

async function evidenceStore(): Promise<{
  root: string;
  path: string;
  store: AccountAvailabilityEvidenceStore;
}> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "account-availability-"));
  roots.push(root);
  const path = join(root, "evidence.json");
  return { root, path, store: new AccountAvailabilityEvidenceStore(path) };
}
