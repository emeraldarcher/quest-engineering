import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { PrivateGitStore } from "../src/workspace/private-git-store.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("private Git store creates a clean database and enforces exact repository/workspace ownership", async () => {
  const root = await tempRoot();
  const store = new PrivateGitStore(root);
  const repository = repositoryInput();
  const first = store.claimRepository(repository);
  const replay = store.claimRepository({
    ...repository,
    recordId: "ignored-replay-id",
  });
  expect(first.created).toBe(true);
  expect(replay.created).toBe(false);
  expect(replay.record.recordId).toBe(repository.recordId);
  expect(() =>
    store.claimRepository({
      ...repository,
      recordId: "other",
      baseCommit: "b".repeat(40),
    }),
  ).toThrow("different baseCommit");
  store.markRepositoryReady(repository.recordId);

  const workspace = workspaceInput(repository.recordId);
  expect(store.claimWorkspace(workspace).created).toBe(true);
  expect(
    store.claimWorkspace({ ...workspace, recordId: "ignored-workspace-replay" })
      .created,
  ).toBe(false);
  expect(() =>
    store.claimWorkspace({
      ...workspace,
      recordId: "other",
      access: "read_only",
    }),
  ).toThrow("different access");
  store.markWorkspaceReady(workspace.recordId);
  store.close();
});

test("private Git store migrates an existing version-1 database forward without changing repository rows", async () => {
  const root = await tempRoot();
  const first = new PrivateGitStore(root);
  const repository = repositoryInput();
  first.claimRepository(repository);
  first.close();

  const databasePath = join(root, "private-git.sqlite");
  const legacy = new Database(databasePath, { strict: true });
  legacy.exec(`
    PRAGMA foreign_keys=OFF;
    DROP TABLE private_git_checkpoints;
    DROP TABLE private_git_workspaces;
    DELETE FROM private_git_schema_migrations WHERE version=2;
  `);
  legacy.close();

  const migrated = new PrivateGitStore(root);
  expect(migrated.listRepositories()).toHaveLength(1);
  expect(migrated.listRepositories()[0]?.recordId).toBe(repository.recordId);
  const workspace = workspaceInput(repository.recordId);
  expect(migrated.claimWorkspace(workspace).record.physicalLineageId).toBe(
    "lineage-1",
  );
  migrated.close();
});

function repositoryInput() {
  return {
    recordId: "repository-record-1",
    backendKind: "sbx",
    environmentId: "environment-1",
    incarnation: "incarnation-1",
    workerId: "worker-1",
    runId: "run-1",
    repositoryId: "repository-1",
    sourceDigest: "source-digest-1",
    sourceJson: '{"schemaVersion":1}',
    baseCommit: "a".repeat(40),
    baseTree: "c".repeat(40),
    importBundleSha256: "d".repeat(64),
    guestGitDir: "/qe/git/repository.git",
  };
}

function workspaceInput(repositoryRecordId: string) {
  return {
    recordId: "workspace-record-1",
    repositoryRecordId,
    backendKind: "sbx",
    environmentId: "environment-1",
    incarnation: "incarnation-1",
    workerId: "worker-1",
    runId: "run-1",
    physicalLineageId: "lineage-1",
    access: "read_write" as const,
    guestPath: "/qe/workspaces/lineage-1",
    branchRef: "refs/heads/qe/lineages/lineage-1",
    runtimeJson: "{}",
  };
}

async function tempRoot(): Promise<string> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "private-git-store-"));
  roots.push(root);
  return root;
}
