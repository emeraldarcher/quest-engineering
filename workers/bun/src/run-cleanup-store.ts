import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EnvironmentRef } from "./execution-environment/types.ts";
import type { HarnessTransportBinding } from "./harnesses/transport-binding.ts";

export type HarnessCleanupState =
  | "retained"
  | "retiring"
  | "retired"
  | "unavailable";
export type ExecutionEnvironmentCleanupState =
  | "cleanup_requested"
  | "stopping"
  | "stopped"
  | "removed"
  | "uncertain"
  | "failed";
export type HostRepositoryCleanupState =
  | "retained"
  | "cleanup_requested"
  | "removed"
  | "failed";

export interface CleanupIssue {
  code: string;
  message: string;
}

export interface HarnessCleanupTarget {
  lineageId: string;
  harnessKind: string;
  transportBinding: HarnessTransportBinding | null;
  authorityDigest: string;
  nativeSessionDigest: string | null;
}

export interface RunCleanupRecord {
  runId: string;
  worktreeId: string;
  workspaceBindingId: string;
  identityHash: string;
  harnessTargets: HarnessCleanupTarget[];
  environmentRef: EnvironmentRef | null;
  environmentAbsenceProven: boolean;
  harness: { state: HarnessCleanupState; issue?: CleanupIssue };
  executionEnvironment: {
    state: ExecutionEnvironmentCleanupState;
    issue?: CleanupIssue;
  };
  hostRunRepository: {
    state: HostRepositoryCleanupState;
    issue?: CleanupIssue;
  };
  requestedAt: string;
  updatedAt: string;
}

interface CleanupRow {
  run_id: string;
  worktree_id: string;
  workspace_binding_id: string;
  identity_hash: string;
  harness_targets_json: string;
  environment_ref_json: string | null;
  environment_absence_proven: number;
  harness_state: HarnessCleanupState;
  harness_issue_json: string | null;
  environment_state: ExecutionEnvironmentCleanupState;
  environment_issue_json: string | null;
  host_repository_state: HostRepositoryCleanupState;
  host_repository_issue_json: string | null;
  requested_at: string;
  updated_at: string;
}

/** Durable, independent resource projections for one explicit Run cleanup. */
export class RunCleanupStore {
  private readonly db: Database;

  constructor(dataRoot: string, path = join(dataRoot, "run-cleanups.sqlite")) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_cleanups (
      run_id TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL,
      workspace_binding_id TEXT NOT NULL,
      identity_hash TEXT NOT NULL,
      harness_targets_json TEXT NOT NULL,
      environment_ref_json TEXT,
      environment_absence_proven INTEGER NOT NULL CHECK(environment_absence_proven IN (0,1)),
      harness_state TEXT NOT NULL CHECK(harness_state IN ('retained','retiring','retired','unavailable')),
      harness_issue_json TEXT,
      environment_state TEXT NOT NULL CHECK(environment_state IN ('cleanup_requested','stopping','stopped','removed','uncertain','failed')),
      environment_issue_json TEXT,
      host_repository_state TEXT NOT NULL CHECK(host_repository_state IN ('retained','cleanup_requested','removed','failed')),
      host_repository_issue_json TEXT,
      requested_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
  }

  close(): void {
    this.db.close();
  }

  get(runId: string): RunCleanupRecord | null {
    const row = this.db
      .query("SELECT * FROM run_cleanups WHERE run_id=?")
      .get(runId) as CleanupRow | null;
    return row ? mapRow(row) : null;
  }

  listReconcilable(): RunCleanupRecord[] {
    return (
      this.db
        .query(
          `SELECT * FROM run_cleanups
           WHERE harness_state IN ('retained','retiring')
              OR environment_state IN ('cleanup_requested','stopping','stopped','uncertain')
              OR (environment_state='removed' AND host_repository_state='cleanup_requested')
           ORDER BY requested_at,run_id`,
        )
        .all() as CleanupRow[]
    ).map(mapRow);
  }

  begin(input: {
    runId: string;
    worktreeId: string;
    workspaceBindingId: string;
    identityHash: string;
    harnessTargets: readonly HarnessCleanupTarget[];
    environmentRef: EnvironmentRef | null;
    environmentAbsenceProven?: boolean;
  }): RunCleanupRecord {
    const existing = this.get(input.runId);
    if (existing) {
      assertIdentity(existing, input);
      return existing;
    }
    const targets = normalizeTargets(input.harnessTargets);
    const absenceProven =
      input.environmentAbsenceProven ?? input.environmentRef === null;
    if (input.environmentRef && absenceProven)
      throw new Error(
        "An exact environment target cannot also be authoritatively absent.",
      );
    const timestamp = now();
    this.db
      .query(
        `INSERT INTO run_cleanups
         (run_id,worktree_id,workspace_binding_id,identity_hash,harness_targets_json,environment_ref_json,environment_absence_proven,harness_state,harness_issue_json,environment_state,environment_issue_json,host_repository_state,host_repository_issue_json,requested_at,updated_at)
         VALUES (?,?,?,?,?,?,?,'retiring',NULL,?,NULL,'cleanup_requested',NULL,?,?)`,
      )
      .run(
        input.runId,
        input.worktreeId,
        input.workspaceBindingId,
        input.identityHash,
        JSON.stringify(targets),
        input.environmentRef ? JSON.stringify(input.environmentRef) : null,
        absenceProven ? 1 : 0,
        input.environmentRef
          ? "cleanup_requested"
          : absenceProven
            ? "removed"
            : "failed",
        timestamp,
        timestamp,
      );
    return this.required(input.runId);
  }

