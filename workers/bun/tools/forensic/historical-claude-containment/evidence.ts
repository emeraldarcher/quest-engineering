import { constants, Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ContainmentError,
  type EnvironmentForensicEvidence,
  HISTORICAL_BACKEND_PROCESS_ID,
  HISTORICAL_ENVIRONMENT_ID,
  HISTORICAL_ENVIRONMENT_INCARNATION,
  HISTORICAL_EXECUTABLE,
  HISTORICAL_PROCESS_GENERATION,
  HISTORICAL_PROCESS_START_IDENTITY,
  HISTORICAL_SETUP_ATTEMPT_ID,
  type HistoricalTargetIdentity,
  type ProductSemanticAuthorityEvidence,
  type ValidatedContainmentEvidence,
  type WorkerV2Evidence,
} from "./types.ts";

export const EVIDENCE_RESPONSIBILITY_TABLE = [
  {
    fact: "setup authorization (authorization_id/authorized_at)",
    product: "authority",
    workerV2: "corroborate",
    physical: "not_applicable",
  },
  {
    fact: "cancellation authority (cancellation_request_id/state/event)",
    product: "authority",
    workerV2: "not_source",
    physical: "not_applicable",
  },
  {
    fact: "setup attempt identity (setup_attempt_id)",
    product: "authority",
    workerV2: "authority",
    physical: "not_applicable",
  },
  {
    fact: "account identity (provider_account_id)",
    product: "authority",
    workerV2: "authority",
    physical: "corroborate_environment_owner",
  },
  {
    fact: "invocation intent (invocation_state/requested_at)",
    product: "recorded_pending_state",
    workerV2: "authority",
    physical: "not_applicable",
  },
  {
    fact: "invocation acknowledgement (state/invocation_state/process_json)",
    product: "not_source",
    workerV2: "authority",
    physical: "not_applicable",
  },
  {
    fact: "process PID/start identity/executable",
    product: "not_source",
    workerV2: "authority_historical",
    physical: "authority_current_observation",
  },
  {
    fact: "process generation",
    product: "not_source",
    workerV2: "authority_historical",
    physical: "bound_by_current_pidfd_start_executable_tuple",
  },
  {
    fact: "current liveness",
    product: "not_source",
    workerV2: "historical_only",
    physical: "authority",
  },
  {
    fact: "physical cancellation submission",
    product: "request_only",
    workerV2: "authority_not_submitted",
    physical: "authority_if_later_submitted",
  },
  {
    fact: "current exact-process match",
    product: "not_source",
    workerV2: "expected_identity",
    physical: "authority",
  },
] as const;

export const SHARED_IDENTITY_FIELDS = [
  "setup_attempt_id",
  "authorization_id",
  "authorized_at",
  "provider_account_id",
  "setup_generation",
  "credential_generation",
  "environment_generation",
  "invocation_worker_generation",
  "invocation_environment_operation_id",
  "worker_id",
  "backend_kind",
  "environment_id",
  "environment_incarnation",
  "auth_configuration_identity",
  "auth_environment_policy",
  "auth_evidence_identity",
  "auth_inspected_at",
] as const;

const V2_ATTEMPT_COLUMNS = [
  "attention_id",
  "cancellation_request_id",
  "command_json",
  "created_at",
  "failure_code",
  "input_delivery_json",
  "invocation_state",
  "preflight_json",
  "process_json",
  "setup_attempt_id",
  "state",
  "updated_at",
  "validation_json",
] as const;
const V2_EVENT_COLUMNS = [
  "details_json",
  "event_id",
  "event_type",
  "occurred_at",
  "setup_attempt_id",
] as const;
const ENVIRONMENT_COLUMNS = [
  "capabilities_json",
  "created_at",
  "creation_token",
  "creator_pid",
  "diagnostics_json",
  "display_name",
  "environment_id",
  "incarnation",
  "last_verified_at",
  "marker_digest",
  "native_agent",
  "native_api_version",
  "native_revision",
  "native_version",
  "owner_generation",
  "owner_id",
  "owner_type",
  "profile_digest",
  "profile_id",
  "record_id",
  "retired_at",
  "spec_digest",
  "state",
  "updated_at",
  "worker_id",
  "backend_kind",
].sort();

