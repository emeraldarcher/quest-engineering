import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  readEnvironmentForensicEvidence,
  readHistoricalWorkerV2Evidence,
  safeDigest,
  validateContainmentEvidence,
} from "./evidence.ts";
import { ContainmentJournal } from "./journal.ts";
import {
  ContainmentError,
  type ContainmentRunOptions,
  type ContainmentRunResult,
  FAILED_GATE_ONE_OPERATION_ID,
  FAILED_GATE_ONE_RETRY_OPERATION_ID,
  HISTORICAL_CANCELLATION_REQUEST_ID,
  HISTORICAL_SETUP_ATTEMPT_ID,
  type PhysicalObservation,
  type PhysicalProcessController,
  type ProductEvidenceReader,
  type ValidatedContainmentEvidence,
} from "./types.ts";

export interface ContainmentProcedureDependencies {
  productEvidence: ProductEvidenceReader;
  physical: PhysicalProcessController;
  clock?: () => Date;
  wait?: (milliseconds: number) => Promise<void>;
}

export async function runHistoricalContainment(
  options: ContainmentRunOptions,
  dependencies: ContainmentProcedureDependencies,
): Promise<ContainmentRunResult> {
  validateOptions(options);
  await assertJournalIsolation(options);
  const snapshotRoot = join(
    dirname(resolve(options.journalPath)),
    ".containment-forensic-snapshots",
  );
  const worker = await readHistoricalWorkerV2Evidence(
    options.workerLedgerPath,
    snapshotRoot,
  );
  const product = await dependencies.productEvidence.read(
    options.setupAttemptId,
  );
  const environment = await readEnvironmentForensicEvidence(
    options.environmentLedgerPath,
    worker,
    snapshotRoot,
  );
  const evidence = validateContainmentEvidence(worker, product, environment);
  validateExecutionRequest(options, evidence);

  const journal = new ContainmentJournal(
    options.journalPath,
    dependencies.clock,
  );
  try {
    journal.prepare(options.containmentOperationId, evidence);
    journal.append(options.containmentOperationId, "authority_validated", {
      cancellation_request_id: evidence.target.cancellationRequestId,
      corroborated_evidence_digest: evidence.corroboratedEvidenceDigest,
    });
    const alreadyCrossedBoundary = journal.hasCancellationIntent(
      options.containmentOperationId,
    );
    if (options.executeCancellation)
      validateReviewedPhysicalIdentity(
        options,
        journal.reviewedPhysicalIdentityDigest(options.containmentOperationId),
      );
    let observation = await dependencies.physical.inspect(evidence.target);
    appendObservation(journal, options.containmentOperationId, observation);

    if (!options.executeCancellation) {
      const permittedAction = permitted(observation, alreadyCrossedBoundary);
      if (observation.kind === "target_absent")
        journal.append(
          options.containmentOperationId,
          "target_observed_terminal",
          terminalDetails(observation),
        );
      journal.append(options.containmentOperationId, "dry_run_completed", {
        permitted_action: permittedAction,
        physical_identity_digest:
          observation.kind === "live_exact"
            ? physicalIdentityDigest(evidence, observation)
            : null,
        signal_count: 0,
      });
      return result(
        "dry_run",
        options,
        evidence,
        observation,
        permittedAction,
        "not_attempted",
        observation.kind === "target_absent" ? "terminal" : "not_applicable",
      );
    }

    if (alreadyCrossedBoundary) {
      appendSettlementProjection(
        journal,
        options.containmentOperationId,
        observation,
      );
      return result(
        "reconcile_only",
        options,
        evidence,
        observation,
        "read_only_reconciliation",
        priorSubmission(journal, options.containmentOperationId),
        observation.kind === "target_absent" ? "terminal" : "unknown",
      );
    }

    if (observation.kind === "target_absent") {
      journal.append(
        options.containmentOperationId,
        "target_observed_terminal",
        terminalDetails(observation),
      );
      return result(
        "execute",
        options,
        evidence,
        observation,
        "record_authoritative_absence",
        "not_attempted",
        "terminal",
      );
    }
    if (observation.kind === "identity_mismatch") {
      journal.append(options.containmentOperationId, "typed_error", {
        error_code: "physical_identity_mismatch",
        reason: observation.reason,
      });
      throw new ContainmentError(
        "physical_identity_mismatch",
        "Current physical identity does not match; no cancellation was submitted.",
      );
    }
    if (observation.kind === "unavailable") {
      journal.append(options.containmentOperationId, "typed_error", {
        error_code: "physical_observation_unavailable",
        reason: observation.reason,
      });
      throw new ContainmentError(
        "physical_observation_unavailable",
        "Current physical identity is unavailable; no cancellation was submitted.",
      );
    }

    const currentPhysicalIdentityDigest = physicalIdentityDigest(
      evidence,
      observation,
    );
    if (currentPhysicalIdentityDigest !== options.confirmPhysicalIdentityDigest)
      throw new ContainmentError(
        "execution_interlock_failed",
        "Current exact physical identity no longer matches the reviewed dry-run digest.",
      );

    const intentRecorded = journal.recordCancellationIntentOnce(
      options.containmentOperationId,
      {
        cancellation_request_id: evidence.target.cancellationRequestId,
        physical_identity_digest: currentPhysicalIdentityDigest,
      },
    );
    if (!intentRecorded) {
      observation = await dependencies.physical.inspect(evidence.target);
      appendObservation(journal, options.containmentOperationId, observation);
      appendSettlementProjection(
        journal,
        options.containmentOperationId,
        observation,
      );
      return result(
        "reconcile_only",
        options,
        evidence,
        observation,
        "read_only_reconciliation",
        priorSubmission(journal, options.containmentOperationId),
        observation.kind === "target_absent" ? "terminal" : "unknown",
      );
    }

    let submission: Awaited<
      ReturnType<PhysicalProcessController["cancelOnce"]>
    >;
    try {
      submission = await dependencies.physical.cancelOnce(
        evidence.target,
        options.containmentOperationId,
      );
    } catch {
      submission = {
        kind: "uncertain",
        observedAt: (dependencies.clock ?? (() => new Date()))().toISOString(),
      };
    }
    if (submission.kind === "not_submitted_target_absent") {
      journal.append(
        options.containmentOperationId,
        "cancellation_not_submitted",
        {
          reason: "target_absent",
        },
      );
      observation = await dependencies.physical.inspect(evidence.target);
      appendObservation(journal, options.containmentOperationId, observation);
      appendSettlementProjection(
        journal,
        options.containmentOperationId,
        observation,
      );
      return result(
        "execute",
        options,
        evidence,
        observation,
        "none",
        "not_submitted",
        observation.kind === "target_absent" ? "terminal" : "unknown",
      );
    }
    if (submission.kind === "not_submitted_identity_mismatch") {
      journal.append(
        options.containmentOperationId,
        "cancellation_not_submitted",
        {
          reason: "identity_mismatch",
        },
      );
      journal.append(options.containmentOperationId, "typed_error", {
        error_code: "physical_identity_mismatch",
      });
      throw new ContainmentError(
        "physical_identity_mismatch",
        "Physical identity changed at the cancellation boundary; no signal was submitted.",
      );
    }
    const submissionState =
      submission.kind === "acknowledged" ? "acknowledged" : "uncertain";
    if (submission.kind === "acknowledged")
      journal.append(options.containmentOperationId, "cancellation_submitted", {
        submission_certainty: "acknowledged",
      });
    journal.append(
      options.containmentOperationId,
      submission.kind === "acknowledged"
        ? "cancellation_acknowledged"
        : "cancellation_uncertain",
      { submission_certainty: submissionState },
    );
    const settlement = await observeSettlement(
      evidence,
      options,
      dependencies,
      journal,
    );
    observation = settlement.observation;
    return result(
      "execute",
      options,
      evidence,
      observation,
      "read_only_reconciliation",
      submissionState,
      settlement.settlement,
    );
  } finally {
    journal.close();
  }
}

