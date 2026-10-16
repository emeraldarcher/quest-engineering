import { expect, test } from "bun:test";
import { SQL } from "bun";
import {
  HISTORICAL_PRODUCT_SCHEMA_MIGRATION,
  HISTORICAL_PRODUCT_SCHEMA_MIGRATION_COUNT,
  type ProductSqlClient,
  ReadOnlyProductEvidenceReader,
} from "../tools/forensic/historical-claude-containment/product-evidence.ts";
import {
  HISTORICAL_CANCELLATION_REQUEST_ID,
  HISTORICAL_ENVIRONMENT_ID,
  HISTORICAL_ENVIRONMENT_INCARNATION,
  HISTORICAL_SETUP_ATTEMPT_ID,
} from "../tools/forensic/historical-claude-containment/types.ts";

const databaseUrl = process.env.QE_CONTAINMENT_PRODUCT_TEST_DATABASE_URL;
const live = Boolean(databaseUrl);

test("unreachable Product database is unavailable without leaking its URL", async () => {
  const reader = new ReadOnlyProductEvidenceReader(
    "postgresql://synthetic-user:synthetic-password@127.0.0.1:1/unreachable?connect_timeout=1",
    { expectedDatabaseName: "unreachable" },
  );
  try {
    await expect(
      reader.read(HISTORICAL_SETUP_ATTEMPT_ID),
    ).rejects.toMatchObject({
      code: "product_evidence_read_unavailable",
      message: "Product database connection could not be established safely.",
    });
  } finally {
    await reader.close();
  }
});