interface WorkerRow {
  setup_attempt_id: string;
  command_json: string;
  state: string;
  invocation_state: string;
  process_json: string | null;
  cancellation_request_id: string | null;
  created_at: string;
  updated_at: string;
}

interface WorkerEventRow {
  event_type: string;
  details_json: string;
  occurred_at: string;
}

interface EnvironmentRow {
  record_id: string;
  backend_kind: string;
  worker_id: string;
  owner_type: string;
  owner_id: string;
  owner_generation: number | null;
  display_name: string;
  environment_id: string | null;
  incarnation: string;
  profile_id: string;
  profile_digest: string;
  state: string;
  marker_digest: string | null;
  native_agent: string | null;
  retired_at: string | null;
}

export async function readHistoricalWorkerV2Evidence(
  databasePath: string,
  snapshotRoot?: string,
): Promise<WorkerV2Evidence> {
  try {
    return await withForensicDatabase(
      databasePath,
      snapshotRoot,
      (database) => {
        const version = database.query("PRAGMA user_version").get() as {
          user_version: number;
        };
        if (version.user_version !== 2)
          fail(
            "historical_evidence_incompatible",
            "Historical Worker ledger is not exact schema version 2.",
          );
        assertExactColumns(
          database,
          "provider_account_setup_attempts",
          V2_ATTEMPT_COLUMNS,
          "historical Worker attempt table",
        );
        assertExactColumns(
          database,
          "provider_account_setup_events",
          V2_EVENT_COLUMNS,
          "historical Worker event table",
        );
        const rows = database
          .query(
            `SELECT setup_attempt_id,command_json,state,invocation_state,process_json,cancellation_request_id,
                created_at,updated_at
         FROM provider_account_setup_attempts WHERE setup_attempt_id=?`,
          )
          .all(HISTORICAL_SETUP_ATTEMPT_ID) as WorkerRow[];
        if (rows.length !== 1)
          fail(
            "historical_evidence_missing",
            "Historical Worker ledger must contain exactly one target attempt.",
          );
        const events = database
          .query(
            `SELECT event_type,details_json,occurred_at
             FROM provider_account_setup_events
             WHERE setup_attempt_id=? ORDER BY event_id`,
          )
          .all(HISTORICAL_SETUP_ATTEMPT_ID) as WorkerEventRow[];
        return parseWorkerRow(rows[0] as WorkerRow, events);
      },
    );
  } catch (error) {
    if (error instanceof ContainmentError) {
      if (
        error.code === "worker_evidence_missing" ||
        error.code === "worker_evidence_mismatch" ||
        error.code === "invalid_arguments"
      )
        throw error;
      if (error.code === "historical_evidence_missing")
        throw new ContainmentError(
          "worker_evidence_missing",
          "Historical Worker v2 evidence is missing.",
        );
      if (error.code === "historical_evidence_incompatible")
        throw new ContainmentError(
          "worker_evidence_mismatch",
          "Historical Worker v2 physical evidence does not match the exact forensic contract.",
        );
    }
    throw new ContainmentError(
      "worker_evidence_mismatch",
      "Historical Worker v2 physical evidence could not be read exactly.",
    );
  }
}

