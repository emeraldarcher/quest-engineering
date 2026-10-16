import { SQL } from "bun";
import { safeDigest } from "./evidence.ts";
import {
  ContainmentError,
  HISTORICAL_BACKEND_PROCESS_ID,
  HISTORICAL_CANCELLATION_REQUEST_ID,
  HISTORICAL_ENVIRONMENT_ID,
  HISTORICAL_ENVIRONMENT_INCARNATION,
  HISTORICAL_EXECUTABLE,
  HISTORICAL_PROCESS_GENERATION,
  HISTORICAL_PROCESS_START_IDENTITY,
  HISTORICAL_SETUP_ATTEMPT_ID,
  type ProductCancellationEvidence,
  type ProductEvidenceReader,
} from "./types.ts";

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
  "process_backend_id",
  "process_start_identity",
  "process_generation",
  "process_executable",
  "invocation_requested_at",
  "invocation_acknowledged_at",
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
  "human_attention_count",
  "transaction_read_only",
] as const;

/** PostgreSQL access is confined to one server-enforced read-only transaction. */
export class ReadOnlyProductEvidenceReader implements ProductEvidenceReader {
  private readonly sql: SQL;

  constructor(databaseUrl: string) {
    if (!/^postgres(?:ql)?:\/\//.test(databaseUrl))
      throw new ContainmentError(
        "invalid_arguments",
        "Product database URL must use PostgreSQL.",
      );
    this.sql = new SQL(databaseUrl, { max: 1 });
  }

  async read(setupAttemptId: string): Promise<ProductCancellationEvidence> {
    if (setupAttemptId !== HISTORICAL_SETUP_ATTEMPT_ID)
      throw new ContainmentError(
        "cancellation_authority_invalid",
        "Product lookup is restricted to the reviewed historical attempt.",
      );
    try {
      const rows = await this.sql.begin(
        "isolation level repeatable read read only",
        async (transaction) =>
          transaction`
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
              attempt.process_backend_id,
              attempt.process_start_identity,
              attempt.process_generation,
              attempt.process_executable,
              attempt.invocation_requested_at,
              attempt.invocation_acknowledged_at,
              attempt.cancellation_request_id,
              attempt.failure_code,
              authorization.id AS authorization_id,
              authorization.kind AS authorization_kind,
              authorization.setup_generation AS authorization_setup_generation,
              authorization.authorized_at AS authorization_authorized_at,
              authorization.auth_configuration_identity AS authorization_auth_configuration_identity,
              authorization.auth_environment_policy AS authorization_auth_environment_policy,
              authorization.auth_inspection_identity AS authorization_auth_inspection_identity,
              authorization.auth_inspected_at AS authorization_auth_inspected_at,
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
              (SELECT count(*)::integer
                 FROM provider_account_human_attention_requests attention
                WHERE attention.setup_attempt_id = attempt.id) AS human_attention_count,
              current_setting('transaction_read_only') AS transaction_read_only
            FROM provider_account_setup_attempts attempt
            JOIN provider_account_setup_authorizations authorization
              ON authorization.setup_attempt_id = attempt.id
            WHERE attempt.id = ${setupAttemptId}
          `,
      );
      if (rows.length !== 1)
        throw new ContainmentError(
          "cancellation_authority_invalid",
          "Product must contain exactly one matching attempt and authorization.",
        );
      return parseProductEvidenceRow(rows[0]);
    } catch (error) {
      if (error instanceof ContainmentError) throw error;
      throw new ContainmentError(
        "historical_evidence_missing",
        "Product cancellation evidence could not be read in a read-only transaction.",
      );
    }
  }

  async close(): Promise<void> {
    await this.sql.close({ timeout: 1 });
  }
}

export function parseProductEvidenceRow(
  value: unknown,
): ProductCancellationEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw incompatible("Product evidence row is malformed.");
  const row = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(row).sort()) !==
    JSON.stringify([...PRODUCT_ROW_KEYS].sort())
  )
    throw incompatible("Product evidence contains unknown or missing fields.");
  exact(row.setup_attempt_id, HISTORICAL_SETUP_ATTEMPT_ID, "setup attempt");
  exact(
    row.cancellation_request_id,
    HISTORICAL_CANCELLATION_REQUEST_ID,
    "cancellation request",
  );
  exact(row.backend_kind, "sbx", "backend");
  exact(row.environment_id, HISTORICAL_ENVIRONMENT_ID, "environment");
  exact(
    row.environment_incarnation,
    HISTORICAL_ENVIRONMENT_INCARNATION,
    "environment incarnation",
  );
  exact(row.process_backend_id, HISTORICAL_BACKEND_PROCESS_ID, "backend PID");
  exact(
    row.process_start_identity,
    HISTORICAL_PROCESS_START_IDENTITY,
    "process start identity",
  );
  exact(
    row.process_generation,
    HISTORICAL_PROCESS_GENERATION,
    "process generation",
  );
  exact(row.process_executable, HISTORICAL_EXECUTABLE, "process executable");
  exact(row.state, "cancellation_requested", "Product setup state");
  exact(row.invocation_state, "acknowledged", "Product invocation state");
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
  exact(row.transaction_read_only, "on", "Product transaction mode");
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
  const invocationAcknowledgedAt = timestamp(
    row.invocation_acknowledged_at,
    "invocation acknowledgement",
  );
  if (
    Date.parse(authorizedAt) > Date.parse(invocationRequestedAt) ||
    Date.parse(invocationRequestedAt) > Date.parse(invocationAcknowledgedAt)
  )
    throw incompatible("Product authorization chronology is invalid.");
  const safe = {
    setupAttemptId: HISTORICAL_SETUP_ATTEMPT_ID,
    cancellationRequestId: HISTORICAL_CANCELLATION_REQUEST_ID,
    authorizationId: text(row.authorization_id, "authorization ID"),
    authorizationKind: "provider_account_setup" as const,
    authorizedAt,
    providerAccountId: text(row.provider_account_id, "ProviderAccount ID"),
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
    backendProcessId: HISTORICAL_BACKEND_PROCESS_ID,
    processStartIdentity: HISTORICAL_PROCESS_START_IDENTITY,
    processGeneration: HISTORICAL_PROCESS_GENERATION,
    executable: HISTORICAL_EXECUTABLE,
    authConfigurationIdentity,
    authEnvironmentPolicy,
    authEvidenceIdentity,
    authInspectedAt,
    state: "cancellation_requested" as const,
    invocationState: "acknowledged" as const,
    invocationRequestedAt,
    invocationAcknowledgedAt,
    authorizationCount: exactCount(
      row.authorization_count,
      1,
      "authorization count",
    ) as 1,
    setupAuthorizedEventCount: exactCount(
      row.setup_authorized_event_count,
      1,
      "setup authorization event count",
    ) as 1,
    cancellationRequestedEventCount: exactCount(
      row.cancellation_requested_event_count,
      1,
      "cancellation event count",
    ) as 1,
    humanAttentionCount: exactCount(
      row.human_attention_count,
      0,
      "HumanAttention count",
    ) as 0,
    transactionReadOnly: true as const,
  };
  return { ...safe, digest: safeDigest(safe) };
}

function timestamp(value: unknown, name: string): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf()))
    return value.toISOString();
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result)))
    throw incompatible(`${name} is invalid.`);
  return new Date(result).toISOString();
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    throw incompatible(`${name} is missing.`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const result = integer(value);
  if (result < 1) throw incompatible(`${name} is invalid.`);
  return result;
}

function exactCount(value: unknown, expected: number, name: string): number {
  const result = integer(value);
  if (result !== expected)
    throw incompatible(`${name} is not exactly ${expected}.`);
  return result;
}

function integer(value: unknown): number {
  const result =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : value;
  if (!Number.isSafeInteger(result))
    throw incompatible("Product numeric evidence is invalid.");
  return result as number;
}

function exact(actual: unknown, expected: unknown, name: string): void {
  if (actual !== expected)
    throw incompatible(
      `${name} does not match the reviewed historical identity.`,
    );
}

function incompatible(message: string): ContainmentError {
  return new ContainmentError("cancellation_authority_invalid", message);
}
