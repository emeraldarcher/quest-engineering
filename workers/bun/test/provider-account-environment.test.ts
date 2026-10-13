import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { FakeExecutionEnvironmentBackend } from "../src/execution-environment/fake.ts";
import {
  type ProviderAccountEnvironmentCommand,
  ProviderAccountEnvironmentManager,
} from "../src/execution-environment/provider-account.ts";
import { cleanupExecutionEnvironment } from "../src/execution-environment/run-cleanup.ts";
import { ExecutionEnvironmentStore } from "../src/execution-environment/store.ts";
import type { ProviderAccountEnvironmentSpec } from "../src/execution-environment/types.ts";
import { decodeProviderAccountReconciliation } from "../src/worker.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("Worker decodes only current-generation ProviderAccount commands with an exact physical fence", () => {
  const message = {
    worker_id: "worker-account-test",
    connection_generation: 8,
    provider_accounts: [
      {
        provider_account_id: "account-wire",
        provider_key: "provider-neutral",
        credential_generation: 2,
        worker_generation: 8,
        operation_id: "operation-wire",
        desired_state: "stopped",
        expected_backend_kind: "sbx",
        expected_environment_id: "environment-wire",
        expected_incarnation: "incarnation-wire",
      },
    ],
  };
  expect(
    decodeProviderAccountReconciliation(message, "worker-account-test", 8),
  ).toEqual([
    {
      providerAccountId: "account-wire",
      providerKey: "provider-neutral",
      credentialGeneration: 2,
      workerGeneration: 8,
      operationId: "operation-wire",
      desiredState: "stopped",
      expectedPhysicalIdentity: {
        backendKind: "sbx",
        environmentId: "environment-wire",
        incarnation: "incarnation-wire",
      },
    },
  ]);
  expect(() =>
    decodeProviderAccountReconciliation(
      {
        ...message,
        provider_accounts: [
          { ...message.provider_accounts[0], expected_incarnation: null },
        ],
      },
      "worker-account-test",
      8,
    ),
  ).toThrow("identity is invalid");
  expect(() =>
    decodeProviderAccountReconciliation(
      {
        ...message,
        provider_accounts: [
          { ...message.provider_accounts[0], credential: "must-not-cross" },
        ],
      },
      "worker-account-test",
      8,
    ),
  ).toThrow("payload is invalid");
  expect(() =>
    decodeProviderAccountReconciliation(message, "worker-account-test", 9),
  ).toThrow("generation is stale");
});

test("generic environment backend accepts exact ProviderAccount owners without a Run layout", async () => {
  const backend = new FakeExecutionEnvironmentBackend();
  const spec = accountSpec("account-generic", 1);
  const first = await backend.ensure(spec);
  const repeated = await backend.ensure(spec);
  const replacement = await backend.ensure(accountSpec("account-generic", 2));

  expect(repeated.ref).toEqual(first.ref);
  expect(first.ref.owner).toEqual({
    kind: "provider_account",
    providerAccountId: "account-generic",
    credentialGeneration: 1,
  });
  expect(replacement.ref.environmentId).not.toBe(first.ref.environmentId);
  expect(replacement.ref.owner).toMatchObject({ credentialGeneration: 2 });

  await expect(
    backend.ensure({
      ...accountSpec("account-malformed", 1),
      layout: { kind: "run" },
      workspace: {
        workspaceId: "must-not-overload-account-ownership",
        access: "none",
        materialization: {
          kind: "disposable_fixture",
          sourceIdentity: "fixture:invalid",
          frozenBase: { kind: "fixture", value: "invalid" },
        },
      },
    } as unknown as ProviderAccountEnvironmentSpec),
  ).rejects.toMatchObject({ code: "invalid_environment_spec" });
});

test("fake ProviderAccount environment is Run-independent, idempotent, and restart durable", async () => {
  const root = await tempRoot();
  const command = desired("account-a", 1, 7, "operation-a");
  let manager = fakeManager(root);

  const first = await manager.apply(command);
  const repeated = await manager.apply(command);
  expect(first).toMatchObject({
    physicalState: "available",
    backendKind: "fake-account",
    providerAccountId: "account-a",
    credentialGeneration: 1,
    workerGeneration: 7,
    operationId: "operation-a",
    canaryPersisted: true,
  });
  expect(repeated.environmentId).toBe(first.environmentId);
  expect(repeated.incarnation).toBe(first.incarnation);
  await manager.close();

  manager = fakeManager(root);
  const restarted = await manager.apply({ ...command, operationId: "restart" });
  expect(restarted.environmentId).toBe(first.environmentId);
  expect(restarted.incarnation).toBe(first.incarnation);
  expect(restarted.canaryPersisted).toBe(true);
  await manager.close();
});

