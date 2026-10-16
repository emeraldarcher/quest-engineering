import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  HISTORICAL_PRODUCT_SCHEMA_MIGRATION,
  HISTORICAL_PRODUCT_SCHEMA_MIGRATION_COUNT,
  type ProductSqlClient,
  type ProductSqlTransaction,
  ReadOnlyProductEvidenceReader,
} from "../tools/forensic/historical-claude-containment/product-evidence.ts";
import {
  HISTORICAL_CANCELLATION_REQUEST_ID,
  HISTORICAL_ENVIRONMENT_ID,
  HISTORICAL_ENVIRONMENT_INCARNATION,
  HISTORICAL_SETUP_ATTEMPT_ID,
} from "../tools/forensic/historical-claude-containment/types.ts";

const DATABASE_NAME = "synthetic_containment_product";

describe("historical containment Product evidence reader", () => {
  test("exact authority is valid in one repeatable-read read-only transaction", async () => {
    const sql = new FakeProductSql({
      identityRows: [identityRow()],
      authorityRows: [authorityRow()],
    });
    const reader = productReader(sql);
    const evidence = await reader.read(HISTORICAL_SETUP_ATTEMPT_ID);

    expect(evidence).toMatchObject({
      setupAttemptId: HISTORICAL_SETUP_ATTEMPT_ID,
      cancellationRequestId: HISTORICAL_CANCELLATION_REQUEST_ID,
      invocationState: "requested",
      invocationAuthority: {
        workerGeneration: 7,
        environmentOperationId: "historical-environment-operation",
        currentWorkerGeneration: 7,
        refenceChain: [],
      },
      authorizationCount: 1,
      cancellationRequestedEventCount: 1,
      laterSemanticEventCount: 0,
      humanAttentionCount: 0,
      transactionReadOnly: true,
      databaseIdentity: {
        databaseName: DATABASE_NAME,
        schemaMigrationVersion: HISTORICAL_PRODUCT_SCHEMA_MIGRATION,
      },
    });
    expect(evidence).not.toHaveProperty("backendProcessId");
    expect(evidence).not.toHaveProperty("processStartIdentity");
    expect(evidence).not.toHaveProperty("processGeneration");
    expect(evidence).not.toHaveProperty("executable");
    expect(evidence).not.toHaveProperty("invocationAcknowledgedAt");
    expect(sql.transactionOptions).toEqual([
      "isolation level repeatable read read only",
    ]);
    expect(sql.queries).toHaveLength(2);
    expect(sql.queries[1]).toContain("setup_authorization.id");
    expect(sql.queries[1]).toContain("provider_account_lifecycle_events");
    expect(sql.queries[1]).toContain("environment_generation_refence_chain");
    expect(sql.queries[1]).toContain("setup_generation_refence_chain");
    expect(sql.queries[1]).not.toMatch(/\bauthorization\./);
    expect(sql.queries[1]).not.toMatch(
      /process_backend_id|process_start_identity|process_generation|process_executable|invocation_acknowledged_at/,
    );
    expect(sql.queries.join("\n")).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|ALTER|VACUUM|TRUNCATE)\b/,
    );
  });

  test("PostgreSQL JSON timestamps without zone are interpreted as schema-defined UTC", async () => {
    const row = authorityRow();
    (row.authority_generation_event as Record<string, unknown>).occurred_at =
      "2026-10-15T00:00:00.000";
    (row.invocation_requested_event as Record<string, unknown>).occurred_at =
      "2026-10-15T00:00:00.000";
    const evidence = await productReader(
      new FakeProductSql({
        identityRows: [identityRow()],
        authorityRows: [row],
      }),
    ).read(HISTORICAL_SETUP_ATTEMPT_ID);
    expect(evidence.invocationAuthority).toMatchObject({
      authorityEventOccurredAt: "2026-10-15T00:00:00.000Z",
      invocationRequestedEventOccurredAt: "2026-10-15T00:00:00.000Z",
    });
  });

  test("successful query with no exact target is product_evidence_missing", async () => {
    const reader = productReader(
      new FakeProductSql({
        identityRows: [identityRow()],
        authorityRows: [],
      }),
    );
    await expect(
      reader.read(HISTORICAL_SETUP_ATTEMPT_ID),
    ).rejects.toMatchObject({ code: "product_evidence_missing" });
  });

  test("connection and transaction initialization failures remain unavailable", async () => {
    const connection = productReader(
      new FakeProductSql({ connectError: new Error("unreachable") }),
    );
    await expect(
      connection.read(HISTORICAL_SETUP_ATTEMPT_ID),
    ).rejects.toMatchObject({ code: "product_evidence_read_unavailable" });

    const transaction = productReader(
      new FakeProductSql({ beginError: new Error("read only begin failed") }),
    );
    await expect(
      transaction.read(HISTORICAL_SETUP_ATTEMPT_ID),
    ).rejects.toMatchObject({ code: "product_evidence_read_unavailable" });
  });

  test("query/schema failures are mismatches, not missing evidence", async () => {
    const reader = productReader(
      new FakeProductSql({
        identityRows: [identityRow()],
        authorityError: Object.assign(new Error("syntax"), {
          code: "ERR_POSTGRES_SYNTAX_ERROR",
        }),
      }),
    );
    await expect(
      reader.read(HISTORICAL_SETUP_ATTEMPT_ID),
    ).rejects.toMatchObject({ code: "product_evidence_mismatch" });
  });

  test("a different selected database fails explicit identity", async () => {
    const reader = productReader(
      new FakeProductSql({
        identityRows: [
          identityRow({ database_name: "current_development_database" }),
        ],
        authorityRows: [],
      }),
    );
    await expect(
      reader.read(HISTORICAL_SETUP_ATTEMPT_ID),
    ).rejects.toMatchObject({ code: "product_evidence_mismatch" });
  });

  test("wrong setup identity is rejected before connecting", async () => {
    const sql = new FakeProductSql({
      identityRows: [identityRow()],
      authorityRows: [authorityRow()],
    });
    await expect(productReader(sql).read(randomUUID())).rejects.toMatchObject({
      code: "product_evidence_mismatch",
    });
    expect(sql.connectCalls).toBe(0);
    expect(sql.queries).toHaveLength(0);
  });

  test.each([
    ["wrong cancellation request", { cancellation_request_id: randomUUID() }],
    [
      "cancellation belongs to another account",
      { cancellation_event_provider_account_id: randomUUID() },
    ],
    [
      "Product falsely claims physical acknowledgement",
      { invocation_state: "acknowledged" },
    ],
    ["unexpected HumanAttention", { human_attention_count: 1 }],
    ["duplicate cancellation", { cancellation_requested_event_count: 2 }],
    ["later superseding event", { later_semantic_event_count: 1 }],
    ["invalid setup authorization count", { authorization_count: 2 }],
    ["wrong ProviderAccount", { provider_account_id: randomUUID() }],
  ] as const)("%s is product_evidence_mismatch", async (_name, mutation) => {
    const reader = productReader(
      new FakeProductSql({
        identityRows: [identityRow()],
        authorityRows: [{ ...authorityRow(), ...mutation }],
      }),
    );
    await expect(
      reader.read(HISTORICAL_SETUP_ATTEMPT_ID),
    ).rejects.toMatchObject({ code: "product_evidence_mismatch" });
  });

  test.each([
    [
      "authorization after invocation intent",
      {
        invocation_requested_at: "2026-10-15T00:00:01.000Z",
        authorization_authorized_at: "2026-10-15T00:00:02.000Z",
      },
    ],
    [
      "cancellation before invocation intent",
      {
        invocation_requested_at: "2026-10-15T00:00:02.000Z",
        cancellation_event_occurred_at: "2026-10-15T00:00:01.000Z",
      },
    ],
  ] as const)("%s is a Product chronology mismatch", async (_name, mutation) => {
    const reader = productReader(
      new FakeProductSql({
        identityRows: [identityRow()],
        authorityRows: [{ ...authorityRow(), ...mutation }],
      }),
    );
    await expect(
      reader.read(HISTORICAL_SETUP_ATTEMPT_ID),
    ).rejects.toMatchObject({ code: "product_evidence_mismatch" });
  });

  test("malformed historical row is product_evidence_mismatch", async () => {
    const malformed = authorityRow();
    delete malformed.provider_key;
    const reader = productReader(
      new FakeProductSql({
        identityRows: [identityRow()],
        authorityRows: [malformed],
      }),
    );
    await expect(
      reader.read(HISTORICAL_SETUP_ATTEMPT_ID),
    ).rejects.toMatchObject({ code: "product_evidence_mismatch" });
  });
});

