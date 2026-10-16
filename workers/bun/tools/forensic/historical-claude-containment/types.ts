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

export const CONTAINMENT_JOURNAL_SCHEMA_VERSION = 1;

export type ContainmentErrorCode =
  | "invalid_arguments"
  | "historical_evidence_missing"
  | "historical_evidence_incompatible"
  | "cancellation_authority_invalid"
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

export interface WorkerV2Evidence {
  target: Omit<
    HistoricalTargetIdentity,
    | "cancellationRequestId"
    | "environmentDisplayName"
    | "environmentMarkerDigest"
    | "environmentNativeAgent"
  >;
  digest: string;
}

export interface ProductCancellationEvidence {
  setupAttemptId: string;
  cancellationRequestId: string;
  authorizationId: string;
  authorizationKind: "provider_account_setup";
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
  backendProcessId: string;
  processStartIdentity: string;
  processGeneration: string;
  executable: string;
  authConfigurationIdentity: string;
  authEnvironmentPolicy: string;
  authEvidenceIdentity: string;
  authInspectedAt: string;
  state: "cancellation_requested";
  invocationState: "acknowledged";
  invocationRequestedAt: string;
  invocationAcknowledgedAt: string;
  authorizationCount: 1;
  setupAuthorizedEventCount: 1;
  cancellationRequestedEventCount: 1;
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

export interface ValidatedContainmentEvidence {
  target: HistoricalTargetIdentity;
  workerEvidenceDigest: string;
  productEvidenceDigest: string;
  environmentEvidenceDigest: string;
  targetIdentityDigest: string;
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
  read(setupAttemptId: string): Promise<ProductCancellationEvidence>;
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
  targetIdentityDigest: string;
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