test("reconciliation retains a bounded failure report for the exact operation", async () => {
  const root = await tempRoot();
  const store = new ExecutionEnvironmentStore(root);
  const manager = new ProviderAccountEnvironmentManager(
    { workerId: "worker-account-test", dataRoot: root, provider: "fake" },
    { fake: true, store },
  );
  const firstCommand = desired("account-failure", 1, 4, "failure-initial");
  await manager.apply(firstCommand);
  const record = store.list()[0];
  if (!record) throw new Error("Expected a durable account environment.");
  store.writeDeterministicCanary(record.recordId, "corrupt-canary");

  const failedCommand = { ...firstCommand, operationId: "failure-current" };
  const failed = await manager.apply(failedCommand);
  expect(failed).toMatchObject({
    physicalState: "degraded",
    eventType: "environment_degraded",
    errorCode: "account_environment_operation_failed",
    errorMessage: "ProviderAccount environment operation failed safely.",
  });
  expect(manager.reportsFor([failedCommand])).toEqual([failed]);
  await manager.close();
});

test("reconciliation reports an unbound durable creation intent without inventing physical identity", async () => {
  const root = await tempRoot();
  const store = new ExecutionEnvironmentStore(root);
  const command = desired("account-creating", 1, 4, "creating-operation");
  store.claimCreation({
    recordId: crypto.randomUUID(),
    backendKind: "fake-account",
    workerId: "worker-account-test",
    owner: {
      kind: "provider_account",
      providerAccountId: command.providerAccountId,
      credentialGeneration: command.credentialGeneration,
    },
    displayName: "fake-account-creating",
    incarnation: crypto.randomUUID(),
    profileId: "test-profile",
    profileDigest: "test-profile-digest",
    specDigest: "test-spec-digest",
    creationToken: crypto.randomUUID(),
    creatorPid: process.pid,
    nativeVersion: "fake-1",
    nativeRevision: "fake-1",
    nativeApiVersion: "fake-1",
  });
  const manager = new ProviderAccountEnvironmentManager(
    { workerId: "worker-account-test", dataRoot: root, provider: "fake" },
    { fake: true, store },
  );

  expect(manager.reportsFor([command])).toMatchObject([
    {
      physicalState: "pending",
      eventType: "environment_reconciled",
      backendKind: "fake-account",
      environmentId: null,
      incarnation: null,
    },
  ]);
  await manager.close();
});

test("concurrent commands serialize by stable account identity across credential generations", async () => {
  const root = await tempRoot();
  const store = new ExecutionEnvironmentStore(root);
  const manager = new ProviderAccountEnvironmentManager(
    { workerId: "worker-account-test", dataRoot: root, provider: "fake" },
    { fake: true, store },
  );

  await Promise.all([
    manager.apply(desired("account-serialized", 1, 2, "serialized-1")),
    manager.apply(desired("account-serialized", 2, 2, "serialized-2")),
  ]);

  const records = store
    .list()
    .filter(
      (record) =>
        record.owner.kind === "provider_account" &&
        record.owner.providerAccountId === "account-serialized",
    );
  expect(records).toHaveLength(2);
  expect(records.filter((record) => record.retiredAt === null)).toHaveLength(1);
  expect(
    records.find((record) => record.retiredAt === null)?.owner,
  ).toMatchObject({ credentialGeneration: 2 });
  await manager.close();
});

test("stale reconciliation cannot replace a newer local credential generation", async () => {
  const root = await tempRoot();
  const manager = fakeManager(root);
  await manager.apply(desired("account-newer-local", 1, 2, "generation-1"));
  const newer = await manager.apply(
    desired("account-newer-local", 2, 2, "generation-2"),
  );

  expect(
    await manager.reconcile([
      desired("account-newer-local", 1, 3, "stale-reconciliation"),
    ]),
  ).toMatchObject([
    { physicalState: "degraded", errorCode: "stale_environment_ref" },
  ]);
  expect(
    await manager.apply(
      desired("account-newer-local", 2, 3, "after-stale-reconciliation"),
    ),
  ).toMatchObject({
    environmentId: newer.environmentId,
    incarnation: newer.incarnation,
  });
  await manager.close();
});

