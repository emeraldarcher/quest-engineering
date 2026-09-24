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
  ).toEqual([{ version: 1 }]);
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
