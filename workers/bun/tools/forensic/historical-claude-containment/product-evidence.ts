import { SQL } from "bun";
import { safeDigest } from "./evidence.ts";
import {
  ContainmentError,
  HISTORICAL_CANCELLATION_REQUEST_ID,
  HISTORICAL_ENVIRONMENT_ID,
  HISTORICAL_ENVIRONMENT_INCARNATION,
  HISTORICAL_SETUP_ATTEMPT_ID,
  type ProductDatabaseIdentity,
  type ProductEvidenceReader,
  type ProductSemanticAuthorityEvidence,
} from "./types.ts";

export const HISTORICAL_PRODUCT_DATABASE_NAME = "qe_phase_e_fresh_16f44656_v3";
export const HISTORICAL_PRODUCT_SCHEMA_MIGRATION = "20261017000000";
export const HISTORICAL_PRODUCT_SCHEMA_MIGRATION_COUNT = 31;

const PRODUCT_IDENTITY_ROW_KEYS = [
  "database_name",
  "database_schema",
  "server_locality",
  "server_port",
  "transaction_isolation",
  "transaction_read_only",
  "migration_count",
  "latest_migration",
] as const;

const PRODUCT_ROW_KEYS = [
  "setup_attempt_id",
  "provider_account_id",
  "setup_generation",
  "credential_generation",
  "environment_generation",
  "provider_key",
  "attempt_authorization_auth_state",
  "attempt_authorization_auth_method",
  "attempt_auth_configuration_identity",
  "attempt_auth_environment_policy",
  "attempt_auth_inspection_identity",
  "attempt_auth_inspected_at",
  "worker_id",
  "worker_generation",
  "environment_operation_id",
  "backend_kind",
  "environment_id",
  "environment_incarnation",
  "state",
  "invocation_state",
  "invocation_requested_at",
  "cancellation_request_id",
  "failure_code",
  "authorization_id",
  "authorization_kind",
  "authorization_setup_generation",
  "authorization_authorized_at",
  "authorization_auth_configuration_identity",
  "authorization_auth_environment_policy",
  "authorization_auth_inspection_identity",
  "authorization_auth_inspected_at",
  "authorization_count",
  "setup_authorized_event_count",
  "cancellation_requested_event_count",
  "cancellation_event_provider_account_id",
  "cancellation_event_setup_generation",
  "cancellation_event_state",
  "cancellation_event_invocation_state",
  "cancellation_event_occurred_at",
  "later_semantic_event_count",
  "human_attention_count",
] as const;

const PRODUCT_IDENTITY_QUERY = `
  SELECT
    current_database() AS database_name,
    current_schema() AS database_schema,
    CASE
      WHEN inet_server_addr() IS NULL
        OR inet_server_addr() <<= inet '127.0.0.0/8'
        OR inet_server_addr() <<= inet '10.0.0.0/8'
        OR inet_server_addr() <<= inet '172.16.0.0/12'
        OR inet_server_addr() <<= inet '192.168.0.0/16'
        OR inet_server_addr() <<= inet 'fc00::/7'
        OR inet_server_addr() = inet '::1'
      THEN 'local'
      ELSE 'remote'
    END AS server_locality,
    inet_server_port() AS server_port,
    current_setting('transaction_isolation') AS transaction_isolation,
    current_setting('transaction_read_only') AS transaction_read_only,
    (SELECT count(*)::integer FROM schema_migrations) AS migration_count,
    (SELECT max(version)::text FROM schema_migrations) AS latest_migration
`;

