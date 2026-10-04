import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SbxExecutionEnvironmentBackend } from "../src/execution-environment/sbx-backend.ts";
import {
  PrivateGitWorkspaceManager,
  validateAndImportPrivateGitExport,
} from "../src/workspace/private-git.ts";
import { sbxSpec } from "./sbx-support.ts";

const live = process.env.QE_LIVE_SBX === "1";

test.skipIf(!live)(
  "live SBX private Git imports, checkpoints, persists, exports, and restores without touching host Git",
  async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "private-git-live-"));
    const sourceRoot = join(root, "source");
    const dataRoot = join(root, "worker-data");
    await initRepository(sourceRoot);
    const baseCommit = await git(sourceRoot, ["rev-parse", "HEAD"]);
    const source = {
      repositoryId: "live-private-git-fixture",
      canonicalSourceIdentifier: "fixture:live-private-git",
      hostRepositoryRoot: sourceRoot,
      frozenBaseCommit: baseCommit,
      provenance: { kind: "authorized_local_object_database" as const },
    };
    const before = await sourceSnapshot(sourceRoot);
    const spec = sbxSpec(`private-git-live-${Date.now()}`);
    spec.workspace.materialization = {
      kind: "frozen_import",
      sourceIdentity: source.canonicalSourceIdentifier,
      frozenBase: { kind: "git_commit", value: baseCommit },
    };
    let backend = new SbxExecutionEnvironmentBackend({
      workerId: spec.workerId,
      dataRoot,
      reconciliationPollMs: 500,
      reconciliationAttempts: 120,
    });
    let manager = new PrivateGitWorkspaceManager({ dataRoot });
    let ref: Awaited<ReturnType<typeof backend.ensure>>["ref"] | null = null;
    try {
      let lease = await backend.ensure(spec);
      ref = lease.ref;
      const repository = await manager.materializeSource({ lease, source });
      const implementation = await manager.ensureWorktree({
        lease,
        repositoryId: source.repositoryId,
        physicalLineageId: "implementation",
        access: "read_write",
      });
      const review = await manager.ensureWorktree({
        lease,
        repositoryId: source.repositoryId,
        physicalLineageId: "review",
        access: "read_only",
      });
      expect(implementation.paths.workspace).not.toBe(review.paths.workspace);
      expect(implementation.paths.repository).toBe(review.paths.repository);

      await checkedExec(
        lease,
        "/usr/bin/python3",
        [
          "-c",
          "import pathlib; pathlib.Path('tracked.txt').write_text('committed in sbx\\n')",
        ],
        implementation.paths.workspace,
      );
      await checkedExec(
        lease,
        "/usr/bin/git",
        ["add", "tracked.txt"],
        implementation.paths.workspace,
      );
      await checkedExec(
        lease,
        "/usr/bin/git",
        ["commit", "-m", "private implementation commit"],
        implementation.paths.workspace,
      );
      await checkedExec(
        lease,
        "/usr/bin/python3",
        [
          "-c",
          "import pathlib; pathlib.Path('tracked.txt').write_text('uncommitted in sbx\\n'); pathlib.Path('untracked.txt').write_text('new in sbx\\n')",
        ],
        implementation.paths.workspace,
      );
      const denied = await lease.exec({
        executable: "/usr/bin/python3",
        args: [
          "-c",
          "import pathlib; pathlib.Path('tracked.txt').write_text('forbidden\\n')",
        ],
        cwd: review.paths.workspace,
      });
      expect(denied.exitCode).not.toBe(0);
      await checkedExec(
        lease,
        "/usr/bin/python3",
        ["-c", "import pathlib; pathlib.Path('runtime-ok').write_text('ok')"],
        review.paths.runtimeTemp,
      );
      const adoptedReview = await manager.ensureWorktree({
        lease,
        repositoryId: source.repositoryId,
        physicalLineageId: "review",
        access: "read_only",
      });
      expect(adoptedReview.physicalId).toBe(review.physicalId);
      const reviewFingerprint = await manager.fingerprint({
        lease,
        physicalLineageId: "review",
      });
      expect(reviewFingerprint.headCommit).toBe(baseCommit);
      expect(reviewFingerprint.untrackedPaths).toEqual([]);
      const beforeStop = await manager.fingerprint({
        lease,
        physicalLineageId: "implementation",
      });

      await backend.stop(ref);
      manager.close();
      backend.close();
      backend = new SbxExecutionEnvironmentBackend({
        workerId: spec.workerId,
        dataRoot,
        reconciliationPollMs: 500,
        reconciliationAttempts: 120,
      });
      manager = new PrivateGitWorkspaceManager({ dataRoot });
      lease = await backend.recover(ref, spec);
      await manager.materializeSource({ lease, source });
      await manager.ensureWorktree({
        lease,
        repositoryId: source.repositoryId,
        physicalLineageId: "implementation",
        access: "read_write",
      });
      expect(
        await manager.fingerprint({
          lease,
          physicalLineageId: "implementation",
        }),
      ).toEqual(beforeStop);

      const changeExport = await manager.checkpoint({
        lease,
        physicalLineageId: "implementation",
        contract: {
          repositoryId: source.repositoryId,
          baseCommit,
          expectedChangedPaths: ["tracked.txt", "untracked.txt"],
        },
      });
      const imported = await validateAndImportPrivateGitExport({
        changeExport,
        fixtureGitDir: join(root, "host-import.git"),
      });
      expect(imported.resultTree).toBe(beforeStop.resultTree);

      const previousEnvironment = lease.ref;
      await backend.remove(previousEnvironment);
      ref = null;
      const replacement = await backend.ensure(spec);
      ref = replacement.ref;
      expect(replacement.ref.incarnation).not.toBe(
        previousEnvironment.incarnation,
      );
      const restored = await manager.restoreCheckpoint({
        lease: replacement,
        changeExport,
        physicalLineageId: "implementation",
        access: "read_write",
      });
      expect(restored.environmentRef.incarnation).toBe(
        replacement.ref.incarnation,
      );
      expect(
        await manager.fingerprint({
          lease: replacement,
          physicalLineageId: "implementation",
        }),
      ).toEqual(beforeStop);
      expect(
        (
          await manager.materializeSource({
            lease: replacement,
            source,
          })
        ).physicalId,
      ).toBe(restored.repositoryPhysicalId);
      expect(await sourceSnapshot(sourceRoot)).toEqual(before);
      expect(repository.source.baseCommit).toBe(baseCommit);
    } finally {
      if (ref) await backend.remove(ref).catch(() => undefined);
      manager.close();
      backend.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  35 * 60_000,
);

