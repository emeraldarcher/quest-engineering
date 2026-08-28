import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type {
  ExecuteAction,
  JsonValue,
  LocalDispatchState,
  ReconcileDispatch,
} from "../protocol/types.ts";
import type { NativeSessionRef } from "../session-host/types.ts";

export interface ProviderLineage {
  lineageId: string;
  provider: "pi";
  resultControlPath: string;
  ownershipToken: string;
  activeActionId: string | null;
  herdrSession: string | null;
  workspaceId: string | null;
  tabId: string | null;
  paneId: string | null;
  terminalId: string | null;
  agentName: string | null;
  nativeSession: NativeSessionRef | null;
}

export interface DispatchRecord {
  action: ExecuteAction;
  state: LocalDispatchState;
  lineageId: string | null;
  resultNonce: string;
  resultDirectory: string;
  outputs: Record<string, JsonValue> | null;
  failure: Record<string, JsonValue> | null;
  promptIntentAt: string | null;
  serverAcknowledgedAt: string | null;
}

export interface Acceptance {
  created: boolean;
  dispatch: DispatchRecord;
}

interface DispatchRow {
  action_id: string;
  action_json: string;
  action_hash: string;
  state: LocalDispatchState;
  lineage_id: string | null;
  result_nonce: string;
  result_directory: string;
  outputs_json: string | null;
  failure_json: string | null;
  prompt_intent_at: string | null;
  server_acknowledged_at: string | null;
}
interface LineageRow {
  lineage_id: string;
  provider: "pi";
  result_control_path: string;
  ownership_token: string;
  active_action_id: string | null;
  herdr_session: string | null;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  terminal_id: string | null;
  agent_name: string | null;
  native_session_json: string | null;
}

export class DispatchRegistry {
  readonly databasePath: string;
  readonly dataRoot: string;
  private readonly db: Database;

