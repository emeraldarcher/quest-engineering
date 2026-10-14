import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { StreamedProcessHandle } from "./execution-environment/types.ts";
import type { WorkspaceToolOperation } from "./workspace-tool-broker-protocol.ts";

const SCHEMA_VERSION = 1;

export type WorkspaceToolBrokerSessionState =
  | "prepared"
  | "admitted"
  | "closing"
  | "closed";

export interface WorkspaceToolBrokerBinding {
  authorizationId: string;
  providerAccountId: string;
  credentialGeneration: number;
  accountEnvironmentGeneration: number;
  accountEnvironment: {
    backendKind: string;
    environmentId: string;
    incarnation: string;
  };
  runId: string;
  actionId: string;
  occurrenceId: string;
  attemptId: string;
  operationalEpoch: number;
  operationalAttempt: number;
  physicalLineageId: string;
  runEnvironment: {
    backendKind: string;
    environmentId: string;
    incarnation: string;
  };
  workspaceId: string;
  worktreeId: string;
  workspaceBindingId: string;
  workspaceAccess: "none" | "read_only" | "read_write";
  workerId: string;
  workerGeneration: number;
  resolvedToolProfile: { tools: string[] };
  resolvedToolProfileId: string;
}

export interface WorkspaceToolBrokerSessionRecord {
  sessionId: string;
  brokerGeneration: number;
  binding: WorkspaceToolBrokerBinding;
  state: WorkspaceToolBrokerSessionState;
  process: StreamedProcessHandle | null;
  closeReason: string | null;
  createdAt: string;
  admittedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
}

export type WorkspaceToolRequestState =
  | "not_submitted"
  | "submitted"
  | "completed"
  | "uncertain"
  | "cancelled"
  | "rejected";

