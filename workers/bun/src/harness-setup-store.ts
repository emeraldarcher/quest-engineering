import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HarnessSetupInspection } from "./harnesses/types.ts";
import type { PrepareHarnessSetupCommand } from "./protocol/types.ts";

export type HarnessSetupState =
  | "authorized"
  | "preparing"
  | "invocation_requested"
  | "invocation_acknowledged"
  | "human_interaction_required"
  | "cancellation_requested"
  | "ready"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "invalidated";

export interface HarnessSetupRecord {
  setupId: string;
  setupGeneration: number;
  command: PrepareHarnessSetupCommand;
  state: HarnessSetupState;
  invocationState:
    | "not_requested"
    | "requested"
    | "acknowledged"
    | "settled"
    | "uncertain";
  inspection: HarnessSetupInspection | null;
  attentionId: string | null;
  failure: { code: string; message: string } | null;
  updatedAt: string;
}

interface SetupRow {
  setup_id: string;
  setup_generation: number;
  command_json: string;
  command_hash: string;
  state: HarnessSetupState;
  invocation_state: HarnessSetupRecord["invocationState"];
  inspection_json: string | null;
  attention_id: string | null;
  failure_json: string | null;
  updated_at: string;
}

export class HarnessSetupStore {
  private readonly db: Database;

  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true });
    this.db = new Database(join(dataRoot, "harness-setups.sqlite"), {
      create: true,
      strict: true,
    });
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
    );
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_metadata(version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS harness_setups(
        setup_id TEXT PRIMARY KEY,
        setup_generation INTEGER NOT NULL,
        command_json TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        invocation_state TEXT NOT NULL,
        inspection_json TEXT,
        attention_id TEXT,
        failure_json TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS harness_setup_responses(
        setup_id TEXT NOT NULL,
        setup_generation INTEGER NOT NULL,
        request_id TEXT NOT NULL,
        attention_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        PRIMARY KEY(setup_id,setup_generation,request_id),
        FOREIGN KEY(setup_id) REFERENCES harness_setups(setup_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS harness_setup_response_attention
        ON harness_setup_responses(setup_id,setup_generation,attention_id);
    `);
    const metadata = this.db
      .query("SELECT version FROM schema_metadata LIMIT 1")
      .get() as { version: number } | null;
    if (!metadata)
      this.db.query("INSERT INTO schema_metadata(version) VALUES (1)").run();
    else if (metadata.version !== 1)
      throw new Error(
        "Worker harness setup database is incompatible; reset this greenfield development database.",
      );
  }

  close(): void {
    this.db.close();
  }

  accept(command: PrepareHarnessSetupCommand): HarnessSetupRecord {
    const json = canonicalJson(command);
    const identityJson = canonicalJson({
      ...command,
      connection_generation: 0,
    });
    const hash = digest(identityJson);
    const current = this.row(command.setup.setup_id);
    if (current) {
      if (
        current.setup_generation !== command.setup.setup_generation ||
        current.command_hash !== hash
      )
        throw new Error(
          "Harness setup identity conflicts with durable Worker state.",
        );
      if (current.command_json !== json)
        this.db
          .query(
            "UPDATE harness_setups SET command_json=?,updated_at=? WHERE setup_id=?",
          )
          .run(json, now(), command.setup.setup_id);
      return this.get(command.setup.setup_id);
    }
    this.db
      .query(`INSERT INTO harness_setups
        (setup_id,setup_generation,command_json,command_hash,state,invocation_state,updated_at)
        VALUES (?,?,?,?,?,?,?)`)
      .run(
        command.setup.setup_id,
        command.setup.setup_generation,
        json,
        hash,
        "authorized",
        "not_requested",
        now(),
      );
    return this.get(command.setup.setup_id);
  }

  get(setupId: string): HarnessSetupRecord {
    const row = this.row(setupId);
    if (!row) throw new Error(`Unknown harness setup ${setupId}.`);
    return map(row);
  }

  list(): HarnessSetupRecord[] {
    return (
      this.db
        .query("SELECT * FROM harness_setups ORDER BY setup_id")
        .all() as SetupRow[]
    ).map(map);
  }

  responseClaimed(
    setupId: string,
    generation: number,
    requestId: string,
    attentionId: string,
  ): boolean {
    const existing = this.db
      .query(`SELECT attention_id FROM harness_setup_responses
        WHERE setup_id=? AND setup_generation=? AND request_id=?`)
      .get(setupId, generation, requestId) as { attention_id: string } | null;
    if (!existing) return false;
    if (existing.attention_id !== attentionId)
      throw new Error("Harness setup response request identity conflicts.");
    return true;
  }

  claimResponse(
    setupId: string,
    generation: number,
    requestId: string,
    attentionId: string,
  ): boolean {
    const record = this.get(setupId);
    if (record.setupGeneration !== generation)
      throw new Error("Harness setup response generation is stale.");
    const existing = this.db
      .query(`SELECT request_id,attention_id FROM harness_setup_responses
        WHERE setup_id=? AND setup_generation=? AND
          (request_id=? OR attention_id=?)`)
      .get(setupId, generation, requestId, attentionId) as {
      request_id: string;
      attention_id: string;
    } | null;
    if (existing) {
      if (
        existing.request_id !== requestId ||
        existing.attention_id !== attentionId
      )
        throw new Error("Harness setup response identity conflicts.");
      return false;
    }
    this.db
      .query(`INSERT INTO harness_setup_responses
        (setup_id,setup_generation,request_id,attention_id,accepted_at)
        VALUES (?,?,?,?,?)`)
      .run(setupId, generation, requestId, attentionId, now());
    return true;
  }

  transition(
    setupId: string,
    generation: number,
    state: HarnessSetupState,
    input: {
      invocationState?: HarnessSetupRecord["invocationState"];
      inspection?: HarnessSetupInspection | null;
      attentionId?: string | null;
      failure?: { code: string; message: string } | null;
    } = {},
  ): HarnessSetupRecord {
    const current = this.get(setupId);
    if (current.setupGeneration !== generation)
      throw new Error("Harness setup generation is stale.");
    this.db
      .query(`UPDATE harness_setups SET
        state=?,invocation_state=?,inspection_json=?,attention_id=?,failure_json=?,updated_at=?
        WHERE setup_id=? AND setup_generation=?`)
      .run(
        state,
        input.invocationState ?? current.invocationState,
        input.inspection === undefined
          ? current.inspection
            ? JSON.stringify(current.inspection)
            : null
          : input.inspection
            ? JSON.stringify(input.inspection)
            : null,
        input.attentionId === undefined
          ? current.attentionId
          : input.attentionId,
        input.failure === undefined
          ? current.failure
            ? JSON.stringify(current.failure)
            : null
          : input.failure
            ? JSON.stringify(input.failure)
            : null,
        now(),
        setupId,
        generation,
      );
    return this.get(setupId);
  }

  private row(setupId: string): SetupRow | null {
    return this.db
      .query("SELECT * FROM harness_setups WHERE setup_id=?")
      .get(setupId) as SetupRow | null;
  }
}

function map(row: SetupRow): HarnessSetupRecord {
  return {
    setupId: row.setup_id,
    setupGeneration: row.setup_generation,
    command: JSON.parse(row.command_json) as PrepareHarnessSetupCommand,
    state: row.state,
    invocationState: row.invocation_state,
    inspection: row.inspection_json
      ? (JSON.parse(row.inspection_json) as HarnessSetupInspection)
      : null,
    attentionId: row.attention_id,
    failure: row.failure_json
      ? (JSON.parse(row.failure_json) as { code: string; message: string })
      : null,
    updatedAt: row.updated_at,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function now(): string {
  return new Date().toISOString();
}
