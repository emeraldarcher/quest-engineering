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
import { workerStateDirectoryName } from "../src/managed-path-policy.ts";

const WORKER_ID = "managed-path-test";
const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true, force: true });
});

test("a fresh default bind restarts with the same QE_HOME-derived Worker state and worktree roots", () => {
  const root = fixture();
  const source = gitSource(join(root, "source"));
  const home = join(root, "fresh-home");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const env = workerEnv(root, home);

  const initiallyConfigured = loadConfig({
    ...env,
    QE_WORKSPACE_BINDINGS_JSON: JSON.stringify([binding(source)]),
  });
  expect(initiallyConfigured.qeHome).toBe(realpathSync(join(home, ".qe")));
  expect(initiallyConfigured.dataRoot).toBe(
    realpathSync(
      join(home, ".qe/state/workers", workerStateDirectoryName(WORKER_ID)),
    ),
  );
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

  expect(restarted.qeHome).toBe(initiallyConfigured.qeHome);
  expect(restarted.dataRoot).toBe(initiallyConfigured.dataRoot);
  expect(restarted.worktreeRoot).toBe(initiallyConfigured.worktreeRoot);
  expect(restarted.workspaceBindings).toEqual(
    initiallyConfigured.workspaceBindings,
  );
});

test("QE_HOME moves both loadConfig defaults while a specialized override moves only Worker state", () => {
  const root = fixture();
  const source = gitSource(join(root, "source"));
  const qeHome = join(root, "qe-home");
  const defaulted = loadConfig({
    ...workerEnv(root, join(root, "unused-home")),
    QE_HOME: qeHome,
    QE_WORKSPACE_BINDINGS_JSON: JSON.stringify([binding(source)]),
  });
  expect(defaulted.dataRoot.startsWith(realpathSync(qeHome))).toBe(true);
  expect(defaulted.worktreeRoot).toBe(realpathSync(join(qeHome, "worktrees")));

  const explicitData = join(root, "dedicated-worker-state");
  const specialized = loadConfig({
    ...workerEnv(root, join(root, "unused-home-2")),
    QE_HOME: join(root, "qe-home-2"),
    QE_WORKER_DATA_ROOT: explicitData,
    QE_WORKSPACE_BINDINGS_JSON: JSON.stringify([binding(source)]),
  });
  expect(specialized.dataRoot).toBe(realpathSync(explicitData));
  expect(specialized.worktreeRoot).toBe(
    realpathSync(join(root, "qe-home-2/worktrees")),
  );
});

test("startup rejects an explicit worktree root nested in a persisted source", () => {
  const root = fixture();
  const source = gitSource(join(root, "source"));
  const dataRoot = join(root, "worker-data");
  mkdirSync(dataRoot, { recursive: true });
  writePersistedBinding(dataRoot, source);

  expect(() =>
    loadConfig({
      ...workerEnv(root, join(root, "home")),
      QE_WORKER_DATA_ROOT: dataRoot,
      QE_WORKSPACE_BINDINGS_JSON: "[]",
      QE_WORKTREE_ROOT: join(source, "managed-worktrees"),
    }),
  ).toThrow(expect.objectContaining({ code: "worktree_source_overlap" }));
});

test("startup rejects persisted source overlap with an explicit Worker data root", () => {
  const root = fixture();
  const source = gitSource(join(root, "source"));
  const dataRoot = join(source, "worker-data");
  mkdirSync(dataRoot, { recursive: true });
  writePersistedBinding(dataRoot, source);

  expect(() =>
    loadConfig({
      ...workerEnv(root, join(root, "home")),
      QE_WORKER_DATA_ROOT: dataRoot,
      QE_WORKSPACE_BINDINGS_JSON: "[]",
      QE_WORKTREE_ROOT: join(root, "worktrees"),
    }),
  ).toThrow(expect.objectContaining({ code: "worker_state_source_overlap" }));
});

test("startup rejects a persisted source nested in the managed worktree root", () => {
  const root = fixture();
  const managed = join(root, "managed-worktrees");
  const source = gitSource(join(managed, "source"));
  const dataRoot = join(root, "worker-data");
  mkdirSync(dataRoot, { recursive: true });
  writePersistedBinding(dataRoot, source);

  expect(() =>
    loadConfig({
      ...workerEnv(managed, join(root, "home")),
      QE_WORKER_DATA_ROOT: dataRoot,
      QE_WORKSPACE_BINDINGS_JSON: "[]",
      QE_WORKTREE_ROOT: managed,
    }),
  ).toThrow(expect.objectContaining({ code: "worktree_source_overlap" }));
});

function workerEnv(allowedRoot: string, home: string): NodeJS.ProcessEnv {
  return {
    HOME: home,
    QE_CONTROL_PLANE_URL: "ws://127.0.0.1:4002/worker/websocket",
    QE_WORKER_ID: WORKER_ID,
    QE_WORKER_TOKEN: "test-token",
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

function writePersistedBinding(dataRoot: string, source: string): void {
  writeFileSync(
    join(dataRoot, "workspace-bindings.json"),
    JSON.stringify({ version: 2, active: [binding(source)], retired: [] }),
  );
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