test("reconciliation never retires account environments owned by another Worker", async () => {
  const root = await tempRoot();
  const store = new ExecutionEnvironmentStore(root);
  const claim = store.claimCreation({
    recordId: crypto.randomUUID(),
    backendKind: "fake-account",
    workerId: "worker-account-other",
    owner: {
      kind: "provider_account",
      providerAccountId: "account-other-worker",
      credentialGeneration: 1,
    },
    displayName: "fake-account-other-worker",
    incarnation: crypto.randomUUID(),
    profileId: "test-profile",
    profileDigest: "test-profile-digest",
    specDigest: "test-spec-digest",
    creationToken: crypto.randomUUID(),
    creatorPid: process.pid,
    nativeVersion: "fake-1",
    nativeRevision: "fake-1",
    nativeApiVersion: "fake-1",
  });
  store.bindPhysical({
    recordId: claim.record.recordId,
    environmentId: "fake-other-worker",
    nativeAgent: "fake",
    markerDigest: "marker-other-worker",
    state: "running",
    capabilities: [],
    diagnostics: [],
  });
  const manager = new ProviderAccountEnvironmentManager(
    { workerId: "worker-account-test", dataRoot: root, provider: "fake" },
    { fake: true, store },
  );

  await manager.reconcile([]);

  expect(store.list()[0]).toMatchObject({
    workerId: "worker-account-other",
    retiredAt: null,
    state: "running",
  });
  await manager.close();
});

test("credential generations replace incarnations and separate accounts never collide", async () => {
  const root = await tempRoot();
  const manager = fakeManager(root);
  const accountA1 = await manager.apply(desired("account-a", 1, 2, "a-1"));
  const accountB1 = await manager.apply(desired("account-b", 1, 2, "b-1"));
  const accountA2 = await manager.apply(desired("account-a", 2, 2, "a-2"));

  expect(accountA1.environmentId).not.toBe(accountB1.environmentId);
  expect(accountA2.environmentId).not.toBe(accountA1.environmentId);
  expect(accountA2.incarnation).not.toBe(accountA1.incarnation);
  expect(accountA2.canaryPersisted).toBe(true);

  expect(
    await manager.apply({
      ...desired("account-a", 1, 2, "a-stale-remove"),
      desiredState: "removed",
      expectedPhysicalIdentity: {
        backendKind: accountA1.backendKind as string,
        environmentId: accountA1.environmentId as string,
        incarnation: accountA1.incarnation as string,
      },
    }),
  ).toMatchObject({ physicalState: "removed" });
  expect(
    await manager.apply(desired("account-a", 2, 2, "a-after-stale-remove")),
  ).toMatchObject({
    environmentId: accountA2.environmentId,
    incarnation: accountA2.incarnation,
  });
  expect(
    await manager.apply(desired("account-a", 1, 2, "a-stale-generation")),
  ).toMatchObject({
    physicalState: "degraded",
    errorCode: "stale_environment_ref",
  });
  expect(
    await manager.apply(desired("account-a", 2, 2, "a-after-stale-generation")),
  ).toMatchObject({
    environmentId: accountA2.environmentId,
    incarnation: accountA2.incarnation,
  });
  const fenced = await manager.apply({
    ...desired("account-a", 2, 2, "a-wrong-physical-fence"),
    desiredState: "stopped",
    expectedPhysicalIdentity: {
      backendKind: accountA2.backendKind as string,
      environmentId: accountA1.environmentId as string,
      incarnation: accountA1.incarnation as string,
    },
  });
  expect(fenced).toMatchObject({
    physicalState: "degraded",
    errorCode: "environment_identity_mismatch",
    environmentId: accountA2.environmentId,
    incarnation: accountA2.incarnation,
  });

  const accountBIdentity = {
    backendKind: accountB1.backendKind as string,
    environmentId: accountB1.environmentId as string,
    incarnation: accountB1.incarnation as string,
  };
  const stopped = await manager.apply({
    ...desired("account-b", 1, 2, "b-stop"),
    desiredState: "stopped",
    expectedPhysicalIdentity: accountBIdentity,
  });
  expect(stopped.physicalState).toBe("stopped");
  expect(
    await manager.apply(desired("account-a", 2, 2, "a-still-running")),
  ).toMatchObject({ physicalState: "available" });

  const removed = await manager.apply({
    ...desired("account-b", 1, 2, "b-remove"),
    desiredState: "removed",
    expectedPhysicalIdentity: accountBIdentity,
  });
  expect(removed.physicalState).toBe("removed");
  expect(
    await manager.apply({
      ...desired("account-b", 1, 2, "b-remove-replay"),
      desiredState: "removed",
      expectedPhysicalIdentity: accountBIdentity,
    }),
  ).toMatchObject({
    physicalState: "removed",
    environmentId: accountB1.environmentId,
    incarnation: accountB1.incarnation,
  });
  await manager.close();
});

