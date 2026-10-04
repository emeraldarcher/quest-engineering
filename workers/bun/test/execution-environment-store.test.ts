import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { ExecutionEnvironmentStore } from "../src/execution-environment/store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("environment store bootstraps a clean versioned SQLite schema", async () => {
  const root = await tempRoot();
  const store = new ExecutionEnvironmentStore(root);
  const claimed = store.claimCreation(intent("record-1", "incarnation-1"));
  expect(claimed.created).toBe(true);
  expect(store.current("sbx", "worker-store", "run-store")).toMatchObject({
    recordId: "record-1",
    state: "creating",
    environmentId: null,
    incarnation: "incarnation-1",
  });
  store.close();

  const db = new Database(join(root, "execution-environments.sqlite"));
  expect(
    db
      .query(
        "SELECT version FROM execution_environment_schema_migrations ORDER BY version",
      )
      .all(),
  ).toEqual([{ version: 1 }, { version: 2 }]);
  const columns = db
    .query("PRAGMA table_info(execution_environments)")
    .all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).not.toContain("spec_json");
  expect(columns.map((column) => column.name)).not.toContain("credentials");
  db.close();
});

test("environment migration preserves unrelated representative Worker data", async () => {
  const root = await tempRoot();
  const path = join(root, "execution-environments.sqlite");
  const old = new Database(path, { create: true });
  old.exec(
    "CREATE TABLE existing_worker_history(id TEXT PRIMARY KEY, value TEXT NOT NULL)",
  );
  old
    .query("INSERT INTO existing_worker_history(id,value) VALUES (?,?)")
    .run("history-1", "preserve-me");
  old.close();

  const store = new ExecutionEnvironmentStore(root);
  store.close();
  const migrated = new Database(path);
  expect(migrated.query("SELECT * FROM existing_worker_history").get()).toEqual(
    { id: "history-1", value: "preserve-me" },
  );
  migrated.close();
});

test("stop events are append-only and invocation claim is exactly once", async () => {
  const root = await tempRoot();
  let milliseconds = Date.parse("2026-01-01T00:00:00.000Z");
  const store = new ExecutionEnvironmentStore(root, undefined, () => {
    const value = new Date(milliseconds);
    milliseconds += 1;
    return value;
  });
  store.claimCreation(intent("record-stop", "incarnation-stop"));
  const begun = store.beginStop("record-stop", "stop-1");
  expect(begun.created).toBe(true);
  expect(store.beginStop("record-stop", "stop-2")).toMatchObject({
    created: false,
    attempt: { stopId: "stop-1" },
  });
  expect(store.claimStopInvocation("record-stop", "stop-1").claimed).toBe(true);
  expect(store.claimStopInvocation("record-stop", "stop-1").claimed).toBe(
    false,
  );
  store.appendStopEvent("record-stop", "stop-1", "stop_invocation_ambiguous", {
    errorCode: "operation_timeout",
  });
  store.appendStopEvent("record-stop", "stop-1", "stop_reconcile_started");
  expect(store.latestStopAttempt("record-stop")).toMatchObject({
    stopId: "stop-1",
    invocation: "ambiguous",
    confirmed: false,
    reopened: false,
  });
  expect(store.stopEvents("record-stop").map((event) => event.type)).toEqual([
    "stop_intent_recorded",
    "stop_invocation_started",
    "stop_invocation_ambiguous",
    "stop_reconcile_started",
  ]);
  expect(
    store.stopEvents("record-stop").map((event) => event.occurredAt),
  ).toEqual([
    "2026-01-01T00:00:00.003Z",
    "2026-01-01T00:00:00.004Z",
    "2026-01-01T00:00:00.005Z",
    "2026-01-01T00:00:00.006Z",
  ]);
  store.close();
});

test("retirement preserves incarnation history and permits one new current record", async () => {
  const root = await tempRoot();
  const store = new ExecutionEnvironmentStore(root);
  store.claimCreation(intent("record-1", "incarnation-1"));
  store.bindPhysical({
    recordId: "record-1",
    environmentId: "environment-1",
    nativeAgent: "shell",
    markerDigest: "marker-1",
    state: "running",
    capabilities: [],
    diagnostics: [],
  });
  store.retire("record-1");
  const replacement = store.claimCreation(intent("record-2", "incarnation-2"));

  expect(replacement.created).toBe(true);
  expect(store.list()).toHaveLength(2);
  expect(store.list().map((record) => record.incarnation)).toEqual([
    "incarnation-1",
    "incarnation-2",
  ]);
  expect(store.list()[0]?.retiredAt).not.toBeNull();
  expect(store.current("sbx", "worker-store", "run-store")?.recordId).toBe(
    "record-2",
  );
  store.close();
});

function intent(recordId: string, incarnation: string) {
  return {
    recordId,
    backendKind: "sbx",
    workerId: "worker-store",
    runId: "run-store",
    displayName: "qe-run-store-123456789abc",
    incarnation,
    profileId: "qe-execution-v1",
    profileDigest: "sha256:profile",
    specDigest: "spec-digest",
    creationToken: `token-${recordId}`,
    creatorPid: 123,
    nativeVersion: "v0.43.0",
    nativeRevision: "revision",
    nativeApiVersion: "0.31.0",
  };
}

async function tempRoot(): Promise<string> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "environment-store-"));
  roots.push(root);
  return root;
}
