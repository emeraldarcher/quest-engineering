export const HISTORICAL_SETUP_ATTEMPT_ID =
  "945ff91e-86e1-40e8-ba7a-c7c8ebfc54e5";
export const HISTORICAL_CANCELLATION_REQUEST_ID =
  "3243dbd3-6968-4f12-b58f-e91d02ad04c2";
export const HISTORICAL_ENVIRONMENT_ID = "9b0051f4-ec09-4680-9eec-51cbb706e256";
export const HISTORICAL_ENVIRONMENT_INCARNATION =
  "98567d15-6df0-4cfc-a27a-2817ba89333f";
export const HISTORICAL_BACKEND_PROCESS_ID = "425";
export const HISTORICAL_PROCESS_START_IDENTITY = "1677";
export const HISTORICAL_PROCESS_GENERATION =
  "8aecbece-10bb-4897-b5d5-41c6ba538b82";
export const HISTORICAL_EXECUTABLE = "/opt/qe/claude/claude";
export const FAILED_GATE_ONE_OPERATION_ID =
  "15428ed9-f6df-4b6d-bfcd-379c7c855eb4";
export const FAILED_GATE_ONE_RETRY_OPERATION_ID =
  "486ffc35-b53c-4579-8a71-e92ec263e936";

export const CONTAINMENT_JOURNAL_SCHEMA_VERSION = 1;

export type ContainmentErrorCode =
  | "invalid_arguments"
  | "historical_evidence_missing"
  | "historical_evidence_incompatible"
  | "worker_evidence_missing"
  | "worker_evidence_mismatch"
  | "product_evidence_read_unavailable"
  | "product_evidence_missing"
  | "product_evidence_mismatch"
  | "corroboration_mismatch"
  | "worker_generation_handoff_unproven"
  | "environment_evidence_incompatible"
  | "physical_identity_mismatch"
  | "physical_observation_unavailable"
  | "cancellation_submission_uncertain"
  | "containment_journal_conflict"
  | "execution_interlock_failed"
  | "settlement_unknown";