async function observeSettlement(
  evidence: ValidatedContainmentEvidence,
  options: ContainmentRunOptions,
  dependencies: ContainmentProcedureDependencies,
  journal: ContainmentJournal,
): Promise<{
  observation: PhysicalObservation;
  settlement: "terminal" | "unknown";
}> {
  const timeoutMs = options.settlementTimeoutMs ?? 30_000;
  const pollMs = options.settlementPollMs ?? 250;
  const start = Date.now();
  let observation = await dependencies.physical.inspect(evidence.target);
  while (true) {
    appendObservation(journal, options.containmentOperationId, observation);
    if (observation.kind === "target_absent") {
      journal.append(
        options.containmentOperationId,
        "target_observed_terminal",
        terminalDetails(observation),
      );
      return { observation, settlement: "terminal" };
    }
    if (
      observation.kind === "identity_mismatch" ||
      observation.kind === "unavailable" ||
      Date.now() - start >= timeoutMs
    ) {
      journal.append(options.containmentOperationId, "settlement_unknown", {
        observation: observation.kind,
      });
      return { observation, settlement: "unknown" };
    }
    await (dependencies.wait ?? Bun.sleep)(pollMs);
    observation = await dependencies.physical.inspect(evidence.target);
  }
}

function validateOptions(options: ContainmentRunOptions): void {
  if (
    !isAbsolute(options.workerLedgerPath) ||
    !isAbsolute(options.environmentLedgerPath) ||
    !isAbsolute(options.journalPath)
  )
    throw new ContainmentError(
      "invalid_arguments",
      "Forensic inputs and the separate containment journal require absolute paths.",
    );
  if (options.setupAttemptId !== HISTORICAL_SETUP_ATTEMPT_ID)
    throw new ContainmentError(
      "invalid_arguments",
      "The tool is restricted to the reviewed historical setup attempt.",
    );
  if (!isUuid(options.containmentOperationId))
    throw new ContainmentError(
      "invalid_arguments",
      "Containment operation ID must be an explicit UUID.",
    );
  if (
    [
      HISTORICAL_SETUP_ATTEMPT_ID,
      HISTORICAL_CANCELLATION_REQUEST_ID,
      FAILED_GATE_ONE_OPERATION_ID,
      FAILED_GATE_ONE_RETRY_OPERATION_ID,
    ].includes(options.containmentOperationId)
  )
    throw new ContainmentError(
      "invalid_arguments",
      "Containment operation ID must be new and independent from historical or failed diagnostic IDs.",
    );
  const timeout = options.settlementTimeoutMs ?? 30_000;
  const poll = options.settlementPollMs ?? 250;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 120_000 ||
    !Number.isSafeInteger(poll) ||
    poll < 1 ||
    poll > timeout
  )
    throw new ContainmentError(
      "invalid_arguments",
      "Settlement bounds are invalid.",
    );
}