interface FakeProductSqlOptions {
  identityRows?: Array<Record<string, unknown>>;
  authorityRows?: Array<Record<string, unknown>>;
  connectError?: unknown;
  beginError?: unknown;
  identityError?: unknown;
  authorityError?: unknown;
}

class FakeProductSql implements ProductSqlClient {
  connectCalls = 0;
  readonly transactionOptions: string[] = [];
  readonly queries: string[] = [];

  constructor(private readonly options: FakeProductSqlOptions) {}

  async connect(): Promise<unknown> {
    this.connectCalls += 1;
    if (this.options.connectError) throw this.options.connectError;
    return this;
  }

  async begin<T>(
    options: string,
    callback: (transaction: ProductSqlTransaction) => Promise<T>,
  ): Promise<T> {
    this.transactionOptions.push(options);
    if (this.options.beginError) throw this.options.beginError;
    let invocation = 0;
    return callback({
      unsafe: async (query) => {
        this.queries.push(query);
        invocation += 1;
        if (invocation === 1) {
          if (this.options.identityError) throw this.options.identityError;
          return structuredClone(this.options.identityRows ?? []);
        }
        if (this.options.authorityError) throw this.options.authorityError;
        return structuredClone(this.options.authorityRows ?? []);
      },
    });
  }

  async close(): Promise<void> {}
}