// Static forensic SQL only. The setup authorization alias deliberately avoids
// PostgreSQL's AUTHORIZATION keyword, which caused the original Gate-1 query
// to fail at `authorization.id` before any authority row could be classified.
const PRODUCT_AUTHORITY_QUERY = `
  SELECT
    attempt.id AS setup_attempt_id,
    attempt.provider_account_id,
    attempt.setup_generation,
    attempt.credential_generation_before AS credential_generation,
    attempt.environment_generation,
    attempt.provider_key,
    attempt.authorization_auth_state AS attempt_authorization_auth_state,
    attempt.authorization_auth_method AS attempt_authorization_auth_method,
    attempt.auth_configuration_identity AS attempt_auth_configuration_identity,
    attempt.auth_environment_policy AS attempt_auth_environment_policy,
    attempt.authorization_inspection_identity AS attempt_auth_inspection_identity,
    attempt.authorization_inspected_at AS attempt_auth_inspected_at,
    attempt.worker_id,
    attempt.worker_generation,
    attempt.environment_operation_id,
    attempt.backend_kind,
    attempt.environment_id,
    attempt.environment_incarnation,
    attempt.state,
    attempt.invocation_state,
    attempt.invocation_requested_at,
    attempt.cancellation_request_id,
    attempt.failure_code,
    setup_authorization.id AS authorization_id,
    setup_authorization.kind AS authorization_kind,
    setup_authorization.setup_generation AS authorization_setup_generation,
    setup_authorization.authorized_at AS authorization_authorized_at,
    setup_authorization.auth_configuration_identity AS authorization_auth_configuration_identity,
    setup_authorization.auth_environment_policy AS authorization_auth_environment_policy,
    setup_authorization.auth_inspection_identity AS authorization_auth_inspection_identity,
    setup_authorization.auth_inspected_at AS authorization_auth_inspected_at,
    (SELECT count(*)::integer
       FROM provider_account_setup_authorizations counted
      WHERE counted.setup_attempt_id = attempt.id) AS authorization_count,
    (SELECT count(*)::integer
       FROM provider_account_setup_events event
      WHERE event.setup_attempt_id = attempt.id
        AND event.event_type = 'setup_authorized') AS setup_authorized_event_count,
    (SELECT count(*)::integer
       FROM provider_account_setup_events event
      WHERE event.setup_attempt_id = attempt.id
        AND event.event_type = 'cancellation_requested') AS cancellation_requested_event_count,
    (SELECT min(event.provider_account_id)
       FROM provider_account_setup_events event
      WHERE event.setup_attempt_id = attempt.id
        AND event.event_type = 'cancellation_requested') AS cancellation_event_provider_account_id,
    (SELECT min(event.setup_generation)
       FROM provider_account_setup_events event
      WHERE event.setup_attempt_id = attempt.id
        AND event.event_type = 'cancellation_requested') AS cancellation_event_setup_generation,
    (SELECT min(event.state)
       FROM provider_account_setup_events event
      WHERE event.setup_attempt_id = attempt.id
        AND event.event_type = 'cancellation_requested') AS cancellation_event_state,
    (SELECT min(event.invocation_state)
       FROM provider_account_setup_events event
      WHERE event.setup_attempt_id = attempt.id
        AND event.event_type = 'cancellation_requested') AS cancellation_event_invocation_state,
    (SELECT min(event.occurred_at)
       FROM provider_account_setup_events event
      WHERE event.setup_attempt_id = attempt.id
        AND event.event_type = 'cancellation_requested') AS cancellation_event_occurred_at,
    (SELECT count(*)::integer
       FROM provider_account_setup_events later
      WHERE later.setup_attempt_id = attempt.id
        AND later.occurred_at > (
          SELECT max(cancelled.occurred_at)
            FROM provider_account_setup_events cancelled
           WHERE cancelled.setup_attempt_id = attempt.id
             AND cancelled.event_type = 'cancellation_requested'
        )) AS later_semantic_event_count,
    (SELECT count(*)::integer
       FROM provider_account_human_attention_requests attention
      WHERE attention.setup_attempt_id = attempt.id) AS human_attention_count
  FROM provider_account_setup_attempts attempt
  LEFT JOIN provider_account_setup_authorizations setup_authorization
    ON setup_authorization.setup_attempt_id = attempt.id
  WHERE attempt.id = $1
`;

export interface ProductDatabaseTarget {
  expectedDatabaseName: string;
  expectedSchemaName?: "public";
  expectedServerLocality?: "local";
  expectedServerPort?: number;
  expectedSchemaMigration?: string;
  expectedSchemaMigrationCount?: number;
}

export interface ProductSqlTransaction {
  unsafe(
    query: string,
    values?: readonly unknown[],
  ): Promise<Array<Record<string, unknown>>>;
}

export interface ProductSqlClient {
  connect(): Promise<unknown>;
  begin<T>(
    options: string,
    callback: (transaction: ProductSqlTransaction) => Promise<T>,
  ): Promise<T>;
  close(options?: { timeout?: number }): Promise<void>;
}

export interface ProductReaderDependencies {
  sql?: ProductSqlClient;
  closeSql?: boolean;
}

type ProductReadStage =
  | "transaction_initialization"
  | "database_identity"
  | "authority_query";