export async function readEnvironmentForensicEvidence(
  databasePath: string,
  worker: WorkerV2Evidence,
  snapshotRoot?: string,
): Promise<EnvironmentForensicEvidence> {
  return withForensicDatabase(databasePath, snapshotRoot, (database) => {
    const versions = database
      .query(
        "SELECT version FROM execution_environment_schema_migrations ORDER BY version",
      )
      .all() as Array<{ version: number }>;
    if (versions.length !== 1 || versions[0]?.version !== 3)
      fail(
        "environment_evidence_incompatible",
        "Environment ledger must be exact current schema version 3.",
      );
    assertExactColumns(
      database,
      "execution_environments",
      ENVIRONMENT_COLUMNS,
      "environment ledger",
    );
    const rows = database
      .query(
        `SELECT record_id,backend_kind,worker_id,owner_type,owner_id,owner_generation,
                display_name,environment_id,incarnation,profile_id,profile_digest,state,
                marker_digest,native_agent,retired_at
         FROM execution_environments
         WHERE environment_id=? AND incarnation=?`,
      )
      .all(
        HISTORICAL_ENVIRONMENT_ID,
        HISTORICAL_ENVIRONMENT_INCARNATION,
      ) as EnvironmentRow[];
    if (rows.length !== 1)
      fail(
        "environment_evidence_incompatible",
        "Environment ledger must contain exactly one historical environment identity.",
      );
    return parseEnvironmentRow(rows[0] as EnvironmentRow, worker);
  });
}

export function validateContainmentEvidence(
  worker: WorkerV2Evidence,
  product: ProductSemanticAuthorityEvidence,
  environment: EnvironmentForensicEvidence,
): ValidatedContainmentEvidence {
  const target = worker.historicalPhysicalIdentity;
  if (
    worker.source !== "worker_v2_immutable_snapshot" ||
    worker.invocationIntent !== "login_invocation_requested" ||
    worker.workerState !== "invocation_acknowledged" ||
    worker.invocationState !== "acknowledged" ||
    worker.cancellationSubmission !== "not_submitted"
  )
    fail(
      "worker_evidence_mismatch",
      "Worker v2 does not prove the exact acknowledged physical invocation without prior cancellation submission.",
    );
  const productComparisons: Array<[unknown, unknown, string]> = [
    [product.setupAttemptId, target.setupAttemptId, "setup attempt"],
    [product.authorizationId, target.authorizationId, "authorization"],
    [product.authorizedAt, target.authorizedAt, "authorization timestamp"],
    [product.providerAccountId, target.providerAccountId, "ProviderAccount"],
    [product.setupGeneration, target.setupGeneration, "setup generation"],
    [
      product.credentialGeneration,
      target.credentialGeneration,
      "credential generation",
    ],
    [
      product.environmentGeneration,
      target.environmentGeneration,
      "environment generation",
    ],
    [
      product.invocationWorkerGeneration,
      target.invocationWorkerGeneration,
      "invocation Worker generation",
    ],
    [
      product.invocationEnvironmentOperationId,
      target.invocationEnvironmentOperationId,
      "environment operation",
    ],
    [product.workerId, target.workerId, "Worker"],
    [product.backendKind, target.backendKind, "backend"],
    [product.environmentId, target.environmentId, "environment"],
    [
      product.environmentIncarnation,
      target.environmentIncarnation,
      "environment incarnation",
    ],
    [
      product.authConfigurationIdentity,
      target.authConfigurationIdentity,
      "authentication configuration",
    ],
    [
      product.authEnvironmentPolicy,
      target.authEnvironmentPolicy,
      "authentication environment policy",
    ],
    [
      product.authEvidenceIdentity,
      target.authEvidenceIdentity,
      "authentication evidence identity",
    ],
    [
      product.authInspectedAt,
      target.authInspectedAt,
      "authentication inspection timestamp",
    ],
  ];
  for (const [actual, expected, name] of productComparisons)
    if (actual !== expected)
      fail(
        "corroboration_mismatch",
        `Historical Product and Worker v2 ${name} identities do not corroborate exactly.`,
      );

  const environmentComparisons: Array<[unknown, unknown, string]> = [
    [environment.backendKind, target.backendKind, "environment-ledger backend"],
    [environment.workerId, target.workerId, "environment-ledger Worker"],
    [
      environment.providerAccountId,
      target.providerAccountId,
      "environment-ledger owner",
    ],
    [
      environment.credentialGeneration,
      target.credentialGeneration,
      "environment-ledger credential generation",
    ],
    [
      environment.environmentId,
      target.environmentId,
      "environment-ledger environment",
    ],
    [
      environment.incarnation,
      target.environmentIncarnation,
      "environment-ledger incarnation",
    ],
    [environment.profileId, target.profileId, "environment-ledger profile"],
    [
      environment.profileDigest,
      target.profileDigest,
      "environment-ledger profile digest",
    ],
  ];
  for (const [actual, expected, name] of environmentComparisons)
    if (actual !== expected)
      fail(
        "environment_evidence_incompatible",
        `Historical ${name} evidence does not corroborate exactly.`,
      );
  if (
    product.source !== "product_repeatable_read_read_only_transaction" ||
    product.state !== "cancellation_requested" ||
    product.invocationState !== "requested" ||
    product.authorizationKind !== "provider_account_setup" ||
    product.authorizationCount !== 1 ||
    product.setupAuthorizedEventCount !== 1 ||
    product.cancellationRequestedEventCount !== 1 ||
    product.laterSemanticEventCount !== 0 ||
    product.humanAttentionCount !== 0 ||
    product.transactionReadOnly !== true
  )
    fail(
      "product_evidence_mismatch",
      "Product evidence does not prove the exact semantic cancellation authority.",
    );
  const completeTarget: HistoricalTargetIdentity = Object.freeze({
    ...target,
    cancellationRequestId: product.cancellationRequestId,
    environmentDisplayName: environment.displayName,
    environmentMarkerDigest: environment.markerDigest,
    environmentNativeAgent: environment.nativeAgent,
  });
  const sharedIdentityMatches = Object.freeze({
    contractVersion: "historical-containment-shared-identity-v1" as const,
    matchedFields: Object.freeze([...SHARED_IDENTITY_FIELDS]),
  });
  const corroboratedEvidenceDigest = safeDigest({
    contractVersion: "historical-containment-corroborated-evidence-v2",
    semanticAuthority: {
      source: "product_repeatable_read_read_only_transaction",
      digest: product.digest,
    },
    historicalPhysicalIdentity: {
      source: "worker_v2_immutable_snapshot",
      digest: worker.digest,
    },
    environmentEvidence: {
      source: "worker_environment_immutable_snapshot",
      digest: environment.digest,
    },
    sharedIdentityMatches,
  });
  return Object.freeze({
    target: completeTarget,
    semanticAuthority: product,
    historicalPhysicalEvidence: worker,
    historicalPhysicalIdentity: target,
    sharedIdentityMatches,
    environmentEvidence: environment,
    workerEvidenceDigest: worker.digest,
    productEvidenceDigest: product.digest,
    environmentEvidenceDigest: environment.digest,
    corroboratedEvidenceDigest,
  });
}

