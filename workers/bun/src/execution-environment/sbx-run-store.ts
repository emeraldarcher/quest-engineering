import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  PrivateGitChangeExport,
  PrivateLineageWorkspace,
} from "../workspace/private-git.ts";
import type { EnvironmentRef } from "./types.ts";

export interface SbxRunExecutionRecord {
  lineageId: string;
  actionId: string;
  runId: string;
  environmentRef: EnvironmentRef;
  workspace: PrivateLineageWorkspace;
  extensionSetDigest: string;
  state: "ready" | "attention_required";
  failureCode: string | null;
  changeExport: PrivateGitChangeExport | null;
  recoveryExport: PrivateGitChangeExport | null;
  hostResultTree: string | null;
  updatedAt: string;
}

interface Row {
  lineage_id: string;
  action_id: string;
  run_id: string;
  environment_ref_json: string;
  workspace_json: string;
  extension_set_digest: string;
  state: SbxRunExecutionRecord["state"];
  failure_code: string | null;
  change_export_json: string | null;
  recovery_export_json: string | null;
  host_result_tree: string | null;
  updated_at: string;
}

/** Durable join between QE physical lineage and independently durable SBX/Git stores. */
export class SbxRunExecutionStore {
  private readonly db: Database;

  constructor(dataRoot: string) {
    const path = join(dataRoot, "sbx-run-executions.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`CREATE TABLE IF NOT EXISTS sbx_run_executions (
      lineage_id TEXT PRIMARY KEY,
      action_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      environment_ref_json TEXT NOT NULL,
      workspace_json TEXT NOT NULL,
      extension_set_digest TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('ready','attention_required')),
      failure_code TEXT,
      change_export_json TEXT,
      recovery_export_json TEXT,
      host_result_tree TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS sbx_run_execution_action
      ON sbx_run_executions(action_id);
    CREATE INDEX IF NOT EXISTS sbx_run_execution_run
      ON sbx_run_executions(run_id);`);
    const columns = new Set(
      (
        this.db.query("PRAGMA table_info(sbx_run_executions)").all() as Array<{
          name: string;
        }>
      ).map((column) => column.name),
    );
    if (!columns.has("host_result_tree"))
      this.db.exec(
        "ALTER TABLE sbx_run_executions ADD COLUMN host_result_tree TEXT",
      );
    if (!columns.has("recovery_export_json")) {
      this.db.exec(
        "ALTER TABLE sbx_run_executions ADD COLUMN recovery_export_json TEXT",
      );
      this.db.exec(
        "UPDATE sbx_run_executions SET recovery_export_json=change_export_json WHERE change_export_json IS NOT NULL",
      );
    }
  }

  close(): void {
    this.db.close();
  }

  get(lineageId: string): SbxRunExecutionRecord | null {
    const row = this.db
      .query("SELECT * FROM sbx_run_executions WHERE lineage_id=?")
      .get(lineageId) as Row | null;
    return row ? mapRow(row) : null;
  }

  forRun(runId: string): SbxRunExecutionRecord[] {
    return (
      this.db
        .query(
          "SELECT * FROM sbx_run_executions WHERE run_id=? ORDER BY updated_at DESC",
        )
        .all(runId) as Row[]
    ).map(mapRow);
  }

  list(): SbxRunExecutionRecord[] {
    return (
      this.db
        .query("SELECT * FROM sbx_run_executions ORDER BY updated_at")
        .all() as Row[]
    ).map(mapRow);
  }

  ready(input: {
    lineageId: string;
    actionId: string;
    runId: string;
    environmentRef: EnvironmentRef;
    workspace: PrivateLineageWorkspace;
    extensionSetDigest: string;
    inheritedHostResultTree?: string;
    inheritedRecoveryExport?: PrivateGitChangeExport;
    replacementOf?: EnvironmentRef;
  }): SbxRunExecutionRecord {
    const existing = this.get(input.lineageId);
    const environmentChanged = Boolean(
      existing &&
        (existing.environmentRef.environmentId !==
          input.environmentRef.environmentId ||
          existing.environmentRef.incarnation !==
            input.environmentRef.incarnation),
    );
    const authorizedReplacement = Boolean(
      existing &&
        environmentChanged &&
        input.replacementOf &&
        sameEnvironment(existing.environmentRef, input.replacementOf),
    );
    if (
      existing &&
      (existing.runId !== input.runId ||
        (environmentChanged && !authorizedReplacement) ||
        existing.workspace.physicalLineageId !==
          input.workspace.physicalLineageId ||
        existing.extensionSetDigest !== input.extensionSetDigest)
    )
      throw new Error(
        "Durable SBX execution identity conflicts with the physical lineage.",
      );
    const now = new Date().toISOString();
    this.db
      .query(`INSERT INTO sbx_run_executions
        (lineage_id,action_id,run_id,environment_ref_json,workspace_json,extension_set_digest,state,failure_code,change_export_json,recovery_export_json,host_result_tree,created_at,updated_at)
        VALUES (?,?,?,?,?,?,'ready',NULL,?,?,?,?,?)
        ON CONFLICT(lineage_id) DO UPDATE SET
          action_id=excluded.action_id,
          environment_ref_json=excluded.environment_ref_json,
          workspace_json=excluded.workspace_json,
          extension_set_digest=excluded.extension_set_digest,
          change_export_json=CASE
            WHEN sbx_run_executions.action_id=excluded.action_id
            THEN sbx_run_executions.change_export_json
            ELSE NULL
          END,
          state='ready',failure_code=NULL,updated_at=excluded.updated_at`)
      .run(
        input.lineageId,
        input.actionId,
        input.runId,
        JSON.stringify(input.environmentRef),
        JSON.stringify(input.workspace),
        input.extensionSetDigest,
        existing?.actionId === input.actionId && existing.changeExport
          ? JSON.stringify(existing.changeExport)
          : null,
        existing?.recoveryExport
          ? JSON.stringify(existing.recoveryExport)
          : input.inheritedRecoveryExport
            ? JSON.stringify(input.inheritedRecoveryExport)
            : null,
        existing?.hostResultTree ?? input.inheritedHostResultTree ?? null,
        now,
        now,
      );
    return this.get(input.lineageId) as SbxRunExecutionRecord;
  }

  bindExport(
    lineageId: string,
    actionId: string,
    changeExport: PrivateGitChangeExport,
  ): SbxRunExecutionRecord {
    const current = this.get(lineageId);
    if (!current || current.actionId !== actionId)
      throw new Error("SBX completion export belongs to a stale Action.");
    if (
      current.changeExport &&
      current.changeExport.exportId !== changeExport.exportId
    )
      throw new Error(
        "A different private-Git export is already bound to this Action.",
      );
    this.db
      .query(
        "UPDATE sbx_run_executions SET change_export_json=?,recovery_export_json=?,host_result_tree=?,updated_at=? WHERE lineage_id=? AND action_id=?",
      )
      .run(
        JSON.stringify(changeExport),
        JSON.stringify(changeExport),
        changeExport.manifest.resultTree,
        new Date().toISOString(),
        lineageId,
        actionId,
      );
    return this.get(lineageId) as SbxRunExecutionRecord;
  }

  attention(lineageId: string, failureCode: string): void {
    this.db
      .query(
        "UPDATE sbx_run_executions SET state='attention_required',failure_code=?,updated_at=? WHERE lineage_id=?",
      )
      .run(failureCode, new Date().toISOString(), lineageId);
  }

  clearAttention(lineageId: string, failureCode: string): void {
    this.db
      .query(
        "UPDATE sbx_run_executions SET state='ready',failure_code=NULL,updated_at=? WHERE lineage_id=? AND failure_code=?",
      )
      .run(new Date().toISOString(), lineageId, failureCode);
  }
}

function sameEnvironment(left: EnvironmentRef, right: EnvironmentRef): boolean {
  return (
    left.backendKind === right.backendKind &&
    left.environmentId === right.environmentId &&
    left.incarnation === right.incarnation &&
    left.workerId === right.workerId &&
    left.runId === right.runId &&
    left.profile.id === right.profile.id &&
    left.profile.digest === right.profile.digest
  );
}

function mapRow(row: Row): SbxRunExecutionRecord {
  return {
    lineageId: row.lineage_id,
    actionId: row.action_id,
    runId: row.run_id,
    environmentRef: JSON.parse(row.environment_ref_json) as EnvironmentRef,
    workspace: JSON.parse(row.workspace_json) as PrivateLineageWorkspace,
    extensionSetDigest: row.extension_set_digest,
    state: row.state,
    failureCode: row.failure_code,
    changeExport: row.change_export_json
      ? (JSON.parse(row.change_export_json) as PrivateGitChangeExport)
      : null,
    recoveryExport: row.recovery_export_json
      ? (JSON.parse(row.recovery_export_json) as PrivateGitChangeExport)
      : null,
    hostResultTree: row.host_result_tree,
    updatedAt: row.updated_at,
  };
}