async function checkedExec(
  lease: Awaited<ReturnType<SbxExecutionEnvironmentBackend["ensure"]>>,
  executable: string,
  args: string[],
  cwd: string,
): Promise<void> {
  const result = await lease.exec({ executable, args, cwd, timeoutMs: 60_000 });
  if (result.exitCode !== 0)
    throw new Error(result.stderr.trim() || `${executable} failed.`);
}

async function initRepository(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.name", "Host Fixture"]);
  await git(root, ["config", "user.email", "host-fixture@example.invalid"]);
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git(root, ["add", "tracked.txt"]);
  await git(root, ["commit", "-qm", "local-only frozen base"]);
  await writeFile(
    join(root, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\nexit 91\n",
  );
}

async function sourceSnapshot(root: string): Promise<Record<string, string>> {
  return {
    refs: await git(root, ["show-ref"], true),
    status: await git(root, ["status", "--porcelain=v2", "-z"]),
    config: await readFile(join(root, ".git", "config"), "utf8"),
    hook: await readFile(join(root, ".git", "hooks", "pre-commit"), "utf8"),
    index: createHash("sha256")
      .update(await readFile(join(root, ".git", "index")))
      .digest("hex"),
  };
}

async function git(
  cwd: string,
  args: string[],
  allowFailure = false,
): Promise<string> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0 && !allowFailure)
    throw new Error(stderr.trim() || `git ${args[0]} failed.`);
  return stdout.trim();
}