export class ContainmentError extends Error {
  constructor(
    readonly code: ContainmentErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface HistoricalTargetIdentity {
  setupAttemptId: string;
  cancellationRequestId: string;
  authorizationId: string;
  authorizedAt: string;
  providerAccountId: string;
  setupGeneration: number;
  credentialGeneration: number;
  environmentGeneration: number;
  invocationWorkerGeneration: number;
  invocationEnvironmentOperationId: string;
  workerId: string;
  backendKind: "sbx";
  environmentId: string;
  environmentIncarnation: string;
  environmentDisplayName: string;
  environmentMarkerDigest: string;
  environmentNativeAgent: string;
  profileId: string;
  profileDigest: string;
  backendProcessId: string;
  processStartIdentity: string;
  processGeneration: string;
  executable: string;
  observedExecutable: string;
  authConfigurationIdentity: string;
  authEnvironmentPolicy: string;
  authEvidenceIdentity: string;
  authInspectedAt: string;
}

export type HistoricalWorkerPhysicalIdentity = Omit<
  HistoricalTargetIdentity,
  | "cancellationRequestId"
  | "environmentDisplayName"
  | "environmentMarkerDigest"
  | "environmentNativeAgent"
>;

export interface WorkerInvocationAuthorityEvidence {
  source: "worker_v2_command_json_and_authorization_accepted_event";
  commandAcceptedAt: string;
  connectionGeneration: number;
  setupWorkerGeneration: number;
  environmentOperationId: string;
  commandReconciliationCount: 0;
}

export interface WorkerV2Evidence {
  source: "worker_v2_immutable_snapshot";
  invocationAuthority: WorkerInvocationAuthorityEvidence;
  invocationIntent: "login_invocation_requested";
  intentRecordedAt: string;
  workerState: "invocation_acknowledged";
  invocationState: "acknowledged";
  acknowledgedRecordedAt: string;
  cancellationSubmission: "not_submitted";
  historicalPhysicalIdentity: HistoricalWorkerPhysicalIdentity;
  digest: string;
}

export interface ProductDatabaseIdentity {
  databaseName: string;
  schemaName: "public";
  serverLocality: "local";
  serverPort: number;
  schemaMigrationVersion: string;
  schemaMigrationCount: number;
}

export interface ProductGenerationRefenceEvidence {
  workerGeneration: number;
  environmentOperationId: string;
  environmentEventOccurredAt: string;
  setupEventOccurredAt: string;
}

export interface ProductInvocationAuthorityEvidence {
  source: "product_append_only_environment_and_setup_events";
  contractVersion: "product-invocation-authority-v1";
  workerGeneration: number;
  environmentOperationId: string;
  authorityEventType: "environment_ensured" | "worker_generation_reconciled";
  authorityEventOccurredAt: string;
  invocationRequestedEventOccurredAt: string;
  currentWorkerGeneration: number;
  currentEnvironmentOperationId: string;
  refenceChain: readonly ProductGenerationRefenceEvidence[];
}

export interface ProductSemanticAuthorityEvidence {
  source: "product_repeatable_read_read_only_transaction";
  databaseIdentity: ProductDatabaseIdentity;
  invocationAuthority: ProductInvocationAuthorityEvidence;
  setupAttemptId: string;
  cancellationRequestId: string;
  authorizationId: string;
  authorizationKind: "provider_account_setup";
  authorizedAt: string;
  providerAccountId: string;
  setupGeneration: number;
  credentialGeneration: number;
  environmentGeneration: number;
  workerId: string;
  backendKind: "sbx";
  environmentId: string;
  environmentIncarnation: string;
  authConfigurationIdentity: string;
  authEnvironmentPolicy: string;
  authEvidenceIdentity: string;
  authInspectedAt: string;
  state: "cancellation_requested";
  invocationState: "requested";
  invocationRequestedAt: string;
  authorizationCount: 1;
  setupAuthorizedEventCount: 1;
  cancellationRequestedEventCount: 1;
  cancellationEventOccurredAt: string;
  laterSemanticEventCount: 0;
  humanAttentionCount: 0;
  transactionReadOnly: true;
  digest: string;
}

export interface EnvironmentForensicEvidence {
  recordId: string;
  backendKind: "sbx";
  workerId: string;
  providerAccountId: string;
  credentialGeneration: number;
  displayName: string;
  environmentId: string;
  incarnation: string;
  profileId: string;
  profileDigest: string;
  markerDigest: string;
  nativeAgent: string;
  state: string;
  digest: string;
}

export interface SharedIdentityMatches {
  contractVersion: "historical-containment-shared-identity-v2";
  matchedFields: readonly string[];
}

export interface GenerationAuthorityMatches {
  contractVersion: "historical-containment-generation-authority-v1";
  matchedFields: readonly [
    "invocation_authority_worker_generation",
    "invocation_authority_environment_operation_id",
  ];
  productInvocationAuthority: ProductInvocationAuthorityEvidence;
  workerInvocationAuthority: WorkerInvocationAuthorityEvidence;
}

export interface ValidatedContainmentEvidence {
  target: HistoricalTargetIdentity;
  semanticAuthority: ProductSemanticAuthorityEvidence;
  historicalPhysicalEvidence: WorkerV2Evidence;
  historicalPhysicalIdentity: HistoricalWorkerPhysicalIdentity;
  sharedIdentityMatches: SharedIdentityMatches;
  generationAuthorityMatches: GenerationAuthorityMatches;
  environmentEvidence: EnvironmentForensicEvidence;
  workerEvidenceDigest: string;
  productEvidenceDigest: string;
  environmentEvidenceDigest: string;
  corroboratedEvidenceDigest: string;
}

export type PhysicalObservation =
  | {
      kind: "live_exact";
      environmentStatus: string;
      pidfdOpened: true;
      observedStartIdentity: string;
      observedExecutable: string;
      observedAt: string;
    }
  | {
      kind: "target_absent";
      reason:
        | "environment_absent"
        | "environment_stopped"
        | "process_absent"
        | "process_terminal";
      environmentStatus: string | null;
      observedAt: string;
    }
  | {
      kind: "identity_mismatch";
      reason:
        | "environment_identity"
        | "environment_ownership"
        | "process_start_identity"
        | "process_executable"
        | "pid_reuse"
        | "marker_digest";
      observedAt: string;
    }
  | {
      kind: "unavailable";
      reason: "sbx_inventory" | "sbx_exec" | "pidfd" | "malformed_observation";
      observedAt: string;
    };

export type CancellationSubmissionResult =
  | { kind: "acknowledged"; observedAt: string }
  | { kind: "not_submitted_target_absent"; observedAt: string }
  | {
      kind: "not_submitted_identity_mismatch";
      observedAt: string;
    }
  | { kind: "uncertain"; observedAt: string };

export interface PhysicalProcessController {
  inspect(target: HistoricalTargetIdentity): Promise<PhysicalObservation>;
  cancelOnce(
    target: HistoricalTargetIdentity,
    containmentOperationId: string,
  ): Promise<CancellationSubmissionResult>;
}

export interface ProductEvidenceReader {
  read(setupAttemptId: string): Promise<ProductSemanticAuthorityEvidence>;
  close(): Promise<void>;
}

export type ContainmentEventType =
  | "prepared"
  | "authority_validated"
  | "physical_observation"
  | "dry_run_completed"
  | "cancellation_intent_recorded"
  | "cancellation_not_submitted"
  | "cancellation_submitted"
  | "cancellation_acknowledged"
  | "cancellation_uncertain"
  | "target_observed_terminal"
  | "settlement_unknown"
  | "typed_error";

export interface ContainmentJournalEvent {
  eventId: number;
  operationId: string;
  eventType: ContainmentEventType;
  details: Readonly<Record<string, unknown>>;
  occurredAt: string;
}

export interface ContainmentRunOptions {
  workerLedgerPath: string;
  environmentLedgerPath: string;
  journalPath: string;
  setupAttemptId: string;
  containmentOperationId: string;
  executeCancellation: boolean;
  confirmCancellationRequestId?: string;
  confirmPhysicalIdentityDigest?: string;
  settlementTimeoutMs?: number;
  settlementPollMs?: number;
}

export interface ContainmentRunResult {
  mode: "dry_run" | "execute" | "reconcile_only";
  operationId: string;
  setupAttemptId: string;
  cancellationRequestId: string;
  targetIdentityDigest: string | null;
  observation: PhysicalObservation;
  permittedAction:
    | "exact_cancellation"
    | "record_authoritative_absence"
    | "read_only_reconciliation"
    | "none";
  cancellationSubmission:
    | "not_attempted"
    | "acknowledged"
    | "not_submitted"
    | "uncertain";
  settlement: "not_applicable" | "terminal" | "unknown";
}
