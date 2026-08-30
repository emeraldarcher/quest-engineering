import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
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
    const binding = this.binding(
      request.workspace_binding_id,
      request.workspace_id,
    );
    const commonDir = await gitCommonDir(binding.source_repository_root);
    const target = this.targetPath(request.workspace_id, request.worktree_id);
    this.persistRequest(request, commonDir, target);
    return this.locks.run(commonDir, async () => {
      const current = this.required(request.worktree_id);
      if (current.state === "ready") return this.verify(request.worktree_id);
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
        const branchRef = `refs/heads/${request.branch_name}`;
        const registered = await registeredWorktrees(
          binding.source_repository_root,
        );
        const registration = registered.find(
          (item) => resolve(item.path) === resolve(target),
        );
        if (!registration && !existsSync(target)) {
          const branchExists = await gitSucceeds(
            binding.source_repository_root,
            ["show-ref", "--verify", "--quiet", branchRef],
          );
          if (branchExists)
            throw coded(
              "run_worktree_branch_conflict",
              `Branch ${request.branch_name} already exists.`,
            );
          mkdirSync(dirname(target), { recursive: true });
          await git(binding.source_repository_root, [
            "worktree",
            "add",
            "-b",
            request.branch_name,
            target,
            baseRevision,
          ]);
        } else if (!registration || !existsSync(target)) {
          throw coded(
            "run_worktree_partial_state",
            "Worktree path and Git registration disagree.",
          );
        }
        const verified = await verifyPhysical(
          target,
          commonDir,
          request.branch_name,
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
          (existsSync(target) ||
            (await gitSucceeds(binding.source_repository_root, [
              "show-ref",
              "--verify",
              "--quiet",
              `refs/heads/${request.branch_name}`,
            ])));
        return this.markProblem(
          request.worktree_id,
          ambiguous
            ? coded(
                "run_worktree_partial_state",
                "Git failed after creating Run-worktree metadata; manual attention is required.",
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
    const binding = this.binding(record.bindingId, record.workspaceId);
    return this.locks.run(record.gitCommonDir, async () => {
      try {
        await verifyPhysical(
          record.canonicalRoot,
          record.gitCommonDir,
          record.branchName,
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
    if (!existsSync(current.canonicalRoot)) {
      const binding = this.binding(current.bindingId, current.workspaceId);
      const registration = (
        await registeredWorktrees(binding.source_repository_root)
      ).find((item) => resolve(item.path) === resolve(current.canonicalRoot));
      if (!registration) {
        this.db
          .query(
            "UPDATE run_worktrees SET state='removed',removed_at=COALESCE(removed_at,?),updated_at=? WHERE worktree_id=?",
          )
          .run(now(), now(), worktreeId);
        return this.required(worktreeId);
      }
      return this.markAttention(worktreeId, "run_worktree_partial_state", {
        message: "Worktree path is absent but Git registration remains.",
      });
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
    const binding = this.binding(record.bindingId, record.workspaceId);
    this.db
      .query(
        "UPDATE run_worktrees SET state='cleanup_requested',updated_at=? WHERE worktree_id=?",
      )
      .run(now(), worktreeId);
    try {
      await git(binding.source_repository_root, [
        "worktree",
        "remove",
        record.canonicalRoot,
      ]);
      const registration = (
        await registeredWorktrees(binding.source_repository_root)
      ).find((item) => resolve(item.path) === resolve(record.canonicalRoot));
      if (registration || existsSync(record.canonicalRoot))
        throw coded(
          "run_worktree_partial_state",
          "Worktree removal did not converge.",
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
  private binding(
    bindingId: string,
    workspaceId: string,
  ): WorkspaceBindingConfig {
    const binding = this.config.workspaceBindings.find(
      (item) =>
        item.binding_id === bindingId && item.workspace_id === workspaceId,
    );
    if (!binding)
      throw coded(
        "run_worktree_binding_mismatch",
        "Requested source binding is not configured on this Worker.",
      );
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
  sourceRoot: string,
): Promise<{ root: string; commonDir: string }> {
  if (!existsSync(path))
    throw coded("run_worktree_missing", "Managed worktree path is missing.");
  const root = realpathSync(await git(path, ["rev-parse", "--show-toplevel"]));
  if (root !== realpathSync(path))
    throw coded(
      "run_worktree_git_mismatch",
      "Canonical top-level differs from the managed root.",
    );
  const commonDir = await gitCommonDir(path);
  if (commonDir !== expectedCommon)
    throw coded(
      "run_worktree_git_mismatch",
      "Git common directory differs from the source binding.",
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
  const registrations = await registeredWorktrees(sourceRoot);
  const registration = registrations.find(
    (item) => resolve(item.path) === resolve(root),
  );
  if (!registration || registration.branch !== `refs/heads/${branchName}`)
    throw coded(
      "run_worktree_registration_mismatch",
      "Git worktree registration does not match the expected Run branch.",
    );
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
async function registeredWorktrees(
  source: string,
): Promise<Array<{ path: string; branch: string | null }>> {
  const output = await git(source, ["worktree", "list", "--porcelain"]);
  const result: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) result.push(current);
      current = { path: line.slice(9), branch: null };
    } else if (current && line.startsWith("branch "))
      current.branch = line.slice(7);
  }
  if (current) result.push(current);
  return result;
}
async function git(cwd: string, args: string[]): Promise<string> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
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
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const [stdout, code] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ]);
  return code === 0 && stdout.trim() ? stdout.trim() : null;
}

async function publicationRemote(
  source: string,
  binding: WorkspaceBindingConfig,
): Promise<{ remoteName: string | null; repositoryIdentity: string | null }> {
  if (
    binding.publication_remote_name &&
    binding.publication_repository_identity
  )
    return {
      remoteName: binding.publication_remote_name,
      repositoryIdentity: binding.publication_repository_identity,
    };
  const remotes = (await git(source, ["remote"])).split("\n").filter(Boolean);
  const remoteName = remotes.includes("origin")
    ? "origin"
    : remotes.length === 1
      ? remotes[0]
      : null;
  if (!remoteName) return { remoteName: null, repositoryIdentity: null };
  const url = await git(source, ["remote", "get-url", remoteName]);
  return { remoteName, repositoryIdentity: githubRepository(url) };
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

async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await process.exited) === 0;
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
