import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { ProviderAccountEnvironmentManager } from "../../src/execution-environment/provider-account.ts";
import { SbxExecutionEnvironmentBackend } from "../../src/execution-environment/sbx-backend.ts";
import {
  SBX_CLAUDE_ACCOUNT_PROFILE,
  SBX_DISPOSABLE_RESOURCE_POLICY,
} from "../../src/execution-environment/sbx-profile.ts";
import { ExecutionEnvironmentStore } from "../../src/execution-environment/store.ts";
import { FakeHarness } from "../../src/harnesses/fake/adapter.ts";
import { QuestEngineeringWorker } from "../../src/worker.ts";
import {
  type PhysicalAcceptanceFixtureMode,
  PhysicalAcceptanceSetupLauncher,
  physicalAcceptanceAuthentication,
} from "./provider-account-setup-launcher.ts";

const [modeValue, interactionSecret] = process.argv.slice(2);
if (
  !["short", "fragmented", "delayed", "silent", "nonzero"].includes(
    modeValue ?? "",
  ) ||
  !interactionSecret
)
  throw new Error(
    "The live ProviderAccount test Worker requires an explicit fixture mode and interaction secret.",
  );
const mode = modeValue as PhysicalAcceptanceFixtureMode;
const config = loadConfig();
if (config.provider === "fake")
  throw new Error(
    "The physical ProviderAccount test Worker requires the real SBX composition.",
  );
const environmentStore = new ExecutionEnvironmentStore(config.dataRoot);
const eventPath = join(
  config.dataRoot,
  "provider-account-physical-events.jsonl",
);
const backend = new SbxExecutionEnvironmentBackend({
  workerId: config.workerId,
  dataRoot: config.dataRoot,
  store: environmentStore,
  executionProfile: SBX_CLAUDE_ACCOUNT_PROFILE,
  resourcePolicy: SBX_DISPOSABLE_RESOURCE_POLICY,
  onStreamedProcessEvent: (event) => {
    appendFileSync(eventPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
  },
});
const environments = new ProviderAccountEnvironmentManager(config, {
  backend,
  store: environmentStore,
  fake: false,
  setupLauncher: new PhysicalAcceptanceSetupLauncher(mode, interactionSecret),
  fakeAuthentication: physicalAcceptanceAuthentication(),
});
const worker = new QuestEngineeringWorker(config, {
  harnesses: [new FakeHarness()],
  providerAccountEnvironments: environments,
  providerAccountSetupOptions: {
    // Scenario B leaves enough time for two full physical reconnect
    // reconciliations before its deterministic timeout. Production uses the
    // same thirty-second discovery bound.
    interactionDiscoveryTimeoutMs: mode === "silent" ? 30_000 : 5_000,
    humanCompletionTimeoutMs: 15_000,
    cancellationSettlementTimeoutMs: 10_000,
  },
});
console.log(
  JSON.stringify({
    event: "physical_provider_account_test_worker_start",
    observedAt: new Date().toISOString(),
    workerId: config.workerId,
    fixtureMode: mode,
  }),
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  for (const record of environmentStore.list()) {
    if (
      record.owner.kind !== "provider_account" ||
      !record.environmentId ||
      record.retiredAt
    )
      continue;
    await environments
      .apply({
        providerAccountId: record.owner.providerAccountId,
        providerKey: "anthropic",
        credentialGeneration: record.owner.credentialGeneration,
        workerGeneration: 1,
        operationId: crypto.randomUUID(),
        desiredState: "removed",
        expectedPhysicalIdentity: {
          backendKind: record.backendKind,
          environmentId: record.environmentId,
          incarnation: record.incarnation,
        },
      })
      .catch(() => undefined);
  }
  await worker.stop();
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

try {
  await worker.run();
} finally {
  await stop();
}
