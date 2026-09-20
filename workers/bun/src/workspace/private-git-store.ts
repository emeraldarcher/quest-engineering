import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export type PrivateRepositoryState =
  | "materializing"
  | "ready"
  | "attention_required";
export type PrivateWorkspaceState = "creating" | "ready" | "attention_required";

export interface PrivateRepositoryRecord {
  recordId: string;
  backendKind: string;
  environmentId: string;
  incarnation: string;
  workerId: string;
  runId: string;
  repositoryId: string;
  sourceDigest: string;
  sourceJson: string;
  baseCommit: string;
  baseTree: string;
  importBundleSha256: string;
  guestGitDir: string;
  state: PrivateRepositoryState;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateWorkspaceRecord {
  recordId: string;
  repositoryRecordId: string;
  backendKind: string;
  environmentId: string;
  incarnation: string;
  workerId: string;
  runId: string;
  physicalLineageId: string;
  access: "read_only" | "read_write";
  guestPath: string;
  branchRef: string;
  runtimeJson: string;
  state: PrivateWorkspaceState;
  fingerprint: string | null;
  checkpointId: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateCheckpointRecord {
  checkpointId: string;
  workspaceRecordId: string;
  fingerprint: string;
  exportId: string;
  bundleSha256: string;
  bundleBytes: number;
  artifactPath: string;
  manifestJson: string;
  createdAt: string;
}

interface RepositoryRow {
  record_id: string;
  backend_kind: string;
  environment_id: string;
  incarnation: string;
  worker_id: string;
  run_id: string;
  repository_id: string;
  source_digest: string;
  source_json: string;
  base_commit: string;
  base_tree: string;
  import_bundle_sha256: string;
  guest_git_dir: string;
  state: PrivateRepositoryState;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkspaceRow {
  record_id: string;
  repository_record_id: string;
  backend_kind: string;
  environment_id: string;
  incarnation: string;
  worker_id: string;
  run_id: string;
  physical_lineage_id: string;
  access: "read_only" | "read_write";
  guest_path: string;
  branch_ref: string;
  runtime_json: string;
  state: PrivateWorkspaceState;
  fingerprint: string | null;
  checkpoint_id: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

interface CheckpointRow {
  checkpoint_id: string;
  workspace_record_id: string;
  fingerprint: string;
  export_id: string;
  bundle_sha256: string;
  bundle_bytes: number;
  artifact_path: string;
  manifest_json: string;
  created_at: string;
}

export class PrivateGitStore {
  readonly databasePath: string;
  private readonly db: Database;

  constructor(
    dataRoot: string,
    databasePath = join(dataRoot, "private-git.sqlite"),
  ) {
    mkdirSync(dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  claimRepository(
    input: Omit<
      PrivateRepositoryRecord,
      "state" | "failureCode" | "createdAt" | "updatedAt"
    >,
  ): { created: boolean; record: PrivateRepositoryRecord } {
    return this.db
      .transaction(() => {
        const existing = this.repository(
          input.backendKind,
          input.environmentId,
          input.incarnation,
          input.repositoryId,
        );
        if (existing) {
          assertRepositoryIdentity(existing, input);
          return { created: false, record: existing };
        }
        const timestamp = now();
        this.db
          .query(
            `INSERT INTO private_git_repositories
             (record_id,backend_kind,environment_id,incarnation,worker_id,run_id,repository_id,source_digest,source_json,base_commit,base_tree,import_bundle_sha256,guest_git_dir,state,failure_code,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'materializing',NULL,?,?)`,
          )
          .run(
            input.recordId,
            input.backendKind,
            input.environmentId,
            input.incarnation,
            input.workerId,
            input.runId,
            input.repositoryId,
            input.sourceDigest,
            input.sourceJson,
            input.baseCommit,
            input.baseTree,
            input.importBundleSha256,
            input.guestGitDir,
            timestamp,
            timestamp,
          );
        return {
          created: true,
          record: this.requiredRepository(input.recordId),
        };
      })
      .immediate();
  }

  repository(
    backendKind: string,
    environmentId: string,
    incarnation: string,
    repositoryId: string,
  ): PrivateRepositoryRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM private_git_repositories
         WHERE backend_kind=? AND environment_id=? AND incarnation=? AND repository_id=?`,
      )
      .get(
        backendKind,
        environmentId,
        incarnation,
        repositoryId,
      ) as RepositoryRow | null;
    return row ? mapRepository(row) : null;
  }

  repositoryByRecordId(recordId: string): PrivateRepositoryRecord | null {
    const row = this.db
      .query("SELECT * FROM private_git_repositories WHERE record_id=?")
      .get(recordId) as RepositoryRow | null;
    return row ? mapRepository(row) : null;
  }

  markRepositoryReady(recordId: string): PrivateRepositoryRecord {
    this.db
      .query(
        "UPDATE private_git_repositories SET state='ready',failure_code=NULL,updated_at=? WHERE record_id=?",
      )
      .run(now(), recordId);
    return this.requiredRepository(recordId);
  }

  markRepositoryAttention(
    recordId: string,
    failureCode: string,
  ): PrivateRepositoryRecord {
    this.db
      .query(
        "UPDATE private_git_repositories SET state='attention_required',failure_code=?,updated_at=? WHERE record_id=?",
      )
      .run(failureCode, now(), recordId);
    return this.requiredRepository(recordId);
  }

  claimWorkspace(
    input: Omit<
      PrivateWorkspaceRecord,
      | "state"
      | "fingerprint"
      | "checkpointId"
      | "failureCode"
      | "createdAt"
      | "updatedAt"
    >,
  ): { created: boolean; record: PrivateWorkspaceRecord } {
    return this.db
      .transaction(() => {
        const existing = this.workspace(
          input.backendKind,
          input.environmentId,
          input.incarnation,
          input.physicalLineageId,
        );
        if (existing) {
          assertWorkspaceIdentity(existing, input);
          return { created: false, record: existing };
        }
        const timestamp = now();
        this.db
          .query(
            `INSERT INTO private_git_workspaces
             (record_id,repository_record_id,backend_kind,environment_id,incarnation,worker_id,run_id,physical_lineage_id,access,guest_path,branch_ref,runtime_json,state,fingerprint,checkpoint_id,failure_code,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'creating',NULL,NULL,NULL,?,?)`,
          )
          .run(
            input.recordId,
            input.repositoryRecordId,
            input.backendKind,
            input.environmentId,
            input.incarnation,
            input.workerId,
            input.runId,
            input.physicalLineageId,
            input.access,
            input.guestPath,
            input.branchRef,
            input.runtimeJson,
            timestamp,
            timestamp,
          );
        return {
          created: true,
          record: this.requiredWorkspace(input.recordId),
        };
      })
      .immediate();
  }

  workspace(
    backendKind: string,
    environmentId: string,
    incarnation: string,
    physicalLineageId: string,
  ): PrivateWorkspaceRecord | null {
    const row = this.db
      .query(
        `SELECT * FROM private_git_workspaces
         WHERE backend_kind=? AND environment_id=? AND incarnation=? AND physical_lineage_id=?`,
      )
      .get(
        backendKind,
        environmentId,
        incarnation,
        physicalLineageId,
      ) as WorkspaceRow | null;
    return row ? mapWorkspace(row) : null;
  }

  workspaceByRecordId(recordId: string): PrivateWorkspaceRecord | null {
    const row = this.db
      .query("SELECT * FROM private_git_workspaces WHERE record_id=?")
      .get(recordId) as WorkspaceRow | null;
    return row ? mapWorkspace(row) : null;
  }

  markWorkspaceReady(recordId: string): PrivateWorkspaceRecord {
    this.db
      .query(
        "UPDATE private_git_workspaces SET state='ready',failure_code=NULL,updated_at=? WHERE record_id=?",
      )
      .run(now(), recordId);
    return this.requiredWorkspace(recordId);
  }

  updateWorkspaceState(
    recordId: string,
    fingerprint: string,
    checkpointId?: string,
  ): PrivateWorkspaceRecord {
    this.db
      .query(
        `UPDATE private_git_workspaces
         SET fingerprint=?,checkpoint_id=COALESCE(?,checkpoint_id),updated_at=?
         WHERE record_id=?`,
      )
      .run(fingerprint, checkpointId ?? null, now(), recordId);
    return this.requiredWorkspace(recordId);
  }

  markWorkspaceAttention(
    recordId: string,
    failureCode: string,
  ): PrivateWorkspaceRecord {
    this.db
      .query(
        "UPDATE private_git_workspaces SET state='attention_required',failure_code=?,updated_at=? WHERE record_id=?",
      )
      .run(failureCode, now(), recordId);
    return this.requiredWorkspace(recordId);
  }

  checkpoint(checkpointId: string): PrivateCheckpointRecord | null {
    const row = this.db
      .query("SELECT * FROM private_git_checkpoints WHERE checkpoint_id=?")
      .get(checkpointId) as CheckpointRow | null;
    return row ? mapCheckpoint(row) : null;
  }

  persistCheckpoint(input: PrivateCheckpointRecord): PrivateCheckpointRecord {
    this.db
      .transaction(() => {
        const existing = this.checkpoint(input.checkpointId);
        if (existing) {
          if (
            existing.fingerprint !== input.fingerprint ||
            existing.exportId !== input.exportId ||
            existing.bundleSha256 !== input.bundleSha256 ||
            existing.bundleBytes !== input.bundleBytes ||
            existing.artifactPath !== input.artifactPath ||
            existing.manifestJson !== input.manifestJson
          )
            throw new Error(
              `Checkpoint ${input.checkpointId} conflicts with durable identity.`,
            );
          return;
        }
        this.db
          .query(
            `INSERT INTO private_git_checkpoints
             (checkpoint_id,workspace_record_id,fingerprint,export_id,bundle_sha256,bundle_bytes,artifact_path,manifest_json,created_at)
             VALUES (?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            input.checkpointId,
            input.workspaceRecordId,
            input.fingerprint,
            input.exportId,
            input.bundleSha256,
            input.bundleBytes,
            input.artifactPath,
            input.manifestJson,
            input.createdAt,
          );
      })
      .immediate();
    return this.checkpoint(input.checkpointId) as PrivateCheckpointRecord;
  }

  listRepositories(): PrivateRepositoryRecord[] {
    return (
      this.db
        .query(
          "SELECT * FROM private_git_repositories ORDER BY created_at,record_id",
        )
        .all() as RepositoryRow[]
    ).map(mapRepository);
  }

  listWorkspaces(): PrivateWorkspaceRecord[] {
    return (
      this.db
        .query(
          "SELECT * FROM private_git_workspaces ORDER BY created_at,record_id",
        )
        .all() as WorkspaceRow[]
    ).map(mapWorkspace);
  }

  private requiredRepository(recordId: string): PrivateRepositoryRecord {
    const record = this.repositoryByRecordId(recordId);
    if (!record) throw new Error(`Unknown private repository ${recordId}.`);
    return record;
  }

  private requiredWorkspace(recordId: string): PrivateWorkspaceRecord {
    const record = this.workspaceByRecordId(recordId);
    if (!record) throw new Error(`Unknown private workspace ${recordId}.`);
    return record;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS private_git_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const versions = new Set(
      (
        this.db
          .query("SELECT version FROM private_git_schema_migrations")
          .all() as Array<{ version: number }>
      ).map((row) => row.version),
    );
    if (!versions.has(1))
      this.db
        .transaction(() => {
          this.db.exec(`
            CREATE TABLE private_git_repositories (
              record_id TEXT PRIMARY KEY,
              backend_kind TEXT NOT NULL,
              environment_id TEXT NOT NULL,
              incarnation TEXT NOT NULL,
              worker_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              repository_id TEXT NOT NULL,
              source_digest TEXT NOT NULL,
              source_json TEXT NOT NULL,
              base_commit TEXT NOT NULL,
              base_tree TEXT NOT NULL,
              import_bundle_sha256 TEXT NOT NULL,
              guest_git_dir TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('materializing','ready','attention_required')),
              failure_code TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX private_git_repository_identity
              ON private_git_repositories(backend_kind,environment_id,incarnation,repository_id);
            CREATE UNIQUE INDEX private_git_repository_path
              ON private_git_repositories(backend_kind,environment_id,incarnation,guest_git_dir);
          `);
          this.db
            .query(
              "INSERT INTO private_git_schema_migrations(version,applied_at) VALUES (1,?)",
            )
            .run(now());
        })
        .immediate();
    if (!versions.has(2))
      this.db
        .transaction(() => {
          this.db.exec(`
            CREATE TABLE private_git_workspaces (
              record_id TEXT PRIMARY KEY,
              repository_record_id TEXT NOT NULL REFERENCES private_git_repositories(record_id),
              backend_kind TEXT NOT NULL,
              environment_id TEXT NOT NULL,
              incarnation TEXT NOT NULL,
              worker_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              physical_lineage_id TEXT NOT NULL,
              access TEXT NOT NULL CHECK(access IN ('read_only','read_write')),
              guest_path TEXT NOT NULL,
              branch_ref TEXT NOT NULL,
              runtime_json TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('creating','ready','attention_required')),
              fingerprint TEXT,
              checkpoint_id TEXT,
              failure_code TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            CREATE UNIQUE INDEX private_git_workspace_lineage
              ON private_git_workspaces(backend_kind,environment_id,incarnation,physical_lineage_id);
            CREATE UNIQUE INDEX private_git_workspace_path
              ON private_git_workspaces(backend_kind,environment_id,incarnation,guest_path);
            CREATE UNIQUE INDEX private_git_workspace_branch
              ON private_git_workspaces(repository_record_id,branch_ref);

            CREATE TABLE private_git_checkpoints (
              checkpoint_id TEXT PRIMARY KEY,
              workspace_record_id TEXT NOT NULL REFERENCES private_git_workspaces(record_id),
              fingerprint TEXT NOT NULL,
              export_id TEXT NOT NULL UNIQUE,
              bundle_sha256 TEXT NOT NULL,
              bundle_bytes INTEGER NOT NULL,
              artifact_path TEXT NOT NULL,
              manifest_json TEXT NOT NULL,
              created_at TEXT NOT NULL
            );
          `);
          this.db
            .query(
              "INSERT INTO private_git_schema_migrations(version,applied_at) VALUES (2,?)",
            )
            .run(now());
        })
        .immediate();
  }
}

function assertRepositoryIdentity(
  existing: PrivateRepositoryRecord,
  input: Omit<
    PrivateRepositoryRecord,
    "state" | "failureCode" | "createdAt" | "updatedAt"
  >,
): void {
  for (const key of [
    "backendKind",
    "environmentId",
    "incarnation",
    "workerId",
    "runId",
    "repositoryId",
    "sourceDigest",
    "sourceJson",
    "baseCommit",
    "baseTree",
    "guestGitDir",
  ] as const)
    if (existing[key] !== input[key])
      throw new Error(
        `Private repository ${existing.repositoryId} was reused with different ${key}.`,
      );
}

function assertWorkspaceIdentity(
  existing: PrivateWorkspaceRecord,
  input: Omit<
    PrivateWorkspaceRecord,
    | "state"
    | "fingerprint"
    | "checkpointId"
    | "failureCode"
    | "createdAt"
    | "updatedAt"
  >,
): void {
  for (const key of [
    "repositoryRecordId",
    "backendKind",
    "environmentId",
    "incarnation",
    "workerId",
    "runId",
    "physicalLineageId",
    "access",
    "guestPath",
    "branchRef",
    "runtimeJson",
  ] as const)
    if (existing[key] !== input[key])
      throw new Error(
        `Private workspace ${existing.physicalLineageId} was reused with different ${key}.`,
      );
}

function mapRepository(row: RepositoryRow): PrivateRepositoryRecord {
  return {
    recordId: row.record_id,
    backendKind: row.backend_kind,
    environmentId: row.environment_id,
    incarnation: row.incarnation,
    workerId: row.worker_id,
    runId: row.run_id,
    repositoryId: row.repository_id,
    sourceDigest: row.source_digest,
    sourceJson: row.source_json,
    baseCommit: row.base_commit,
    baseTree: row.base_tree,
    importBundleSha256: row.import_bundle_sha256,
    guestGitDir: row.guest_git_dir,
    state: row.state,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWorkspace(row: WorkspaceRow): PrivateWorkspaceRecord {
  return {
    recordId: row.record_id,
    repositoryRecordId: row.repository_record_id,
    backendKind: row.backend_kind,
    environmentId: row.environment_id,
    incarnation: row.incarnation,
    workerId: row.worker_id,
    runId: row.run_id,
    physicalLineageId: row.physical_lineage_id,
    access: row.access,
    guestPath: row.guest_path,
    branchRef: row.branch_ref,
    runtimeJson: row.runtime_json,
    state: row.state,
    fingerprint: row.fingerprint,
    checkpointId: row.checkpoint_id,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCheckpoint(row: CheckpointRow): PrivateCheckpointRecord {
  return {
    checkpointId: row.checkpoint_id,
    workspaceRecordId: row.workspace_record_id,
    fingerprint: row.fingerprint,
    exportId: row.export_id,
    bundleSha256: row.bundle_sha256,
    bundleBytes: row.bundle_bytes,
    artifactPath: row.artifact_path,
    manifestJson: row.manifest_json,
    createdAt: row.created_at,
  };
}

function now(): string {
  return new Date().toISOString();
}
