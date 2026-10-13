import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { StreamedProcessHandle } from "./execution-environment/types.ts";
import type {
  ProviderAccountSetupCommand,
  ProviderAccountSetupInvocationState,
  ProviderAccountSetupState,
  ProviderAccountSetupValidation,
} from "./protocol/types.ts";

export const PROVIDER_ACCOUNT_SETUP_SCHEMA_VERSION = 1;

export interface ProviderAccountSetupRecord {
  setupAttemptId: string;
  command: ProviderAccountSetupCommand;
  state: ProviderAccountSetupState;
  invocationState: ProviderAccountSetupInvocationState;
  process: StreamedProcessHandle | null;
  attentionId: string | null;
  validation: ProviderAccountSetupValidation | null;
  failureCode: string | null;
  cancellationRequestId: string | null;
  inputDelivery: {
    attentionId: string;
    requestGeneration: number;
    deliveryAttemptId: string;
    state:
      | "delivery_requested"
      | "delivery_acknowledged"
      | "delivery_uncertain";
    requestedAt: string;
    observedAt: string | null;
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface SetupRow {
  setup_attempt_id: string;
  command_json: string;
  state: ProviderAccountSetupState;
  invocation_state: ProviderAccountSetupInvocationState;
  process_json: string | null;
  attention_id: string | null;
  validation_json: string | null;
  failure_code: string | null;
  cancellation_request_id: string | null;
  input_delivery_json: string | null;
  created_at: string;
  updated_at: string;
}

/** Current-only safe metadata ledger. Sensitive interaction bytes are never accepted here. */
export class ProviderAccountSetupStore {
  readonly databasePath: string;
  private readonly db: Database;

  constructor(
    dataRoot: string,
    databasePath = join(dataRoot, "provider-account-setups.sqlite"),
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(dataRoot, { recursive: true });
    this.databasePath = databasePath;
    this.db = new Database(databasePath, { create: true, strict: true });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    try {
      this.bootstrap();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  get(id: string): ProviderAccountSetupRecord | null {
    const row = this.db
      .query(
        "SELECT * FROM provider_account_setup_attempts WHERE setup_attempt_id=?",
      )
      .get(id) as SetupRow | null;
    return row ? mapRow(row) : null;
  }

  list(): ProviderAccountSetupRecord[] {
    return (
      this.db
        .query(
          "SELECT * FROM provider_account_setup_attempts ORDER BY created_at,setup_attempt_id",
        )
        .all() as SetupRow[]
    ).map(mapRow);
  }

  accept(command: ProviderAccountSetupCommand): ProviderAccountSetupRecord {
    return this.db
      .transaction(() => {
        const existing = this.get(command.setup.setup_attempt_id);
        const now = this.now();
        if (existing) {
          assertCompatible(existing, command);
          this.db
            .query(
              `UPDATE provider_account_setup_attempts
               SET command_json=?,updated_at=? WHERE setup_attempt_id=?`,
            )
            .run(JSON.stringify(command), now, existing.setupAttemptId);
          this.event(existing.setupAttemptId, "command_reconciled");
          return this.required(existing.setupAttemptId);
        }
        this.db
          .query(
            `INSERT INTO provider_account_setup_attempts
             (setup_attempt_id,command_json,state,invocation_state,process_json,attention_id,validation_json,failure_code,cancellation_request_id,input_delivery_json,created_at,updated_at)
             VALUES (?,?,?,?,NULL,NULL,NULL,NULL,?,NULL,?,?)`,
          )
          .run(
            command.setup.setup_attempt_id,
            JSON.stringify(command),
            command.setup.state,
            command.setup.invocation_state,
            command.setup.cancellation_request_id,
            now,
            now,
          );
        this.event(command.setup.setup_attempt_id, "authorization_accepted");
        return this.required(command.setup.setup_attempt_id);
      })
      .immediate();
  }

  transition(
    id: string,
    attributes: Partial<{
      state: ProviderAccountSetupState;
      invocationState: ProviderAccountSetupInvocationState;
      process: StreamedProcessHandle | null;
      attentionId: string | null;
      validation: ProviderAccountSetupValidation | null;
      failureCode: string | null;
      cancellationRequestId: string | null;
    }>,
    eventType: string,
  ): ProviderAccountSetupRecord {
    return this.db
      .transaction(() => {
        const current = this.required(id);
        const next = {
          state: attributes.state ?? current.state,
          invocationState:
            attributes.invocationState ?? current.invocationState,
          process:
            attributes.process === undefined
              ? current.process
              : attributes.process,
          attentionId:
            attributes.attentionId === undefined
              ? current.attentionId
              : attributes.attentionId,
          validation:
            attributes.validation === undefined
              ? current.validation
              : attributes.validation,
          failureCode:
            attributes.failureCode === undefined
              ? current.failureCode
              : attributes.failureCode,
          cancellationRequestId:
            attributes.cancellationRequestId === undefined
              ? current.cancellationRequestId
              : attributes.cancellationRequestId,
        };
        this.db
          .query(
            `UPDATE provider_account_setup_attempts
             SET state=?,invocation_state=?,process_json=?,attention_id=?,validation_json=?,failure_code=?,cancellation_request_id=?,updated_at=?
             WHERE setup_attempt_id=?`,
          )
          .run(
            next.state,
            next.invocationState,
            next.process ? JSON.stringify(next.process) : null,
            next.attentionId,
            next.validation ? JSON.stringify(next.validation) : null,
            next.failureCode,
            next.cancellationRequestId,
            this.now(),
            id,
          );
        this.event(id, eventType);
        return this.required(id);
      })
      .immediate();
  }

  requestInputDelivery(input: {
    setupAttemptId: string;
    attentionId: string;
    requestGeneration: number;
    deliveryAttemptId: string;
  }): ProviderAccountSetupRecord {
    return this.db
      .transaction(() => {
        const current = this.required(input.setupAttemptId);
        if (current.inputDelivery) {
          if (
            current.inputDelivery.attentionId !== input.attentionId ||
            current.inputDelivery.requestGeneration !==
              input.requestGeneration ||
            current.inputDelivery.deliveryAttemptId !== input.deliveryAttemptId
          )
            throw new Error(
              "ProviderAccount setup input delivery identity conflicts.",
            );
          return current;
        }
        const delivery = {
          attentionId: input.attentionId,
          requestGeneration: input.requestGeneration,
          deliveryAttemptId: input.deliveryAttemptId,
          state: "delivery_requested" as const,
          requestedAt: this.now(),
          observedAt: null,
        };
        this.db
          .query(
            "UPDATE provider_account_setup_attempts SET input_delivery_json=?,updated_at=? WHERE setup_attempt_id=?",
          )
          .run(JSON.stringify(delivery), this.now(), input.setupAttemptId);
        this.event(input.setupAttemptId, "input_delivery_requested");
        return this.required(input.setupAttemptId);
      })
      .immediate();
  }

  settleInputDelivery(
    id: string,
    state: "delivery_acknowledged" | "delivery_uncertain",
  ): ProviderAccountSetupRecord {
    return this.db
      .transaction(() => {
        const current = this.required(id);
        if (!current.inputDelivery)
          throw new Error(
            "ProviderAccount setup input delivery was not requested.",
          );
        if (current.inputDelivery.state !== "delivery_requested") {
          if (current.inputDelivery.state !== state)
            throw new Error(
              "ProviderAccount setup input delivery is already terminal.",
            );
          return current;
        }
        const delivery = {
          ...current.inputDelivery,
          state,
          observedAt: this.now(),
        };
        this.db
          .query(
            "UPDATE provider_account_setup_attempts SET input_delivery_json=?,updated_at=? WHERE setup_attempt_id=?",
          )
          .run(JSON.stringify(delivery), this.now(), id);
        this.event(id, state);
        return this.required(id);
      })
      .immediate();
  }

  events(id: string): Array<{
    eventType: string;
    details: Record<string, unknown>;
    occurredAt: string;
  }> {
    return (
      this.db
        .query(
          `SELECT event_type,details_json,occurred_at
           FROM provider_account_setup_events WHERE setup_attempt_id=? ORDER BY event_id`,
        )
        .all(id) as Array<{
        event_type: string;
        details_json: string;
        occurred_at: string;
      }>
    ).map((row) => ({
      eventType: row.event_type,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      occurredAt: row.occurred_at,
    }));
  }

  private required(id: string): ProviderAccountSetupRecord {
    const value = this.get(id);
    if (!value) throw new Error(`ProviderAccount setup ${id} does not exist.`);
    return value;
  }

  private event(id: string, eventType: string): void {
    this.db
      .query(
        `INSERT INTO provider_account_setup_events
         (setup_attempt_id,event_type,details_json,occurred_at) VALUES (?,?,?,?)`,
      )
      .run(id, eventType, "{}", this.now());
  }

  private bootstrap(): void {
    const versionRow = this.db.query("PRAGMA user_version").get() as {
      user_version: number;
    } | null;
    const version = Number(versionRow?.user_version ?? 0);
    const tables = this.db
      .query(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'provider_account_setup%'",
      )
      .all() as Array<{ name: string }>;
    if (version === 0 && tables.length === 0) {
      this.db.exec(`
        CREATE TABLE provider_account_setup_attempts(
          setup_attempt_id TEXT PRIMARY KEY,
          command_json TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('authorized','preparing','invocation_requested','invocation_acknowledged','human_interaction_required','validating','succeeded','failed','uncertain','cancellation_requested','cancelled','invalidated')),
          invocation_state TEXT NOT NULL CHECK(invocation_state IN ('not_requested','requested','acknowledged','settled','uncertain')),
          process_json TEXT,
          attention_id TEXT,
          validation_json TEXT,
          failure_code TEXT,
          cancellation_request_id TEXT,
          input_delivery_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX provider_account_setup_one_active_per_account
        ON provider_account_setup_attempts(json_extract(command_json,'$.setup.provider_account_id'))
        WHERE state IN ('authorized','preparing','invocation_requested','invocation_acknowledged','human_interaction_required','validating','cancellation_requested');
        CREATE TABLE provider_account_setup_events(
          event_id INTEGER PRIMARY KEY AUTOINCREMENT,
          setup_attempt_id TEXT NOT NULL REFERENCES provider_account_setup_attempts(setup_attempt_id) ON DELETE RESTRICT,
          event_type TEXT NOT NULL,
          details_json TEXT NOT NULL,
          occurred_at TEXT NOT NULL
        );
        CREATE INDEX provider_account_setup_events_attempt
        ON provider_account_setup_events(setup_attempt_id,event_id);
        PRAGMA user_version=${PROVIDER_ACCOUNT_SETUP_SCHEMA_VERSION};
      `);
      return;
    }
    if (version !== PROVIDER_ACCOUNT_SETUP_SCHEMA_VERSION)
      throw new Error(
        `ProviderAccount setup SQLite schema ${version} is stale; expected ${PROVIDER_ACCOUNT_SETUP_SCHEMA_VERSION}. Recreate Worker state explicitly.`,
      );
    const names = new Set(tables.map((table) => table.name));
    if (
      !names.has("provider_account_setup_attempts") ||
      !names.has("provider_account_setup_events")
    )
      throw new Error("ProviderAccount setup SQLite schema is incomplete.");

    this.assertColumns("provider_account_setup_attempts", [
      "setup_attempt_id",
      "command_json",
      "state",
      "invocation_state",
      "process_json",
      "attention_id",
      "validation_json",
      "failure_code",
      "cancellation_request_id",
      "input_delivery_json",
      "created_at",
      "updated_at",
    ]);
    this.assertColumns("provider_account_setup_events", [
      "event_id",
      "setup_attempt_id",
      "event_type",
      "details_json",
      "occurred_at",
    ]);

    const indexes = new Set(
      (
        this.db
          .query(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'provider_account_setup%'",
          )
          .all() as Array<{ name: string }>
      ).map((index) => index.name),
    );
    if (
      !indexes.has("provider_account_setup_one_active_per_account") ||
      !indexes.has("provider_account_setup_events_attempt")
    )
      throw new Error("ProviderAccount setup SQLite schema is incomplete.");
  }

  private assertColumns(table: string, expected: readonly string[]): void {
    const actual = (
      this.db.query(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    if (
      actual.length !== expected.length ||
      expected.some((column) => !actual.includes(column))
    )
      throw new Error("ProviderAccount setup SQLite schema is incomplete.");
  }

  private now(): string {
    return this.clock().toISOString();
  }
}

function mapRow(row: SetupRow): ProviderAccountSetupRecord {
  return {
    setupAttemptId: row.setup_attempt_id,
    command: JSON.parse(row.command_json) as ProviderAccountSetupCommand,
    state: row.state,
    invocationState: row.invocation_state,
    process: row.process_json
      ? (JSON.parse(row.process_json) as StreamedProcessHandle)
      : null,
    attentionId: row.attention_id,
    validation: row.validation_json
      ? (JSON.parse(row.validation_json) as ProviderAccountSetupValidation)
      : null,
    failureCode: row.failure_code,
    cancellationRequestId: row.cancellation_request_id,
    inputDelivery: row.input_delivery_json
      ? (JSON.parse(
          row.input_delivery_json,
        ) as ProviderAccountSetupRecord["inputDelivery"])
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertCompatible(
  existing: ProviderAccountSetupRecord,
  incoming: ProviderAccountSetupCommand,
): void {
  const left = existing.command.setup;
  const right = incoming.setup;
  const stable =
    left.setup_attempt_id === right.setup_attempt_id &&
    left.provider_account_id === right.provider_account_id &&
    left.setup_generation === right.setup_generation &&
    left.authorization_id === right.authorization_id &&
    left.authorization_kind === right.authorization_kind &&
    left.authorized_at === right.authorized_at &&
    left.credential_generation === right.credential_generation &&
    left.environment_generation === right.environment_generation &&
    left.provider_key === right.provider_key &&
    left.environment.backend_kind === right.environment.backend_kind &&
    left.environment.environment_id === right.environment.environment_id &&
    left.environment.incarnation === right.environment.incarnation;
  if (!stable)
    throw new Error(
      "ProviderAccount setup command conflicts with durable identity.",
    );
  if (
    incoming.connection_generation !== right.worker_generation ||
    incoming.connection_generation < existing.command.connection_generation
  )
    throw new Error("ProviderAccount setup Worker generation is stale.");
}
