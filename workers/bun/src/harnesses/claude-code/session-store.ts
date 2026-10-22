import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { ManagedHarnessLifecycleStore } from "../lifecycle-diagnostics.ts";

export interface ClaudeCodeSessionRecord {
  nativeSessionId: string;
  lineageId: string;
  logicalLineageId: string;
  providerAccountId: string;
  credentialGeneration: number;
  accountEnvironmentId: string;
  accountEnvironmentIncarnation: string;
  model: string;
  effort: string;
  state: "prepared" | "active" | "idle" | "closed" | "uncertain";
  createdAt: string;
  updatedAt: string;
}

interface Row {
  native_session_id: string;
  lineage_id: string;
  logical_lineage_id: string;
  provider_account_id: string;
  credential_generation: number;
  account_environment_id: string;
  account_environment_incarnation: string;
  model: string;
  effort: string;
  state: ClaudeCodeSessionRecord["state"];
  created_at: string;
  updated_at: string;
}

export class ClaudeCodeSessionStore {
  private readonly db: Database;
  readonly lifecycle: ManagedHarnessLifecycleStore;

  constructor(
    dataRoot: string,
    private readonly now = () => new Date(),
  ) {
    const path = join(dataRoot, "claude-code-sessions-v1.sqlite");
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS claude_code_sessions(
        native_session_id TEXT PRIMARY KEY,
        lineage_id TEXT NOT NULL UNIQUE,
        logical_lineage_id TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        credential_generation INTEGER NOT NULL,
        account_environment_id TEXT NOT NULL,
        account_environment_incarnation TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('prepared','active','idle','closed','uncertain')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      UPDATE claude_code_sessions
      SET state='uncertain',updated_at=datetime('now')
      WHERE state IN ('prepared','active');
    `);
    this.lifecycle = new ManagedHarnessLifecycleStore(this.db);
  }

  get(nativeSessionId: string): ClaudeCodeSessionRecord | null {
    const row = this.db
      .query("SELECT * FROM claude_code_sessions WHERE native_session_id=?")
      .get(nativeSessionId) as Row | null;
    return row ? map(row) : null;
  }

  forLineage(lineageId: string): ClaudeCodeSessionRecord | null {
    const row = this.db
      .query("SELECT * FROM claude_code_sessions WHERE lineage_id=?")
      .get(lineageId) as Row | null;
    return row ? map(row) : null;
  }

  create(
    input: Omit<ClaudeCodeSessionRecord, "state" | "createdAt" | "updatedAt">,
  ): ClaudeCodeSessionRecord {
    const now = this.now().toISOString();
    this.db
      .query(
        `INSERT INTO claude_code_sessions
         (native_session_id,lineage_id,logical_lineage_id,provider_account_id,credential_generation,account_environment_id,account_environment_incarnation,model,effort,state,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,'prepared',?,?)`,
      )
      .run(
        input.nativeSessionId,
        input.lineageId,
        input.logicalLineageId,
        input.providerAccountId,
        input.credentialGeneration,
        input.accountEnvironmentId,
        input.accountEnvironmentIncarnation,
        input.model,
        input.effort,
        now,
        now,
      );
    return this.required(input.nativeSessionId);
  }

  transition(
    nativeSessionId: string,
    from: readonly ClaudeCodeSessionRecord["state"][],
    to: ClaudeCodeSessionRecord["state"],
  ): ClaudeCodeSessionRecord {
    const changed = this.db
      .query(
        `UPDATE claude_code_sessions SET state=?,updated_at=?
         WHERE native_session_id=? AND state IN (${from.map(() => "?").join(",")})`,
      )
      .run(to, this.now().toISOString(), nativeSessionId, ...from);
    if (changed.changes !== 1)
      throw new Error("Claude Code native-session transition is stale.");
    return this.required(nativeSessionId);
  }

  closeLineage(lineageId: string): void {
    this.db
      .query(
        "UPDATE claude_code_sessions SET state='closed',updated_at=? WHERE lineage_id=? AND state!='closed'",
      )
      .run(this.now().toISOString(), lineageId);
  }

  close(): void {
    this.db.close();
  }

  private required(nativeSessionId: string): ClaudeCodeSessionRecord {
    const record = this.get(nativeSessionId);
    if (!record) throw new Error("Claude Code native session is missing.");
    return record;
  }
}

function map(row: Row): ClaudeCodeSessionRecord {
  return {
    nativeSessionId: row.native_session_id,
    lineageId: row.lineage_id,
    logicalLineageId: row.logical_lineage_id,
    providerAccountId: row.provider_account_id,
    credentialGeneration: row.credential_generation,
    accountEnvironmentId: row.account_environment_id,
    accountEnvironmentIncarnation: row.account_environment_incarnation,
    model: row.model,
    effort: row.effort,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