export function safeDigest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function withForensicDatabase<T>(
  databasePath: string,
  snapshotRoot: string | undefined,
  operation: (database: Database) => T,
): Promise<T> {
  if (!isAbsolute(databasePath))
    fail("invalid_arguments", "Forensic database paths must be absolute.");
  const status = await lstat(databasePath).catch(() => null);
  if (!status?.isFile() || status.isSymbolicLink())
    fail(
      "historical_evidence_missing",
      "Forensic database path must name one existing regular non-symlink file.",
    );
  const canonicalPath = await realpath(databasePath);
  const walPath = `${canonicalPath}-wal`;
  const wal = await lstat(walPath).catch(() => null);
  if (!wal || wal.size === 0) {
    const originals = [canonicalPath, walPath, `${canonicalPath}-shm`];
    const before = await Promise.all(originals.map(fileSignature));
    let result: T;
    try {
      result = withImmutableDatabase(canonicalPath, operation);
    } finally {
      const after = await Promise.all(originals.map(fileSignature));
      assertUnchangedSignatures(before, after);
    }
    return result;
  }
  if (!wal.isFile() || wal.isSymbolicLink())
    fail(
      "historical_evidence_incompatible",
      "Forensic SQLite WAL must be one regular non-symlink file.",
    );
  if (!snapshotRoot || !isAbsolute(snapshotRoot))
    fail(
      "invalid_arguments",
      "A separate absolute snapshot root is required for WAL-backed forensic evidence.",
    );
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  const snapshotRootStatus = await lstat(snapshotRoot);
  if (!snapshotRootStatus.isDirectory() || snapshotRootStatus.isSymbolicLink())
    fail(
      "invalid_arguments",
      "Forensic snapshot root must be a regular non-symlink directory.",
    );
  const directory = await mkdtemp(join(snapshotRoot, "sqlite-snapshot-"));
  try {
    const originals = [canonicalPath, walPath, `${canonicalPath}-shm`];
    const before = await Promise.all(originals.map(fileSignature));
    const snapshotPath = join(directory, basename(canonicalPath));
    await writeFile(snapshotPath, await readFile(canonicalPath), {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(`${snapshotPath}-wal`, await readFile(walPath), {
      flag: "wx",
      mode: 0o600,
    });
    const afterCopy = await Promise.all(originals.map(fileSignature));
    assertUnchangedSignatures(
      before,
      afterCopy,
      "Forensic SQLite evidence changed while its read-only snapshot was captured.",
    );
    const database = new Database(snapshotPath, {
      readwrite: true,
      strict: true,
    });
    try {
      database.exec("PRAGMA query_only=ON;");
      const result = operation(database);
      const afterRead = await Promise.all(originals.map(fileSignature));
      assertUnchangedSignatures(before, afterRead);
      return result;
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function assertUnchangedSignatures(
  before: Awaited<ReturnType<typeof fileSignature>>[],
  after: Awaited<ReturnType<typeof fileSignature>>[],
  message = "Forensic SQLite evidence changed during read-only validation.",
): void {
  if (JSON.stringify(before) !== JSON.stringify(after))
    fail("historical_evidence_incompatible", message);
}

function withImmutableDatabase<T>(
  canonicalPath: string,
  operation: (database: Database) => T,
): T {
  const uri = `${pathToFileURL(canonicalPath).href}?mode=ro&immutable=1`;
  const database = new Database(
    uri,
    constants.SQLITE_OPEN_READONLY |
      constants.SQLITE_OPEN_URI |
      constants.SQLITE_OPEN_NOFOLLOW,
  );
  try {
    return operation(database);
  } finally {
    database.close();
  }
}

async function fileSignature(
  path: string,
): Promise<{ path: string; size: number; digest: string } | null> {
  const status = await lstat(path).catch(() => null);
  if (!status) return null;
  if (!status.isFile() || status.isSymbolicLink())
    fail(
      "historical_evidence_incompatible",
      "Forensic SQLite input contains a non-regular sidecar.",
    );
  const bytes = await readFile(path);
  return {
    path,
    size: bytes.byteLength,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
}

function parseWorkerRow(
  row: WorkerRow,
  events: WorkerEventRow[],
): WorkerV2Evidence {
  if (
    row.setup_attempt_id !== HISTORICAL_SETUP_ATTEMPT_ID ||
    row.state !== "invocation_acknowledged" ||
    row.invocation_state !== "acknowledged" ||
    row.cancellation_request_id !== null ||
    !row.process_json
  )
    fail(
      "historical_evidence_incompatible",
      "Historical Worker row does not retain the exact acknowledged pre-cancellation state.",
    );
  const attemptRecordedAt = timestampText(
    row.created_at,
    "Worker attempt record timestamp",
  );
  timestampText(row.updated_at, "Worker attempt update timestamp");
  for (const event of events) {
    timestampText(event.occurred_at, "Worker event timestamp");
    const details = parseJson(event.details_json);
    if (
      !details ||
      typeof details !== "object" ||
      Array.isArray(details) ||
      Object.keys(details as Record<string, unknown>).length !== 0
    )
      fail(
        "historical_evidence_incompatible",
        "Historical Worker event details are not the exact empty schema-2 contract.",
      );
  }
  const invocationRequestedEvents = events.filter(
    (event) => event.event_type === "login_invocation_requested",
  );
  const invocationAcknowledgedEvents = events.filter(
    (event) => event.event_type === "login_invocation_acknowledged",
  );
  if (
    invocationRequestedEvents.length !== 1 ||
    invocationAcknowledgedEvents.length !== 1 ||
    events.some((event) => event.event_type.includes("cancellation"))
  )
    fail(
      "historical_evidence_incompatible",
      "Worker events do not prove one login intent, one physical acknowledgement, and zero cancellation activity.",
    );
  const intentRecordedAt = timestampText(
    invocationRequestedEvents[0]?.occurred_at,
    "Worker invocation intent event timestamp",
  );
  const acknowledgedRecordedAt = timestampText(
    invocationAcknowledgedEvents[0]?.occurred_at,
    "Worker invocation acknowledgement event timestamp",
  );
  if (
    Date.parse(attemptRecordedAt) > Date.parse(intentRecordedAt) ||
    Date.parse(intentRecordedAt) > Date.parse(acknowledgedRecordedAt)
  )
    fail(
      "historical_evidence_incompatible",
      "Worker acknowledgement chronology precedes its invocation intent.",
    );
  const command = exactObject(parseJson(row.command_json), [
    "type",
    "protocol_version",
    "worker_id",
    "connection_generation",
    "setup",
  ]);
  exactValue(command.type, "prepare_provider_account_setup", "command type");
  exactValue(command.protocol_version, 18, "Worker protocol");
  const workerId = text(command.worker_id, "worker_id");
  const connectionGeneration = positiveInteger(
    command.connection_generation,
    "connection generation",
  );
  const setup = exactObject(command.setup, [
    "setup_attempt_id",
    "provider_account_id",
    "setup_generation",
    "authorization_id",
    "authorization_kind",
    "authorized_at",
    "credential_generation",
    "environment_generation",
    "worker_generation",
    "environment_operation_id",
    "provider_key",
    "environment",
    "authorized_authentication",
    "interaction_public_key",
    "state",
    "invocation_state",
    "cancellation_request_id",
  ]);
  exactValue(
    setup.setup_attempt_id,
    HISTORICAL_SETUP_ATTEMPT_ID,
    "setup attempt",
  );
  exactValue(
    setup.authorization_kind,
    "provider_account_setup",
    "authorization kind",
  );
  exactValue(setup.provider_key, "anthropic", "provider");
  exactValue(
    setup.worker_generation,
    connectionGeneration,
    "accepted setup command Worker generation",
  );
  exactValue(setup.state, "authorized", "accepted setup command state");
  exactValue(
    setup.invocation_state,
    "not_requested",
    "accepted setup command invocation state",
  );
  exactValue(
    setup.cancellation_request_id,
    null,
    "accepted setup command cancellation request",
  );
  text(setup.interaction_public_key, "interaction public key");
  const authorizedAt = timestampText(
    setup.authorized_at,
    "authorization timestamp",
  );
  const commandEnvironment = exactObject(setup.environment, [
    "backend_kind",
    "environment_id",
    "incarnation",
  ]);
  exactValue(commandEnvironment.backend_kind, "sbx", "setup backend");
  exactValue(
    commandEnvironment.environment_id,
    HISTORICAL_ENVIRONMENT_ID,
    "setup environment",
  );
  exactValue(
    commandEnvironment.incarnation,
    HISTORICAL_ENVIRONMENT_INCARNATION,
    "setup environment incarnation",
  );
  const authentication = exactObject(setup.authorized_authentication, [
    "state",
    "method",
    "configuration_identity",
    "environment_policy",
    "evidence_identity",
    "inspected_at",
  ]);
  exactValue(
    authentication.state,
    "authentication_required",
    "authorized authentication state",
  );
  exactValue(authentication.method, "none", "authorized authentication method");
  const authEvidenceIdentity = text(
    authentication.evidence_identity,
    "authentication evidence identity",
  );
  const authInspectedAt = timestampText(
    authentication.inspected_at,
    "authentication inspection timestamp",
  );

  const process = exactObject(parseJson(row.process_json), [
    "contractVersion",
    "backendKind",
    "environment",
    "backendProcessId",
    "processStartIdentity",
    "processGeneration",
    "executable",
    "observedExecutable",
  ]);
  exactValue(process.contractVersion, 1, "process contract");
  exactValue(process.backendKind, "sbx", "process backend");
  exactValue(
    process.backendProcessId,
    HISTORICAL_BACKEND_PROCESS_ID,
    "backend PID",
  );
  exactValue(
    process.processStartIdentity,
    HISTORICAL_PROCESS_START_IDENTITY,
    "process start identity",
  );
  exactValue(
    process.processGeneration,
    HISTORICAL_PROCESS_GENERATION,
    "process generation",
  );
  exactValue(process.executable, HISTORICAL_EXECUTABLE, "requested executable");
  exactValue(
    process.observedExecutable,
    HISTORICAL_EXECUTABLE,
    "observed executable",
  );
  const processEnvironment = exactObject(process.environment, [
    "backendKind",
    "environmentId",
    "incarnation",
    "workerId",
    "owner",
    "profile",
  ]);
  exactValue(
    processEnvironment.backendKind,
    "sbx",
    "process environment backend",
  );
  exactValue(
    processEnvironment.environmentId,
    HISTORICAL_ENVIRONMENT_ID,
    "process environment",
  );
  exactValue(
    processEnvironment.incarnation,
    HISTORICAL_ENVIRONMENT_INCARNATION,
    "process environment incarnation",
  );
  exactValue(processEnvironment.workerId, workerId, "process Worker");
  const owner = exactObject(processEnvironment.owner, [
    "kind",
    "providerAccountId",
    "credentialGeneration",
  ]);
  exactValue(owner.kind, "provider_account", "environment owner kind");
  const profile = exactObject(processEnvironment.profile, ["id", "digest"]);
  const target = {
    setupAttemptId: HISTORICAL_SETUP_ATTEMPT_ID,
    authorizationId: text(setup.authorization_id, "authorization ID"),
    authorizedAt,
    providerAccountId: text(setup.provider_account_id, "ProviderAccount ID"),
    setupGeneration: positiveInteger(
      setup.setup_generation,
      "setup generation",
    ),
    credentialGeneration: positiveInteger(
      setup.credential_generation,
      "credential generation",
    ),
    environmentGeneration: positiveInteger(
      setup.environment_generation,
      "environment generation",
    ),
    invocationWorkerGeneration: positiveInteger(
      setup.worker_generation,
      "invocation Worker generation",
    ),
    invocationEnvironmentOperationId: text(
      setup.environment_operation_id,
      "environment operation ID",
    ),
    workerId,
    backendKind: "sbx" as const,
    environmentId: HISTORICAL_ENVIRONMENT_ID,
    environmentIncarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
    profileId: text(profile.id, "profile ID"),
    profileDigest: text(profile.digest, "profile digest"),
    backendProcessId: HISTORICAL_BACKEND_PROCESS_ID,
    processStartIdentity: HISTORICAL_PROCESS_START_IDENTITY,
    processGeneration: HISTORICAL_PROCESS_GENERATION,
    executable: HISTORICAL_EXECUTABLE,
    observedExecutable: HISTORICAL_EXECUTABLE,
    authConfigurationIdentity: text(
      authentication.configuration_identity,
      "authentication configuration",
    ),
    authEnvironmentPolicy: text(
      authentication.environment_policy,
      "authentication environment policy",
    ),
    authEvidenceIdentity,
    authInspectedAt,
  };
  exactValue(
    owner.providerAccountId,
    target.providerAccountId,
    "process owner account",
  );
  exactValue(
    owner.credentialGeneration,
    target.credentialGeneration,
    "process owner generation",
  );
  const evidence = {
    source: "worker_v2_immutable_snapshot" as const,
    invocationIntent: "login_invocation_requested" as const,
    intentRecordedAt,
    workerState: "invocation_acknowledged" as const,
    invocationState: "acknowledged" as const,
    acknowledgedRecordedAt,
    cancellationSubmission: "not_submitted" as const,
    historicalPhysicalIdentity: Object.freeze(target),
  };
  return Object.freeze({ ...evidence, digest: safeDigest(evidence) });
}

function parseEnvironmentRow(
  row: EnvironmentRow,
  worker: WorkerV2Evidence,
): EnvironmentForensicEvidence {
  if (
    row.backend_kind !== "sbx" ||
    row.owner_type !== "provider_account" ||
    row.environment_id !== HISTORICAL_ENVIRONMENT_ID ||
    row.incarnation !== HISTORICAL_ENVIRONMENT_INCARNATION ||
    row.state !== "running" ||
    row.retired_at !== null ||
    !row.marker_digest ||
    !row.native_agent
  )
    fail(
      "environment_evidence_incompatible",
      "Environment ledger does not contain one active exact SBX ownership record.",
    );
  const evidence = {
    recordId: text(row.record_id, "environment record ID"),
    backendKind: "sbx" as const,
    workerId: text(row.worker_id, "environment Worker"),
    providerAccountId: text(row.owner_id, "environment owner"),
    credentialGeneration: positiveInteger(
      row.owner_generation,
      "environment owner generation",
    ),
    displayName: text(row.display_name, "SBX display name"),
    environmentId: HISTORICAL_ENVIRONMENT_ID,
    incarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
    profileId: text(row.profile_id, "environment profile"),
    profileDigest: text(row.profile_digest, "environment profile digest"),
    markerDigest: sha256Hex(row.marker_digest, "environment marker digest"),
    nativeAgent: text(row.native_agent, "SBX native agent"),
    state: text(row.state, "environment state"),
  };
  if (
    evidence.workerId !== worker.historicalPhysicalIdentity.workerId ||
    evidence.providerAccountId !==
      worker.historicalPhysicalIdentity.providerAccountId ||
    evidence.credentialGeneration !==
      worker.historicalPhysicalIdentity.credentialGeneration ||
    evidence.profileId !== worker.historicalPhysicalIdentity.profileId ||
    evidence.profileDigest !== worker.historicalPhysicalIdentity.profileDigest
  )
    fail(
      "environment_evidence_incompatible",
      "Environment ownership does not match the historical process handle.",
    );
  return Object.freeze({ ...evidence, digest: safeDigest(evidence) });
}

function assertExactColumns(
  database: Database,
  table: string,
  expected: readonly string[],
  label: string,
): void {
  const actual = (
    database.query(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  )
    .map((row) => row.name)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort()))
    fail(
      "historical_evidence_incompatible",
      `Unknown or missing fields in ${label}; forensic parsing is refused.`,
    );
}

function exactObject(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail(
      "historical_evidence_incompatible",
      "Historical evidence object is malformed.",
    );
  const result = value as Record<string, unknown>;
  if (
    JSON.stringify(Object.keys(result).sort()) !==
    JSON.stringify([...expectedKeys].sort())
  )
    fail(
      "historical_evidence_incompatible",
      "Historical evidence contains unknown or missing fields.",
    );
  return result;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    fail(
      "historical_evidence_incompatible",
      "Historical JSON evidence is malformed.",
    );
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value)
    fail("historical_evidence_incompatible", `${name} evidence is missing.`);
  return value;
}

function timestampText(value: unknown, name: string): string {
  const result = text(value, name);
  if (Number.isNaN(Date.parse(result)))
    fail("historical_evidence_incompatible", `${name} evidence is invalid.`);
  return new Date(result).toISOString();
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    fail("historical_evidence_incompatible", `${name} evidence is invalid.`);
  return Number(value);
}

function sha256Hex(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[a-f0-9]{64}$/.test(result))
    fail("historical_evidence_incompatible", `${name} evidence is invalid.`);
  return result;
}

function exactValue(actual: unknown, expected: unknown, name: string): void {
  if (actual !== expected)
    fail(
      "historical_evidence_incompatible",
      `${name} evidence does not match the reviewed historical identity.`,
    );
}

function fail(
  code: ConstructorParameters<typeof ContainmentError>[0],
  message: string,
): never {
  throw new ContainmentError(code, message);
}