async function assertJournalIsolation(
  options: ContainmentRunOptions,
): Promise<void> {
  const inputArtifacts = [
    options.workerLedgerPath,
    `${options.workerLedgerPath}-wal`,
    `${options.workerLedgerPath}-shm`,
    options.environmentLedgerPath,
    `${options.environmentLedgerPath}-wal`,
    `${options.environmentLedgerPath}-shm`,
  ];
  const journalArtifacts = [
    options.journalPath,
    `${options.journalPath}-wal`,
    `${options.journalPath}-shm`,
  ];
  const entries = await Promise.all(
    [...inputArtifacts, ...journalArtifacts].map(async (path) => ({
      path,
      canonical: await canonicalProspectivePath(path),
      status: await lstat(path).catch(() => null),
    })),
  );
  const inputEntries = entries.slice(0, inputArtifacts.length);
  const journalEntries = entries.slice(inputArtifacts.length);
  for (const journal of journalEntries) {
    if (
      journal.status &&
      (!journal.status.isFile() || journal.status.isSymbolicLink())
    )
      throw new ContainmentError(
        "invalid_arguments",
        "Containment journal artifacts must be regular non-symlink files.",
      );
    for (const input of inputEntries)
      if (
        journal.canonical === input.canonical ||
        (journal.status &&
          input.status &&
          journal.status.dev === input.status.dev &&
          journal.status.ino === input.status.ino)
      )
        throw new ContainmentError(
          "invalid_arguments",
          "Containment journal and sidecars must be physically separate from every forensic input.",
        );
  }
}

async function canonicalProspectivePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    const missing: string[] = [basename(path)];
    let ancestor = dirname(path);
    while (true) {
      try {
        return join(await realpath(ancestor), ...missing);
      } catch {
        const parent = dirname(ancestor);
        if (parent === ancestor) return resolve(path);
        missing.unshift(basename(ancestor));
        ancestor = parent;
      }
    }
  }
}

function validateExecutionRequest(
  options: ContainmentRunOptions,
  evidence: ValidatedContainmentEvidence,
): void {
  if (!options.executeCancellation) return;
  if (
    options.confirmCancellationRequestId !==
      HISTORICAL_CANCELLATION_REQUEST_ID ||
    options.confirmCancellationRequestId !==
      evidence.target.cancellationRequestId ||
    !options.confirmPhysicalIdentityDigest?.startsWith("sha256:")
  )
    throw new ContainmentError(
      "execution_interlock_failed",
      "Destructive execution requires the exact cancellation request and one reviewed dry-run physical identity digest.",
    );
}

function validateReviewedPhysicalIdentity(
  options: ContainmentRunOptions,
  reviewedDigest: string | null,
): void {
  if (
    !reviewedDigest ||
    options.confirmPhysicalIdentityDigest !== reviewedDigest
  )
    throw new ContainmentError(
      "execution_interlock_failed",
      "Destructive execution requires the physical identity digest persisted by this operation's successful dry run.",
    );
}

