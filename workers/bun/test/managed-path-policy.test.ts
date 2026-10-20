import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import {
  assertSourceHostSeparation,
  provisionManagedHostPaths,
  selectManagedHostPaths,
  workerStateDirectoryName,
} from "../src/managed-path-policy.ts";

const WORKER_ID = "managed-path-test";
const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    try {
      chmodSync(fixture, 0o700);
    } catch {
      // A nested permission fixture may already have been removed.
    }
    rmSync(fixture, { recursive: true, force: true });
  }
});

describe("canonical QE host path policy", () => {
  test("Worker state directory identity has one stable collision-resistant format", () => {
    expect(workerStateDirectoryName(WORKER_ID)).toBe(
      "worker-01f217468cc1aca768d6405a7bf2cbe858cb30e30fc7ceb97b4463fcddcab971",
    );
  });

  test("empty HOME creates one private current-format QE layout", () => {
    const root = fixture();
    const home = join(root, "fresh-home");
    mkdirSync(home, { recursive: true, mode: 0o700 });

    const paths = provisionManagedHostPaths({ HOME: home }, WORKER_ID);

    expect(paths.qeHome).toBe(realpathSync(join(home, ".qe")));
    expect(paths.dataRoot).toBe(
      realpathSync(
        join(home, ".qe/state/workers", workerStateDirectoryName(WORKER_ID)),
      ),
    );
    expect(paths.worktreeRoot).toBe(realpathSync(join(home, ".qe/worktrees")));
    expect(paths.dataRootSource).toBe("QE_HOME");
    expect(paths.worktreeRootSource).toBe("QE_HOME");
    for (const path of [
      paths.qeHome,
      join(paths.qeHome, "state"),
      join(paths.qeHome, "state/workers"),
      paths.dataRoot,
      paths.worktreeRoot,
    ]) {
      expect(existsSync(path)).toBe(true);
      if (process.platform !== "win32")
        expect(lstatSync(path).mode & 0o077).toBe(0);
    }
  });

  test("selection from inside this checkout resolves every default outside the checkout", () => {
    const checkout = realpathSync(resolve(import.meta.dir, "../../.."));
    const externalUserHome = join(resolve(checkout, ".."), "qe-isolated-user");
    const qeHome = join(externalUserHome, ".qe");
    const existedBefore = existsSync(qeHome);
    const selected = selectManagedHostPaths(
      { HOME: externalUserHome },
      WORKER_ID,
    );

    for (const path of [
      selected.qeHome,
      selected.dataRoot,
      selected.worktreeRoot,
    ])
      expect(relative(checkout, path).startsWith("..")).toBe(true);
    expect(existsSync(qeHome)).toBe(existedBefore);
  });

  test("the built-in OS user-home fallback is portable when HOME is absent", () => {
    const root = fixture();
    const fallbackHome = join(root, "os-user-home");
    const paths = provisionManagedHostPaths({}, WORKER_ID, fallbackHome);

    expect(paths.qeHome).toBe(realpathSync(join(fallbackHome, ".qe")));
    expect(paths.dataRoot.startsWith(paths.qeHome)).toBe(true);
    expect(paths.worktreeRoot).toBe(
      realpathSync(join(paths.qeHome, "worktrees")),
    );
  });

  test("all host-root inputs must be absolute and never become cwd-dependent", () => {
    for (const env of [
      { HOME: "relative-home" },
      { QE_HOME: "relative-qe-home" },
      { QE_WORKER_DATA_ROOT: "relative-worker-state" },
      { QE_WORKTREE_ROOT: "relative-worktrees" },
    ]) {
      expect(() =>
        provisionManagedHostPaths(env, WORKER_ID, resolve(".pi/fallback-home")),
      ).toThrow(expect.objectContaining({ code: "managed_path_not_absolute" }));
    }
  });

  test("QE_HOME coherently relocates Worker state and worktrees", () => {
    const root = fixture();
    const qeHome = join(root, "managed-data");
    const paths = provisionManagedHostPaths(
      { HOME: join(root, "other-home"), QE_HOME: qeHome },
      WORKER_ID,
    );

    expect(paths.qeHome).toBe(realpathSync(qeHome));
    expect(paths.dataRoot).toBe(
      realpathSync(
        join(qeHome, "state/workers", workerStateDirectoryName(WORKER_ID)),
      ),
    );
    expect(paths.worktreeRoot).toBe(realpathSync(join(qeHome, "worktrees")));
  });

  test("QE_WORKER_DATA_ROOT moves only Worker durable state", () => {
    const root = fixture();
    const qeHome = join(root, "qe-home");
    const explicitData = join(root, "dedicated-worker-volume");
    const paths = provisionManagedHostPaths(
      {
        QE_HOME: qeHome,
        QE_WORKER_DATA_ROOT: explicitData,
      },
      WORKER_ID,
    );

    expect(paths.dataRootSource).toBe("QE_WORKER_DATA_ROOT");
    expect(paths.dataRoot).toBe(realpathSync(explicitData));
    expect(paths.worktreeRoot).toBe(realpathSync(join(qeHome, "worktrees")));
  });

  test("QE_WORKTREE_ROOT moves only managed Run repositories", () => {
    const root = fixture();
    const qeHome = join(root, "qe-home");
    const explicitWorktrees = join(root, "dedicated-worktree-volume");
    const paths = provisionManagedHostPaths(
      {
        QE_HOME: qeHome,
        QE_WORKTREE_ROOT: explicitWorktrees,
      },
      WORKER_ID,
    );

    expect(paths.worktreeRootSource).toBe("QE_WORKTREE_ROOT");
    expect(paths.worktreeRoot).toBe(realpathSync(explicitWorktrees));
    expect(paths.dataRoot.startsWith(realpathSync(qeHome))).toBe(true);
  });

  test("specialized Worker-state and worktree overrides cannot overlap", () => {
    const root = fixture();
    const shared = join(root, "shared");
    expect(() =>
      provisionManagedHostPaths(
        {
          QE_HOME: join(root, "qe-home"),
          QE_WORKER_DATA_ROOT: shared,
          QE_WORKTREE_ROOT: join(shared, "worktrees"),
        },
        WORKER_ID,
      ),
    ).toThrow(expect.objectContaining({ code: "managed_roots_overlap" }));
  });

  test("a non-directory collision fails with a typed actionable error", () => {
    const root = fixture();
    const collision = join(root, "collision");
    writeFileSync(collision, "not a directory");

    expect(() =>
      provisionManagedHostPaths(
        { QE_HOME: join(root, "qe-home"), QE_WORKER_DATA_ROOT: collision },
        WORKER_ID,
      ),
    ).toThrow(
      expect.objectContaining({ code: "managed_directory_not_directory" }),
    );
  });

  test.skipIf(process.platform === "win32")(
    "an existing group/world-writable override fails closed",
    () => {
      const root = fixture();
      const unsafe = join(root, "unsafe-permissions");
      mkdirSync(unsafe, { mode: 0o777 });
      chmodSync(unsafe, 0o777);

      expect(() =>
        provisionManagedHostPaths(
          { QE_HOME: join(root, "qe-home"), QE_WORKTREE_ROOT: unsafe },
          WORKER_ID,
        ),
      ).toThrow(
        expect.objectContaining({
          code: "managed_directory_unsafe_permissions",
        }),
      );
    },
  );

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "an existing unwritable override fails before Worker startup",
    () => {
      const root = fixture();
      const unwritable = join(root, "unwritable");
      mkdirSync(unwritable, { mode: 0o500 });
      try {
        expect(() =>
          provisionManagedHostPaths(
            { QE_HOME: join(root, "qe-home"), QE_WORKTREE_ROOT: unwritable },
            WORKER_ID,
          ),
        ).toThrow(
          expect.objectContaining({
            code: "managed_directory_creation_failed",
          }),
        );
      } finally {
        chmodSync(unwritable, 0o700);
      }
    },
  );

  test("QE home, Worker state, and worktrees each reject both source nesting directions", () => {
    const root = fixture();
    const cases = [
      { component: "qeHome", code: "qe_home_source_overlap" },
      { component: "dataRoot", code: "worker_state_source_overlap" },
      { component: "worktreeRoot", code: "worktree_source_overlap" },
    ] as const;

    for (const [index, item] of cases.entries()) {
      for (const direction of [
        "managed-in-source",
        "source-in-managed",
        "equal",
      ] as const) {
        const caseRoot = join(root, `${index}-${direction}`);
        const source =
          direction === "equal"
            ? join(caseRoot, "same")
            : direction === "managed-in-source"
              ? join(caseRoot, "source")
              : join(caseRoot, "managed", "source");
        const managed =
          direction === "equal"
            ? source
            : direction === "managed-in-source"
              ? join(source, "managed")
              : join(caseRoot, "managed");
        const paths = {
          qeHome: join(caseRoot, "qe-home"),
          dataRoot: join(caseRoot, "worker-state"),
          worktreeRoot: join(caseRoot, "worktrees"),
        };
        paths[item.component] = managed;
        for (const path of [
          source,
          paths.qeHome,
          paths.dataRoot,
          paths.worktreeRoot,
        ])
          mkdirSync(path, { recursive: true });

        expect(() => assertSourceHostSeparation(source, paths)).toThrow(
          expect.objectContaining({ code: item.code }),
        );
      }
    }
  });

  test.skipIf(process.platform === "win32")(
    "canonical paths reject symlink aliases into a source",
    () => {
      const root = fixture();
      const source = join(root, "source");
      const outside = join(root, "outside");
      const linkedWorktrees = join(outside, "worktrees");
      mkdirSync(join(source, "actual-worktrees"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(join(source, "actual-worktrees"), linkedWorktrees, "dir");
      const paths = {
        qeHome: join(root, "qe-home"),
        dataRoot: join(root, "worker-state"),
        worktreeRoot: linkedWorktrees,
      };
      mkdirSync(paths.qeHome);
      mkdirSync(paths.dataRoot);

      expect(() => assertSourceHostSeparation(source, paths)).toThrow(
        expect.objectContaining({ code: "worktree_source_overlap" }),
      );
    },
  );
});

function fixture(): string {
  const parent = resolve(".pi/tmp");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "managed-path-policy-"));
  fixtures.push(root);
  return root;
}
