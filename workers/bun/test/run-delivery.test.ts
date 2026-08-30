import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import {
  DeliveryError,
  RunDeliveryRegistry,
} from "../src/workspace/run-delivery.ts";
import { RunWorktreeRegistry } from "../src/workspace/run-worktrees.ts";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  ),
);

test("preserves agent commits, finalizes remaining files once, pushes, and safely cleans up", async () => {
  const fixture = await setup({ identity: true });
  const worktrees = new RunWorktreeRegistry(fixture.config);
  const record = await worktrees.provision(request());
  await worktrees.retain(record.worktreeId);
  await writeFile(join(record.canonicalRoot, "agent.txt"), "committed\n");
  await command([
    "git",
    "-C",
    record.canonicalRoot,
    "-c",
    "user.name=Agent",
    "-c",
    "user.email=agent@example.invalid",
    "add",
    "agent.txt",
  ]);
  await command([
    "git",
    "-C",
    record.canonicalRoot,
    "-c",
    "user.name=Agent",
    "-c",
    "user.email=agent@example.invalid",
    "commit",
    "-q",
    "-m",
    "agent commit",
  ]);
  await writeFile(join(record.canonicalRoot, "final.txt"), "uncommitted\n");
  const deliveries = new RunDeliveryRegistry(fixture.config, worktrees);
  const inspected = await deliveries.inspect(delivery());
  expect(inspected.noChanges).toBe(false);
  expect(inspected.evidence.summary.files_changed).toBe(2);
  const published = await deliveries.publish(
    { ...delivery(), expected_fingerprint: inspected.fingerprint },
    "Safe title\nignored",
  );
  expect(published.headRevision).toHaveLength(40);
  expect(
    await output([
      "git",
      "-C",
      record.canonicalRoot,
      "log",
      "-1",
      "--format=%s",
    ]),
  ).toBe("Quest: Safe title ignored");
  expect(
    await output([
      "git",
      "--git-dir",
      fixture.remote,
      "rev-parse",
      `refs/heads/${record.branchName}`,
    ]),
  ).toBe(published.headRevision);
  const removed = await worktrees.cleanup(record.worktreeId);
  expect(removed.state).toBe("removed");
  expect((await worktrees.cleanup(record.worktreeId)).state).toBe("removed");
  expect(
    await output([
      "git",
      "-C",
      fixture.source,
      "rev-parse",
      `refs/heads/${record.branchName}`,
    ]),
  ).toBe(published.headRevision);
  expect(
    await output([
      "git",
      "--git-dir",
      fixture.remote,
      "rev-parse",
      `refs/heads/${record.branchName}`,
    ]),
  ).toBe(published.headRevision);
  deliveries.close();
  worktrees.close();
});

test("no changes is authoritative and does not publish", async () => {
  const fixture = await setup({ identity: true });
  const worktrees = new RunWorktreeRegistry(fixture.config);
  const record = await worktrees.provision(request());
  await worktrees.retain(record.worktreeId);
  const deliveries = new RunDeliveryRegistry(fixture.config, worktrees);
  const inspected = await deliveries.inspect(delivery());
  expect(inspected.noChanges).toBe(true);
  expect(inspected.evidence.files).toEqual([]);
  deliveries.close();
  worktrees.close();
});