export function physicalIdentityDigest(
  evidence: ValidatedContainmentEvidence,
  observation: Extract<PhysicalObservation, { kind: "live_exact" }>,
): string {
  if (
    observation.environmentStatus !== "running" ||
    observation.pidfdOpened !== true ||
    observation.observedStartIdentity !==
      evidence.target.processStartIdentity ||
    observation.observedExecutable !== evidence.target.observedExecutable
  )
    throw new ContainmentError(
      "physical_identity_mismatch",
      "The claimed live observation does not exactly corroborate the historical Worker identity.",
    );
  return safeDigest({
    contractVersion: "historical-containment-physical-identity-v3",
    semanticAuthority: {
      source: "product_repeatable_read_read_only_transaction",
      digest: evidence.productEvidenceDigest,
    },
    historicalPhysicalIdentity: {
      source: "worker_v2_immutable_snapshot",
      digest: evidence.workerEvidenceDigest,
    },
    environmentEvidence: {
      source: "worker_environment_immutable_snapshot",
      digest: evidence.environmentEvidenceDigest,
    },
    sharedIdentityMatches: evidence.sharedIdentityMatches,
    generationAuthorityMatches: evidence.generationAuthorityMatches,
    currentPhysicalIdentity: {
      source: "sbx_pidfd_observation",
      observation: "live_exact",
      environmentId: evidence.target.environmentId,
      environmentIncarnation: evidence.target.environmentIncarnation,
      environmentStatus: observation.environmentStatus,
      backendProcessId: evidence.target.backendProcessId,
      pidfdOpened: observation.pidfdOpened,
      observedStartIdentity: observation.observedStartIdentity,
      observedExecutable: observation.observedExecutable,
    },
  });
}

function appendObservation(
  journal: ContainmentJournal,
  operationId: string,
  observation: PhysicalObservation,
): void {
  journal.append(
    operationId,
    "physical_observation",
    observationDetails(observation),
  );
}

function observationDetails(
  observation: PhysicalObservation,
): Readonly<Record<string, unknown>> {
  if (observation.kind === "live_exact")
    return {
      observation: observation.kind,
      environment_status: observation.environmentStatus,
      pidfd_opened: observation.pidfdOpened,
      observed_start_identity: observation.observedStartIdentity,
      observed_executable: observation.observedExecutable,
      observed_at: observation.observedAt,
    };
  return {
    observation: observation.kind,
    reason: observation.reason,
    observed_at: observation.observedAt,
  };
}

function appendSettlementProjection(
  journal: ContainmentJournal,
  operationId: string,
  observation: PhysicalObservation,
): void {
  if (observation.kind === "target_absent") {
    journal.append(
      operationId,
      "target_observed_terminal",
      terminalDetails(observation),
    );
    return;
  }
  journal.append(operationId, "settlement_unknown", {
    observation: observation.kind,
  });
}

function terminalDetails(
  observation: Extract<PhysicalObservation, { kind: "target_absent" }>,
): Readonly<Record<string, unknown>> {
  return {
    result: "target_not_present_or_already_terminal",
    reason: observation.reason,
    exit_status: "unavailable",
    observed_at: observation.observedAt,
  };
}

function permitted(
  observation: PhysicalObservation,
  alreadyCrossedBoundary: boolean,
): ContainmentRunResult["permittedAction"] {
  if (alreadyCrossedBoundary) return "read_only_reconciliation";
  if (observation.kind === "live_exact") return "exact_cancellation";
  if (observation.kind === "target_absent")
    return "record_authoritative_absence";
  return "none";
}

function priorSubmission(
  journal: ContainmentJournal,
  operationId: string,
): ContainmentRunResult["cancellationSubmission"] {
  if (journal.hasEvent(operationId, "cancellation_acknowledged"))
    return "acknowledged";
  return "uncertain";
}

function result(
  mode: ContainmentRunResult["mode"],
  options: ContainmentRunOptions,
  evidence: ValidatedContainmentEvidence,
  observation: PhysicalObservation,
  permittedAction: ContainmentRunResult["permittedAction"],
  cancellationSubmission: ContainmentRunResult["cancellationSubmission"],
  settlement: ContainmentRunResult["settlement"],
): ContainmentRunResult {
  return {
    mode,
    operationId: options.containmentOperationId,
    setupAttemptId: evidence.target.setupAttemptId,
    cancellationRequestId: evidence.target.cancellationRequestId,
    targetIdentityDigest:
      observation.kind === "live_exact"
        ? physicalIdentityDigest(evidence, observation)
        : options.executeCancellation
          ? (options.confirmPhysicalIdentityDigest ?? null)
          : null,
    observation,
    permittedAction,
    cancellationSubmission,
    settlement,
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}
