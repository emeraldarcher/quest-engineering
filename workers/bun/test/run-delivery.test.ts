import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  open,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join, relative } from "node:path";
import type { WorkerConfig } from "../src/config.ts";
import {
  DELIVERY_REGULAR_FILE_INSPECTION_LIMIT_BYTES,
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
    await succeeds([
      "git",
      "-C",
      fixture.source,
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${record.branchName}`,
    ]),
  ).toBe(false);
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

test("regular untracked numstat and tracked Delivery evidence retain their existing semantics", async () => {
  const fixture = await setup({ identity: true });
  const sourceBefore = await repositoryState(fixture.source);
  const worktrees = new RunWorktreeRegistry(fixture.config);
  const record = await worktrees.provision(request());
  await worktrees.retain(record.worktreeId);
  await writeFile(join(record.canonicalRoot, "README.md"), "changed\n");
  await writeFile(join(record.canonicalRoot, "ordinary.txt"), "one\ntwo\n");
  const deliveries = new RunDeliveryRegistry(fixture.config, worktrees);

  const inspected = await deliveries.inspect(delivery());

  expect(inspected.evidence.files).toEqual([
    {
      path: "README.md",
      status: "modified",
      additions: 1,
      deletions: 1,
      binary: false,
    },
    {
      path: "ordinary.txt",
      status: "added",
      additions: 3,
      deletions: 0,
      binary: false,
    },
  ]);
  expect(inspected.evidence.summary).toEqual({
    files_changed: 2,
    additions: 4,
    deletions: 1,
  });
  expect(await repositoryState(fixture.source)).toBe(sourceBefore);
  deliveries.close();
  worktrees.close();
});

test("Delivery preserves every untracked symlink form without opening or traversing its target", async () => {
  const fixture = await setup({ identity: true });
  const sourceBefore = await repositoryState(fixture.source);
  const worktrees = new RunWorktreeRegistry(fixture.config);
  const record = await worktrees.provision(request());
  await worktrees.retain(record.worktreeId);
  const root = record.canonicalRoot;
  const sentinel = join(fixture.root, "host-sentinel.txt");
  const sentinelText = "DELIVERY_MUST_NOT_READ_THIS_SENTINEL";
  const externalDirectory = join(fixture.root, "external-directory");
  const largeTarget = join(fixture.root, "large-external-target.bin");
  await writeFile(sentinel, sentinelText);
  await mkdir(externalDirectory);
  await writeFile(join(externalDirectory, "outside.txt"), sentinelText);
  const large = await open(largeTarget, "w");
  await large.truncate(DELIVERY_REGULAR_FILE_INSPECTION_LIMIT_BYTES * 128);
  await large.close();
  await mkdir(join(root, "nested"));
  const targets = new Map([
    ["relative-link", "README.md"],
    ["escaping-link", relative(root, sentinel)],
    ["absolute-link", sentinel],
    ["dangling-link", "missing-target"],
    ["directory-link", externalDirectory],
    ["nested/link", sentinel],
    ["large-link", largeTarget],
  ]);
  for (const [path, target] of targets) await symlink(target, join(root, path));
  const attemptedOpens: string[] = [];
  const openedFiles: string[] = [];
  const deliveries = new RunDeliveryRegistry(
    fixture.config,
    worktrees,
    undefined,
    {
      beforeRegularFileOpen: (path) => {
        attemptedOpens.push(path);
      },
      regularFileOpened: (path) => {
        openedFiles.push(path);
      },
    },
  );

  const inspected = await deliveries.inspect(delivery());
  const repeated = await deliveries.inspect(delivery());

  expect(inspected.evidence.files).toEqual(
    [...targets.keys()].sort().map((path) => ({
      path,
      status: "added",
      additions: 1,
      deletions: 0,
      binary: false,
    })),
  );
  expect(
    inspected.evidence.files.some((file) =>
      file.path.startsWith("directory-link/"),
    ),
  ).toBe(false);
  expect(inspected.fingerprint).toBe(repeated.fingerprint);
  expect(JSON.stringify(inspected)).not.toContain(sentinelText);
  expect(attemptedOpens).toEqual([]);
  expect(openedFiles).toEqual([]);
  for (const [path, target] of targets)
    expect(await readlink(join(root, path))).toBe(target);

  const published = await deliveries.publish(
    { ...delivery(), expected_fingerprint: inspected.fingerprint },
    "Symlink delivery",
  );
  expect(published.fingerprint).toBe(inspected.fingerprint);
  expect(attemptedOpens).toEqual([]);
  expect(openedFiles).toEqual([]);
  expect(
    await output([
      "git",
      "--git-dir",
      fixture.remote,
      "cat-file",
      "-p",
      `${record.branchName}:absolute-link`,
    ]),
  ).toBe(sentinel);
  expect(await repositoryState(fixture.source)).toBe(sourceBefore);
  deliveries.close();
  worktrees.close();
});

test("large untracked regular files fail before content is opened or exact statistics are reported", async () => {
  const fixture = await setup({ identity: true });
  const worktrees = new RunWorktreeRegistry(fixture.config);
  const record = await worktrees.provision(request());
  await worktrees.retain(record.worktreeId);
  const largePath = join(record.canonicalRoot, "large-regular.txt");
  const large = await open(largePath, "w");
  await large.truncate(DELIVERY_REGULAR_FILE_INSPECTION_LIMIT_BYTES + 1);
  await large.close();
  const attemptedOpens: string[] = [];
  const deliveries = new RunDeliveryRegistry(
    fixture.config,
    worktrees,
    undefined,
    {
      beforeRegularFileOpen: (path) => {
        attemptedOpens.push(path);
      },
    },
  );

  await expect(deliveries.inspect(delivery())).rejects.toMatchObject({
    code: "delivery_file_inspection_too_large",
  });
  expect(attemptedOpens).toEqual([]);
  deliveries.close();
  worktrees.close();
});

test("regular-file type mutation is revalidated with no-follow open and fails closed", async () => {
  const fixture = await setup({ identity: true });
  const worktrees = new RunWorktreeRegistry(fixture.config);
  const record = await worktrees.provision(request());
  await worktrees.retain(record.worktreeId);
  const sentinel = join(fixture.root, "race-sentinel.txt");
  const candidate = join(record.canonicalRoot, "raced.txt");
  await writeFile(sentinel, "RACE_SENTINEL_MUST_NOT_BE_OPENED");
  await writeFile(candidate, "ordinary\n");
  let attempts = 0;
  const openedFiles: string[] = [];
  const deliveries = new RunDeliveryRegistry(
    fixture.config,
    worktrees,
    undefined,
    {
      beforeRegularFileOpen: async (path) => {
        attempts += 1;
        if (attempts !== 2) return;
        await unlink(path);
        await symlink(sentinel, path);
      },
      regularFileOpened: (path) => {
        openedFiles.push(path);
      },
    },
  );

  await expect(deliveries.inspect(delivery())).rejects.toMatchObject({
    code: "delivery_entry_changed",
  });
  expect(attempts).toBe(2);
  expect(openedFiles).toEqual([candidate]);
  expect(await readlink(candidate)).toBe(sentinel);
  deliveries.close();
  worktrees.close();
});

test("unsupported special entries are rejected without opening them", async () => {
  if (process.platform === "win32") return;
  const fixture = await setup({ identity: true });
  const worktrees = new RunWorktreeRegistry(fixture.config);
  const record = await worktrees.provision(request());
  await worktrees.retain(record.worktreeId);
  const fifo = join(record.canonicalRoot, "README.md");
  await unlink(fifo);
  await command(["mkfifo", fifo]);
  const attemptedOpens: string[] = [];
  const deliveries = new RunDeliveryRegistry(
    fixture.config,
    worktrees,
    undefined,
    {
      beforeRegularFileOpen: (path) => {
        attemptedOpens.push(path);
      },
    },
  );

  await expect(deliveries.inspect(delivery())).rejects.toMatchObject({
    code: "delivery_entry_unsupported",
  });
  expect(attemptedOpens).toEqual([]);
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
async function succeeds(argv: string[]): Promise<boolean> {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
  return (await child.exited) === 0;
}

async function repositoryState(root: string): Promise<string> {
  return `${await output(["git", "-C", root, "rev-parse", "HEAD"])}\n${await output(
    ["git", "-C", root, "status", "--porcelain=v1", "--untracked-files=all"],
  )}`;
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