export interface WorkspaceToolRequestRecord {
  sessionId: string;
  requestId: string;
  operation: WorkspaceToolOperation;
  mutating: boolean;
  requestDigest: string;
  state: WorkspaceToolRequestState;
  process: StreamedProcessHandle | null;
  errorCode: string | null;
  requestBytes: number;
  resultBytes: number | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

interface SessionRow {
  session_id: string;
  broker_generation: number;
  binding_json: string;
  state: WorkspaceToolBrokerSessionState;
  process_json: string | null;
  close_reason: string | null;
  created_at: string;
  admitted_at: string | null;
  closed_at: string | null;
  updated_at: string;
}

interface RequestRow {
  session_id: string;
  request_id: string;
  operation: WorkspaceToolOperation;
  mutating: number;
  request_digest: string;
  state: WorkspaceToolRequestState;
  process_json: string | null;
  error_code: string | null;
  request_bytes: number;
  result_bytes: number | null;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export class WorkspaceToolBrokerStore {
  private readonly db: Database;

  constructor(
    dataRoot: string,
    private readonly now = () => new Date(),
  ) {
    const path = join(dataRoot, "workspace-tool-broker-v1.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    try {
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
      this.bootstrap();
      this.reconcileRestart();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  createSession(input: {
    sessionId: string;
    brokerGeneration: number;
    binding: WorkspaceToolBrokerBinding;
  }): WorkspaceToolBrokerSessionRecord {
    const now = this.timestamp();
    this.db
      .query(
        `INSERT INTO broker_sessions
         (session_id,broker_generation,binding_json,state,process_json,close_reason,created_at,admitted_at,closed_at,updated_at)
         VALUES (?,?,?,'prepared',NULL,NULL,?,NULL,NULL,?)`,
      )
      .run(
        input.sessionId,
        input.brokerGeneration,
        JSON.stringify(input.binding),
        now,
        now,
      );
    this.event(input.sessionId, null, "session_prepared", null);
    return this.requiredSession(input.sessionId);
  }

  session(id: string): WorkspaceToolBrokerSessionRecord | null {
    const row = this.db
      .query("SELECT * FROM broker_sessions WHERE session_id=?")
      .get(id) as SessionRow | null;
    return row ? mapSession(row) : null;
  }

  sessions(): WorkspaceToolBrokerSessionRecord[] {
    return (
      this.db
        .query("SELECT * FROM broker_sessions ORDER BY created_at")
        .all() as SessionRow[]
    ).map(mapSession);
  }

  generation(providerAccountId: string, actionId: string): number {
    const row = this.db
      .query(
        `SELECT COALESCE(MAX(broker_generation),0) AS generation
         FROM broker_sessions
         WHERE json_extract(binding_json,'$.providerAccountId')=?
           AND json_extract(binding_json,'$.actionId')=?`,
      )
      .get(providerAccountId, actionId) as { generation: number };
    return row.generation + 1;
  }

  admit(
    id: string,
    process: StreamedProcessHandle,
  ): WorkspaceToolBrokerSessionRecord {
    const now = this.timestamp();
    const changed = this.db
      .query(
        `UPDATE broker_sessions
         SET state='admitted',process_json=?,admitted_at=COALESCE(admitted_at,?),updated_at=?
         WHERE session_id=? AND state='prepared'`,
      )
      .run(JSON.stringify(process), now, now, id);
    if (changed.changes !== 1)
      throw new Error("Workspace tool broker session is not prepared.");
    this.event(id, null, "session_admitted", null);
    return this.requiredSession(id);
  }

  closeSession(id: string, reason: string): WorkspaceToolBrokerSessionRecord {
    const now = this.timestamp();
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE broker_requests
           SET state=CASE WHEN mutating=1 AND state='submitted' THEN 'uncertain'
                          WHEN state IN ('not_submitted','submitted') THEN 'cancelled'
                          ELSE state END,
               error_code=CASE WHEN mutating=1 AND state='submitted' THEN 'broker_request_outcome_uncertain'
                               WHEN state IN ('not_submitted','submitted') THEN 'broker_session_closed'
                               ELSE error_code END,
               completed_at=CASE WHEN state IN ('not_submitted','submitted') THEN ? ELSE completed_at END,
               updated_at=?
           WHERE session_id=?`,
        )
        .run(now, now, id);
      this.db
        .query(
          `UPDATE broker_sessions SET state='closed',close_reason=?,closed_at=COALESCE(closed_at,?),updated_at=?
           WHERE session_id=? AND state!='closed'`,
        )
        .run(reason, now, now, id);
      this.event(id, null, "session_closed", reason);
    })();
    return this.requiredSession(id);
  }

  createRequest(input: {
    sessionId: string;
    requestId: string;
    operation: WorkspaceToolOperation;
    mutating: boolean;
    requestDigest: string;
    requestBytes: number;
  }): WorkspaceToolRequestRecord {
    const now = this.timestamp();
    this.db
      .query(
        `INSERT INTO broker_requests
         (session_id,request_id,operation,mutating,request_digest,state,process_json,error_code,request_bytes,result_bytes,started_at,completed_at,updated_at)
         VALUES (?,?,?,?,?,'not_submitted',NULL,NULL,?,NULL,NULL,NULL,?)`,
      )
      .run(
        input.sessionId,
        input.requestId,
        input.operation,
        input.mutating ? 1 : 0,
        input.requestDigest,
        input.requestBytes,
        now,
      );
    this.event(
      input.sessionId,
      input.requestId,
      "request_recorded",
      input.operation,
    );
    return this.requiredRequest(input.sessionId, input.requestId);
  }

  request(
    sessionId: string,
    requestId: string,
  ): WorkspaceToolRequestRecord | null {
    const row = this.db
      .query(
        "SELECT * FROM broker_requests WHERE session_id=? AND request_id=?",
      )
      .get(sessionId, requestId) as RequestRow | null;
    return row ? mapRequest(row) : null;
  }

  submitted(sessionId: string, requestId: string): WorkspaceToolRequestRecord {
    const now = this.timestamp();
    this.transition(sessionId, requestId, ["not_submitted"], "submitted", {
      startedAt: now,
    });
    this.event(sessionId, requestId, "request_submitted", null);
    return this.requiredRequest(sessionId, requestId);
  }

  bindProcess(
    sessionId: string,
    requestId: string,
    process: StreamedProcessHandle,
  ): WorkspaceToolRequestRecord {
    const now = this.timestamp();
    const changed = this.db
      .query(
        `UPDATE broker_requests SET process_json=?,updated_at=?
         WHERE session_id=? AND request_id=? AND state='submitted' AND process_json IS NULL`,
      )
      .run(JSON.stringify(process), now, sessionId, requestId);
    if (changed.changes !== 1)
      throw new Error(
        "Workspace tool broker request process binding is stale.",
      );
    this.event(sessionId, requestId, "process_acknowledged", null);
    return this.requiredRequest(sessionId, requestId);
  }

  complete(
    sessionId: string,
    requestId: string,
    resultBytes: number,
  ): WorkspaceToolRequestRecord {
    this.transition(sessionId, requestId, ["submitted"], "completed", {
      resultBytes,
      completedAt: this.timestamp(),
    });
    this.event(sessionId, requestId, "request_completed", String(resultBytes));
    return this.requiredRequest(sessionId, requestId);
  }

  reject(
    sessionId: string,
    requestId: string,
    code: string,
  ): WorkspaceToolRequestRecord {
    this.transition(
      sessionId,
      requestId,
      ["not_submitted", "submitted"],
      "rejected",
      { errorCode: code, completedAt: this.timestamp() },
    );
    this.event(sessionId, requestId, "request_rejected", code);
    return this.requiredRequest(sessionId, requestId);
  }

  uncertain(
    sessionId: string,
    requestId: string,
    code: string,
  ): WorkspaceToolRequestRecord {
    this.transition(sessionId, requestId, ["submitted"], "uncertain", {
      errorCode: code,
      completedAt: this.timestamp(),
    });
    this.event(sessionId, requestId, "request_uncertain", code);
    return this.requiredRequest(sessionId, requestId);
  }

  cancelled(
    sessionId: string,
    requestId: string,
    code = "broker_request_cancelled",
  ): WorkspaceToolRequestRecord {
    this.transition(
      sessionId,
      requestId,
      ["not_submitted", "submitted"],
      "cancelled",
      { errorCode: code, completedAt: this.timestamp() },
    );
    this.event(sessionId, requestId, "request_cancelled", code);
    return this.requiredRequest(sessionId, requestId);
  }

  private transition(
    sessionId: string,
    requestId: string,
    expected: WorkspaceToolRequestState[],
    state: WorkspaceToolRequestState,
    values: {
      errorCode?: string;
      resultBytes?: number;
      startedAt?: string;
      completedAt?: string;
    },
  ): void {
    const now = this.timestamp();
    const changed = this.db
      .query(
        `UPDATE broker_requests
         SET state=?,error_code=COALESCE(?,error_code),result_bytes=COALESCE(?,result_bytes),
             started_at=COALESCE(?,started_at),completed_at=COALESCE(?,completed_at),updated_at=?
         WHERE session_id=? AND request_id=? AND state IN (${expected.map(() => "?").join(",")})`,
      )
      .run(
        state,
        values.errorCode ?? null,
        values.resultBytes ?? null,
        values.startedAt ?? null,
        values.completedAt ?? null,
        now,
        sessionId,
        requestId,
        ...expected,
      );
    if (changed.changes !== 1)
      throw new Error("Workspace tool broker request transition is stale.");
  }

  private reconcileRestart(): void {
    const now = this.timestamp();
    this.db.transaction(() => {
      this.db
        .query(
          `UPDATE broker_requests
           SET state=CASE WHEN mutating=1 AND state='submitted' THEN 'uncertain'
                          WHEN state IN ('not_submitted','submitted') THEN 'cancelled'
                          ELSE state END,
               error_code=CASE WHEN mutating=1 AND state='submitted' THEN 'broker_request_outcome_uncertain'
                               WHEN state IN ('not_submitted','submitted') THEN 'broker_transport_lost'
                               ELSE error_code END,
               completed_at=CASE WHEN state IN ('not_submitted','submitted') THEN ? ELSE completed_at END,
               updated_at=?
           WHERE state IN ('not_submitted','submitted')`,
        )
        .run(now, now);
      this.db
        .query(
          `UPDATE broker_sessions SET state='closed',close_reason='worker_restarted',closed_at=?,updated_at=?
           WHERE state!='closed'`,
        )
        .run(now, now);
    })();
  }

  private requiredSession(id: string): WorkspaceToolBrokerSessionRecord {
    const session = this.session(id);
    if (!session)
      throw new Error(`Workspace tool broker session ${id} is missing.`);
    return session;
  }

  private requiredRequest(
    sessionId: string,
    requestId: string,
  ): WorkspaceToolRequestRecord {
    const request = this.request(sessionId, requestId);
    if (!request)
      throw new Error(`Workspace tool broker request ${requestId} is missing.`);
    return request;
  }

  private event(
    sessionId: string,
    requestId: string | null,
    type: string,
    detail: string | null,
  ): void {
    this.db
      .query(
        "INSERT INTO broker_events(session_id,request_id,event_type,detail,observed_at) VALUES (?,?,?,?,?)",
      )
      .run(sessionId, requestId, type, detail, this.timestamp());
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private bootstrap(): void {
    const versionRow = this.db.query("PRAGMA user_version").get() as {
      user_version: number;
    } | null;
    const version = Number(versionRow?.user_version ?? 0);
    const tables = this.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'broker_%'",
      )
      .all() as Array<{ name: string }>;
    if (version === 0 && tables.length === 0) {
      this.db.exec(`
        CREATE TABLE broker_sessions(
          session_id TEXT PRIMARY KEY,
          broker_generation INTEGER NOT NULL,
          binding_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('prepared','admitted','closing','closed')),
          process_json TEXT,
          close_reason TEXT,
          created_at TEXT NOT NULL,
          admitted_at TEXT,
          closed_at TEXT,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE broker_requests(
          session_id TEXT NOT NULL REFERENCES broker_sessions(session_id),
          request_id TEXT NOT NULL,
          operation TEXT NOT NULL,
          mutating INTEGER NOT NULL CHECK(mutating IN (0,1)),
          request_digest TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('not_submitted','submitted','completed','uncertain','cancelled','rejected')),
          process_json TEXT,
          error_code TEXT,
          request_bytes INTEGER NOT NULL,
          result_bytes INTEGER,
          started_at TEXT,
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(session_id,request_id)
        ) STRICT;
        CREATE TABLE broker_events(
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          request_id TEXT,
          event_type TEXT NOT NULL,
          detail TEXT,
          observed_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX broker_requests_session_state_idx ON broker_requests(session_id,state);
        PRAGMA user_version=${SCHEMA_VERSION};
      `);
      return;
    }
    if (version !== SCHEMA_VERSION)
      throw new Error(
        `Workspace tool broker SQLite schema ${version} is stale; expected ${SCHEMA_VERSION}. Recreate Worker state explicitly.`,
      );
    const names = new Set(tables.map((table) => table.name));
    for (const required of [
      "broker_sessions",
      "broker_requests",
      "broker_events",
    ])
      if (!names.has(required))
        throw new Error(
          "Workspace tool broker SQLite schema is stale or incomplete.",
        );
  }
}

function mapSession(row: SessionRow): WorkspaceToolBrokerSessionRecord {
  return {
    sessionId: row.session_id,
    brokerGeneration: row.broker_generation,
    binding: JSON.parse(row.binding_json) as WorkspaceToolBrokerBinding,
    state: row.state,
    process: row.process_json
      ? (JSON.parse(row.process_json) as StreamedProcessHandle)
      : null,
    closeReason: row.close_reason,
    createdAt: row.created_at,
    admittedAt: row.admitted_at,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
  };
}

function mapRequest(row: RequestRow): WorkspaceToolRequestRecord {
  return {
    sessionId: row.session_id,
    requestId: row.request_id,
    operation: row.operation,
    mutating: row.mutating === 1,
    requestDigest: row.request_digest,
    state: row.state,
    process: row.process_json
      ? (JSON.parse(row.process_json) as StreamedProcessHandle)
      : null,
    errorCode: row.error_code,
    requestBytes: row.request_bytes,
    resultBytes: row.result_bytes,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    updatedAt: row.updated_at,
  };
}