  updateHarness(
    runId: string,
    state: HarnessCleanupState,
    issue?: CleanupIssue,
  ): RunCleanupRecord {
    const current = this.required(runId);
    if (current.harness.state === "retired" && state !== "retired")
      throw new Error("Retired harness cleanup cannot regress.");
    this.db
      .query(
        "UPDATE run_cleanups SET harness_state=?,harness_issue_json=?,updated_at=? WHERE run_id=?",
      )
      .run(state, issue ? JSON.stringify(issue) : null, now(), runId);
    return this.required(runId);
  }

  updateEnvironment(
    runId: string,
    state: ExecutionEnvironmentCleanupState,
    issue?: CleanupIssue,
  ): RunCleanupRecord {
    const current = this.required(runId);
    if (current.executionEnvironment.state === "removed" && state !== "removed")
      throw new Error("Removed execution environment cleanup cannot regress.");
    this.db
      .query(
        "UPDATE run_cleanups SET environment_state=?,environment_issue_json=?,updated_at=? WHERE run_id=?",
      )
      .run(state, issue ? JSON.stringify(issue) : null, now(), runId);
    return this.required(runId);
  }

  updateHostRepository(
    runId: string,
    state: HostRepositoryCleanupState,
    issue?: CleanupIssue,
  ): RunCleanupRecord {
    const current = this.required(runId);
    if (
      state === "removed" &&
      (current.harness.state !== "retired" ||
        current.executionEnvironment.state !== "removed")
    )
      throw new Error(
        "Host Run repository cannot be removed before harness retirement and execution environment removal.",
      );
    if (current.hostRunRepository.state === "removed" && state !== "removed")
      throw new Error("Removed host Run repository cleanup cannot regress.");
    this.db
      .query(
        "UPDATE run_cleanups SET host_repository_state=?,host_repository_issue_json=?,updated_at=? WHERE run_id=?",
      )
      .run(state, issue ? JSON.stringify(issue) : null, now(), runId);
    return this.required(runId);
  }

  private required(runId: string): RunCleanupRecord {
    const record = this.get(runId);
    if (!record) throw new Error(`Run cleanup ${runId} is missing.`);
    return record;
  }
}

function assertIdentity(
  existing: RunCleanupRecord,
  input: {
    worktreeId: string;
    workspaceBindingId: string;
    identityHash: string;
    harnessTargets: readonly HarnessCleanupTarget[];
    environmentRef: EnvironmentRef | null;
    environmentAbsenceProven?: boolean;
  },
): void {
  const targets = normalizeTargets(input.harnessTargets);
  if (
    existing.worktreeId !== input.worktreeId ||
    existing.workspaceBindingId !== input.workspaceBindingId ||
    existing.identityHash !== input.identityHash ||
    JSON.stringify(existing.harnessTargets) !== JSON.stringify(targets) ||
    JSON.stringify(existing.environmentRef) !==
      JSON.stringify(input.environmentRef) ||
    (input.environmentAbsenceProven !== undefined &&
      existing.environmentAbsenceProven !== input.environmentAbsenceProven)
  )
    throw new Error(
      "Run cleanup request conflicts with its frozen resource identities.",
    );
}

function mapRow(row: CleanupRow): RunCleanupRecord {
  return {
    runId: row.run_id,
    worktreeId: row.worktree_id,
    workspaceBindingId: row.workspace_binding_id,
    identityHash: row.identity_hash,
    harnessTargets: JSON.parse(
      row.harness_targets_json,
    ) as HarnessCleanupTarget[],
    environmentRef: row.environment_ref_json
      ? (JSON.parse(row.environment_ref_json) as EnvironmentRef)
      : null,
    environmentAbsenceProven: row.environment_absence_proven === 1,
    harness: resource(row.harness_state, row.harness_issue_json),
    executionEnvironment: resource(
      row.environment_state,
      row.environment_issue_json,
    ),
    hostRunRepository: resource(
      row.host_repository_state,
      row.host_repository_issue_json,
    ),
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  };
}

function normalizeTargets(
  targets: readonly HarnessCleanupTarget[],
): HarnessCleanupTarget[] {
  const byLineage = new Map<string, HarnessCleanupTarget>();
  for (const target of targets) {
    const existing = byLineage.get(target.lineageId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(target))
      throw new Error(
        `Harness cleanup lineage ${target.lineageId} has conflicting frozen identities.`,
      );
    byLineage.set(target.lineageId, { ...target });
  }
  return [...byLineage.values()].sort((left, right) =>
    left.lineageId.localeCompare(right.lineageId),
  );
}

function resource<T extends string>(
  state: T,
  issueJson: string | null,
): { state: T; issue?: CleanupIssue } {
  return {
    state,
    ...(issueJson ? { issue: JSON.parse(issueJson) as CleanupIssue } : {}),
  };
}

function now(): string {
  return new Date().toISOString();
}
