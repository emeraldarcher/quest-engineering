import { afterEach, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { workerCapabilities } from "../src/capabilities.ts";
import { loadConfig } from "../src/config.ts";
import {
  applyConfiguredPiModelScope,
  type DiscoveredPiModelCatalog,
} from "../src/execution-environment/sbx-run.ts";
import type { HarnessDiscovery } from "../src/harnesses/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const discovered: DiscoveredPiModelCatalog = {
  authenticated: true,
  diagnostics: ["Pi dynamic discovery authenticated."],
  accountScope: "a".repeat(64),
  authGeneration: "b".repeat(64),
  metadata: {
    authority: "advisory",
    conclusive: false,
    status: 200,
    observedAt: "2026-09-22T00:00:00.000Z",
    modelCount: 0,
  },
  models: [
    {
      provider: "openai-codex",
      model: "model-a",
      displayName: "Model A",
      accountAvailability: "verified_available",
      reasoningCapability: {
        kind: "enumerated",
        values: ["low", "medium", "high"],
      },
    },
    {
      provider: "openai-codex",
      model: "model-b",
      displayName: "Model B",
      accountAvailability: "verified_unavailable",
      reasoningCapability: { kind: "unsupported" },
    },
    {
      provider: "openai-codex",
      model: "model-c",
      displayName: "Model C",
      accountAvailability: "unknown",
      reasoningCapability: {
        kind: "enumerated",
        values: ["medium", "high"],
      },
    },
  ],
};

test("production config requires one exact absolute Herdr executable", async () => {
  const configured = await environment();
  expect(loadConfig(configured).herdrBin).toBe(realpathSync(process.execPath));
  const missing = { ...configured };
  delete missing.QE_HERDR_BIN;
  expect(() => loadConfig(missing)).toThrow("QE_HERDR_BIN is required");
  expect(() => loadConfig({ ...configured, QE_HERDR_BIN: "herdr" })).toThrow(
    "must be an absolute path",
  );
  expect(() =>
    loadConfig({
      ...configured,
      QE_HERDR_BIN: configured.QE_WORKER_DATA_ROOT,
    }),
  ).toThrow("must identify an existing executable file");
});

test("dispatch availability defaults active and supports generic maintenance registration", async () => {
  const active = loadConfig(await environment());
  expect(active.dispatchAvailability).toBe("active");
  expect(
    workerCapabilities(active, "darwin", "arm64").dispatch_availability,
  ).toBe("active");

  const maintenance = loadConfig(
    await environment({ QE_WORKER_DISPATCH_AVAILABILITY: "maintenance" }),
  );
  expect(maintenance.dispatchAvailability).toBe("maintenance");
  expect(
    workerCapabilities(maintenance, "darwin", "arm64").dispatch_availability,
  ).toBe("maintenance");

  const invalid = await environment({
    QE_WORKER_DISPATCH_AVAILABILITY: "draining-ish",
  });
  expect(() => loadConfig(invalid)).toThrow("must be active or maintenance");
});

test("omitted model configuration remains absent while an authored empty value remains deny-all", async () => {
  const omitted = loadConfig(await environment());
  expect(Object.hasOwn(omitted, "executorModels")).toBe(false);
  expect(omitted.executorModels).toBeUndefined();
  expect(JSON.parse(JSON.stringify(omitted))).not.toHaveProperty(
    "executorModels",
  );

  const empty = loadConfig(await environment({ QE_EXECUTOR_MODELS: "" }));
  expect(Object.hasOwn(empty, "executorModels")).toBe(true);
  expect(empty.executorModels).toEqual([]);
  expect(JSON.parse(JSON.stringify(empty)).executorModels).toEqual([]);

  const duplicate = loadConfig(
    await environment({
      QE_EXECUTOR_MODELS:
        "openai-codex/model-a,openai-codex/model-a,openai-codex/model-c",
    }),
  );
  expect(duplicate.executorModels).toEqual([
    { provider: "openai-codex", model: "model-a" },
    { provider: "openai-codex", model: "model-c" },
  ]);
});

test("omitted scope retains the complete dynamic catalog and reasoning metadata", () => {
  const result = applyConfiguredPiModelScope(discovered, undefined);
  expect(result.models).toEqual(discovered.models);
  expect(result.authenticated).toBe(true);
  expect(result.diagnostics.at(-1)).toBe(
    "QE model scope is omitted; retained all 3 dynamically discovered model(s).",
  );
});

test("explicit empty scope denies every dynamically discovered model", () => {
  const result = applyConfiguredPiModelScope(discovered, []);
  expect(result.models).toEqual([]);
  expect(result.authenticated).toBe(true);
  expect(result.diagnostics.at(-1)).toBe(
    "QE model scope is explicitly empty; policy retained 0 of 3 dynamically discovered model(s).",
  );
});