/** PostgreSQL access is confined to one server-enforced read-only transaction. */
export class ReadOnlyProductEvidenceReader implements ProductEvidenceReader {
  private readonly sql: ProductSqlClient;
  private readonly closeSql: boolean;
  private readonly target: Required<ProductDatabaseTarget>;

  constructor(
    databaseUrl: string,
    target: ProductDatabaseTarget,
    dependencies: ProductReaderDependencies = {},
  ) {
    if (!/^postgres(?:ql)?:\/\//.test(databaseUrl))
      throw new ContainmentError(
        "invalid_arguments",
        "Product database URL must use PostgreSQL.",
      );
    let connectionHost = "";
    try {
      connectionHost = new URL(databaseUrl).hostname;
    } catch {
      throw new ContainmentError(
        "invalid_arguments",
        "Product database URL is malformed.",
      );
    }
    if (
      !new Set(["localhost", "127.0.0.1", "[::1]", "::1"]).has(connectionHost)
    )
      throw new ContainmentError(
        "invalid_arguments",
        "Historical Product database connection must use an explicit local host.",
      );
    if (!target.expectedDatabaseName)
      throw new ContainmentError(
        "invalid_arguments",
        "Expected Product database identity is required.",
      );
    this.target = {
      expectedDatabaseName: target.expectedDatabaseName,
      expectedSchemaName: target.expectedSchemaName ?? "public",
      expectedServerLocality: target.expectedServerLocality ?? "local",
      expectedServerPort: target.expectedServerPort ?? 5432,
      expectedSchemaMigration:
        target.expectedSchemaMigration ?? HISTORICAL_PRODUCT_SCHEMA_MIGRATION,
      expectedSchemaMigrationCount:
        target.expectedSchemaMigrationCount ??
        HISTORICAL_PRODUCT_SCHEMA_MIGRATION_COUNT,
    };
    this.sql =
      dependencies.sql ??
      (new SQL(databaseUrl, { max: 1 }) as unknown as ProductSqlClient);
    this.closeSql = dependencies.closeSql ?? !dependencies.sql;
  }

  async read(
    setupAttemptId: string,
  ): Promise<ProductSemanticAuthorityEvidence> {
    if (setupAttemptId !== HISTORICAL_SETUP_ATTEMPT_ID)
      throw mismatch(
        "Product lookup is restricted to the reviewed historical attempt.",
      );
    try {
      await this.sql.connect();
    } catch {
      throw unavailable(
        "Product database connection could not be established safely.",
      );
    }

    const progress: {
      transactionEntered: boolean;
      stage: ProductReadStage;
    } = {
      transactionEntered: false,
      stage: "transaction_initialization",
    };
    try {
      return await this.sql.begin(
        "isolation level repeatable read read only",
        async (transaction) => {
          progress.transactionEntered = true;
          progress.stage = "database_identity";
          const identityRows = await transaction.unsafe(PRODUCT_IDENTITY_QUERY);
          if (identityRows.length !== 1)
            throw mismatch(
              "Product database identity query did not return exactly one row.",
            );
          const identity = parseProductDatabaseIdentity(
            identityRows[0],
            this.target,
          );

          progress.stage = "authority_query";
          const rows = await transaction.unsafe(PRODUCT_AUTHORITY_QUERY, [
            setupAttemptId,
          ]);
          if (rows.length === 0)
            throw new ContainmentError(
              "product_evidence_missing",
              "The exact historical Product setup attempt is absent from the selected database.",
            );
          if (rows.length !== 1)
            throw mismatch(
              "Product contains ambiguous setup authorization evidence.",
            );
          return parseProductEvidenceRow(rows[0], identity);
        },
      );
    } catch (error) {
      if (error instanceof ContainmentError) throw error;
      if (!progress.transactionEntered)
        throw unavailable(
          "Product read-only transaction initialization failed.",
        );
      if (isSchemaOrQueryShapeError(error))
        throw mismatch(
          progress.stage === "database_identity"
            ? "Product database identity schema is incompatible."
            : "Product authority query is incompatible with the selected historical schema.",
        );
      throw unavailable(
        progress.stage === "database_identity"
          ? "Product database identity could not be read safely."
          : "Product cancellation evidence could not be read safely.",
      );
    }
  }

  async close(): Promise<void> {
    if (this.closeSql) await this.sql.close({ timeout: 1 });
  }
}

export function parseProductDatabaseIdentity(
  value: unknown,
  target: Required<ProductDatabaseTarget>,
): ProductDatabaseIdentity {
  const row = exactRow(value, PRODUCT_IDENTITY_ROW_KEYS, "database identity");
  exact(row.database_name, target.expectedDatabaseName, "Product database");
  exact(row.database_schema, target.expectedSchemaName, "Product schema");
  exact(
    row.server_locality,
    target.expectedServerLocality,
    "Product server locality",
  );
  exact(row.transaction_read_only, "on", "Product transaction mode");
  const isolation = text(row.transaction_isolation, "transaction isolation");
  if (!new Set(["repeatable read", "serializable"]).has(isolation))
    throw mismatch("Product transaction isolation is weaker than required.");
  exact(
    text(row.latest_migration, "latest Product migration"),
    target.expectedSchemaMigration,
    "latest Product migration",
  );
  exact(
    integer(row.migration_count),
    target.expectedSchemaMigrationCount,
    "Product migration count",
  );
  const port = positiveInteger(row.server_port, "Product server port");
  exact(port, target.expectedServerPort, "Product server port");
  return Object.freeze({
    databaseName: target.expectedDatabaseName,
    schemaName: target.expectedSchemaName,
    serverLocality: target.expectedServerLocality,
    serverPort: port,
    schemaMigrationVersion: target.expectedSchemaMigration,
    schemaMigrationCount: target.expectedSchemaMigrationCount,
  });
}

export function parseProductEvidenceRow(
  value: unknown,
  databaseIdentity: ProductDatabaseIdentity,
): ProductSemanticAuthorityEvidence {
  const row = exactRow(value, PRODUCT_ROW_KEYS, "evidence");
  exact(row.setup_attempt_id, HISTORICAL_SETUP_ATTEMPT_ID, "setup attempt");
  exact(
    row.cancellation_request_id,
    HISTORICAL_CANCELLATION_REQUEST_ID,
    "cancellation request",
  );
  exact(row.state, "cancellation_requested", "Product setup state");
  exact(row.invocation_state, "requested", "Product invocation state");
  exact(row.backend_kind, "sbx", "backend");
  exact(row.environment_id, HISTORICAL_ENVIRONMENT_ID, "environment");
  exact(
    row.environment_incarnation,
    HISTORICAL_ENVIRONMENT_INCARNATION,
    "environment incarnation",
  );
  exact(row.authorization_kind, "provider_account_setup", "authorization kind");
  exact(
    row.attempt_authorization_auth_state,
    "authentication_required",
    "authorized authentication state",
  );
  exact(
    row.attempt_authorization_auth_method,
    "none",
    "authorized authentication method",
  );
  exact(row.provider_key, "anthropic", "provider");
  exact(row.failure_code, "setup_cancelled", "cancellation failure code");

  const providerAccountId = text(row.provider_account_id, "ProviderAccount ID");
  const setupGeneration = positiveInteger(
    row.setup_generation,
    "setup generation",
  );
  exact(
    positiveInteger(
      row.authorization_setup_generation,
      "authorization setup generation",
    ),
    setupGeneration,
    "authorization setup generation",
  );
  const authConfigurationIdentity = text(
    row.attempt_auth_configuration_identity,
    "attempt authentication configuration",
  );
  exact(
    row.authorization_auth_configuration_identity,
    authConfigurationIdentity,
    "authorization authentication configuration",
  );
  const authEnvironmentPolicy = text(
    row.attempt_auth_environment_policy,
    "attempt authentication environment policy",
  );
  exact(
    row.authorization_auth_environment_policy,
    authEnvironmentPolicy,
    "authorization authentication environment policy",
  );
  const authEvidenceIdentity = text(
    row.attempt_auth_inspection_identity,
    "attempt authentication evidence identity",
  );
  exact(
    row.authorization_auth_inspection_identity,
    authEvidenceIdentity,
    "authorization authentication evidence identity",
  );
  const authInspectedAt = timestamp(
    row.attempt_auth_inspected_at,
    "attempt authentication inspection timestamp",
  );
  exact(
    timestamp(
      row.authorization_auth_inspected_at,
      "authorization authentication inspection timestamp",
    ),
    authInspectedAt,
    "authorization authentication inspection timestamp",
  );
  const authorizedAt = timestamp(
    row.authorization_authorized_at,
    "authorization timestamp",
  );
  const invocationRequestedAt = timestamp(
    row.invocation_requested_at,
    "invocation request",
  );
  if (Date.parse(authorizedAt) > Date.parse(invocationRequestedAt))
    throw mismatch("Product authorization chronology is invalid.");

  exactCount(row.authorization_count, 1, "authorization count");
  exactCount(
    row.setup_authorized_event_count,
    1,
    "setup authorization event count",
  );
  exactCount(
    row.cancellation_requested_event_count,
    1,
    "cancellation event count",
  );
  exact(
    row.cancellation_event_provider_account_id,
    providerAccountId,
    "cancellation event ProviderAccount",
  );
  exact(
    positiveInteger(
      row.cancellation_event_setup_generation,
      "cancellation event setup generation",
    ),
    setupGeneration,
    "cancellation event setup generation",
  );
  exact(
    row.cancellation_event_state,
    "cancellation_requested",
    "cancellation event state",
  );
  exact(
    row.cancellation_event_invocation_state,
    "requested",
    "cancellation event invocation state",
  );
  const cancellationEventOccurredAt = timestamp(
    row.cancellation_event_occurred_at,
    "cancellation event timestamp",
  );
  if (
    Date.parse(cancellationEventOccurredAt) < Date.parse(invocationRequestedAt)
  )
    throw mismatch("Product cancellation chronology is invalid.");
  exactCount(row.later_semantic_event_count, 0, "later semantic event count");
  exactCount(row.human_attention_count, 0, "HumanAttention count");

  const safe = {
    source: "product_repeatable_read_read_only_transaction" as const,
    databaseIdentity: Object.freeze({ ...databaseIdentity }),
    setupAttemptId: HISTORICAL_SETUP_ATTEMPT_ID,
    cancellationRequestId: HISTORICAL_CANCELLATION_REQUEST_ID,
    authorizationId: text(row.authorization_id, "authorization ID"),
    authorizationKind: "provider_account_setup" as const,
    authorizedAt,
    providerAccountId,
    setupGeneration,
    credentialGeneration: positiveInteger(
      row.credential_generation,
      "credential generation",
    ),
    environmentGeneration: positiveInteger(
      row.environment_generation,
      "environment generation",
    ),
    invocationWorkerGeneration: positiveInteger(
      row.worker_generation,
      "Worker generation",
    ),
    invocationEnvironmentOperationId: text(
      row.environment_operation_id,
      "environment operation ID",
    ),
    workerId: text(row.worker_id, "Worker ID"),
    backendKind: "sbx" as const,
    environmentId: HISTORICAL_ENVIRONMENT_ID,
    environmentIncarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
    authConfigurationIdentity,
    authEnvironmentPolicy,
    authEvidenceIdentity,
    authInspectedAt,
    state: "cancellation_requested" as const,
    invocationState: "requested" as const,
    invocationRequestedAt,
    authorizationCount: 1 as const,
    setupAuthorizedEventCount: 1 as const,
    cancellationRequestedEventCount: 1 as const,
    cancellationEventOccurredAt,
    laterSemanticEventCount: 0 as const,
    humanAttentionCount: 0 as const,
    transactionReadOnly: true as const,
  };
  return Object.freeze({ ...safe, digest: safeDigest(safe) });
}

function exactRow(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw mismatch(`Product ${name} row is malformed.`);
  const row = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...keys].sort())
  )
    throw mismatch(`Product ${name} contains unknown or missing fields.`);
  return row;
}

