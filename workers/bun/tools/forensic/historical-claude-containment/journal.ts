import { constants, Database } from "bun:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { canonicalJson } from "./evidence.ts";
import {
  CONTAINMENT_JOURNAL_SCHEMA_VERSION,
  ContainmentError,
  type ContainmentEventType,
  type ContainmentJournalEvent,
  type ValidatedContainmentEvidence,
} from "./types.ts";

interface OperationRow {
  operation_id: string;
  target_setup_attempt_id: string;
  cancellation_request_id: string;
  authorization_id: string;
  provider_account_id: string;
  worker_id: string;
  backend_kind: string;
  environment_id: string;
  environment_incarnation: string;
  backend_process_id: string;
  process_start_identity: string;
  process_generation: string;
  executable: string;
  target_identity_digest: string;
  worker_evidence_digest: string;
  product_evidence_digest: string;
  environment_evidence_digest: string;
  created_at: string;
}

interface EventRow {
  event_id: number;
  operation_id: string;
  event_type: ContainmentEventType;
  details_json: string;
  occurred_at: string;
}

/** Separate append-only event journal. It never opens Worker or Product persistence. */
export class ContainmentJournal {
  private readonly database: Database;

  constructor(
    readonly path: string,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!isAbsolute(path))
      throw new ContainmentError(
        "invalid_arguments",
        "Containment journal path must be absolute.",
      );
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new Database(
      path,
      constants.SQLITE_OPEN_READWRITE |
        constants.SQLITE_OPEN_CREATE |
        constants.SQLITE_OPEN_NOFOLLOW,
    );
    this.database.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.bootstrap();
    chmodSync(path, 0o600);
  }

  close(): void {
    this.database.close();
  }

  prepare(
    operationId: string,
    evidence: ValidatedContainmentEvidence,
  ): { created: boolean } {
    return this.database
      .transaction(() => {
        const existing = this.operation(operationId);
        if (existing) {
          assertOperation(existing, evidence);
          return { created: false };
        }
        const targetOperation = this.database
          .query(
            `SELECT operation_id FROM containment_operations
             WHERE target_setup_attempt_id=? AND cancellation_request_id=?`,
          )
          .get(
            evidence.target.setupAttemptId,
            evidence.target.cancellationRequestId,
          ) as { operation_id: string } | null;
        if (targetOperation)
          throw new ContainmentError(
            "containment_journal_conflict",
            `Historical target is already bound to containment operation ${targetOperation.operation_id}.`,
          );
        const occurredAt = this.now();
        this.database
          .query(
            `INSERT INTO containment_operations
             (operation_id,target_setup_attempt_id,cancellation_request_id,authorization_id,
              provider_account_id,worker_id,backend_kind,environment_id,environment_incarnation,
              backend_process_id,process_start_identity,process_generation,executable,
              target_identity_digest,worker_evidence_digest,product_evidence_digest,
              environment_evidence_digest,created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            operationId,
            evidence.target.setupAttemptId,
            evidence.target.cancellationRequestId,
            evidence.target.authorizationId,
            evidence.target.providerAccountId,
            evidence.target.workerId,
            evidence.target.backendKind,
            evidence.target.environmentId,
            evidence.target.environmentIncarnation,
            evidence.target.backendProcessId,
            evidence.target.processStartIdentity,
            evidence.target.processGeneration,
            evidence.target.executable,
            evidence.corroboratedEvidenceDigest,
            evidence.workerEvidenceDigest,
            evidence.productEvidenceDigest,
            evidence.environmentEvidenceDigest,
            occurredAt,
          );
        this.appendUnsafe(operationId, "prepared", {
          corroborated_evidence_digest: evidence.corroboratedEvidenceDigest,
        });
        return { created: true };
      })
      .immediate();
  }

  append(
    operationId: string,
    eventType: ContainmentEventType,
    details: Readonly<Record<string, unknown>> = {},
  ): void {
    this.database
      .transaction(() => {
        if (!this.operation(operationId))
          throw new ContainmentError(
            "containment_journal_conflict",
            "Containment operation is not prepared.",
          );
        this.appendUnsafe(operationId, eventType, details);
      })
      .immediate();
  }

  recordCancellationIntentOnce(
    operationId: string,
    details: Readonly<Record<string, unknown>>,
  ): boolean {
    return this.database
      .transaction(() => {
        if (!this.operation(operationId))
          throw new ContainmentError(
            "containment_journal_conflict",
            "Containment operation is not prepared.",
          );
        if (this.hasCancellationIntent(operationId)) return false;
        this.appendUnsafe(operationId, "cancellation_intent_recorded", details);
        return true;
      })
      .immediate();
  }

  hasCancellationIntent(operationId: string): boolean {
    return Boolean(
      this.database
        .query(
          `SELECT event_id FROM containment_events
           WHERE operation_id=? AND event_type='cancellation_intent_recorded'
           LIMIT 1`,
        )
        .get(operationId),
    );
  }

  reviewedPhysicalIdentityDigest(operationId: string): string | null {
    const row = this.database
      .query(
        `SELECT details_json FROM containment_events
         WHERE operation_id=? AND event_type='dry_run_completed'
         ORDER BY event_id DESC LIMIT 1`,
      )
      .get(operationId) as { details_json: string } | null;
    if (!row) return null;
    const details = JSON.parse(row.details_json) as Record<string, unknown>;
    return typeof details.physical_identity_digest === "string"
      ? details.physical_identity_digest
      : null;
  }

  hasEvent(operationId: string, eventType: ContainmentEventType): boolean {
    return Boolean(
      this.database
        .query(
          `SELECT event_id FROM containment_events
           WHERE operation_id=? AND event_type=? LIMIT 1`,
        )
        .get(operationId, eventType),
    );
  }

  events(operationId: string): ContainmentJournalEvent[] {
    return (
      this.database
        .query(
          `SELECT event_id,operation_id,event_type,details_json,occurred_at
           FROM containment_events WHERE operation_id=? ORDER BY event_id`,
        )
        .all(operationId) as EventRow[]
    ).map((row) => ({
      eventId: row.event_id,
      operationId: row.operation_id,
      eventType: row.event_type,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      occurredAt: row.occurred_at,
    }));
  }

  private operation(operationId: string): OperationRow | null {
    return this.database
      .query("SELECT * FROM containment_operations WHERE operation_id=?")
      .get(operationId) as OperationRow | null;
  }

  private appendUnsafe(
    operationId: string,
    eventType: ContainmentEventType,
    details: Readonly<Record<string, unknown>>,
  ): void {
    const serialized = canonicalJson(details);
    if (Buffer.byteLength(serialized, "utf8") > 4_096)
      throw new ContainmentError(
        "containment_journal_conflict",
        "Containment event metadata exceeds the safe bound.",
      );
    this.database
      .query(
        `INSERT INTO containment_events
         (operation_id,event_type,details_json,occurred_at) VALUES (?,?,?,?)`,
      )
      .run(operationId, eventType, serialized, this.now());
  }

  private bootstrap(): void {
    const version = this.database.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    const tables = this.database
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'containment_%'",
      )
      .all() as Array<{ name: string }>;
    if (version.user_version === 0 && tables.length === 0) {
      this.database.exec(`
        CREATE TABLE containment_operations(
          operation_id TEXT PRIMARY KEY,
          target_setup_attempt_id TEXT NOT NULL,
          cancellation_request_id TEXT NOT NULL,
          authorization_id TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          worker_id TEXT NOT NULL,
          backend_kind TEXT NOT NULL,
          environment_id TEXT NOT NULL,
          environment_incarnation TEXT NOT NULL,
          backend_process_id TEXT NOT NULL,
          process_start_identity TEXT NOT NULL,
          process_generation TEXT NOT NULL,
          executable TEXT NOT NULL,
          target_identity_digest TEXT NOT NULL,
          worker_evidence_digest TEXT NOT NULL,
          product_evidence_digest TEXT NOT NULL,
          environment_evidence_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          UNIQUE(target_setup_attempt_id,cancellation_request_id)
        );
        CREATE TABLE containment_events(
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          operation_id TEXT NOT NULL REFERENCES containment_operations(operation_id) ON DELETE RESTRICT,
          event_type TEXT NOT NULL CHECK(event_type IN (
            'prepared','authority_validated','physical_observation','dry_run_completed',
            'cancellation_intent_recorded','cancellation_not_submitted',
            'cancellation_submitted','cancellation_acknowledged','cancellation_uncertain',
            'target_observed_terminal','settlement_unknown','typed_error'
          )),
          details_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX containment_events_operation
          ON containment_events(operation_id,event_id);
        CREATE TRIGGER containment_operations_no_update
          BEFORE UPDATE ON containment_operations
          BEGIN SELECT RAISE(ABORT,'containment operations are append-only'); END;
        CREATE TRIGGER containment_operations_no_delete
          BEFORE DELETE ON containment_operations
          BEGIN SELECT RAISE(ABORT,'containment operations are append-only'); END;
        CREATE TRIGGER containment_events_no_update
          BEFORE UPDATE ON containment_events
          BEGIN SELECT RAISE(ABORT,'containment events are append-only'); END;
        CREATE TRIGGER containment_events_no_delete
          BEFORE DELETE ON containment_events
          BEGIN SELECT RAISE(ABORT,'containment events are append-only'); END;
        PRAGMA user_version=${CONTAINMENT_JOURNAL_SCHEMA_VERSION};
      `);
      return;
    }
    if (version.user_version !== CONTAINMENT_JOURNAL_SCHEMA_VERSION)
      throw new ContainmentError(
        "containment_journal_conflict",
        `Containment journal schema ${version.user_version} is incompatible.`,
      );
    const names = new Set(tables.map((table) => table.name));
    if (
      !names.has("containment_operations") ||
      !names.has("containment_events")
    )
      throw new ContainmentError(
        "containment_journal_conflict",
        "Containment journal schema is incomplete.",
      );
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function assertOperation(
  row: OperationRow,
  evidence: ValidatedContainmentEvidence,
): void {
  if (
    row.target_setup_attempt_id !== evidence.target.setupAttemptId ||
    row.cancellation_request_id !== evidence.target.cancellationRequestId ||
    row.authorization_id !== evidence.target.authorizationId ||
    row.provider_account_id !== evidence.target.providerAccountId ||
    row.worker_id !== evidence.target.workerId ||
    row.backend_kind !== evidence.target.backendKind ||
    row.environment_id !== evidence.target.environmentId ||
    row.environment_incarnation !== evidence.target.environmentIncarnation ||
    row.backend_process_id !== evidence.target.backendProcessId ||
    row.process_start_identity !== evidence.target.processStartIdentity ||
    row.process_generation !== evidence.target.processGeneration ||
    row.executable !== evidence.target.executable ||
    row.target_identity_digest !== evidence.corroboratedEvidenceDigest ||
    row.worker_evidence_digest !== evidence.workerEvidenceDigest ||
    row.product_evidence_digest !== evidence.productEvidenceDigest ||
    row.environment_evidence_digest !== evidence.environmentEvidenceDigest
  )
    throw new ContainmentError(
      "containment_journal_conflict",
      "Containment operation identity conflicts with prior forensic evidence.",
    );
}
