import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  EnvironmentCapability,
  EnvironmentLifecycleState,
  EnvironmentReadinessDiagnostic,
  EnvironmentRef,
} from "./types.ts";

export type DurableEnvironmentState = "creating" | EnvironmentLifecycleState;

export interface DurableEnvironmentRecord {
  recordId: string;
  backendKind: string;
  workerId: string;
  runId: string;
  displayName: string;
  environmentId: string | null;
  incarnation: string;
  profileId: string;
  profileDigest: string;
  specDigest: string;
  state: DurableEnvironmentState;
  creationToken: string;
  creatorPid: number;
  markerDigest: string | null;
  nativeVersion: string | null;
  nativeRevision: string | null;
  nativeApiVersion: string | null;
  nativeAgent: string | null;
  capabilities: readonly EnvironmentCapability[];
  diagnostics: readonly EnvironmentReadinessDiagnostic[];
  createdAt: string;
  updatedAt: string;
  lastVerifiedAt: string | null;
  retiredAt: string | null;
}

export type DurableStopEventType =
  | "stop_intent_recorded"
  | "stop_invocation_started"
  | "stop_invocation_acknowledged"
  | "stop_invocation_ambiguous"
  | "stop_invocation_not_started"
  | "stop_reconcile_started"
  | "stop_still_in_progress"
  | "stop_observation_unavailable"
  | "stop_confirmed"
  | "stop_identity_mismatch"
  | "stop_environment_absent"
  | "stop_cycle_reopened";

export interface DurableStopEvent {
  eventId: number;
  recordId: string;
  stopId: string;
  type: DurableStopEventType;
  details: Readonly<Record<string, unknown>>;
  occurredAt: string;
}

export interface DurableStopAttempt {
  recordId: string;
  stopId: string;
  events: readonly DurableStopEvent[];
  invocation: "not_invoked" | "started" | "acknowledged" | "ambiguous";
  confirmed: boolean;
  reopened: boolean;
}

export interface EnvironmentCreationIntent {
  recordId: string;
  backendKind: string;
  workerId: string;
  runId: string;
  displayName: string;
  incarnation: string;
  profileId: string;
  profileDigest: string;
  specDigest: string;
  creationToken: string;
  creatorPid: number;
  nativeVersion: string;
  nativeRevision: string;
  nativeApiVersion: string;
}

interface StopEventRow {
  event_id: number;
  record_id: string;
  stop_id: string;
  event_type: DurableStopEventType;
  details_json: string;
  occurred_at: string;
}

interface EnvironmentRow {
  record_id: string;
  backend_kind: string;
  worker_id: string;
  run_id: string;
  display_name: string;
  environment_id: string | null;
  incarnation: string;
  profile_id: string;
  profile_digest: string;
  spec_digest: string;
  state: DurableEnvironmentState;
  creation_token: string;
  creator_pid: number;
  marker_digest: string | null;
  native_version: string | null;
  native_revision: string | null;
  native_api_version: string | null;
  native_agent: string | null;
  capabilities_json: string;
  diagnostics_json: string;
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
  retired_at: string | null;
}

export class ExecutionEnvironmentStore {
  readonly databasePath: string;
  private readonly db: Database;