// Opt-in integration tests require an explicitly disposable local database.
// They refuse every ordinary QE database name before creating fixture state.
test.skipIf(!live)(
  "PostgreSQL enforces the forensic transaction as read-only",
  async () => {
    await withDisposableSql(async (sql) => {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS qe_forensic_read_only_canary_v1(
          id integer PRIMARY KEY,
          value text NOT NULL
        )
      `);
      await sql.unsafe(
        `INSERT INTO qe_forensic_read_only_canary_v1(id,value)
         VALUES (1,'unchanged') ON CONFLICT (id) DO NOTHING`,
      );
      const before = await sql.unsafe(
        "SELECT id,value FROM qe_forensic_read_only_canary_v1 ORDER BY id",
      );
      let rejected: unknown = null;
      try {
        await sql.begin(
          "isolation level repeatable read read only",
          async (transaction) =>
            transaction.unsafe(
              "UPDATE qe_forensic_read_only_canary_v1 SET value='forbidden' WHERE id=1",
            ),
        );
      } catch (error) {
        rejected = error;
      }
      expect(rejected).not.toBeNull();
      expect(
        String((rejected as { message?: unknown }).message ?? rejected),
      ).toContain("read-only transaction");
      expect(
        await sql.unsafe(
          "SELECT id,value FROM qe_forensic_read_only_canary_v1 ORDER BY id",
        ),
      ).toEqual(before);
    });
  },
  30_000,
);

test.skipIf(!live)(
  "exact synthetic Product authority is immutable across the forensic read",
  async () => {
    await withDisposableSql(async (sql, databaseName) => {
      await prepareTemporaryProductSchema(sql, true);
      const before = await fixtureState(sql);
      const reader = new ReadOnlyProductEvidenceReader(
        databaseUrl as string,
        { expectedDatabaseName: databaseName },
        { sql: sql as unknown as ProductSqlClient, closeSql: false },
      );
      const evidence = await reader.read(HISTORICAL_SETUP_ATTEMPT_ID);
      expect(evidence).toMatchObject({
        cancellationRequestId: HISTORICAL_CANCELLATION_REQUEST_ID,
        invocationState: "requested",
        authorizationCount: 1,
        humanAttentionCount: 0,
        laterSemanticEventCount: 0,
        transactionReadOnly: true,
      });
      expect(await fixtureState(sql)).toEqual(before);
    });
  },
  30_000,
);

test.skipIf(!live)(
  "different valid Product database without the target is missing, not unavailable",
  async () => {
    await withDisposableSql(async (sql, databaseName) => {
      await prepareTemporaryProductSchema(sql, false);
      const reader = new ReadOnlyProductEvidenceReader(
        databaseUrl as string,
        { expectedDatabaseName: databaseName },
        { sql: sql as unknown as ProductSqlClient, closeSql: false },
      );
      await expect(
        reader.read(HISTORICAL_SETUP_ATTEMPT_ID),
      ).rejects.toMatchObject({ code: "product_evidence_missing" });
    });
  },
  30_000,
);

async function withDisposableSql(
  operation: (sql: SQL, databaseName: string) => Promise<void>,
): Promise<void> {
  const sql = new SQL(databaseUrl as string, { max: 1 });
  try {
    const identity = await sql.unsafe(
      "SELECT current_database() AS database_name",
    );
    const databaseName = String(identity[0]?.database_name ?? "");
    if (!/^qe_containment_product_reader_test_[a-z0-9_]+$/.test(databaseName))
      throw new Error(
        "Product reader integration tests require an explicitly disposable database.",
      );
    await operation(sql, databaseName);
  } finally {
    await sql.close({ timeout: 1 });
  }
}

async function prepareTemporaryProductSchema(
  sql: SQL,
  includeTarget: boolean,
): Promise<void> {
  await sql.unsafe(`
    CREATE TEMP TABLE schema_migrations(version bigint PRIMARY KEY);
    CREATE TEMP TABLE provider_account_setup_attempts(
      id text PRIMARY KEY,
      provider_account_id text NOT NULL,
      setup_generation bigint NOT NULL,
      credential_generation_before bigint NOT NULL,
      environment_generation bigint NOT NULL,
      provider_key text NOT NULL,
      authorization_auth_state text NOT NULL,
      authorization_auth_method text NOT NULL,
      auth_configuration_identity text NOT NULL,
      auth_environment_policy text NOT NULL,
      authorization_inspection_identity text NOT NULL,
      authorization_inspected_at timestamptz NOT NULL,
      worker_id text NOT NULL,
      worker_generation bigint NOT NULL,
      environment_operation_id text NOT NULL,
      backend_kind text NOT NULL,
      environment_id text NOT NULL,
      environment_incarnation text NOT NULL,
      state text NOT NULL,
      invocation_state text NOT NULL,
      process_backend_id text,
      process_start_identity text,
      process_generation text,
      process_executable text,
      invocation_requested_at timestamptz,
      invocation_acknowledged_at timestamptz,
      cancellation_request_id text,
      failure_code text
    );
    CREATE TEMP TABLE provider_account_setup_authorizations(
      id text PRIMARY KEY,
      setup_attempt_id text NOT NULL,
      setup_generation bigint NOT NULL,
      kind text NOT NULL,
      authorized_at timestamptz NOT NULL,
      auth_configuration_identity text NOT NULL,
      auth_environment_policy text NOT NULL,
      auth_inspection_identity text NOT NULL,
      auth_inspected_at timestamptz NOT NULL
    );
    CREATE TEMP TABLE provider_account_setup_events(
      id text PRIMARY KEY,
      setup_attempt_id text NOT NULL,
      provider_account_id text NOT NULL,
      setup_generation bigint NOT NULL,
      event_type text NOT NULL,
      state text NOT NULL,
      invocation_state text NOT NULL,
      occurred_at timestamptz NOT NULL
    );
    CREATE TEMP TABLE provider_account_human_attention_requests(
      id text PRIMARY KEY,
      setup_attempt_id text NOT NULL
    );
    INSERT INTO schema_migrations(version)
      SELECT value FROM generate_series(1,${HISTORICAL_PRODUCT_SCHEMA_MIGRATION_COUNT - 1}) AS value;
    INSERT INTO schema_migrations(version)
      VALUES (${HISTORICAL_PRODUCT_SCHEMA_MIGRATION});
  `);
  if (!includeTarget) return;

  const observedAt = "2026-10-15T00:00:00.000Z";
  await sql.unsafe(
    `INSERT INTO provider_account_setup_attempts(
       id,provider_account_id,setup_generation,credential_generation_before,
       environment_generation,provider_key,authorization_auth_state,
       authorization_auth_method,auth_configuration_identity,auth_environment_policy,
       authorization_inspection_identity,authorization_inspected_at,worker_id,
       worker_generation,environment_operation_id,backend_kind,environment_id,
       environment_incarnation,state,invocation_state,process_backend_id,
       process_start_identity,process_generation,process_executable,
       invocation_requested_at,invocation_acknowledged_at,cancellation_request_id,
       failure_code
     ) VALUES ($1,$2,1,2,3,'anthropic','authentication_required','none',
       'claude-code-2.1.292-subscription-v1',
       'claude-subscription-explicit-environment-v1','authentication-evidence',$3,
       'historical-worker',7,'historical-environment-operation','sbx',$4,$5,
       'cancellation_requested','requested',NULL,NULL,NULL,NULL,$3,NULL,$6,
       'setup_cancelled')`,
    [
      HISTORICAL_SETUP_ATTEMPT_ID,
      "historical-account",
      observedAt,
      HISTORICAL_ENVIRONMENT_ID,
      HISTORICAL_ENVIRONMENT_INCARNATION,
      HISTORICAL_CANCELLATION_REQUEST_ID,
    ],
  );
  await sql.unsafe(
    `INSERT INTO provider_account_setup_authorizations(
       id,setup_attempt_id,setup_generation,kind,authorized_at,
       auth_configuration_identity,auth_environment_policy,
       auth_inspection_identity,auth_inspected_at
     ) VALUES ('historical-authorization',$1,1,'provider_account_setup',$2,
       'claude-code-2.1.292-subscription-v1',
       'claude-subscription-explicit-environment-v1','authentication-evidence',$2)`,
    [HISTORICAL_SETUP_ATTEMPT_ID, observedAt],
  );
  await sql.unsafe(
    `INSERT INTO provider_account_setup_events(
       id,setup_attempt_id,provider_account_id,setup_generation,event_type,
       state,invocation_state,occurred_at
     ) VALUES
       ('authorization-event',$1,'historical-account',1,'setup_authorized',
        'authorized','not_requested',$2),
       ('cancellation-event',$1,'historical-account',1,'cancellation_requested',
        'cancellation_requested','requested',$3)`,
    [
      HISTORICAL_SETUP_ATTEMPT_ID,
      "2026-10-15T00:00:00.000Z",
      "2026-10-15T00:00:02.000Z",
    ],
  );
}

async function fixtureState(sql: SQL): Promise<unknown> {
  const rows = await sql.unsafe(`
    SELECT
      (SELECT count(*)::integer FROM provider_account_setup_attempts) AS attempts,
      (SELECT count(*)::integer FROM provider_account_setup_authorizations) AS authorizations,
      (SELECT count(*)::integer FROM provider_account_setup_events) AS events,
      (SELECT count(*)::integer FROM provider_account_human_attention_requests) AS attention,
      (SELECT state FROM provider_account_setup_attempts WHERE id='${HISTORICAL_SETUP_ATTEMPT_ID}') AS state,
      (SELECT cancellation_request_id FROM provider_account_setup_attempts WHERE id='${HISTORICAL_SETUP_ATTEMPT_ID}') AS cancellation_request_id
  `);
  return rows;
}
