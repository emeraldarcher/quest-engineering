import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workerCapabilities } from "../src/capabilities.ts";
import type { WorkerConfig } from "../src/config.ts";
import { RunWorktreeRegistry } from "../src/workspace/run-worktrees.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("isolates simultaneous Runs and serializes linked bindings by Git common directory", async () => {
  const fixture = await setup();
  const registry = new RunWorktreeRegistry(fixture.config);
  await writeFile(join(fixture.source, "dirty-only.txt"), "excluded\n");

  const [first, second] = await Promise.all([
    registry.provision(request("1", workspace(1), binding(1))),
    registry.provision(request("2", workspace(2), binding(2))),
  ]);

  expect(first.state).toBe("ready");
  expect(second.state).toBe("ready");
  expect(first.canonicalRoot).not.toBe(second.canonicalRoot);
  expect(first.branchName).not.toBe(second.branchName);
  expect(first.gitCommonDir).toBe(second.gitCommonDir);
  expect(first.sourceDirtyExcluded).toBe(true);
  expect(
    await Bun.file(join(first.canonicalRoot, "dirty-only.txt")).exists(),
  ).toBe(false);

  await command([
    "git",
    "-C",
    first.canonicalRoot,
    "switch",
    "-q",
    "-c",
    "sabotage",
  ]);
  const fenced = await registry.verify(first.worktreeId);
  expect(fenced.state).toBe("attention_required");
  expect(fenced.failureCode).toBe("run_worktree_branch_mismatch");

  const retiredBinding = fixture.config.workspaceBindings.pop();
  expect(retiredBinding?.binding_id).toBe(binding(2));
  fixture.config.retiredWorkspaceBindings = retiredBinding
    ? [retiredBinding]
    : [];

  registry.close();
  const restarted = new RunWorktreeRegistry(fixture.config);
  expect((await restarted.verify(second.worktreeId)).state).toBe("ready");
  expect(
    workerCapabilities(fixture.config, "test", "test").workspace_bindings.some(
      (item) => item.binding_id === binding(2),
    ),
  ).toBe(false);
  await expect(
    restarted.provision(request("3", workspace(2), binding(2))),
  ).rejects.toMatchObject({ code: "run_worktree_binding_mismatch" });
  expect(
    restarted.get(request("3", workspace(2), binding(2)).worktree_id),
  ).toBe(null);
  expect((await restarted.cleanup(second.worktreeId)).state).toBe("removed");
  restarted.close();
});

function request(id: string, workspaceId: string, bindingId: string) {
  const stable = id.repeat(32);
  return {
    worktree_id: `00000000-0000-4000-8000-00000000000${id}`,
    run_id: `run-${id}`,
    workspace_id: workspaceId,
    workspace_binding_id: bindingId,
    base: { kind: "binding_head_v1" as const },
    branch_name: `qe/run/${stable}`,
    identity_hash: `identity-${id}`,
  };
}
function workspace(id: number): string {
  return `10000000-0000-4000-8000-00000000000${id}`;
}
function binding(id: number): string {
  return `20000000-0000-4000-8000-00000000000${id}`;
}

async function setup() {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "run-worktrees-"));
  roots.push(root);
  const source = join(root, "source");
  const linked = join(root, "linked-source");
  await mkdir(source);
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
  await command([
    "git",
    "-C",
    source,
    "worktree",
    "add",
    "-q",
    "-b",
    "linked-source",
    linked,
    "HEAD",
  ]);
  const config: WorkerConfig = {
    controlPlaneUrl: "ws://localhost/worker/websocket",
    workerId: "worktree-test",
    workerToken: "token",
    maxConcurrency: 2,
    tags: [],
    herdrSession: "test-herdr",
    allowedRoots: [
      {
        key: "fixtures",
        path: root,
        max_access: "read_write",
        discover_depth: 2,
        allow_unconfined_shell: true,
      },
    ],
    workspaceBindings: [
      {
        binding_id: binding(1),
        workspace_id: workspace(1),
        authorized_root_key: "fixtures",
        source_repository_root: source,
        max_access: "read_write",
        allow_unconfined_shell: true,
      },
      {
        binding_id: binding(2),
        workspace_id: workspace(2),
        authorized_root_key: "fixtures",
        source_repository_root: linked,
        max_access: "read_write",
        allow_unconfined_shell: true,
      },
    ],
    worktreeRoot: join(root, "managed"),
    executorModels: [{ provider: "fake", model: "test" }],
    reasoningLevels: ["low", "medium", "high"],
    dataRoot: join(root, "data"),
    piThinking: "medium",
    heartbeatMs: 1000,
    reconnectMs: 1000,
    resultTimeoutMs: 1000,
    provider: "fake",
    fakeOutputs: {},
    fakeDelayMs: 0,
  };
  await mkdir(config.worktreeRoot, { recursive: true });
  return { root, source, config };
}
async function command(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  const error = await new Response(child.stderr).text();
  const code = await child.exited;
  if (code !== 0) throw new Error(`${argv.join(" ")} failed: ${error}`);
}
