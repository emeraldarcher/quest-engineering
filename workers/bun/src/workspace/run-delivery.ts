import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { WorkerConfig } from "../config.ts";
import type {
  RunWorktreeRecord,
  RunWorktreeRegistry,
} from "./run-worktrees.ts";

export interface DeliveryCommand {
  delivery_id: string;
  command_revision: number;
  run_id: string;
  worktree_id: string;
  workspace_binding_id: string;
  identity_hash: string;
  branch_name: string;
  expected_fingerprint?: string;
  base_revision?: string;
  base_branch_name?: string;
  repository_identity?: string;
  remote_name?: string;
}
export interface ChangeFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}
export interface ChangeEvidence {
  version: 1;
  base_revision: string;
  head_before_finalize: string;
  working_tree: {
    dirty: boolean;
    tracked_entries: number;
    untracked_entries: number;
  };
  summary: { files_changed: number; additions: number; deletions: number };
  files: ChangeFile[];
  source_dirty_changes_excluded: boolean;
  inspected_at: string;
}
export interface DeliveryInspection {
  fingerprint: string;
  evidence: ChangeEvidence;
  noChanges: boolean;
  record: RunWorktreeRecord;
}

export class RunDeliveryRegistry {
  private readonly db: Database;
  constructor(
    private readonly config: WorkerConfig,
    private readonly worktrees: RunWorktreeRegistry,
    databasePath = join(config.dataRoot, "run-deliveries.sqlite"),
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_deliveries (
      delivery_id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, worktree_id TEXT NOT NULL,
      command_revision INTEGER NOT NULL, identity_hash TEXT NOT NULL, fingerprint TEXT,
      head_revision TEXT, phase TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
  }
  close(): void {
    this.db.close();
  }

  async inspect(command: DeliveryCommand): Promise<DeliveryInspection> {
    const record = await this.validate(command);
    const evidence = await inspectChanges(record);
    const fingerprint = await contentFingerprint(
      record.canonicalRoot,
      evidence.files,
    );
    this.persist(command, fingerprint, "inspected", null);
    return {
      fingerprint,
      evidence,
      noChanges: evidence.files.length === 0,
      record,
    };
  }

  async publish(
    command: DeliveryCommand,
    questTitle: string,
  ): Promise<{
    fingerprint: string;
    headRevision: string;
    record: RunWorktreeRecord;
  }> {
    const record = await this.validate(command);
    const current = await inspectChanges(record);
    const fingerprint = await contentFingerprint(
      record.canonicalRoot,
      current.files,
    );
    const local = this.get(command.delivery_id);
    const expected = command.expected_fingerprint ?? local?.fingerprint;
    if (!expected || fingerprint !== expected)
      throw coded(
        "delivery_content_changed",
        "Run workspace content changed after Delivery inspection.",
      );
    const dirty = await git(record.canonicalRoot, [
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
    ]);
    if (dirty.length > 0) {
      const identity = await commitIdentity(record.canonicalRoot, this.config);
      await git(record.canonicalRoot, ["add", "-A", "--"]);
      await git(record.canonicalRoot, [
        "-c",
        `user.name=${identity.name}`,
        "-c",
        `user.email=${identity.email}`,
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--no-verify",
        "-m",
        commitSubject(questTitle),
      ]);
    }
    if (
      (
        await git(record.canonicalRoot, [
          "status",
          "--porcelain=v1",
          "--untracked-files=normal",
        ])
      ).length > 0
    )
      throw coded(
        "delivery_worktree_not_clean",
        "Run workspace was not clean after finalization.",
      );
    const finalEvidence = await inspectChanges(record);
    const finalFingerprint = await contentFingerprint(
      record.canonicalRoot,
      finalEvidence.files,
    );
    if (finalFingerprint !== expected)
      throw coded(
        "delivery_content_changed",
        "Finalized content differs from inspected content.",
      );
    const headRevision = await git(record.canonicalRoot, [
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ]);
    const remoteName = command.remote_name ?? record.publicationRemoteName;
    if (!remoteName)
      throw coded(
        "publication_remote_unresolved",
        "No exact publication remote is associated with this Project.",
      );
    const remote = await git(record.canonicalRoot, [
      "ls-remote",
      "--heads",
      remoteName,
      `refs/heads/${record.branchName}`,
    ]);
    if (remote) {
      const remoteOid = remote.split(/\s+/)[0];
      if (remoteOid !== headRevision)
        throw coded(
          "remote_branch_conflict",
          "The remote Run branch differs from this Delivery.",
        );
    } else {
      await git(record.canonicalRoot, [
        "push",
        "--porcelain",
        "--set-upstream",
        remoteName,
        `refs/heads/${record.branchName}:refs/heads/${record.branchName}`,
      ]);
    }
    this.persist(command, expected, "pushed", headRevision);
    return { fingerprint: expected, headRevision, record };
  }

  private async validate(command: DeliveryCommand): Promise<RunWorktreeRecord> {
    if (
      !command.delivery_id ||
      !Number.isInteger(command.command_revision) ||
      command.command_revision < 1
    )
      throw coded(
        "delivery_command_invalid",
        "Delivery command identity is invalid.",
      );
    const record = await this.worktrees.verify(command.worktree_id);
    if (record.state !== "retained")
      throw coded(
        "run_worktree_not_retained",
        "Delivery requires a retained Run workspace.",
      );
    if (
      record.runId !== command.run_id ||
      record.bindingId !== command.workspace_binding_id ||
      record.identityHash !== command.identity_hash ||
      record.branchName !== command.branch_name
    )
      throw coded(
        "delivery_identity_conflict",
        "Delivery command does not match the durable Run workspace.",
      );
    if (!record.baseRevision)
      throw coded(
        "base_revision_unresolved",
        "The Run base revision is unavailable.",
      );
    if (!record.baseBranchName)
      throw coded(
        "base_branch_unresolved",
        "The Run base branch is unavailable.",
      );
    if (!record.publicationRemoteName || !record.publicationRepositoryIdentity)
      throw coded(
        "publication_remote_unresolved",
        "The Project has no unambiguous GitHub publication remote.",
      );
    const remoteBase = await git(record.canonicalRoot, [
      "ls-remote",
      "--heads",
      record.publicationRemoteName,
      `refs/heads/${record.baseBranchName}`,
    ]);
    if (!remoteBase)
      throw coded(
        "base_branch_missing_on_remote",
        "The persisted base branch does not exist on the publication remote.",
      );
    if (
      command.repository_identity &&
      command.repository_identity.toLowerCase() !==
        record.publicationRepositoryIdentity.toLowerCase()
    )
      throw coded(
        "cross_repository_pull_request_not_supported",
        "v0.13 supports same-repository GitHub Pull Requests only.",
      );
    const ancestor = await gitSucceeds(record.canonicalRoot, [
      "merge-base",
      "--is-ancestor",
      record.baseRevision,
      "HEAD",
    ]);
    if (!ancestor)
      throw coded(
        "base_revision_not_ancestor",
        "Persisted base revision is not an ancestor of the Run branch.",
      );
    return record;
  }

  private get(deliveryId: string): {
    fingerprint: string | null;
    phase: string;
    head_revision: string | null;
  } | null {
    return this.db
      .query(
        "SELECT fingerprint,phase,head_revision FROM run_deliveries WHERE delivery_id=?",
      )
      .get(deliveryId) as {
      fingerprint: string | null;
      phase: string;
      head_revision: string | null;
    } | null;
  }
  private persist(
    command: DeliveryCommand,
    fingerprint: string,
    phase: string,
    headRevision: string | null,
  ): void {
    const existing = this.db
      .query("SELECT * FROM run_deliveries WHERE delivery_id=?")
      .get(command.delivery_id) as Record<string, unknown> | null;
    if (
      existing &&
      (existing.run_id !== command.run_id ||
        existing.worktree_id !== command.worktree_id ||
        existing.identity_hash !== command.identity_hash)
    )
      throw coded(
        "delivery_identity_conflict",
        "Delivery ID was reused with different immutable fields.",
      );
    this.db
      .query(`INSERT INTO run_deliveries (delivery_id,run_id,worktree_id,command_revision,identity_hash,fingerprint,head_revision,phase,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(delivery_id) DO UPDATE SET command_revision=excluded.command_revision,
      fingerprint=COALESCE(run_deliveries.fingerprint,excluded.fingerprint),head_revision=COALESCE(excluded.head_revision,run_deliveries.head_revision),phase=excluded.phase,updated_at=excluded.updated_at`)
      .run(
        command.delivery_id,
        command.run_id,
        command.worktree_id,
        command.command_revision,
        command.identity_hash,
        fingerprint,
        headRevision,
        phase,
        new Date().toISOString(),
      );
  }
}

async function inspectChanges(
  record: RunWorktreeRecord,
): Promise<ChangeEvidence> {
  if (!record.baseRevision)
    throw coded("base_revision_unresolved", "Base revision is unavailable.");
  const trackedRaw = await gitBuffer(record.canonicalRoot, [
    "diff",
    "--name-only",
    "-z",
    record.baseRevision,
    "--",
  ]);
  const untrackedRaw = await gitBuffer(record.canonicalRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const tracked = nulStrings(trackedRaw);
  const untracked = nulStrings(untrackedRaw);
  const paths = [...new Set([...tracked, ...untracked])].sort((a, b) =>
    Buffer.from(a).compare(Buffer.from(b)),
  );
  const files: ChangeFile[] = [];
  for (const path of paths) {
    const isUntracked = untracked.includes(path);
    const statusRaw = isUntracked
      ? "A"
      : ((
          await git(record.canonicalRoot, [
            "diff",
            "--name-status",
            record.baseRevision,
            "--",
            path,
          ])
        ).split(/\s+/)[0] ?? "M");
    const num = isUntracked
      ? await untrackedNumstat(join(record.canonicalRoot, path))
      : await git(record.canonicalRoot, [
          "diff",
          "--numstat",
          record.baseRevision,
          "--",
          path,
        ]);
    const [added = "0", deleted = "0"] = num.split(/\s+/);
    files.push({
      path,
      status: statusName(statusRaw),
      additions: added === "-" ? 0 : Number(added),
      deletions: deleted === "-" ? 0 : Number(deleted),
      binary: added === "-" || deleted === "-",
    });
  }
  const status = await git(record.canonicalRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=normal",
  ]);
  return {
    version: 1,
    base_revision: record.baseRevision,
    head_before_finalize: await git(record.canonicalRoot, [
      "rev-parse",
      "HEAD",
    ]),
    working_tree: {
      dirty: status.length > 0,
      tracked_entries: tracked.length,
      untracked_entries: untracked.length,
    },
    summary: {
      files_changed: files.length,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    },
    files,
    source_dirty_changes_excluded: record.sourceDirtyExcluded,
    inspected_at: new Date().toISOString(),
  };
}
async function contentFingerprint(
  root: string,
  files: ChangeFile[],
): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(
      `${Buffer.byteLength(file.path)}:${file.path}\0${file.status}\0`,
    );
    try {
      const metadata = await lstat(join(root, file.path));
      hash.update(
        `${metadata.mode & 0o111 ? "x" : "-"}\0${metadata.isSymbolicLink() ? "l" : "f"}\0`,
      );
      hash.update(
        metadata.isSymbolicLink()
          ? await readlink(join(root, file.path))
          : await readFile(join(root, file.path)),
      );
    } catch {
      hash.update("deleted");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}
async function commitIdentity(
  root: string,
  config: WorkerConfig,
): Promise<{ name: string; email: string }> {
  if (
    (config.gitAuthorName && !config.gitAuthorEmail) ||
    (!config.gitAuthorName && config.gitAuthorEmail)
  )
    throw coded(
      "git_identity_invalid",
      "QE_GIT_AUTHOR_NAME and QE_GIT_AUTHOR_EMAIL must be configured together.",
    );
  const name =
    config.gitAuthorName ??
    (await gitOptional(root, ["config", "--get", "user.name"]));
  const email =
    config.gitAuthorEmail ??
    (await gitOptional(root, ["config", "--get", "user.email"]));
  if (!name || !email)
    throw coded(
      "git_identity_missing",
      "Git commit identity is not configured.",
    );
  if (
    [name, email].some((value) =>
      [...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    )
  )
    throw coded(
      "git_identity_invalid",
      "Git commit identity contains unsupported control characters.",
    );
  return { name, email };
}
function commitSubject(title: string): string {
  const clean = [...title]
    .map((value) => {
      const code = value.charCodeAt(0);
      return code < 32 || code === 127 ? " " : value;
    })
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return `Quest: ${clean || "changes"}`;
}
function statusName(value: string): string {
  if (value.startsWith("A")) return "added";
  if (value.startsWith("D")) return "deleted";
  if (value.startsWith("R")) return "renamed";
  return "modified";
}
async function untrackedNumstat(path: string): Promise<string> {
  const content = await readFile(path);
  if (content.includes(0)) return "-\t-";
  return `${content.toString("utf8").split("\n").length}\t0`;
}
function nulStrings(value: Uint8Array): string[] {
  return Buffer.from(value).toString("utf8").split("\0").filter(Boolean);
}
async function git(cwd: string, args: string[]): Promise<string> {
  return Buffer.from(await gitBuffer(cwd, args))
    .toString("utf8")
    .trim();
}
async function gitBuffer(cwd: string, args: string[]): Promise<Uint8Array> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw coded("delivery_git_failed", err.trim() || `git ${args[0]} failed`);
  return new Uint8Array(out);
}
async function gitOptional(
  cwd: string,
  args: string[],
): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}
async function gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await child.exited) === 0;
}
export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
function coded(code: string, message: string): DeliveryError {
  return new DeliveryError(code, message);
}
