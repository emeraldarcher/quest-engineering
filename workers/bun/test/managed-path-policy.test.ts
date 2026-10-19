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
import { join, resolve } from "node:path";
import {
  assertSourceWorktreeSeparation,
  provisionManagedWorktreePaths,
} from "../src/managed-path-policy.ts";

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

describe("managed QE worktree path policy", () => {
  test("first run creates a stable private per-user default independent of data root", () => {
    const root = fixture();
    const home = join(root, "fresh-home");
    const dataRoot = join(root, "worker-state-elsewhere");
    mkdirSync(home, { recursive: true, mode: 0o700 });

    const first = provisionManagedWorktreePaths({
      HOME: home,
      QE_WORKER_DATA_ROOT: dataRoot,
    });
    const second = provisionManagedWorktreePaths({
      HOME: home,
      QE_WORKER_DATA_ROOT: join(root, "different-worker-state"),
    });

    expect(first.source).toBe("user_home_default");
    expect(first.qeHome).toBe(realpathSync(join(home, ".qe")));
    expect(first.worktreeRoot).toBe(realpathSync(join(home, ".qe/worktrees")));
    expect(second.worktreeRoot).toBe(first.worktreeRoot);
    expect(first.worktreeRoot.startsWith(dataRoot)).toBe(false);
    if (process.platform !== "win32") {
      expect(lstatSync(first.qeHome).mode & 0o077).toBe(0);
      expect(lstatSync(first.worktreeRoot).mode & 0o077).toBe(0);
    }
  });

  test("the built-in user-home fallback is portable when HOME is absent", () => {
    const root = fixture();
    const fallbackHome = join(root, "os-user-home");
    const paths = provisionManagedWorktreePaths({}, fallbackHome);

    expect(paths.source).toBe("user_home_default");
    expect(paths.worktreeRoot).toBe(
      realpathSync(join(fallbackHome, ".qe/worktrees")),
    );
  });

  test("QE_HOME relocates the automatic worktree child", () => {
    const root = fixture();
    const qeHome = join(root, "managed-data");
    const paths = provisionManagedWorktreePaths({
      HOME: join(root, "other-home"),
      QE_HOME: qeHome,
    });

    expect(paths.source).toBe("QE_HOME");
    expect(paths.qeHome).toBe(realpathSync(qeHome));
    expect(paths.worktreeRoot).toBe(realpathSync(join(qeHome, "worktrees")));
  });

  test("QE_WORKTREE_ROOT has precedence and does not create an unused QE_HOME", () => {
    const root = fixture();
    const explicit = join(root, "explicit-worktrees");
    const unusedQeHome = join(root, "unused-qe-home");
    const paths = provisionManagedWorktreePaths({
      HOME: join(root, "home"),
      QE_HOME: unusedQeHome,
      QE_WORKTREE_ROOT: explicit,
    });

    expect(paths.source).toBe("QE_WORKTREE_ROOT");
    expect(paths.worktreeRoot).toBe(realpathSync(explicit));
    expect(existsSync(unusedQeHome)).toBe(false);
  });

  test("a non-directory collision fails with a typed actionable error", () => {
    const root = fixture();
    const collision = join(root, "collision");
    writeFileSync(collision, "not a directory");

    expect(() =>
      provisionManagedWorktreePaths({ QE_WORKTREE_ROOT: collision }),
    ).toThrow(
      expect.objectContaining({
        code: "managed_directory_not_directory",
      }),
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
        provisionManagedWorktreePaths({ QE_WORKTREE_ROOT: unsafe }),
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
          provisionManagedWorktreePaths({ QE_WORKTREE_ROOT: unwritable }),
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

  test("rejects both source/worktree nesting directions with one typed error", () => {
    const root = fixture();
    const source = join(root, "source");
    const nestedWorktrees = join(source, "managed");
    const managed = join(root, "managed");
    const nestedSource = join(managed, "source");
    for (const path of [nestedWorktrees, nestedSource])
      mkdirSync(path, { recursive: true });

    for (const pair of [
      [source, nestedWorktrees],
      [nestedSource, managed],
      [source, source],
    ] as const) {
      expect(() => assertSourceWorktreeSeparation(pair[0], pair[1])).toThrow(
        expect.objectContaining({
          code: "worktree_source_overlap",
        }),
      );
    }
  });

  test.skipIf(process.platform === "win32")(
    "canonical paths reject a lexically safe worktree symlink into the source",
    () => {
      const root = fixture();
      const source = join(root, "source");
      const outside = join(root, "outside");
      const linkedWorktrees = join(outside, "worktrees");
      mkdirSync(join(source, "actual-worktrees"), { recursive: true });
      mkdirSync(outside, { recursive: true });
      symlinkSync(join(source, "actual-worktrees"), linkedWorktrees, "dir");

      expect(() =>
        assertSourceWorktreeSeparation(source, linkedWorktrees),
      ).toThrow(
        expect.objectContaining({
          code: "worktree_source_overlap",
        }),
      );
    },
  );

  test.skipIf(process.platform === "win32")(
    "canonical paths reject a source symlink into the managed root",
    () => {
      const root = fixture();
      const managed = join(root, "managed");
      const actualSource = join(managed, "actual-source");
      const linkedSource = join(root, "linked-source");
      mkdirSync(actualSource, { recursive: true });
      symlinkSync(actualSource, linkedSource, "dir");

      expect(() =>
        assertSourceWorktreeSeparation(linkedSource, managed),
      ).toThrow(
        expect.objectContaining({
          code: "worktree_source_overlap",
        }),
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