function productReader(sql: ProductSqlClient): ReadOnlyProductEvidenceReader {
  return new ReadOnlyProductEvidenceReader(
    "postgresql://synthetic:synthetic@localhost/synthetic",
    { expectedDatabaseName: DATABASE_NAME },
    { sql, closeSql: false },
  );
}

function identityRow(
  mutation: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    database_name: DATABASE_NAME,
    database_schema: "public",
    server_locality: "local",
    server_port: 5432,
    transaction_isolation: "repeatable read",
    transaction_read_only: "on",
    migration_count: HISTORICAL_PRODUCT_SCHEMA_MIGRATION_COUNT,
    latest_migration: HISTORICAL_PRODUCT_SCHEMA_MIGRATION,
    ...mutation,
  };
}

function authorityRow(): Record<string, unknown> {
  const observedAt = "2026-10-15T00:00:00.000Z";
  return {
    setup_attempt_id: HISTORICAL_SETUP_ATTEMPT_ID,
    provider_account_id: "historical-account",
    setup_generation: 1,
    credential_generation: 2,
    environment_generation: 3,
    provider_key: "anthropic",
    attempt_authorization_auth_state: "authentication_required",
    attempt_authorization_auth_method: "none",
    attempt_auth_configuration_identity: "claude-code-2.1.292-subscription-v1",
    attempt_auth_environment_policy:
      "claude-subscription-explicit-environment-v1",
    attempt_auth_inspection_identity: "authentication-evidence",
    attempt_auth_inspected_at: observedAt,
    worker_id: "historical-worker",
    current_worker_generation: 7,
    current_environment_operation_id: "historical-environment-operation",
    authority_generation_event: {
      event_type: "environment_ensured",
      worker_id: "historical-worker",
      worker_generation: 7,
      environment_operation_id: "historical-environment-operation",
      credential_generation: 3,
      backend_kind: "sbx",
      environment_id: HISTORICAL_ENVIRONMENT_ID,
      environment_incarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
      physical_state: "available",
      lifecycle_state: "connected",
      details: { report: "credential_free", canary_persisted: true },
      occurred_at: observedAt,
    },
    authority_generation_event_count: 1,
    invocation_requested_event: {
      provider_account_id: "historical-account",
      setup_generation: 1,
      state: "invocation_requested",
      invocation_state: "requested",
      details: { observed_state: "invocation_requested" },
      occurred_at: observedAt,
    },
    invocation_requested_event_count: 1,
    environment_generation_refence_chain: [],
    setup_generation_refence_chain: [],
    backend_kind: "sbx",
    environment_id: HISTORICAL_ENVIRONMENT_ID,
    environment_incarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
    state: "cancellation_requested",
    invocation_state: "requested",
    invocation_requested_at: observedAt,
    cancellation_request_id: HISTORICAL_CANCELLATION_REQUEST_ID,
    failure_code: "setup_cancelled",
    authorization_id: "historical-authorization",
    authorization_kind: "provider_account_setup",
    authorization_setup_generation: 1,
    authorization_authorized_at: observedAt,
    authorization_auth_configuration_identity:
      "claude-code-2.1.292-subscription-v1",
    authorization_auth_environment_policy:
      "claude-subscription-explicit-environment-v1",
    authorization_auth_inspection_identity: "authentication-evidence",
    authorization_auth_inspected_at: observedAt,
    authorization_count: 1,
    setup_authorized_event_count: 1,
    cancellation_requested_event_count: 1,
    cancellation_event_provider_account_id: "historical-account",
    cancellation_event_setup_generation: 1,
    cancellation_event_state: "cancellation_requested",
    cancellation_event_invocation_state: "requested",
    cancellation_event_occurred_at: observedAt,
    later_semantic_event_count: 0,
    human_attention_count: 0,
  };
}