function timestamp(value: unknown, name: string): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf()))
    return value.toISOString();
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result))) throw mismatch(`${name} is invalid.`);
  return new Date(result).toISOString();
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw mismatch(`${name} is missing.`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const result = integer(value);
  if (result < 1) throw mismatch(`${name} is invalid.`);
  return result;
}

function exactCount(value: unknown, expected: number, name: string): void {
  const result = integer(value);
  if (result !== expected)
    throw mismatch(`${name} is not exactly ${expected}.`);
}

function integer(value: unknown): number {
  const result =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : value;
  if (!Number.isSafeInteger(result))
    throw mismatch("Product numeric evidence is invalid.");
  return result as number;
}

function exact(actual: unknown, expected: unknown, name: string): void {
  if (actual !== expected)
    throw mismatch(`${name} does not match the reviewed historical identity.`);
}

function isSchemaOrQueryShapeError(error: unknown): boolean {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  return /(?:SYNTAX|UNDEFINED|AMBIGUOUS|DATATYPE|INVALID_COLUMN|CARDINALITY)/.test(
    code,
  );
}

function unavailable(message: string): ContainmentError {
  return new ContainmentError("product_evidence_read_unavailable", message);
}

function mismatch(message: string): ContainmentError {
  return new ContainmentError("product_evidence_mismatch", message);
}