test("invalid identity and conflicting remote branch are structured attention failures", async () => {
  const fixture = await setup({ identity: false });
  const worktrees = new RunWorktreeRegistry(fixture.config);
  const record = await worktrees.provision(request());
  await worktrees.retain(record.worktreeId);
  await writeFile(join(record.canonicalRoot, "change.txt"), "change\n");
  const deliveries = new RunDeliveryRegistry(fixture.config, worktrees);
  const inspected = await deliveries.inspect(delivery());
  await expect(
    deliveries.publish(
      {
        ...delivery(),
        expected_fingerprint: inspected.fingerprint,
        repository_identity: "upstream/repo",
      },
      "title",
    ),
  ).rejects.toMatchObject({
    code: "cross_repository_pull_request_not_supported",
  });

  fixture.config.gitAuthorName = "QE";
  await expect(
    deliveries.publish(
      { ...delivery(), expected_fingerprint: inspected.fingerprint },
      "title",
    ),
  ).rejects.toMatchObject({ code: "git_identity_invalid" });

  fixture.config.gitAuthorEmail = "qe@example.invalid";
  await command([
    "git",
    "-C",
    fixture.source,
    "push",
    "origin",
    `HEAD:refs/heads/${record.branchName}`,
  ]);
  await expect(
    deliveries.publish(
      { ...delivery(), expected_fingerprint: inspected.fingerprint },
      "title",
    ),
  ).rejects.toMatchObject({ code: "remote_branch_conflict" });
  deliveries.close();
  worktrees.close();
});

function request() {
  return {
    worktree_id: "00000000-0000-4000-8000-000000000001",
    run_id: "run-delivery",
    workspace_id: "10000000-0000-4000-8000-000000000001",
    workspace_binding_id: "20000000-0000-4000-8000-000000000001",
    base: { kind: "binding_head_v1" as const },
    branch_name: "qe/run/11111111111111111111111111111111",
    identity_hash: "identity-delivery",
  };
}
function delivery() {
  return {
    delivery_id: "30000000-0000-4000-8000-000000000001",
    command_revision: 1,
    run_id: "run-delivery",
    worktree_id: request().worktree_id,
    workspace_binding_id: request().workspace_binding_id,
    identity_hash: request().identity_hash,
    branch_name: request().branch_name,
  };
}
async function setup(options: { identity: boolean }) {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "run-delivery-"));
  roots.push(root);
  const source = join(root, "source");
  const remote = join(root, "remote.git");
  await mkdir(source);
  await command(["git", "init", "-q", "--bare", remote]);
  await command(["git", "init", "-q", source]);
  await writeFile(join(source, "README.md"), "# fixture\n");
  await command(["git", "-C", source, "add", "README.md"]);
  await command([
    "git",
    "-C",
    source,
    "-c",
    "user.name=QE",
    "-c",
    "user.email=qe@example.invalid",
    "commit",
    "-q",
    "-m",
    "fixture",
  ]);
  await command(["git", "-C", source, "remote", "add", "origin", remote]);
  await command(["git", "-C", source, "push", "-q", "origin", "HEAD"]);
  const config: WorkerConfig = {
    controlPlaneUrl: "ws://localhost",
    workerId: "delivery-test",
    workerToken: "token",
    maxConcurrency: 1,
    tags: [],
    herdrSession: "test",
    allowedRoots: [
      {
        key: "fixtures",
        path: root,
        max_access: "read_write",
        discover_depth: 1,
        allow_unconfined_shell: true,
      },
    ],
    workspaceBindings: [
      {
        binding_id: request().workspace_binding_id,
        workspace_id: request().workspace_id,
        authorized_root_key: "fixtures",
        source_repository_root: source,
        publication_remote_name: "origin",
        publication_repository_identity: "owner/repo",
        max_access: "read_write",
        allow_unconfined_shell: true,
      },
    ],
    worktreeRoot: join(root, "managed"),
    executorModels: [{ provider: "fake", model: "test" }],
    reasoningLevels: ["low"],
    dataRoot: join(root, "data"),
    piThinking: "low",
    heartbeatMs: 1000,
    reconnectMs: 1000,
    resultTimeoutMs: 1000,
    provider: "fake",
    fakeOutputs: {},
    fakeDelayMs: 0,
    ...(options.identity
      ? { gitAuthorName: "QE", gitAuthorEmail: "qe@example.invalid" }
      : {}),
  };
  await mkdir(config.worktreeRoot, { recursive: true });
  return { root, source, remote, config };
}
async function command(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0)
    throw new DeliveryError("command_failed", `${argv.join(" ")}: ${err}`);
}
async function output(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(err);
  return out.trim();
}
