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
  "current_worker_generation",
  "current_environment_operation_id",
  "authority_generation_event",
  "authority_generation_event_count",
  "invocation_requested_event",
  "invocation_requested_event_count",
  "environment_generation_refence_chain",
  "setup_generation_refence_chain",
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
    attempt.worker_generation AS current_worker_generation,
    attempt.environment_operation_id AS current_environment_operation_id,
    jsonb_build_object(
      'event_type', authority_generation.event_type,
      'worker_id', authority_generation.worker_id,
      'worker_generation', authority_generation.worker_generation,
      'environment_operation_id', authority_generation.operation_id,
      'credential_generation', authority_generation.credential_generation,
      'backend_kind', authority_generation.backend_kind,
      'environment_id', authority_generation.environment_id,
      'environment_incarnation', authority_generation.incarnation,
      'physical_state', authority_generation.physical_state,
      'lifecycle_state', authority_generation.lifecycle_state,
      'details', authority_generation.details,
      'occurred_at', authority_generation.occurred_at
    ) AS authority_generation_event,
    (SELECT count(*)::integer
       FROM provider_account_lifecycle_events candidate
      WHERE candidate.provider_account_id = attempt.provider_account_id
        AND candidate.event_type = authority_generation.event_type
        AND candidate.worker_id = authority_generation.worker_id
        AND candidate.worker_generation = authority_generation.worker_generation
        AND candidate.operation_id = authority_generation.operation_id
        AND candidate.occurred_at = authority_generation.occurred_at) AS authority_generation_event_count,
    jsonb_build_object(
      'provider_account_id', invocation_requested_event.provider_account_id,
      'setup_generation', invocation_requested_event.setup_generation,
      'state', invocation_requested_event.state,
      'invocation_state', invocation_requested_event.invocation_state,
      'details', invocation_requested_event.details,
      'occurred_at', invocation_requested_event.occurred_at
    ) AS invocation_requested_event,
    (SELECT count(*)::integer
       FROM provider_account_setup_events candidate
      WHERE candidate.setup_attempt_id = attempt.id
        AND candidate.event_type = 'setup_state_observed'
        AND candidate.details->>'observed_state' = 'invocation_requested') AS invocation_requested_event_count,
    COALESCE(
      (SELECT jsonb_agg(
          jsonb_build_object(
            'worker_id', event.worker_id,
            'worker_generation', event.worker_generation,
            'environment_operation_id', event.operation_id,
            'credential_generation', event.credential_generation,
            'backend_kind', event.backend_kind,
            'environment_id', event.environment_id,
            'environment_incarnation', event.incarnation,
            'physical_state', event.physical_state,
            'lifecycle_state', event.lifecycle_state,
            'details', event.details,
            'occurred_at', event.occurred_at
          ) ORDER BY event.occurred_at, event.id)
         FROM provider_account_lifecycle_events event
        WHERE event.provider_account_id = attempt.provider_account_id
          AND event.event_type = 'worker_generation_reconciled'
          AND event.occurred_at > setup_authorization.authorized_at),
      '[]'::jsonb
    ) AS environment_generation_refence_chain,
    COALESCE(
      (SELECT jsonb_agg(
          jsonb_build_object(
            'provider_account_id', event.provider_account_id,
            'setup_generation', event.setup_generation,
            'state', event.state,
            'invocation_state', event.invocation_state,
            'details', event.details,
            'occurred_at', event.occurred_at
          ) ORDER BY event.occurred_at, event.id)
         FROM provider_account_setup_events event
        WHERE event.setup_attempt_id = attempt.id
          AND event.event_type = 'worker_generation_reconciled'
          AND event.occurred_at > setup_authorization.authorized_at),
      '[]'::jsonb
    ) AS setup_generation_refence_chain,
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
  LEFT JOIN LATERAL (
    SELECT event.*
      FROM provider_account_lifecycle_events event
     WHERE event.provider_account_id = attempt.provider_account_id
       AND event.worker_id = attempt.worker_id
       AND event.credential_generation = attempt.environment_generation
       AND event.backend_kind = attempt.backend_kind
       AND event.environment_id = attempt.environment_id
       AND event.incarnation = attempt.environment_incarnation
       AND event.physical_state = 'available'
       AND event.event_type IN ('environment_ensured', 'worker_generation_reconciled')
       AND event.occurred_at <= setup_authorization.authorized_at
     ORDER BY event.occurred_at DESC, event.id DESC
     LIMIT 1
  ) authority_generation ON true
  LEFT JOIN LATERAL (
    SELECT event.*
      FROM provider_account_setup_events event
     WHERE event.setup_attempt_id = attempt.id
       AND event.event_type = 'setup_state_observed'
       AND event.details->>'observed_state' = 'invocation_requested'
     ORDER BY event.occurred_at, event.id
     LIMIT 1
  ) invocation_requested_event ON true
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

  const workerId = text(row.worker_id, "Worker ID");
  const credentialGeneration = positiveInteger(
    row.credential_generation,
    "credential generation",
  );
  const environmentGeneration = positiveInteger(
    row.environment_generation,
    "environment generation",
  );
  const currentWorkerGeneration = positiveInteger(
    row.current_worker_generation,
    "current Product Worker generation",
  );
  const currentEnvironmentOperationId = text(
    row.current_environment_operation_id,
    "current Product environment operation",
  );
  const authorityEvent = exactObject(
    row.authority_generation_event,
    [
      "event_type",
      "worker_id",
      "worker_generation",
      "environment_operation_id",
      "credential_generation",
      "backend_kind",
      "environment_id",
      "environment_incarnation",
      "physical_state",
      "lifecycle_state",
      "details",
      "occurred_at",
    ],
    "invocation-authority lifecycle event",
  );
  exactCount(
    row.authority_generation_event_count,
    1,
    "invocation-authority lifecycle event count",
  );
  const authorityEventType = text(
    authorityEvent.event_type,
    "invocation-authority event type",
  );
  if (
    authorityEventType !== "environment_ensured" &&
    authorityEventType !== "worker_generation_reconciled"
  )
    throw mismatch("Product invocation-authority event type is invalid.");
  exact(authorityEvent.worker_id, workerId, "invocation-authority Worker");
  exact(
    positiveInteger(
      authorityEvent.credential_generation,
      "invocation-authority credential generation",
    ),
    environmentGeneration,
    "invocation-authority credential generation",
  );
  exact(authorityEvent.backend_kind, "sbx", "invocation-authority backend");
  exact(
    authorityEvent.environment_id,
    HISTORICAL_ENVIRONMENT_ID,
    "invocation-authority environment",
  );
  exact(
    authorityEvent.environment_incarnation,
    HISTORICAL_ENVIRONMENT_INCARNATION,
    "invocation-authority environment incarnation",
  );
  exact(
    authorityEvent.physical_state,
    "available",
    "invocation-authority physical state",
  );
  exact(
    authorityEvent.lifecycle_state,
    "connected",
    "invocation-authority lifecycle state",
  );
  const authorityDetails = exactObject(
    authorityEvent.details,
    authorityEventType === "environment_ensured"
      ? ["report", "canary_persisted"]
      : [],
    "invocation-authority event details",
  );
  if (authorityEventType === "environment_ensured") {
    exact(
      authorityDetails.report,
      "credential_free",
      "invocation-authority environment report",
    );
    exact(
      authorityDetails.canary_persisted,
      true,
      "invocation-authority canary",
    );
  }
  const invocationAuthorityWorkerGeneration = positiveInteger(
    authorityEvent.worker_generation,
    "invocation-authority Worker generation",
  );
  const invocationAuthorityEnvironmentOperationId = text(
    authorityEvent.environment_operation_id,
    "invocation-authority environment operation",
  );
  const authorityEventOccurredAt = timestamp(
    authorityEvent.occurred_at,
    "invocation-authority event timestamp",
  );

  const invocationEvent = exactObject(
    row.invocation_requested_event,
    [
      "provider_account_id",
      "setup_generation",
      "state",
      "invocation_state",
      "details",
      "occurred_at",
    ],
    "invocation-requested setup event",
  );
  exactCount(
    row.invocation_requested_event_count,
    1,
    "invocation-requested setup event count",
  );
  exact(
    invocationEvent.provider_account_id,
    providerAccountId,
    "invocation-requested event ProviderAccount",
  );
  exact(
    positiveInteger(
      invocationEvent.setup_generation,
      "invocation-requested event setup generation",
    ),
    setupGeneration,
    "invocation-requested event setup generation",
  );
  exact(
    invocationEvent.state,
    "invocation_requested",
    "invocation-requested event state",
  );
  exact(
    invocationEvent.invocation_state,
    "requested",
    "invocation-requested event invocation state",
  );
  const invocationEventDetails = exactObject(
    invocationEvent.details,
    ["observed_state"],
    "invocation-requested event details",
  );
  exact(
    invocationEventDetails.observed_state,
    "invocation_requested",
    "invocation-requested observed state",
  );
  const invocationRequestedEventOccurredAt = timestamp(
    invocationEvent.occurred_at,
    "invocation-requested event timestamp",
  );
  if (
    Date.parse(authorityEventOccurredAt) > Date.parse(authorizedAt) ||
    Date.parse(invocationRequestedAt) >
      Date.parse(invocationRequestedEventOccurredAt)
  )
    throw mismatch("Product invocation-authority chronology is invalid.");

  const environmentRefences = exactArray(
    row.environment_generation_refence_chain,
    "environment generation refence chain",
  );
  const setupRefences = exactArray(
    row.setup_generation_refence_chain,
    "setup generation refence chain",
  );
  if (environmentRefences.length !== setupRefences.length)
    throw mismatch(
      "Product environment and setup generation refence chains do not pair exactly.",
    );
  const refenceChain: Array<{
    workerGeneration: number;
    environmentOperationId: string;
    environmentEventOccurredAt: string;
    setupEventOccurredAt: string;
  }> = [];
  let expectedCurrentWorkerGeneration = invocationAuthorityWorkerGeneration;
  let expectedCurrentEnvironmentOperationId =
    invocationAuthorityEnvironmentOperationId;
  let previousEventAt = invocationRequestedEventOccurredAt;
  for (let index = 0; index < environmentRefences.length; index += 1) {
    const environmentRefence = exactObject(
      environmentRefences[index],
      [
        "worker_id",
        "worker_generation",
        "environment_operation_id",
        "credential_generation",
        "backend_kind",
        "environment_id",
        "environment_incarnation",
        "physical_state",
        "lifecycle_state",
        "details",
        "occurred_at",
      ],
      "environment generation refence",
    );
    const setupRefence = exactObject(
      setupRefences[index],
      [
        "provider_account_id",
        "setup_generation",
        "state",
        "invocation_state",
        "details",
        "occurred_at",
      ],
      "setup generation refence",
    );
    exact(environmentRefence.worker_id, workerId, "generation-refence Worker");
    exact(
      positiveInteger(
        environmentRefence.credential_generation,
        "generation-refence credential generation",
      ),
      environmentGeneration,
      "generation-refence credential generation",
    );
    exact(environmentRefence.backend_kind, "sbx", "generation-refence backend");
    exact(
      environmentRefence.environment_id,
      HISTORICAL_ENVIRONMENT_ID,
      "generation-refence environment",
    );
    exact(
      environmentRefence.environment_incarnation,
      HISTORICAL_ENVIRONMENT_INCARNATION,
      "generation-refence environment incarnation",
    );
    exact(
      environmentRefence.physical_state,
      "available",
      "generation-refence physical state",
    );
    exact(
      environmentRefence.lifecycle_state,
      "connected",
      "generation-refence lifecycle state",
    );
    exactObject(
      environmentRefence.details,
      [],
      "environment generation-refence details",
    );
    exact(
      setupRefence.provider_account_id,
      providerAccountId,
      "setup generation-refence ProviderAccount",
    );
    exact(
      positiveInteger(
        setupRefence.setup_generation,
        "setup generation-refence setup generation",
      ),
      setupGeneration,
      "setup generation-refence setup generation",
    );
    exact(
      setupRefence.state,
      "invocation_requested",
      "setup generation-refence state",
    );
    exact(
      setupRefence.invocation_state,
      "requested",
      "setup generation-refence invocation state",
    );
    exactObject(setupRefence.details, [], "setup generation-refence details");
    const workerGeneration = positiveInteger(
      environmentRefence.worker_generation,
      "generation-refence Worker generation",
    );
    const environmentOperationId = text(
      environmentRefence.environment_operation_id,
      "generation-refence environment operation",
    );
    const environmentEventOccurredAt = timestamp(
      environmentRefence.occurred_at,
      "environment generation-refence timestamp",
    );
    const setupEventOccurredAt = timestamp(
      setupRefence.occurred_at,
      "setup generation-refence timestamp",
    );
    if (
      workerGeneration !== expectedCurrentWorkerGeneration + 1 ||
      environmentOperationId === expectedCurrentEnvironmentOperationId ||
      Date.parse(environmentEventOccurredAt) <= Date.parse(previousEventAt) ||
      Date.parse(setupEventOccurredAt) <
        Date.parse(environmentEventOccurredAt) ||
      Date.parse(setupEventOccurredAt) >=
        Date.parse(cancellationEventOccurredAt)
    )
      throw mismatch("Product generation refence chronology is invalid.");
    const nextEnvironmentRefence = environmentRefences[index + 1];
    if (nextEnvironmentRefence) {
      const next = exactObject(
        nextEnvironmentRefence,
        [
          "worker_id",
          "worker_generation",
          "environment_operation_id",
          "credential_generation",
          "backend_kind",
          "environment_id",
          "environment_incarnation",
          "physical_state",
          "lifecycle_state",
          "details",
          "occurred_at",
        ],
        "next environment generation refence",
      );
      if (
        Date.parse(setupEventOccurredAt) >=
        Date.parse(
          timestamp(
            next.occurred_at,
            "next environment generation-refence timestamp",
          ),
        )
      )
        throw mismatch("Product generation refence pairing is ambiguous.");
    }
    refenceChain.push({
      workerGeneration,
      environmentOperationId,
      environmentEventOccurredAt,
      setupEventOccurredAt,
    });
    expectedCurrentWorkerGeneration = workerGeneration;
    expectedCurrentEnvironmentOperationId = environmentOperationId;
    previousEventAt = setupEventOccurredAt;
  }
  exact(
    currentWorkerGeneration,
    expectedCurrentWorkerGeneration,
    "current Product Worker-generation projection",
  );
  exact(
    currentEnvironmentOperationId,
    expectedCurrentEnvironmentOperationId,
    "current Product environment-operation projection",
  );
  const invocationAuthority = Object.freeze({
    source: "product_append_only_environment_and_setup_events" as const,
    contractVersion: "product-invocation-authority-v1" as const,
    workerGeneration: invocationAuthorityWorkerGeneration,
    environmentOperationId: invocationAuthorityEnvironmentOperationId,
    authorityEventType,
    authorityEventOccurredAt,
    invocationRequestedEventOccurredAt,
    currentWorkerGeneration,
    currentEnvironmentOperationId,
    refenceChain: Object.freeze(
      refenceChain.map((refence) => Object.freeze(refence)),
    ),
  });

  const safe = {
    source: "product_repeatable_read_read_only_transaction" as const,
    databaseIdentity: Object.freeze({ ...databaseIdentity }),
    invocationAuthority,
    setupAttemptId: HISTORICAL_SETUP_ATTEMPT_ID,
    cancellationRequestId: HISTORICAL_CANCELLATION_REQUEST_ID,
    authorizationId: text(row.authorization_id, "authorization ID"),
    authorizationKind: "provider_account_setup" as const,
    authorizedAt,
    providerAccountId,
    setupGeneration,
    credentialGeneration,
    environmentGeneration,
    workerId,
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
  return exactObject(value, keys, `${name} row`);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  name: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw mismatch(`Product ${name} is malformed.`);
  const row = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...keys].sort())
  )
    throw mismatch(`Product ${name} contains unknown or missing fields.`);
  return row;
}

function exactArray(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw mismatch(`Product ${name} is malformed.`);
  return value;
}

function timestamp(value: unknown, name: string): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf()))
    return value.toISOString();
  const result = text(value, name);
  const utcResult = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(
    result,
  )
    ? `${result.replace(" ", "T")}Z`
    : result;
  if (Number.isNaN(Date.parse(utcResult)))
    throw mismatch(`${name} is invalid.`);
  return new Date(utcResult).toISOString();
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
