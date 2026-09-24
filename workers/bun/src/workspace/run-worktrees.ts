import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { WorkerConfig, WorkspaceBindingConfig } from "../config.ts";

export interface ProvisionRunWorktree {
  worktree_id: string;
  run_id: string;
  workspace_id: string;
  workspace_binding_id: string;
  base: { kind: "binding_head_v1" };
  branch_name: string;
  identity_hash: string;
}
export interface RunWorktreeRecord {
  worktreeId: string;
  runId: string;
  workspaceId: string;
  bindingId: string;
  baseSelector: string;
  baseRevision: string | null;
  baseBranchName: string | null;
  branchName: string;
  publicationRemoteName: string | null;
  publicationRepositoryIdentity: string | null;
  canonicalRoot: string;
  gitCommonDir: string;
  sourceDirtyExcluded: boolean;
  identityHash: string;
  state:
    | "requested"
    | "provisioning"
    | "ready"
    | "attention_required"
    | "failed"
    | "retained"
    | "cleanup_requested"
    | "removed";
  failureCode: string | null;
  failureDetails: Record<string, unknown> | null;
}
interface Row {
  worktree_id: string;
  run_id: string;
  workspace_id: string;
  binding_id: string;
  base_selector: string;
  base_revision: string | null;
  base_branch_name: string | null;
  branch_name: string;
  publication_remote_name: string | null;
  publication_repository_identity: string | null;
  canonical_root: string;
  git_common_dir: string;
  source_dirty_excluded: number;
  identity_hash: string;
  state: RunWorktreeRecord["state"];
  failure_code: string | null;
  failure_details_json: string | null;
}

class GitOperationLocks {
  private readonly tails = new Map<string, Promise<void>>();
  async run<T>(commonDir: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(commonDir) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const tail = previous.then(() => current);
    this.tails.set(commonDir, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(commonDir) === tail) this.tails.delete(commonDir);
    }
  }
}

