import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkerConfig, WorkspaceBindingConfig } from "../src/config.ts";
import { loadConfig } from "../src/config.ts";
import type { WorkerCapabilities } from "../src/protocol/types.ts";
import { applyBindingReconciliation } from "../src/workspace/binding-state.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

describe("Workspace binding reconciliation", () => {
  test("zero and valid bindings remain active", async () => {
    const fixture = await setup([]);
    expect(
      applyBindingReconciliation(fixture.config, fixture.capabilities, []),
    ).toEqual({ active: 0, retired: 0, fencedConfigured: 0 });

    const valid = binding(1);
    fixture.config.workspaceBindings.push(valid);
    fixture.capabilities.workspace_bindings.push(valid);
    expect(
      applyBindingReconciliation(fixture.config, fixture.capabilities, [
        outcome(valid, "accepted"),
      ]),
    ).toEqual({ active: 1, retired: 0, fencedConfigured: 0 });
  });

  test("a stale persisted binding is atomically retired without touching unrelated state", async () => {
    const stale = binding(1);
    const fixture = await setup([stale]);
    const unrelated = join(fixture.root, "dispatches.sqlite");
    await writeFile(unrelated, "durable dispatch sentinel");

    expect(
      applyBindingReconciliation(fixture.config, fixture.capabilities, [
        outcome(stale, "stale_workspace"),
      ]),
    ).toEqual({ active: 0, retired: 1, fencedConfigured: 0 });

    const state = JSON.parse(
      await readFile(fixture.config.workspaceBindingsPath as string, "utf8"),
    );
    expect(state.active).toEqual([]);
    expect(state.retired).toEqual([stale]);
    expect(await readFile(unrelated, "utf8")).toBe("durable dispatch sentinel");
  });

  test("mixed and multiple stale outcomes affect only rejected bindings", async () => {
    const validA = binding(1);
    const staleA = binding(2);
    const staleB = binding(3);
    const validB = binding(4);
    const fixture = await setup([validA, staleA, staleB, validB]);

    applyBindingReconciliation(fixture.config, fixture.capabilities, [
      outcome(validA, "accepted"),
      outcome(staleA, "stale_workspace"),
      outcome(staleB, "stale_workspace"),
      outcome(validB, "accepted"),
    ]);

    expect(
      fixture.config.workspaceBindings.map((item) => item.binding_id),
    ).toEqual([validA.binding_id, validB.binding_id]);
    expect(
      fixture.config.retiredWorkspaceBindings?.map((item) => item.binding_id),
    ).toEqual([staleA.binding_id, staleB.binding_id]);
  });

  test("transient or malformed reconciliation preserves local bindings", async () => {
    const local = binding(1);
    const fixture = await setup([local]);
    const before = await readFile(
      fixture.config.workspaceBindingsPath as string,
      "utf8",
    );

    expect(() =>
      applyBindingReconciliation(
        fixture.config,
        fixture.capabilities,
        undefined,
      ),
    ).toThrow("omitted binding reconciliation outcomes");
    expect(fixture.config.workspaceBindings).toEqual([local]);
    expect(
      await readFile(fixture.config.workspaceBindingsPath as string, "utf8"),
    ).toBe(before);
  });

  test("retired persistence does not resurrect on restart", async () => {
    const stale = binding(1);
    const fixture = await setup([stale]);
    applyBindingReconciliation(fixture.config, fixture.capabilities, [
      outcome(stale, "stale_workspace"),
    ]);

    const restarted = loadConfig(environment(fixture.root));
    expect(restarted.workspaceBindings).toEqual([]);
    expect(restarted.retiredWorkspaceBindings).toEqual([stale]);
  });

  test("environment binding is fenced in memory without rewriting configuration", async () => {
    const configured = binding(1);
    const fixture = await setup([], [configured]);
    const before = await readFile(
      fixture.config.workspaceBindingsPath as string,
      "utf8",
    );

    expect(
      applyBindingReconciliation(fixture.config, fixture.capabilities, [
        outcome(configured, "stale_workspace"),
      ]),
    ).toEqual({ active: 0, retired: 0, fencedConfigured: 1 });
    expect(fixture.config.workspaceBindings).toEqual([]);
    expect(fixture.config.retiredWorkspaceBindings).toEqual([configured]);
    expect(
      await readFile(fixture.config.workspaceBindingsPath as string, "utf8"),
    ).toBe(before);
  });
});

async function setup(
  persisted: WorkspaceBindingConfig[],
  configured: WorkspaceBindingConfig[] = [],
) {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "binding-state-"));
  roots.push(root);
  const source = join(root, "source");
  await mkdir(join(source, ".git"), { recursive: true });
  for (const item of [...persisted, ...configured])
    item.source_repository_root = source;
  const workspaceBindingsPath = join(root, "workspace-bindings.json");
  await writeFile(workspaceBindingsPath, JSON.stringify(persisted));
  const config: WorkerConfig = {
    controlPlaneUrl: "ws://127.0.0.1/worker/websocket",
    workerId: "binding-state-test",
    workerToken: "token",
    maxConcurrency: 1,
    tags: [],
    herdrSession: "binding-state-test",
    allowedRoots: [],
    workspaceBindings: [...configured, ...persisted],
    retiredWorkspaceBindings: [],
    configuredWorkspaceBindingIds: configured.map((item) => item.binding_id),
    workspaceBindingsPath,
    worktreeRoot: join(root, "worktrees"),
    dataRoot: root,
    piThinking: "medium",
    heartbeatMs: 10_000,
    reconnectMs: 1_000,
    resultTimeoutMs: 10_000,
    provider: "fake",
    fakeOutputs: {},
    fakeDelayMs: 0,
  };
  const capabilities: WorkerCapabilities = {
    os: "test",
    arch: "test",
    max_concurrency: 1,
    tags: [],
    executors: [],
    workspace_bindings: [...config.workspaceBindings],
  };
  return { root, source, config, capabilities };
}

function environment(root: string): NodeJS.ProcessEnv {
  return {
    QE_CONTROL_PLANE_URL: "ws://127.0.0.1/worker/websocket",
    QE_WORKER_ID: "binding-state-test",
    QE_WORKER_TOKEN: "token",
    QE_ALLOWED_ROOTS_JSON: JSON.stringify([
      {
        key: "projects",
        path: root,
        max_access: "read_write",
        discover_depth: 1,
        allow_unconfined_shell: false,
      },
    ]),
    QE_WORKER_DATA_ROOT: root,
    QE_WORKTREE_ROOT: join(root, "worktrees"),
    QE_WORKER_PROVIDER: "fake",
    QE_ENABLE_TEST_PROVIDER: "1",
  };
}

function binding(index: number): WorkspaceBindingConfig {
  return {
    binding_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    workspace_id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    authorized_root_key: "projects",
    source_repository_root: process.cwd(),
    source_fingerprint: null,
    publication_remote_name: null,
    publication_repository_identity: null,
    max_access: "read_write",
    allow_unconfined_shell: false,
  };
}

function outcome(
  value: WorkspaceBindingConfig,
  status: "accepted" | "stale_workspace",
) {
  return {
    binding_id: value.binding_id,
    workspace_id: value.workspace_id,
    status,
  };
}