test("nonempty scope retains an exact subset in native catalog order", () => {
  const result = applyConfiguredPiModelScope(discovered, [
    { provider: "openai-codex", model: "model-c" },
    { provider: "openai-codex", model: "model-a" },
  ]);
  expect(result.models.map((model) => model.model)).toEqual([
    "model-a",
    "model-c",
  ]);
  expect(result.models[0]?.reasoningCapability).toEqual(
    discovered.models[0]?.reasoningCapability,
  );
  expect(result.authenticated).toBe(true);
  expect(result.diagnostics.at(-1)).toBe(
    "Configured QE model scope retained 2 of 3 dynamically discovered model(s).",
  );
});

test("zero-model discovery is distinguished from QE policy exclusion", () => {
  const result = applyConfiguredPiModelScope(
    { ...discovered, diagnostics: [], models: [] },
    undefined,
  );
  expect(result.models).toEqual([]);
  expect(result.authenticated).toBe(true);
  expect(result.diagnostics).toEqual([
    "Dynamic Pi discovery returned zero compatible models; QE model scope is omitted.",
  ]);
});

test("empty advisory metadata does not suppress the runtime catalog", async () => {
  const config = loadConfig(await environment());
  const scoped = applyConfiguredPiModelScope(discovered, config.executorModels);
  const capabilities = workerCapabilities(config, "darwin", "arm64", [
    discoveryFor(scoped),
  ]);
  expect(scoped.metadata.modelCount).toBe(0);
  expect(scoped.models).toHaveLength(3);
  expect(capabilities.executors[0]?.models).toHaveLength(3);
});

test("unknown nonempty scope advertises no fallback and explains policy exclusion", () => {
  const result = applyConfiguredPiModelScope(discovered, [
    { provider: "openai-codex", model: "missing-model" },
  ]);
  expect(result.models).toEqual([]);
  expect(result.authenticated).toBe(true);
  expect(result.diagnostics.at(-1)).toContain(
    "policy excluded the entire discovered catalog",
  );
});

test("scope matching is exact across duplicates, case, and provider", () => {
  const modelA = discovered.models[0];
  if (!modelA) throw new Error("missing model A fixture");
  const catalog: DiscoveredPiModelCatalog = {
    ...discovered,
    models: [
      modelA,
      { ...modelA, model: "MODEL-A" },
      { ...modelA, provider: "other-provider" },
    ],
  };
  const result = applyConfiguredPiModelScope(catalog, [
    { provider: "openai-codex", model: "model-a" },
    { provider: "openai-codex", model: "model-a" },
  ]);
  expect(result.models).toEqual([modelA]);
});

test("resolved omitted-scope catalog reaches Worker capability publication", async () => {
  const config = loadConfig(await environment());
  const scoped = applyConfiguredPiModelScope(discovered, config.executorModels);
  const capabilities = workerCapabilities(config, "darwin", "arm64", [
    discoveryFor(scoped),
  ]);
  expect(capabilities.executors).toHaveLength(1);
  expect(
    JSON.stringify(
      capabilities.executors[0]?.models.map((model) => [
        model.provider,
        model.model,
        model.reasoning_capability,
      ]),
    ),
  ).toBe(
    JSON.stringify(
      discovered.models.map((model) => [
        model.provider,
        model.model,
        model.reasoningCapability,
      ]),
    ),
  );
});

test("resolved explicit-empty scope remains truthfully unschedulable", async () => {
  const config = loadConfig(await environment({ QE_EXECUTOR_MODELS: "" }));
  const scoped = applyConfiguredPiModelScope(discovered, config.executorModels);
  const capabilities = workerCapabilities(config, "darwin", "arm64", [
    discoveryFor(scoped),
  ]);
  expect(scoped.models).toEqual([]);
  expect(scoped.authenticated).toBe(true);
  expect(capabilities.executors).toEqual([]);
});

function discoveryFor(catalog: DiscoveredPiModelCatalog): HarnessDiscovery {
  return {
    kind: "pi",
    displayName: "Pi",
    strategy: "native_extension",
    integration: {
      status: catalog.authenticated ? "ready" : "auth_required",
      detail: catalog.diagnostics.join(" "),
      installed: true,
      authenticated: catalog.authenticated,
    },
    models: catalog.models,
    capabilities: {
      structuredResult: catalog.authenticated,
    } as HarnessDiscovery["capabilities"],
  };
}

async function environment(
  overrides: NodeJS.ProcessEnv = {},
): Promise<NodeJS.ProcessEnv> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "model-scope-"));
  roots.push(root);
  return {
    HOME: "/Users/test",
    QE_CONTROL_PLANE_URL: "ws://127.0.0.1:4000/worker/websocket",
    QE_WORKER_ID: "model-scope-worker",
    QE_WORKER_TOKEN: "unused",
    QE_WORKER_PROVIDER: "pi",
    QE_WORKER_HARNESSES: "pi",
    QE_HERDR_BIN: process.execPath,
    QE_WORKER_DATA_ROOT: root,
    QE_WORKTREE_ROOT: join(root, "worktrees"),
    QE_ALLOWED_ROOTS_JSON: "[]",
    ...overrides,
  };
}