  constructor(
    dataRoot: string,
    databasePath = join(dataRoot, "execution-environments.sqlite"),
    private readonly clock: () => Date = () => new Date(),
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

  claimCreation(intent: EnvironmentCreationIntent): {
    created: boolean;
    record: DurableEnvironmentRecord;
  } {
    return this.db
      .transaction(() => {
        const existing = this.current(
          intent.backendKind,
          intent.workerId,
          intent.runId,
        );
        if (existing) return { created: false, record: existing };
        const timestamp = this.now();
        this.db
          .query(
            `INSERT INTO execution_environments
            (record_id,backend_kind,worker_id,run_id,display_name,environment_id,incarnation,profile_id,profile_digest,spec_digest,state,creation_token,creator_pid,marker_digest,native_version,native_revision,native_api_version,native_agent,capabilities_json,diagnostics_json,created_at,updated_at,last_verified_at,retired_at)
            VALUES (?,?,?,?,?,NULL,?,?,?,?,'creating',?,?,NULL,?,?,?,NULL,'[]','[]',?,?,NULL,NULL)`,
          )
          .run(
            intent.recordId,
            intent.backendKind,
            intent.workerId,
            intent.runId,
            intent.displayName,
            intent.incarnation,
            intent.profileId,
            intent.profileDigest,
            intent.specDigest,
            intent.creationToken,
            intent.creatorPid,
            intent.nativeVersion,
            intent.nativeRevision,
            intent.nativeApiVersion,
            timestamp,
            timestamp,
          );
        return {
          created: true,
          record: this.required(intent.recordId),
        };
      })
      .immediate();
  }

  current(
    backendKind: string,
    workerId: string,
    runId: string,
  ): DurableEnvironmentRecord | null {
    const row = this.db
      .query(
        "SELECT * FROM execution_environments WHERE backend_kind=? AND worker_id=? AND run_id=? AND retired_at IS NULL",
      )
      .get(backendKind, workerId, runId) as EnvironmentRow | null;
    return row ? mapRow(row) : null;
  }

  byRef(ref: EnvironmentRef): DurableEnvironmentRecord | null {
    const row = this.db
      .query(
        "SELECT * FROM execution_environments WHERE backend_kind=? AND worker_id=? AND run_id=? AND environment_id=? AND incarnation=?",
      )
      .get(
        ref.backendKind,
        ref.workerId,
        ref.runId,
        ref.environmentId,
        ref.incarnation,
      ) as EnvironmentRow | null;
    return row ? mapRow(row) : null;
  }

  list(): DurableEnvironmentRecord[] {
    return (
      this.db
        .query(
          "SELECT * FROM execution_environments ORDER BY created_at,record_id",
        )
        .all() as EnvironmentRow[]
    ).map(mapRow);
  }

  acquireCreationOwnership(input: {
    recordId: string;
    creationToken: string;
    creatorPid: number;
    allowTakeover: boolean;
  }): boolean {
    return this.db
      .transaction(() => {
        const current = this.required(input.recordId);
        if (current.retiredAt || current.state !== "creating") return false;
        if (current.creationToken === input.creationToken) return true;
        if (!input.allowTakeover) return false;
        this.db
          .query(
            "UPDATE execution_environments SET creation_token=?,creator_pid=?,updated_at=? WHERE record_id=? AND state='creating' AND retired_at IS NULL",
          )
          .run(
            input.creationToken,
            input.creatorPid,
            this.now(),
            input.recordId,
          );
        return (
          this.required(input.recordId).creationToken === input.creationToken
        );
      })
      .immediate();
  }

  bindPhysical(input: {
    recordId: string;
    environmentId: string;
    nativeAgent: string;
    markerDigest: string;
    state: Extract<EnvironmentLifecycleState, "running" | "stopped">;
    capabilities: readonly EnvironmentCapability[];
    diagnostics: readonly EnvironmentReadinessDiagnostic[];
  }): DurableEnvironmentRecord {
    const record = this.required(input.recordId);
    if (record.retiredAt)
      throw new Error(`Environment record ${input.recordId} is retired.`);
    if (
      record.environmentId !== null &&
      record.environmentId !== input.environmentId
    )
      throw new Error(
        `Environment record ${input.recordId} is already bound to another physical identity.`,
      );
    const timestamp = this.now();
    this.db
      .query(
        `UPDATE execution_environments SET environment_id=?,native_agent=?,marker_digest=?,state=?,capabilities_json=?,diagnostics_json=?,last_verified_at=?,updated_at=?
         WHERE record_id=? AND retired_at IS NULL`,
      )
      .run(
        input.environmentId,
        input.nativeAgent,
        input.markerDigest,
        input.state,
        JSON.stringify(input.capabilities),
        JSON.stringify(input.diagnostics),
        timestamp,
        timestamp,
        input.recordId,
      );
    return this.required(input.recordId);
  }

  markVerified(input: {
    recordId: string;
    state: Extract<EnvironmentLifecycleState, "running" | "stopped">;
    markerDigest: string;
    capabilities: readonly EnvironmentCapability[];
    diagnostics: readonly EnvironmentReadinessDiagnostic[];
    nativeVersion: string;
    nativeRevision: string;
    nativeApiVersion: string;
  }): DurableEnvironmentRecord {
    const timestamp = this.now();
    this.db
      .query(
        `UPDATE execution_environments SET state=?,marker_digest=?,capabilities_json=?,diagnostics_json=?,native_version=?,native_revision=?,native_api_version=?,last_verified_at=?,updated_at=?
         WHERE record_id=? AND retired_at IS NULL`,
      )
      .run(
        input.state,
        input.markerDigest,
        JSON.stringify(input.capabilities),
        JSON.stringify(input.diagnostics),
        input.nativeVersion,
        input.nativeRevision,
        input.nativeApiVersion,
        timestamp,
        timestamp,
        input.recordId,
      );
    return this.required(input.recordId);
  }

  markState(
    recordId: string,
    state: DurableEnvironmentState,
    diagnostics: readonly EnvironmentReadinessDiagnostic[] = [],
  ): DurableEnvironmentRecord {
    this.db
      .query(
        "UPDATE execution_environments SET state=?,diagnostics_json=?,updated_at=? WHERE record_id=? AND retired_at IS NULL",
      )
      .run(state, JSON.stringify(diagnostics), this.now(), recordId);
    return this.required(recordId);
  }

  retire(recordId: string): DurableEnvironmentRecord {
    const timestamp = this.now();
    this.db
      .query(
        "UPDATE execution_environments SET state='removed',retired_at=COALESCE(retired_at,?),updated_at=? WHERE record_id=?",
      )
      .run(timestamp, timestamp, recordId);
    return this.required(recordId);
  }

  beginStop(
    recordId: string,
    stopId: string,
  ): {
    created: boolean;
    attempt: DurableStopAttempt;
    event?: DurableStopEvent;
  } {
    return this.db
      .transaction(() => {
        this.required(recordId);
        const existing = this.latestStopAttempt(recordId);
        if (existing && !existing.reopened)
          return { created: false, attempt: existing };
        const event = this.insertStopEvent(
          recordId,
          stopId,
          "stop_intent_recorded",
          {},
        );
        return {
          created: true,
          attempt: this.requiredStopAttempt(recordId, stopId),
          event,
        };
      })
      .immediate();
  }

  claimStopInvocation(
    recordId: string,
    stopId: string,
  ): {
    claimed: boolean;
    event?: DurableStopEvent;
  } {
    return this.db
      .transaction(() => {
        const attempt = this.requiredStopAttempt(recordId, stopId);
        if (attempt.invocation !== "not_invoked") return { claimed: false };
        return {
          claimed: true,
          event: this.insertStopEvent(
            recordId,
            stopId,
            "stop_invocation_started",
            {},
          ),
        };
      })
      .immediate();
  }

  appendStopEvent(
    recordId: string,
    stopId: string,
    type: DurableStopEventType,
    details: Readonly<Record<string, unknown>> = {},
  ): DurableStopEvent {
    this.requiredStopAttempt(recordId, stopId);
    return this.insertStopEvent(recordId, stopId, type, details);
  }

  stopEvents(recordId: string): DurableStopEvent[] {
    return (
      this.db
        .query(
          "SELECT * FROM execution_environment_stop_events WHERE record_id=? ORDER BY event_id",
        )
        .all(recordId) as StopEventRow[]
    ).map(mapStopEvent);
  }

  latestStopAttempt(recordId: string): DurableStopAttempt | null {
    const latest = this.db
      .query(
        "SELECT stop_id FROM execution_environment_stop_events WHERE record_id=? ORDER BY event_id DESC LIMIT 1",
      )
      .get(recordId) as { stop_id: string } | null;
    return latest ? this.requiredStopAttempt(recordId, latest.stop_id) : null;
  }

  reopenStopCycle(recordId: string): DurableStopEvent | null {
    return this.db
      .transaction(() => {
        const attempt = this.latestStopAttempt(recordId);
        if (!attempt || attempt.reopened || !attempt.confirmed) return null;
        return this.insertStopEvent(
          recordId,
          attempt.stopId,
          "stop_cycle_reopened",
          {},
        );
      })
      .immediate();
  }

  private requiredStopAttempt(
    recordId: string,
    stopId: string,
  ): DurableStopAttempt {
    const events = (
      this.db
        .query(
          "SELECT * FROM execution_environment_stop_events WHERE record_id=? AND stop_id=? ORDER BY event_id",
        )
        .all(recordId, stopId) as StopEventRow[]
    ).map(mapStopEvent);
    if (events.length === 0)
      throw new Error(`Unknown environment stop attempt ${stopId}.`);
    const types = new Set(events.map((event) => event.type));
    const invocation = types.has("stop_invocation_acknowledged")
      ? "acknowledged"
      : types.has("stop_invocation_ambiguous")
        ? "ambiguous"
        : types.has("stop_invocation_started")
          ? "started"
          : "not_invoked";
    return {
      recordId,
      stopId,
      events,
      invocation,
      confirmed:
        types.has("stop_confirmed") || types.has("stop_environment_absent"),
      reopened: types.has("stop_cycle_reopened"),
    };
  }

  private insertStopEvent(
    recordId: string,
    stopId: string,
    type: DurableStopEventType,
    details: Readonly<Record<string, unknown>>,
  ): DurableStopEvent {
    const result = this.db
      .query(
        "INSERT INTO execution_environment_stop_events(record_id,stop_id,event_type,details_json,occurred_at) VALUES (?,?,?,?,?) RETURNING event_id",
      )
      .get(recordId, stopId, type, JSON.stringify(details), this.now()) as {
      event_id: number;
    };
    const row = this.db
      .query("SELECT * FROM execution_environment_stop_events WHERE event_id=?")
      .get(result.event_id) as StopEventRow;
    return mapStopEvent(row);
  }

  private now(): string {
    return this.clock().toISOString();
  }

  private required(recordId: string): DurableEnvironmentRecord {
    const row = this.db
      .query("SELECT * FROM execution_environments WHERE record_id=?")
      .get(recordId) as EnvironmentRow | null;
    if (!row) throw new Error(`Unknown environment record ${recordId}.`);
    return mapRow(row);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS execution_environment_schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );
    `);
    const applied = new Set(
      (
        this.db
          .query(
            "SELECT version FROM execution_environment_schema_migrations ORDER BY version",
          )
          .all() as Array<{ version: number }>
      ).map((row) => row.version),
    );
    if (!applied.has(1))
      this.db
        .transaction(() => {
          this.db.exec(`
            CREATE TABLE execution_environments (
              record_id TEXT PRIMARY KEY,
              backend_kind TEXT NOT NULL,
              worker_id TEXT NOT NULL,
              run_id TEXT NOT NULL,
              display_name TEXT NOT NULL,
              environment_id TEXT,
              incarnation TEXT NOT NULL,
              profile_id TEXT NOT NULL,
              profile_digest TEXT NOT NULL,
              spec_digest TEXT NOT NULL,
              state TEXT NOT NULL CHECK(state IN ('creating','running','stopped','removed','missing','incompatible','degraded')),
              creation_token TEXT NOT NULL,
              creator_pid INTEGER NOT NULL,
              marker_digest TEXT,
              native_version TEXT,
              native_revision TEXT,
              native_api_version TEXT,
              native_agent TEXT,
              capabilities_json TEXT NOT NULL DEFAULT '[]',
              diagnostics_json TEXT NOT NULL DEFAULT '[]',
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              last_verified_at TEXT,
              retired_at TEXT
            );
            CREATE UNIQUE INDEX execution_environments_current_owner
              ON execution_environments(backend_kind,worker_id,run_id)
              WHERE retired_at IS NULL;
            CREATE UNIQUE INDEX execution_environments_current_name
              ON execution_environments(backend_kind,display_name)
              WHERE retired_at IS NULL;
            CREATE UNIQUE INDEX execution_environments_physical_identity
              ON execution_environments(backend_kind,environment_id)
              WHERE environment_id IS NOT NULL;
          `);
          this.db
            .query(
              "INSERT INTO execution_environment_schema_migrations(version,applied_at) VALUES (1,?)",
            )
            .run(this.now());
        })
        .immediate();
    if (!applied.has(2))
      this.db
        .transaction(() => {
          this.db.exec(`
            CREATE TABLE execution_environment_stop_events (
              event_id INTEGER PRIMARY KEY AUTOINCREMENT,
              record_id TEXT NOT NULL REFERENCES execution_environments(record_id),
              stop_id TEXT NOT NULL,
              event_type TEXT NOT NULL CHECK(event_type IN (
                'stop_intent_recorded','stop_invocation_started',
                'stop_invocation_acknowledged','stop_invocation_ambiguous',
                'stop_invocation_not_started','stop_reconcile_started',
                'stop_still_in_progress','stop_observation_unavailable',
                'stop_confirmed','stop_identity_mismatch',
                'stop_environment_absent','stop_cycle_reopened'
              )),
              details_json TEXT NOT NULL DEFAULT '{}',
              occurred_at TEXT NOT NULL
            );
            CREATE INDEX execution_environment_stop_record
              ON execution_environment_stop_events(record_id,event_id);
          `);
          this.db
            .query(
              "INSERT INTO execution_environment_schema_migrations(version,applied_at) VALUES (2,?)",
            )
            .run(this.now());
        })
        .immediate();
  }
}

function mapStopEvent(row: StopEventRow): DurableStopEvent {
  return {
    eventId: row.event_id,
    recordId: row.record_id,
    stopId: row.stop_id,
    type: row.event_type,
    details: JSON.parse(row.details_json) as Record<string, unknown>,
    occurredAt: row.occurred_at,
  };
}

function mapRow(row: EnvironmentRow): DurableEnvironmentRecord {
  return {
    recordId: row.record_id,
    backendKind: row.backend_kind,
    workerId: row.worker_id,
    runId: row.run_id,
    displayName: row.display_name,
    environmentId: row.environment_id,
    incarnation: row.incarnation,
    profileId: row.profile_id,
    profileDigest: row.profile_digest,
    specDigest: row.spec_digest,
    state: row.state,
    creationToken: row.creation_token,
    creatorPid: row.creator_pid,
    markerDigest: row.marker_digest,
    nativeVersion: row.native_version,
    nativeRevision: row.native_revision,
    nativeApiVersion: row.native_api_version,
    nativeAgent: row.native_agent,
    capabilities: JSON.parse(row.capabilities_json) as EnvironmentCapability[],
    diagnostics: JSON.parse(
      row.diagnostics_json,
    ) as EnvironmentReadinessDiagnostic[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at,
    retiredAt: row.retired_at,
  };
}