test("Run cleanup rejects an account-owned ref before any destructive backend call", async () => {
  const calls: string[] = [];
  const backend = {
    kind: "proof",
    readiness: async () => {
      throw new Error("unused");
    },
    currentEnvironment: async () => null,
    ensure: async () => {
      throw new Error("unused");
    },
    recover: async () => {
      throw new Error("unused");
    },
    inspect: async () => {
      calls.push("inspect");
      throw new Error("must not inspect");
    },
    stop: async () => {
      calls.push("stop");
      throw new Error("must not stop");
    },
    reconcileStop: async () => {
      calls.push("reconcile");
      throw new Error("must not reconcile");
    },
    retireStreamedProcesses: async () => {
      calls.push("retire");
      throw new Error("must not retire");
    },
    remove: async () => {
      calls.push("remove");
      throw new Error("must not remove");
    },
  };
  const result = await cleanupExecutionEnvironment(backend, {
    backendKind: "proof",
    environmentId: "account-environment",
    incarnation: "account-incarnation",
    workerId: "worker-account-test",
    owner: {
      kind: "provider_account",
      providerAccountId: "account-a",
      credentialGeneration: 1,
    },
    profile: { id: "profile", digest: "digest" },
  });
  expect(result).toEqual({
    state: "failed",
    issue: {
      code: "environment_owner_mismatch",
      message: "Run cleanup cannot remove a ProviderAccount-owned environment.",
    },
  });
  expect(calls).toEqual([]);
});

test("Worker environment SQLite rejects the immediately stale owner schema", async () => {
  const root = await tempRoot();
  const path = join(root, "execution-environments.sqlite");
  const stale = new Database(path, { create: true });
  stale.exec(
    "CREATE TABLE execution_environment_schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO execution_environment_schema_migrations VALUES (2,'stale')",
  );
  stale.close();
  expect(() => new ExecutionEnvironmentStore(root)).toThrow(
    "schema is obsolete",
  );
});

test.skipIf(process.env.QE_LIVE_SBX !== "1")(
  "live ProviderAccount SBX lifecycle is bounded and preserves its canary across Worker restart",
  async () => {
    const root = await tempRoot();
    const command = desired(`live-${crypto.randomUUID()}`, 1, 1, "live-ensure");
    let manager = new ProviderAccountEnvironmentManager(
      { workerId: "worker-account-live", dataRoot: root, provider: "pi" },
      { fake: false },
    );
    const ensured = await manager.apply(command);
    expect(ensured).toMatchObject({
      physicalState: "available",
      backendKind: "sbx",
      canaryPersisted: true,
    });
    await manager.close();

    manager = new ProviderAccountEnvironmentManager(
      { workerId: "worker-account-live", dataRoot: root, provider: "pi" },
      { fake: false },
    );
    const restarted = await manager.apply({
      ...command,
      operationId: "live-restart",
    });
    expect(restarted).toMatchObject({
      environmentId: ensured.environmentId,
      incarnation: ensured.incarnation,
      canaryPersisted: true,
    });
    const expectedPhysicalIdentity = {
      backendKind: ensured.backendKind as string,
      environmentId: ensured.environmentId as string,
      incarnation: ensured.incarnation as string,
    };
    expect(
      await manager.apply({
        ...command,
        operationId: "live-stop",
        desiredState: "stopped",
        expectedPhysicalIdentity,
      }),
    ).toMatchObject({ physicalState: "stopped" });
    expect(
      await manager.apply({
        ...command,
        operationId: "live-remove",
        desiredState: "removed",
        expectedPhysicalIdentity,
      }),
    ).toMatchObject({ physicalState: "removed" });
    await manager.close();
  },
);

function accountSpec(
  providerAccountId: string,
  credentialGeneration: number,
): ProviderAccountEnvironmentSpec {
  return {
    workerId: "worker-account-test",
    owner: {
      kind: "provider_account",
      providerAccountId,
      credentialGeneration,
    },
    layout: { kind: "provider_account", version: "provider-account-cell-v1" },
    profile: {
      id: "test-account-profile",
      digest: "sha256:test-account-profile",
    },
    resourcePolicy: {
      id: "test-account-resources",
      digest: "sha256:test-account-resources",
    },
    networkRequirements: [],
    credentialGrants: [],
    controlChannels: [],
    requiredCapabilities: [],
  };
}

function fakeManager(root: string): ProviderAccountEnvironmentManager {
  return new ProviderAccountEnvironmentManager(
    { workerId: "worker-account-test", dataRoot: root, provider: "fake" },
    { fake: true },
  );
}

function desired(
  providerAccountId: string,
  credentialGeneration: number,
  workerGeneration: number,
  operationId: string,
): ProviderAccountEnvironmentCommand {
  return {
    providerAccountId,
    providerKey: "deterministic-fake",
    credentialGeneration,
    workerGeneration,
    operationId,
    desiredState: "available",
    expectedPhysicalIdentity: null,
  };
}

async function tempRoot(): Promise<string> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "provider-account-environment-"));
  roots.push(root);
  return root;
}