  constructor(databasePath: string, dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true });
    this.databasePath = databasePath;
    this.dataRoot = dataRoot;
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  accept(action: ExecuteAction): Acceptance {
    const actionJson = canonicalJson(action);
    const actionHash = digest(actionJson);
    return this.db
      .transaction(() => {
        const existing = this.row(action.action_id);
        if (existing) {
          if (
            existing.action_hash !== actionHash ||
            existing.action_json !== actionJson
          ) {
            throw new Error(`Action-ID conflict for ${action.action_id}.`);
          }
          return { created: false, dispatch: mapDispatch(existing) };
        }

        let lineageId: string | null = null;
        if (action.context_requirement.selector === "fresh") {
          lineageId = crypto.randomUUID();
          const controlPath = this.lineageControlPath(lineageId);
          this.db
            .query(`INSERT INTO provider_lineages
          (lineage_id,provider,result_control_path,ownership_token,active_action_id,created_at,updated_at)
          VALUES (?,?,?,?,NULL,?,?)`)
            .run(
              lineageId,
              "pi",
              controlPath,
              `qe-${digest(`${action.worker_id}:${lineageId}`).slice(0, 24)}`,
              now(),
              now(),
            );
        }

        const resultNonce = crypto.randomUUID();
        const resultDirectory = join(
          this.dataRoot,
          "results",
          digest(action.action_id),
          resultNonce,
        );
        this.db
          .query(`INSERT INTO dispatches
        (action_id,run_id,occurrence_id,attempt_id,semantic_step_key,action_json,action_hash,state,lineage_id,result_nonce,result_directory,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            action.action_id,
            action.run_id,
            action.occurrence_id,
            action.attempt_id,
            action.semantic_step_key,
            actionJson,
            actionHash,
            "accepted",
            lineageId,
            resultNonce,
            resultDirectory,
            now(),
            now(),
          );
        return { created: true, dispatch: this.get(action.action_id) };
      })
      .immediate();
  }

  adopt(input: {
    action: ExecuteAction;
    lineage: ProviderLineage;
    state: "accepted" | "running";
    resultNonce: string;
    resultDirectory: string;
  }): DispatchRecord {
    return this.db
      .transaction(() => {
        const existing = this.row(input.action.action_id);
        if (existing) return mapDispatch(existing);
        const lineage = input.lineage;
        this.db
          .query(`INSERT INTO provider_lineages
        (lineage_id,provider,result_control_path,ownership_token,active_action_id,herdr_session,workspace_id,tab_id,pane_id,terminal_id,agent_name,native_session_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lineage_id) DO NOTHING`)
          .run(
            lineage.lineageId,
            lineage.provider,
            lineage.resultControlPath,
            lineage.ownershipToken,
            input.action.action_id,
            lineage.herdrSession,
            lineage.workspaceId,
            lineage.tabId,
            lineage.paneId,
            lineage.terminalId,
            lineage.agentName,
            lineage.nativeSession
              ? JSON.stringify(lineage.nativeSession)
              : null,
            now(),
            now(),
          );
        const persistedLineage = this.getLineage(lineage.lineageId);
        if (persistedLineage.ownershipToken !== lineage.ownershipToken) {
          throw new Error(
            `Adopted lineage ${lineage.lineageId} has conflicting ownership.`,
          );
        }
        this.db
          .query(
            `UPDATE provider_lineages SET active_action_id=?,herdr_session=?,workspace_id=?,tab_id=?,pane_id=?,terminal_id=?,agent_name=?,native_session_json=?,updated_at=? WHERE lineage_id=?`,
          )
          .run(
            input.action.action_id,
            lineage.herdrSession,
            lineage.workspaceId,
            lineage.tabId,
            lineage.paneId,
            lineage.terminalId,
            lineage.agentName,
            lineage.nativeSession
              ? JSON.stringify(lineage.nativeSession)
              : null,
            now(),
            lineage.lineageId,
          );
        const actionJson = canonicalJson(input.action);
        this.db
          .query(`INSERT INTO dispatches
        (action_id,run_id,occurrence_id,attempt_id,semantic_step_key,action_json,action_hash,state,lineage_id,result_nonce,result_directory,prompt_intent_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(
            input.action.action_id,
            input.action.run_id,
            input.action.occurrence_id,
            input.action.attempt_id,
            input.action.semantic_step_key,
            actionJson,
            digest(actionJson),
            input.state,
            lineage.lineageId,
            input.resultNonce,
            input.resultDirectory,
            now(),
            now(),
            now(),
          );
        return this.get(input.action.action_id);
      })
      .immediate();
  }

  get(actionId: string): DispatchRecord {
    const row = this.row(actionId);
    if (!row) throw new Error(`Unknown dispatch: ${actionId}`);
    return mapDispatch(row);
  }

  list(): DispatchRecord[] {
    return (
      this.db
        .query("SELECT * FROM dispatches ORDER BY rowid")
        .all() as DispatchRow[]
    ).map(mapDispatch);
  }

  listByOccurrence(occurrenceId: string): DispatchRecord[] {
    return (
      this.db
        .query("SELECT * FROM dispatches WHERE occurrence_id=? ORDER BY rowid")
        .all(occurrenceId) as DispatchRow[]
    ).map(mapDispatch);
  }

  resolveContinuation(occurrenceId: string): ProviderLineage {
    const records = this.listByOccurrence(occurrenceId).filter(
      (item) => item.lineageId && item.state === "completed",
    );
    const lineageIds = [
      ...new Set(records.map((item) => item.lineageId as string)),
    ];
    if (lineageIds.length !== 1)
      throw new Error(
        `Continuation occurrence ${occurrenceId} has ${lineageIds.length} authoritative provider lineages.`,
      );
    return this.getLineage(lineageIds[0] as string);
  }

  assignLineage(actionId: string, lineageId: string): DispatchRecord {
    this.db
      .query(
        "UPDATE dispatches SET lineage_id=?,updated_at=? WHERE action_id=? AND lineage_id IS NULL",
      )
      .run(lineageId, now(), actionId);
    const dispatch = this.get(actionId);
    if (dispatch.lineageId !== lineageId)
      throw new Error(
        `Dispatch ${actionId} is already assigned to another lineage.`,
      );
    return dispatch;
  }

  getLineage(lineageId: string): ProviderLineage {
    const row = this.db
      .query("SELECT * FROM provider_lineages WHERE lineage_id=?")
      .get(lineageId) as LineageRow | null;
    if (!row) throw new Error(`Unknown provider lineage: ${lineageId}`);
    return mapLineage(row);
  }

  listLineages(): ProviderLineage[] {
    return (
      this.db
        .query("SELECT * FROM provider_lineages ORDER BY rowid")
        .all() as LineageRow[]
    ).map(mapLineage);
  }

  occupy(lineageId: string, actionId: string): void {
    this.db
      .transaction(() => {
        const lineage = this.getLineage(lineageId);
        if (lineage.activeActionId && lineage.activeActionId !== actionId) {
          throw new Error(
            `Provider lineage ${lineageId} is occupied by ${lineage.activeActionId}.`,
          );
        }
        this.db
          .query(
            "UPDATE provider_lineages SET active_action_id=?,updated_at=? WHERE lineage_id=?",
          )
          .run(actionId, now(), lineageId);
      })
      .immediate();
  }

  recordHost(
    lineageId: string,
    input: {
      herdrSession: string;
      workspaceId: string;
      tabId?: string;
      paneId: string;
      terminalId?: string;
      agentName: string;
      nativeSession?: NativeSessionRef;
    },
  ): void {
    this.db
      .query(`UPDATE provider_lineages SET
      herdr_session=?,workspace_id=?,tab_id=?,pane_id=?,terminal_id=?,agent_name=?,native_session_json=?,updated_at=?
      WHERE lineage_id=?`)
      .run(
        input.herdrSession,
        input.workspaceId,
        input.tabId ?? null,
        input.paneId,
        input.terminalId ?? null,
        input.agentName,
        input.nativeSession ? JSON.stringify(input.nativeSession) : null,
        now(),
        lineageId,
      );
  }

  markPromptIntent(actionId: string): void {
    this.db
      .query(
        "UPDATE dispatches SET prompt_intent_at=COALESCE(prompt_intent_at,?),updated_at=? WHERE action_id=?",
      )
      .run(now(), now(), actionId);
  }

  markRunning(actionId: string): void {
    this.db
      .query(
        "UPDATE dispatches SET state='running',updated_at=? WHERE action_id=? AND state IN ('accepted','running')",
      )
      .run(now(), actionId);
  }

  complete(
    actionId: string,
    outputs: Record<string, JsonValue>,
  ): DispatchRecord {
    return this.db
      .transaction(() => {
        const dispatch = this.get(actionId);
        if (!dispatch.lineageId)
          throw new Error(
            `Completed dispatch ${actionId} has no provider lineage.`,
          );
        if (dispatch.state === "failed" || dispatch.state === "uncertain")
          throw new Error(
            `Cannot complete ${actionId} from ${dispatch.state}.`,
          );
        this.db
          .query(
            "UPDATE dispatches SET state='completed',outputs_json=?,failure_json=NULL,updated_at=? WHERE action_id=?",
          )
          .run(JSON.stringify(outputs), now(), actionId);
        // Occupancy is physical Pi execution state, not control-plane acknowledgement.
        this.db
          .query(
            "UPDATE provider_lineages SET active_action_id=NULL,updated_at=? WHERE lineage_id=? AND active_action_id=?",
          )
          .run(now(), dispatch.lineageId, actionId);
        return this.get(actionId);
      })
      .immediate();
  }

  fail(
    actionId: string,
    failure: Record<string, JsonValue>,
    uncertain = false,
  ): DispatchRecord {
    return this.db
      .transaction(() => {
        const dispatch = this.get(actionId);
        this.db
          .query(
            "UPDATE dispatches SET state=?,failure_json=?,updated_at=? WHERE action_id=? AND state!='completed'",
          )
          .run(
            uncertain ? "uncertain" : "failed",
            JSON.stringify(failure),
            now(),
            actionId,
          );
        if (dispatch.lineageId) {
          this.db
            .query(
              "UPDATE provider_lineages SET active_action_id=NULL,updated_at=? WHERE lineage_id=? AND active_action_id=?",
            )
            .run(now(), dispatch.lineageId, actionId);
        }
        return this.get(actionId);
      })
      .immediate();
  }

  acknowledgeServerCompletion(actionId: string): void {
    this.db
      .query(
        "UPDATE dispatches SET server_acknowledged_at=COALESCE(server_acknowledged_at,?),updated_at=? WHERE action_id=? AND state='completed'",
      )
      .run(now(), now(), actionId);
  }

  reconcilePayloads(): ReconcileDispatch[] {
    return this.list().map((dispatch) => {
      const state = dispatch.state === "uncertain" ? "failed" : dispatch.state;
      return {
        action_id: dispatch.action.action_id,
        occurrence_id: dispatch.action.occurrence_id,
        attempt_id: dispatch.action.attempt_id,
        state,
        ...(state === "completed" && dispatch.outputs
          ? { outputs: dispatch.outputs }
          : {}),
        ...(state === "failed"
          ? { failure: dispatch.failure ?? { reason: "execution_uncertain" } }
          : {}),
      };
    });
  }

  private lineageControlPath(lineageId: string): string {
    return join(this.dataRoot, "lineages", lineageId, "result-control.json");
  }

  private row(actionId: string): DispatchRow | null {
    return this.db
      .query("SELECT * FROM dispatches WHERE action_id=?")
      .get(actionId) as DispatchRow | null;
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_lineages (
        lineage_id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK(provider='pi'),
        result_control_path TEXT NOT NULL UNIQUE,
        ownership_token TEXT NOT NULL UNIQUE,
        active_action_id TEXT,
        herdr_session TEXT,
        workspace_id TEXT,
        tab_id TEXT,
        pane_id TEXT,
        terminal_id TEXT,
        agent_name TEXT,
        native_session_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatches (
        action_id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        occurrence_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        semantic_step_key TEXT NOT NULL,
        action_json TEXT NOT NULL,
        action_hash TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('accepted','running','completed','failed','uncertain')),
        lineage_id TEXT REFERENCES provider_lineages(lineage_id),
        result_nonce TEXT NOT NULL,
        result_directory TEXT NOT NULL,
        outputs_json TEXT,
        failure_json TEXT,
        prompt_intent_at TEXT,
        server_acknowledged_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dispatches_occurrence_id ON dispatches(occurrence_id);
      CREATE INDEX IF NOT EXISTS dispatches_attempt_id ON dispatches(attempt_id);
      CREATE INDEX IF NOT EXISTS dispatches_run_occurrence ON dispatches(run_id,occurrence_id);
      CREATE INDEX IF NOT EXISTS dispatches_state ON dispatches(state);
    `);
  }
}

function mapDispatch(row: DispatchRow): DispatchRecord {
  return {
    action: JSON.parse(row.action_json) as ExecuteAction,
    state: row.state,
    lineageId: row.lineage_id,
    resultNonce: row.result_nonce,
    resultDirectory: row.result_directory,
    outputs: row.outputs_json
      ? (JSON.parse(row.outputs_json) as Record<string, JsonValue>)
      : null,
    failure: row.failure_json
      ? (JSON.parse(row.failure_json) as Record<string, JsonValue>)
      : null,
    promptIntentAt: row.prompt_intent_at,
    serverAcknowledgedAt: row.server_acknowledged_at,
  };
}
function mapLineage(row: LineageRow): ProviderLineage {
  return {
    lineageId: row.lineage_id,
    provider: row.provider,
    resultControlPath: row.result_control_path,
    ownershipToken: row.ownership_token,
    activeActionId: row.active_action_id,
    herdrSession: row.herdr_session,
    workspaceId: row.workspace_id,
    tabId: row.tab_id,
    paneId: row.pane_id,
    terminalId: row.terminal_id,
    agentName: row.agent_name,
    nativeSession: row.native_session_json
      ? (JSON.parse(row.native_session_json) as NativeSessionRef)
      : null,
  };
}
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function now(): string {
  return new Date().toISOString();
}
