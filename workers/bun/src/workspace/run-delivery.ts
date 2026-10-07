import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { constants, mkdirSync, type Stats } from "node:fs";
import { type FileHandle, lstat, open, readlink } from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
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
export interface DeliveryInspectionHooks {
  beforeRegularFileOpen?: (path: string) => void | Promise<void>;
  regularFileOpened?: (path: string) => void;
}

export const DELIVERY_REGULAR_FILE_INSPECTION_LIMIT_BYTES = 1_048_576;
const DELIVERY_READ_CHUNK_BYTES = 64 * 1024;

type EntrySnapshot =
  | { kind: "missing" }
  | { kind: "regular"; metadata: Stats }
  | { kind: "symlink"; metadata: Stats; linkText: string };
interface InspectedChanges {
  evidence: ChangeEvidence;
  entries: Map<string, EntrySnapshot>;
}

export class RunDeliveryRegistry {
  private readonly db: Database;
  constructor(
    private readonly config: WorkerConfig,
    private readonly worktrees: RunWorktreeRegistry,
    databasePath = join(config.dataRoot, "run-deliveries.sqlite"),
    private readonly inspectionHooks: DeliveryInspectionHooks = {},
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
    const inspection = await inspectChanges(record, this.inspectionHooks);
    const fingerprint = await contentFingerprint(
      record.canonicalRoot,
      inspection.evidence.files,
      inspection.entries,
      this.inspectionHooks,
    );
    this.persist(command, fingerprint, "inspected", null);
    return {
      fingerprint,
      evidence: inspection.evidence,
      noChanges: inspection.evidence.files.length === 0,
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
    const current = await inspectChanges(record, this.inspectionHooks);
    const fingerprint = await contentFingerprint(
      record.canonicalRoot,
      current.evidence.files,
      current.entries,
      this.inspectionHooks,
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
    const finalInspection = await inspectChanges(record, this.inspectionHooks);
    const finalFingerprint = await contentFingerprint(
      record.canonicalRoot,
      finalInspection.evidence.files,
      finalInspection.entries,
      this.inspectionHooks,
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
  hooks: DeliveryInspectionHooks,
): Promise<InspectedChanges> {
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
  const entries = new Map<string, EntrySnapshot>();
  const untrackedPaths = new Set(untracked);
  for (const path of paths) {
    const isUntracked = untrackedPaths.has(path);
    const entry = await inspectEntry(record.canonicalRoot, path, !isUntracked);
    entries.set(path, entry);
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
      ? await untrackedNumstat(
          deliveryEntryPath(record.canonicalRoot, path),
          entry,
          hooks,
        )
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
    evidence: {
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
    },
    entries,
  };
}
async function contentFingerprint(
  root: string,
  files: ChangeFile[],
  entries: Map<string, EntrySnapshot>,
  hooks: DeliveryInspectionHooks,
): Promise<string> {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(
      `${Buffer.byteLength(file.path)}:${file.path}\0${file.status}\0`,
    );
    const expected = entries.get(file.path);
    if (!expected)
      throw coded(
        "delivery_entry_changed",
        "Filesystem entry changed during Delivery inspection.",
      );
    const current = await inspectEntry(root, file.path, true);
    assertSameEntry(expected, current);
    if (current.kind === "missing") hash.update("deleted");
    else {
      hash.update(
        `${current.metadata.mode & 0o111 ? "x" : "-"}\0${current.kind === "symlink" ? "l" : "f"}\0`,
      );
      if (current.kind === "symlink") hash.update(current.linkText);
      else
        await readRegularFile(
          deliveryEntryPath(root, file.path),
          current,
          undefined,
          hooks,
          (chunk) => hash.update(chunk),
        );
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
async function untrackedNumstat(
  path: string,
  entry: EntrySnapshot,
  hooks: DeliveryInspectionHooks,
): Promise<string> {
  if (entry.kind === "missing")
    throw coded(
      "delivery_entry_changed",
      "Filesystem entry changed during Delivery inspection.",
    );
  // A Git symlink is one logical added link. Its target text is fingerprinted,
  // but target content is never opened or counted as Delivery evidence.
  if (entry.kind === "symlink") return "1\t0";
  let lines = 1;
  let binary = false;
  await readRegularFile(
    path,
    entry,
    DELIVERY_REGULAR_FILE_INSPECTION_LIMIT_BYTES,
    hooks,
    (chunk) => {
      if (chunk.includes(0)) binary = true;
      for (const byte of chunk) if (byte === 10) lines += 1;
    },
  );
  return binary ? "-\t-" : `${lines}\t0`;
}

async function inspectEntry(
  root: string,
  path: string,
  allowMissing: boolean,
): Promise<EntrySnapshot> {
  const entryPath = deliveryEntryPath(root, path);
  const parts = path.split("/");
  let parent = resolve(root);
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const metadata = await safeLstat(parent, allowMissing);
    if (!metadata || !metadata.isDirectory()) {
      if (allowMissing) return { kind: "missing" };
      throw coded(
        "delivery_entry_changed",
        "Filesystem entry changed during Delivery inspection.",
      );
    }
  }
  const metadata = await safeLstat(entryPath, allowMissing);
  if (!metadata) return { kind: "missing" };
  if (metadata.isFile()) return { kind: "regular", metadata };
  if (metadata.isSymbolicLink()) {
    let linkText: string;
    try {
      linkText = await readlink(entryPath);
    } catch {
      throw coded(
        "delivery_entry_changed",
        "Filesystem entry changed during Delivery inspection.",
      );
    }
    const after = await safeLstat(entryPath, false);
    if (!after?.isSymbolicLink() || !sameMetadata(metadata, after))
      throw coded(
        "delivery_entry_changed",
        "Filesystem entry changed during Delivery inspection.",
      );
    return { kind: "symlink", metadata: after, linkText };
  }
  throw coded(
    "delivery_entry_unsupported",
    "Delivery cannot inspect this filesystem entry type safely.",
  );
}

function deliveryEntryPath(root: string, path: string): string {
  if (
    path.length === 0 ||
    path.includes("\0") ||
    path.startsWith("/") ||
    isAbsolute(path) ||
    posix.normalize(path) !== path ||
    path
      .split("/")
      .some(
        (part) =>
          part === "" ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  )
    throw coded(
      "delivery_path_unsafe",
      "Git reported an unsafe Delivery repository path.",
    );
  const canonicalRoot = resolve(root);
  const candidate = resolve(canonicalRoot, ...path.split("/"));
  const fromRoot = relative(canonicalRoot, candidate);
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  )
    throw coded(
      "delivery_path_unsafe",
      "Git reported an unsafe Delivery repository path.",
    );
  return candidate;
}

async function safeLstat(
  path: string,
  allowMissing: boolean,
): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch (error) {
    if (allowMissing && errorCode(error) === "ENOENT") return null;
    if (["ENOENT", "ENOTDIR"].includes(errorCode(error) ?? ""))
      throw coded(
        "delivery_entry_changed",
        "Filesystem entry changed during Delivery inspection.",
      );
    throw coded(
      "delivery_entry_uninspectable",
      "Delivery could not safely inspect a filesystem entry.",
    );
  }
}

async function readRegularFile(
  path: string,
  expected: Extract<EntrySnapshot, { kind: "regular" }>,
  maxBytes: number | undefined,
  hooks: DeliveryInspectionHooks,
  consume: (chunk: Buffer) => void,
): Promise<void> {
  if (maxBytes !== undefined && expected.metadata.size > maxBytes)
    throw coded(
      "delivery_file_inspection_too_large",
      `Untracked regular-file evidence is limited to ${maxBytes} bytes.`,
    );
  await hooks.beforeRegularFileOpen?.(path);
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(errorCode(error) ?? ""))
      throw coded(
        "delivery_entry_changed",
        "Filesystem entry changed during Delivery inspection.",
      );
    throw coded(
      "delivery_entry_uninspectable",
      "Delivery could not safely open a regular filesystem entry.",
    );
  }
  hooks.regularFileOpened?.(path);
  try {
    const before = await handle.stat();
    if (!before.isFile() || !sameMetadata(expected.metadata, before))
      throw coded(
        "delivery_entry_changed",
        "Filesystem entry changed during Delivery inspection.",
      );
    if (maxBytes !== undefined && before.size > maxBytes)
      throw coded(
        "delivery_file_inspection_too_large",
        `Untracked regular-file evidence is limited to ${maxBytes} bytes.`,
      );
    const buffer = Buffer.allocUnsafe(DELIVERY_READ_CHUNK_BYTES);
    let bytes = 0;
    while (true) {
      const length =
        maxBytes === undefined
          ? buffer.byteLength
          : Math.min(buffer.byteLength, maxBytes - bytes + 1);
      const result = await handle.read(buffer, 0, length, null);
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
      if (maxBytes !== undefined && bytes > maxBytes)
        throw coded(
          "delivery_file_inspection_too_large",
          `Untracked regular-file evidence is limited to ${maxBytes} bytes.`,
        );
      consume(buffer.subarray(0, result.bytesRead));
    }
    const after = await handle.stat();
    const current = await safeLstat(path, false);
    if (
      !current?.isFile() ||
      bytes !== after.size ||
      !sameMetadata(expected.metadata, after) ||
      !sameMetadata(expected.metadata, current)
    )
      throw coded(
        "delivery_entry_changed",
        "Filesystem entry changed during Delivery inspection.",
      );
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    throw coded(
      "delivery_entry_uninspectable",
      "Delivery could not safely read a regular filesystem entry.",
    );
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function assertSameEntry(
  expected: EntrySnapshot,
  current: EntrySnapshot,
): void {
  if (
    expected.kind !== current.kind ||
    (expected.kind !== "missing" &&
      current.kind !== "missing" &&
      !sameMetadata(expected.metadata, current.metadata)) ||
    (expected.kind === "symlink" &&
      current.kind === "symlink" &&
      expected.linkText !== current.linkText)
  )
    throw coded(
      "delivery_entry_changed",
      "Filesystem entry changed during Delivery inspection.",
    );
}

function sameMetadata(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
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