export class RunWorktreeRegistry {
  private readonly db: Database;
  private readonly locks = new GitOperationLocks();
  constructor(
    private readonly config: WorkerConfig,
    databasePath = join(config.dataRoot, "run-worktrees.sqlite"),
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_worktrees (
      worktree_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      binding_id TEXT NOT NULL,
      base_selector TEXT NOT NULL,
      base_revision TEXT,
      base_branch_name TEXT,
      branch_name TEXT NOT NULL,
      publication_remote_name TEXT,
      publication_repository_identity TEXT,
      canonical_root TEXT NOT NULL,
      git_common_dir TEXT NOT NULL,
      source_dirty_excluded INTEGER NOT NULL DEFAULT 0,
      identity_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('requested','provisioning','ready','attention_required','failed','retained','cleanup_requested','removed')),
      failure_code TEXT,
      failure_details_json TEXT,
      created_at TEXT NOT NULL,
      ready_at TEXT,
      retained_at TEXT,
      removed_at TEXT,
      updated_at TEXT NOT NULL
    )`);
    for (const statement of [
      "ALTER TABLE run_worktrees ADD COLUMN base_branch_name TEXT",
      "ALTER TABLE run_worktrees ADD COLUMN publication_remote_name TEXT",
      "ALTER TABLE run_worktrees ADD COLUMN publication_repository_identity TEXT",
    ]) {
      try {
        this.db.exec(statement);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !error.message.includes("duplicate column")
        )
          throw error;
      }
    }
  }
  close(): void {
    this.db.close();
  }
  get(worktreeId: string): RunWorktreeRecord | null {
    const row = this.db
      .query("SELECT * FROM run_worktrees WHERE worktree_id=?")
      .get(worktreeId) as Row | null;
    return row ? mapRow(row) : null;
  }
  getForRun(runId: string): RunWorktreeRecord | null {
    const row = this.db
      .query("SELECT * FROM run_worktrees WHERE run_id=?")
      .get(runId) as Row | null;
    return row ? mapRow(row) : null;
  }
  list(): RunWorktreeRecord[] {
    return (
      this.db
        .query("SELECT * FROM run_worktrees ORDER BY created_at")
        .all() as Row[]
    ).map(mapRow);
  }

  async provision(request: ProvisionRunWorktree): Promise<RunWorktreeRecord> {
    validateRequest(request);
    const binding = this.activeBinding(
      request.workspace_binding_id,
      request.workspace_id,
    );
    const sourceCommonDir = await gitCommonDir(binding.source_repository_root);
    const target = this.targetPath(request.workspace_id, request.worktree_id);
    const isolatedCommonDir = resolve(target, ".git");
    this.persistRequest(request, isolatedCommonDir, target);
    return this.locks.run(sourceCommonDir, async () => {
      const current = this.required(request.worktree_id);
      // The per-common-dir lock already serializes physical provisioning. A
      // duplicate request must not recursively acquire that same non-reentrant
      // lock through verify(). The first successful provision verified before
      // persisting ready, so its durable record is the idempotent response.
      if (current.state === "ready") return current;
      if (["attention_required", "failed", "removed"].includes(current.state))
        return current;
      try {
        let baseRevision = current.baseRevision;
        if (!baseRevision) {
          baseRevision = await git(binding.source_repository_root, [
            "rev-parse",
            "--verify",
            "--end-of-options",
            "HEAD^{commit}",
          ]);
          const baseBranchName = await gitOptional(
            binding.source_repository_root,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
          );
          const publication = await publicationRemote(
            binding.source_repository_root,
            binding,
          );
          this.db
            .query(
              "UPDATE run_worktrees SET base_revision=?,base_branch_name=?,publication_remote_name=?,publication_repository_identity=?,state='provisioning',updated_at=? WHERE worktree_id=?",
            )
            .run(
              baseRevision,
              baseBranchName,
              publication.remoteName,
              publication.repositoryIdentity,
              now(),
              request.worktree_id,
            );
        }
        const dirty =
          (
            await git(binding.source_repository_root, [
              "status",
              "--porcelain",
              "--untracked-files=normal",
            ])
          ).length > 0;
        if (!existsSync(target)) {
          mkdirSync(dirname(target), { recursive: true });
          const publication = await publicationRemote(
            binding.source_repository_root,
            binding,
          );
          await initializeIsolatedRepository({
            source: binding.source_repository_root,
            target,
            baseRevision,
            branchName: request.branch_name,
            publication,
          });
        }
        const verified = await verifyPhysical(
          target,
          isolatedCommonDir,
          request.branch_name,
          sourceCommonDir,
          binding.source_repository_root,
        );
        if ((await git(target, ["rev-parse", "HEAD"])) !== baseRevision)
          throw coded(
            "run_worktree_base_mismatch",
            "New worktree did not start at the persisted base revision.",
          );
        this.db
          .query(
            `UPDATE run_worktrees SET canonical_root=?,git_common_dir=?,source_dirty_excluded=?,state='ready',failure_code=NULL,failure_details_json=NULL,ready_at=COALESCE(ready_at,?),updated_at=? WHERE worktree_id=?`,
          )
          .run(
            verified.root,
            verified.commonDir,
            dirty ? 1 : 0,
            now(),
            now(),
            request.worktree_id,
          );
        return this.required(request.worktree_id);
      } catch (error) {
        const ambiguous =
          error instanceof WorktreeError &&
          error.code === "run_worktree_git_failed" &&
          existsSync(target);
        return this.markProblem(
          request.worktree_id,
          ambiguous
            ? coded(
                "run_worktree_partial_state",
                "Git failed after creating isolated Run-repository state; manual attention is required.",
              )
            : error,
        );
      }
    });
  }

  async verify(worktreeId: string): Promise<RunWorktreeRecord> {
    const record = this.required(worktreeId);
    if (
      record.state !== "ready" &&
      record.state !== "retained" &&
      record.state !== "cleanup_requested"
    )
      throw coded("run_worktree_not_ready", `Worktree is ${record.state}.`);
    const binding = this.historicalBinding(
      record.bindingId,
      record.workspaceId,
    );
    return this.locks.run(record.gitCommonDir, async () => {
      try {
        await verifyPhysical(
          record.canonicalRoot,
          record.gitCommonDir,
          record.branchName,
          await gitCommonDir(binding.source_repository_root),
          binding.source_repository_root,
        );
        return this.required(worktreeId);
      } catch (error) {
        return this.markProblem(worktreeId, error);
      }
    });
  }

  async retain(worktreeId: string): Promise<RunWorktreeRecord> {
    const verified = await this.verify(worktreeId);
    if (verified.state === "attention_required") return verified;
    this.db
      .query(
        "UPDATE run_worktrees SET state='retained',retained_at=COALESCE(retained_at,?),updated_at=? WHERE worktree_id=?",
      )
      .run(now(), now(), worktreeId);
    return this.required(worktreeId);
  }

  async cleanup(worktreeId: string): Promise<RunWorktreeRecord> {
    const current = this.required(worktreeId);
    if (current.state === "removed") return current;
    const binding = this.historicalBinding(
      current.bindingId,
      current.workspaceId,
    );
    const sourceCommonDir = await gitCommonDir(binding.source_repository_root);
    if (resolve(current.gitCommonDir) === resolve(sourceCommonDir))
      return this.markAttention(
        worktreeId,
        "run_worktree_legacy_source_linked",
        {
          message:
            "Legacy source-linked worktree requires explicit forensic disposition; QE will not mutate the source repository during cleanup.",
        },
      );
    if (!existsSync(current.canonicalRoot)) {
      this.db
        .query(
          "UPDATE run_worktrees SET state='removed',removed_at=COALESCE(removed_at,?),updated_at=? WHERE worktree_id=?",
        )
        .run(now(), now(), worktreeId);
      return this.required(worktreeId);
    }
    const record = await this.verify(worktreeId);
    if (record.state === "attention_required") return record;
    const status = await git(record.canonicalRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ]);
    if (status.length > 0)
      return this.markAttention(worktreeId, "run_worktree_cleanup_dirty", {
        message: "The retained Run workspace has uncommitted changes.",
      });
    this.db
      .query(
        "UPDATE run_worktrees SET state='cleanup_requested',updated_at=? WHERE worktree_id=?",
      )
      .run(now(), worktreeId);
    try {
      await rm(record.canonicalRoot, { recursive: true });
      if (existsSync(record.canonicalRoot))
        throw coded(
          "run_worktree_partial_state",
          "Isolated Run repository removal did not converge.",
        );
      this.db
        .query(
          "UPDATE run_worktrees SET state='removed',removed_at=?,updated_at=? WHERE worktree_id=?",
        )
        .run(now(), now(), worktreeId);
      return this.required(worktreeId);
    } catch (error) {
      if (!existsSync(record.canonicalRoot)) {
        this.db
          .query(
            "UPDATE run_worktrees SET state='removed',removed_at=?,updated_at=? WHERE worktree_id=?",
          )
          .run(now(), now(), worktreeId);
        return this.required(worktreeId);
      }
      return this.markProblem(worktreeId, error);
    }
  }

  markAttention(
    worktreeId: string,
    code: string,
    details: Record<string, unknown>,
  ): RunWorktreeRecord {
    this.db
      .query(
        "UPDATE run_worktrees SET state='attention_required',failure_code=?,failure_details_json=?,updated_at=? WHERE worktree_id=?",
      )
      .run(code, JSON.stringify(details), now(), worktreeId);
    return this.required(worktreeId);
  }

  private persistRequest(
    request: ProvisionRunWorktree,
    commonDir: string,
    target: string,
  ): void {
    this.db
      .transaction(() => {
        const byRun = this.getForRun(request.run_id);
        if (byRun && byRun.worktreeId !== request.worktree_id)
          throw coded(
            "run_worktree_identity_conflict",
            "Run already has a different worktree identity.",
          );
        const existing = this.get(request.worktree_id);
        if (existing) {
          if (
            existing.runId !== request.run_id ||
            existing.workspaceId !== request.workspace_id ||
            existing.bindingId !== request.workspace_binding_id ||
            existing.baseSelector !== request.base.kind ||
            existing.branchName !== request.branch_name ||
            existing.identityHash !== request.identity_hash
          )
            throw coded(
              "run_worktree_identity_conflict",
              "Worktree ID was reused with different immutable fields.",
            );
          return;
        }
        this.db
          .query(
            `INSERT INTO run_worktrees (worktree_id,run_id,workspace_id,binding_id,base_selector,branch_name,canonical_root,git_common_dir,identity_hash,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'requested',?,?)`,
          )
          .run(
            request.worktree_id,
            request.run_id,
            request.workspace_id,
            request.workspace_binding_id,
            request.base.kind,
            request.branch_name,
            target,
            commonDir,
            request.identity_hash,
            now(),
            now(),
          );
      })
      .immediate();
  }
  private markProblem(worktreeId: string, error: unknown): RunWorktreeRecord {
    const code =
      error instanceof WorktreeError
        ? error.code
        : "run_worktree_provision_failed";
    const details = {
      message: error instanceof Error ? error.message : String(error),
    };
    const uncertain = [
      "run_worktree_partial_state",
      "run_worktree_missing",
      "run_worktree_git_mismatch",
      "run_worktree_branch_mismatch",
      "run_worktree_registration_mismatch",
    ].includes(code);
    this.db
      .query(
        "UPDATE run_worktrees SET state=?,failure_code=?,failure_details_json=?,updated_at=? WHERE worktree_id=?",
      )
      .run(
        uncertain ? "attention_required" : "failed",
        code,
        JSON.stringify(details),
        now(),
        worktreeId,
      );
    return this.required(worktreeId);
  }
  private activeBinding(
    bindingId: string,
    workspaceId: string,
  ): WorkspaceBindingConfig {
    return this.findBinding(
      this.config.workspaceBindings,
      bindingId,
      workspaceId,
      "Requested source binding is not active on this Worker.",
    );
  }
  private historicalBinding(
    bindingId: string,
    workspaceId: string,
  ): WorkspaceBindingConfig {
    return this.findBinding(
      [
        ...this.config.workspaceBindings,
        ...(this.config.retiredWorkspaceBindings ?? []),
      ],
      bindingId,
      workspaceId,
      "Recorded source binding is unavailable on this Worker.",
    );
  }
  private findBinding(
    bindings: WorkspaceBindingConfig[],
    bindingId: string,
    workspaceId: string,
    message: string,
  ): WorkspaceBindingConfig {
    const binding = bindings.find(
      (item) =>
        item.binding_id === bindingId && item.workspace_id === workspaceId,
    );
    if (!binding) throw coded("run_worktree_binding_mismatch", message);
    return binding;
  }
  private required(worktreeId: string): RunWorktreeRecord {
    const value = this.get(worktreeId);
    if (!value)
      throw coded("run_worktree_missing", `Unknown worktree ${worktreeId}.`);
    return value;
  }
  private targetPath(workspaceId: string, worktreeId: string): string {
    return join(
      realpathSync(this.config.worktreeRoot),
      digest(workspaceId).slice(0, 16),
      worktreeId,
    );
  }
}

export class WorktreeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function coded(code: string, message: string): WorktreeError {
  return new WorktreeError(code, message);
}
function validateRequest(request: ProvisionRunWorktree): void {
  if (request.base.kind !== "binding_head_v1")
    throw coded(
      "run_worktree_base_selector_invalid",
      "Unsupported base selector.",
    );
  if (!/^qe\/run\/[0-9a-f]{32}$/.test(request.branch_name))
    throw coded("run_worktree_branch_invalid", "Run branch name is invalid.");
}
async function verifyPhysical(
  path: string,
  expectedCommon: string,
  branchName: string,
  sourceCommon: string,
  sourceRoot: string,
): Promise<{ root: string; commonDir: string }> {
  if (!existsSync(path))
    throw coded(
      "run_worktree_missing",
      "Managed isolated Run repository path is missing.",
    );
  const root = realpathSync(await git(path, ["rev-parse", "--show-toplevel"]));
  if (root !== realpathSync(path))
    throw coded(
      "run_worktree_git_mismatch",
      "Canonical top-level differs from the managed root.",
    );
  const commonDir = await gitCommonDir(path);
  if (commonDir !== realpathSync(expectedCommon) || commonDir === sourceCommon)
    throw coded(
      commonDir === sourceCommon
        ? "run_worktree_legacy_source_linked"
        : "run_worktree_git_mismatch",
      commonDir === sourceCommon
        ? "Run workspace is linked to the source repository; source mutation is forbidden."
        : "Git common directory differs from the Worker-owned isolated repository.",
    );
  const branch = await git(path, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (branch !== branchName)
    throw coded(
      "run_worktree_branch_mismatch",
      `Expected ${branchName}, found ${branch}.`,
    );
  const remoteNames = (await git(path, ["remote"])).split("\n").filter(Boolean);
  for (const remoteName of remoteNames) {
    const url = await git(path, ["remote", "get-url", remoteName]);
    if (await sameLocalRepository(url, sourceRoot))
      throw coded(
        "run_worktree_git_mismatch",
        "Worker-owned Run repository retained the host source as a writable remote.",
      );
  }
  return { root, commonDir };
}
async function gitCommonDir(path: string): Promise<string> {
  const value = await git(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return realpathSync(value);
}
async function initializeIsolatedRepository(input: {
  source: string;
  target: string;
  baseRevision: string;
  branchName: string;
  publication: {
    remoteName: string | null;
    repositoryIdentity: string | null;
    url: string | null;
  };
}): Promise<void> {
  mkdirSync(input.target, { recursive: false });
  const objectFormat = await git(input.source, [
    "rev-parse",
    "--show-object-format",
  ]);
  await git(input.target, ["init", `--object-format=${objectFormat}`]);
  await git(input.target, [
    "fetch",
    "--no-tags",
    "--no-write-fetch-head",
    input.source,
    input.baseRevision,
  ]);
  await git(input.target, [
    "checkout",
    "-b",
    input.branchName,
    input.baseRevision,
  ]);
  if (input.publication.remoteName && input.publication.url) {
    if (await sameLocalRepository(input.publication.url, input.source))
      throw coded(
        "run_worktree_git_mismatch",
        "The publication remote resolves to the host source repository.",
      );
    await git(input.target, [
      "remote",
      "add",
      input.publication.remoteName,
      input.publication.url,
    ]);
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(
    [
      "/usr/bin/git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.file.allow=always",
      "-C",
      cwd,
      ...args,
    ],
    {
      env: controlledGitEnvironment(cwd),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (code !== 0)
    throw coded(
      "run_worktree_git_failed",
      stderr.trim() || `git ${args[0]} failed with ${code}`,
    );
  return stdout.trim();
}
async function gitOptional(
  cwd: string,
  args: string[],
): Promise<string | null> {
  const process = Bun.spawn(
    ["/usr/bin/git", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args],
    {
      env: controlledGitEnvironment(cwd),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const [stdout, code] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  return code === 0 && stdout.trim() ? stdout.trim() : null;
}

function controlledGitEnvironment(cwd: string): Record<string, string> {
  return {
    PATH: "/usr/bin:/bin",
    HOME: resolve(cwd),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

async function sameLocalRepository(
  url: string,
  sourceRoot: string,
): Promise<boolean> {
  const candidate = localRepositoryPath(url, sourceRoot);
  if (!candidate || !existsSync(candidate)) return false;
  try {
    return (await gitCommonDir(candidate)) === (await gitCommonDir(sourceRoot));
  } catch {
    return realpathSync(candidate) === realpathSync(sourceRoot);
  }
}

function localRepositoryPath(url: string, relativeTo: string): string | null {
  if (url.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(url).pathname);
    } catch {
      return null;
    }
  }
  if (url.startsWith("/")) return url;
  if (!url.includes("://") && !/^[^/]+@[^:]+:/.test(url))
    return resolve(relativeTo, url);
  return null;
}

async function publicationRemote(
  source: string,
  binding: WorkspaceBindingConfig,
): Promise<{
  remoteName: string | null;
  repositoryIdentity: string | null;
  url: string | null;
}> {
  const remotes = (await git(source, ["remote"])).split("\n").filter(Boolean);
  const remoteName = binding.publication_remote_name
    ? binding.publication_remote_name
    : remotes.includes("origin")
      ? "origin"
      : remotes.length === 1
        ? remotes[0]
        : null;
  if (!remoteName || !remotes.includes(remoteName))
    return {
      remoteName: null,
      repositoryIdentity: binding.publication_repository_identity ?? null,
      url: null,
    };
  const configuredUrl = await git(source, ["remote", "get-url", remoteName]);
  const localPath = localRepositoryPath(configuredUrl, source);
  const url =
    localPath && existsSync(localPath)
      ? realpathSync(localPath)
      : configuredUrl;
  return {
    remoteName,
    repositoryIdentity:
      binding.publication_repository_identity ?? githubRepository(url),
    url,
  };
}

function githubRepository(url: string): string | null {
  const clean = url
    .replace(/\?.*$/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  const match = clean.match(
    /(?:https?:\/\/|ssh:\/\/git@|git@)(github\.com)(?:[:/])([^/]+)\/([^/]+)$/i,
  );
  return match ? `${match[2]}/${match[3]}` : null;
}

function mapRow(row: Row): RunWorktreeRecord {
  return {
    worktreeId: row.worktree_id,
    runId: row.run_id,
    workspaceId: row.workspace_id,
    bindingId: row.binding_id,
    baseSelector: row.base_selector,
    baseRevision: row.base_revision,
    baseBranchName: row.base_branch_name,
    branchName: row.branch_name,
    publicationRemoteName: row.publication_remote_name,
    publicationRepositoryIdentity: row.publication_repository_identity,
    canonicalRoot: row.canonical_root,
    gitCommonDir: row.git_common_dir,
    sourceDirtyExcluded: row.source_dirty_excluded === 1,
    identityHash: row.identity_hash,
    state: row.state,
    failureCode: row.failure_code,
    failureDetails: row.failure_details_json
      ? (JSON.parse(row.failure_details_json) as Record<string, unknown>)
      : null,
  };
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function now(): string {
  return new Date().toISOString();
}
