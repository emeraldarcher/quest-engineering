import { afterEach, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true, force: true });
});

test("a persisted bind restarts with the same automatic per-user worktree root", () => {
  const root = fixture();
  const source = gitSource(join(root, "source"));
  const home = join(root, "fresh-home");
  const dataRoot = join(root, "worker-data");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = workerEnv(root, source, home, dataRoot);

  const initiallyConfigured = loadConfig({
    ...env,
    QE_WORKSPACE_BINDINGS_JSON: JSON.stringify([binding(source)]),
  });
  expect(initiallyConfigured.worktreeRoot).toBe(
    realpathSync(join(home, ".qe/worktrees")),
  );

  const bindingsPath = initiallyConfigured.workspaceBindingsPath;
  if (!bindingsPath) throw new Error("binding state path was not configured");
  writeFileSync(
    bindingsPath,
    JSON.stringify({
      version: 2,
      active: initiallyConfigured.workspaceBindings,
      retired: [],
    }),
  );
  const restarted = loadConfig({
    ...env,
    QE_WORKSPACE_BINDINGS_JSON: "[]",
  });

  expect(restarted.worktreeRoot).toBe(initiallyConfigured.worktreeRoot);
  expect(restarted.workspaceBindings).toEqual(
    initiallyConfigured.workspaceBindings,
  );
});

test("startup rejects an explicit worktree root nested in a persisted source", () => {
  const root = fixture();
  const source = gitSource(join(root, "source"));
  const dataRoot = join(root, "worker-data");
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    join(dataRoot, "workspace-bindings.json"),
    JSON.stringify({ version: 2, active: [binding(source)], retired: [] }),
  );

  expect(() =>
    loadConfig({
      ...workerEnv(root, source, join(root, "home"), dataRoot),
      QE_WORKSPACE_BINDINGS_JSON: "[]",
      QE_WORKTREE_ROOT: join(source, "managed-worktrees"),
    }),
  ).toThrow(expect.objectContaining({ code: "worktree_source_overlap" }));
});

test("startup rejects a persisted source nested in the managed root", () => {
  const root = fixture();
  const managed = join(root, "managed-worktrees");
  const source = gitSource(join(managed, "source"));
  const dataRoot = join(root, "worker-data");
  mkdirSync(dataRoot, { recursive: true });
  writeFileSync(
    join(dataRoot, "workspace-bindings.json"),
    JSON.stringify({ version: 2, active: [binding(source)], retired: [] }),
  );

  expect(() =>
    loadConfig({
      ...workerEnv(managed, source, join(root, "home"), dataRoot),
      QE_WORKSPACE_BINDINGS_JSON: "[]",
      QE_WORKTREE_ROOT: managed,
    }),
  ).toThrow(expect.objectContaining({ code: "worktree_source_overlap" }));
});

function workerEnv(
  allowedRoot: string,
  _source: string,
  home: string,
  dataRoot: string,
): NodeJS.ProcessEnv {
  return {
    HOME: home,
    QE_CONTROL_PLANE_URL: "ws://127.0.0.1:4002/worker/websocket",
    QE_WORKER_ID: "managed-path-test",
    QE_WORKER_TOKEN: "test-token",
    QE_WORKER_DATA_ROOT: dataRoot,
    QE_ALLOWED_ROOTS_JSON: JSON.stringify([
      {
        key: "fixture",
        path: allowedRoot,
        max_access: "read_write",
        discover_depth: 2,
        allow_unconfined_shell: false,
      },
    ]),
    QE_WORKER_PROVIDER: "fake",
    QE_ENABLE_TEST_PROVIDER: "1",
    QE_HERDR_SESSION: "q",
    XDG_CONFIG_HOME: resolve(".pi"),
  };
}

function binding(source: string): Record<string, unknown> {
  return {
    binding_id: "10000000-0000-4000-8000-000000000001",
    workspace_id: "20000000-0000-4000-8000-000000000002",
    authorized_root_key: "fixture",
    source_repository_root: source,
    max_access: "read_write",
    allow_unconfined_shell: false,
  };
}

function gitSource(path: string): string {
  mkdirSync(path, { recursive: true });
  command(["git", "init", "-q", path]);
  writeFileSync(join(path, "README.md"), "# managed path fixture\n");
  command(["git", "-C", path, "add", "README.md"]);
  command([
    "git",
    "-C",
    path,
    "-c",
    "user.name=Quest Engineering",
    "-c",
    "user.email=quest@example.invalid",
    "commit",
    "-q",
    "-m",
    "fixture",
  ]);
  return realpathSync(path);
}

function command(argv: string[]): void {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString() || `command failed: ${argv[0]}`);
}

function fixture(): string {
  const parent = resolve(".pi/tmp");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "config-managed-path-"));
  fixtures.push(root);
  return root;
}
