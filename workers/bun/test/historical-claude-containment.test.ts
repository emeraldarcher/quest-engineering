import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { SbxClient } from "../src/execution-environment/sbx-client.ts";
import { parseContainmentArguments } from "../tools/forensic/historical-claude-containment/cli.ts";
import {
  EVIDENCE_RESPONSIBILITY_TABLE,
  readEnvironmentForensicEvidence,
  readHistoricalWorkerV2Evidence,
  SHARED_IDENTITY_FIELDS,
  validateContainmentEvidence,
} from "../tools/forensic/historical-claude-containment/evidence.ts";
import { ContainmentJournal } from "../tools/forensic/historical-claude-containment/journal.ts";
import {
  PIDFD_CANCELLATION_PROGRAM,
  PIDFD_INSPECTION_PROGRAM,
  SbxPidfdPhysicalProcessController,
} from "../tools/forensic/historical-claude-containment/physical.ts";
import { runHistoricalContainment } from "../tools/forensic/historical-claude-containment/procedure.ts";
import {
  HISTORICAL_PRODUCT_DATABASE_NAME,
  HISTORICAL_PRODUCT_SCHEMA_MIGRATION,
  HISTORICAL_PRODUCT_SCHEMA_MIGRATION_COUNT,
  parseProductEvidenceRow,
} from "../tools/forensic/historical-claude-containment/product-evidence.ts";
import {
  type CancellationSubmissionResult,
  ContainmentError,
  FAILED_GATE_ONE_OPERATION_ID,
  FAILED_GATE_ONE_RETRY_OPERATION_ID,
  HISTORICAL_BACKEND_PROCESS_ID,
  HISTORICAL_CANCELLATION_REQUEST_ID,
  HISTORICAL_ENVIRONMENT_ID,
  HISTORICAL_ENVIRONMENT_INCARNATION,
  HISTORICAL_EXECUTABLE,
  HISTORICAL_PROCESS_GENERATION,
  HISTORICAL_PROCESS_START_IDENTITY,
  HISTORICAL_SETUP_ATTEMPT_ID,
  type HistoricalTargetIdentity,
  type PhysicalObservation,
  type PhysicalProcessController,
  type ProductDatabaseIdentity,
  type ProductEvidenceReader,
  type ProductSemanticAuthorityEvidence,
} from "../tools/forensic/historical-claude-containment/types.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("one-time historical Claude containment", () => {
  test("synthetic schema-two parser reads only exact required identity and authority", async () => {
    const fixture = await forensicFixture();
    const evidence = await readHistoricalWorkerV2Evidence(fixture.workerLedger);
    expect(evidence.historicalPhysicalIdentity).toMatchObject({
      setupAttemptId: HISTORICAL_SETUP_ATTEMPT_ID,
      backendKind: "sbx",
      environmentId: HISTORICAL_ENVIRONMENT_ID,
      environmentIncarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
      backendProcessId: HISTORICAL_BACKEND_PROCESS_ID,
      processStartIdentity: HISTORICAL_PROCESS_START_IDENTITY,
      processGeneration: HISTORICAL_PROCESS_GENERATION,
      executable: HISTORICAL_EXECUTABLE,
    });
    expect(JSON.stringify(evidence)).not.toContain("interaction-public-key");
  });

  test("unknown or missing schema-two fields fail closed without conversion", async () => {
    const fixture = await forensicFixture();
    const database = new Database(fixture.workerLedger);
    database.exec(
      "ALTER TABLE provider_account_setup_attempts ADD COLUMN unknown_legacy_field TEXT",
    );
    database.close();
    await expect(
      readHistoricalWorkerV2Evidence(fixture.workerLedger),
    ).rejects.toMatchObject({ code: "worker_evidence_mismatch" });
    const preserved = new Database(fixture.workerLedger, { readonly: true });
    expect(preserved.query("PRAGMA user_version").get()).toEqual({
      user_version: 2,
    });
    expect(
      preserved
        .query(
          "SELECT cancellation_request_id FROM provider_account_setup_attempts",
        )
        .get(),
    ).toEqual({ cancellation_request_id: null });
    preserved.close();
  });

  test("missing Worker v2 attempt is worker_evidence_missing before physical access", async () => {
    const fixture = await forensicFixture();
    const database = new Database(fixture.workerLedger);
    database
      .query(
        "DELETE FROM provider_account_setup_attempts WHERE setup_attempt_id=?",
      )
      .run(HISTORICAL_SETUP_ATTEMPT_ID);
    database.close();
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "worker_evidence_missing",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test("Worker accepted-command provenance requires one acceptance and no command reconciliation", async () => {
    for (const eventMutation of [
      "DELETE FROM provider_account_setup_events WHERE event_type='authorization_accepted'",
      `INSERT INTO provider_account_setup_events
       (setup_attempt_id,event_type,details_json,occurred_at)
       VALUES ('${HISTORICAL_SETUP_ATTEMPT_ID}','command_reconciled','{}','${timestamp()}')`,
      "UPDATE provider_account_setup_events SET occurred_at='2026-10-14T00:00:00.000Z' WHERE event_type='authorization_accepted'",
    ]) {
      const fixture = await forensicFixture();
      const database = new Database(fixture.workerLedger);
      database.exec(eventMutation);
      database.close();
      const physical = new FakePhysical([liveObservation()]);
      await expect(dryRun(fixture, physical)).rejects.toMatchObject({
        code: "worker_evidence_mismatch",
      });
      expect(physical.inspectionCalls).toBe(0);
    }
  });

  test("Worker row cannot replace missing invocation acknowledgement event", async () => {
    const fixture = await forensicFixture();
    const database = new Database(fixture.workerLedger);
    database
      .query(
        "DELETE FROM provider_account_setup_events WHERE event_type='login_invocation_acknowledged'",
      )
      .run();
    database.close();
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "worker_evidence_mismatch",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test("Worker-side cancellation event contradicts not-submitted physical history", async () => {
    const fixture = await forensicFixture();
    const database = new Database(fixture.workerLedger);
    database
      .query(
        `INSERT INTO provider_account_setup_events
         (setup_attempt_id,event_type,details_json,occurred_at)
         VALUES (?,'cancellation_requested','{}',?)`,
      )
      .run(HISTORICAL_SETUP_ATTEMPT_ID, timestamp());
    database.close();
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "worker_evidence_mismatch",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test("Worker acknowledgement chronology cannot precede Worker intent record", async () => {
    const fixture = await forensicFixture();
    mutateWorkerAttempt(fixture.workerLedger, {
      created_at: "2026-10-15T00:00:02.000Z",
      updated_at: "2026-10-15T00:00:01.000Z",
    });
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "worker_evidence_mismatch",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test("WAL-backed v2 evidence is snapshotted without modifying original files", async () => {
    const fixture = await forensicFixture();
    const writer = new Database(fixture.workerLedger);
    try {
      writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;");
      writer
        .query(
          "UPDATE provider_account_setup_attempts SET cancellation_request_id='stale-main-value'",
        )
        .run();
      writer.exec("PRAGMA wal_checkpoint(TRUNCATE);");
      writer
        .query(
          "UPDATE provider_account_setup_attempts SET cancellation_request_id=NULL",
        )
        .run();
      const paths = [
        fixture.workerLedger,
        `${fixture.workerLedger}-wal`,
        `${fixture.workerLedger}-shm`,
      ];
      const before = await Promise.all(paths.map(fileDigest));
      const evidence = await readHistoricalWorkerV2Evidence(
        fixture.workerLedger,
        join(fixture.root, "forensic-snapshots"),
      );
      expect(evidence.historicalPhysicalIdentity.setupAttemptId).toBe(
        HISTORICAL_SETUP_ATTEMPT_ID,
      );
      expect(await Promise.all(paths.map(fileDigest))).toEqual(before);
    } finally {
      writer.close();
    }
  });

  test("journal path cannot alias any forensic input", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([liveObservation()]);
    await link(fixture.workerLedger, fixture.journal);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    await rm(fixture.journal);
    await symlink(fixture.environmentLedger, fixture.journal);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "invalid_arguments",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test("exact live target dry-run is eligible and sends zero signals", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([liveObservation()]);
    const result = await dryRun(fixture, physical);
    expect(result).toMatchObject({
      mode: "dry_run",
      permittedAction: "exact_cancellation",
      cancellationSubmission: "not_attempted",
    });
    expect(result.targetIdentityDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(readJournalDetails(fixture)).toContain(
      `"physical_identity_digest":"${result.targetIdentityDigest}"`,
    );
    expect(physical.cancellationCalls).toBe(0);
    const journal = await readFile(fixture.journal, "utf8");
    expect(journal).not.toContain("interaction-public-key");
    expect(journal).not.toContain("authentication-evidence");
    const appendOnly = new Database(fixture.journal);
    expect(() =>
      appendOnly.query("UPDATE containment_events SET details_json='{}'").run(),
    ).toThrow("append-only");
    expect(() =>
      appendOnly.query("DELETE FROM containment_operations").run(),
    ).toThrow("append-only");
    appendOnly.close();
  });

  test("responsibility table keeps semantic, historical physical, and current physical authority distinct", () => {
    expect(EVIDENCE_RESPONSIBILITY_TABLE).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fact: expect.stringContaining("cancellation authority"),
          product: "authority",
          workerV2: "not_source",
        }),
        expect.objectContaining({
          fact: expect.stringContaining("invocation acknowledgement"),
          product: "not_source",
          workerV2: "authority",
        }),
        expect.objectContaining({
          fact: expect.stringContaining("process PID"),
          product: "not_source",
          workerV2: "authority_historical",
          physical: "authority_current_observation",
        }),
        expect.objectContaining({
          fact: "invocation authority generation and environment operation",
          product: "authority_from_append_only_pre_refence_events",
          workerV2: "authority_from_accepted_command",
        }),
        expect.objectContaining({
          fact: "current/reconnected Worker generation and environment operation",
          product: "current_projection_with_append_only_refence_chain",
          workerV2: "not_comparable_to_invocation_authority",
        }),
        expect.objectContaining({
          fact: "process generation",
          product: "not_source",
          workerV2: "authority_historical",
          physical: "bound_by_current_pidfd_start_executable_tuple",
        }),
      ]),
    );
  });

  test("exact historical asymmetry corroborates Product semantic authority with Worker physical acknowledgement", async () => {
    const fixture = await forensicFixture();
    const worker = await readHistoricalWorkerV2Evidence(fixture.workerLedger);
    const product = await fixture.product.read(HISTORICAL_SETUP_ATTEMPT_ID);
    const environment = await readEnvironmentForensicEvidence(
      fixture.environmentLedger,
      worker,
    );
    const corroborated = validateContainmentEvidence(
      worker,
      product,
      environment,
    );

    expect(product).toMatchObject({
      source: "product_repeatable_read_read_only_transaction",
      state: "cancellation_requested",
      invocationState: "requested",
    });
    expect(product).not.toHaveProperty("backendProcessId");
    expect(product).not.toHaveProperty("processGeneration");
    expect(worker).toMatchObject({
      source: "worker_v2_immutable_snapshot",
      invocationIntent: "login_invocation_requested",
      workerState: "invocation_acknowledged",
      invocationState: "acknowledged",
      cancellationSubmission: "not_submitted",
      historicalPhysicalIdentity: {
        backendProcessId: HISTORICAL_BACKEND_PROCESS_ID,
        processStartIdentity: HISTORICAL_PROCESS_START_IDENTITY,
        processGeneration: HISTORICAL_PROCESS_GENERATION,
        executable: HISTORICAL_EXECUTABLE,
      },
    });
    expect(Object.isFrozen(product)).toBe(true);
    expect(Object.isFrozen(worker)).toBe(true);
    expect(Object.isFrozen(corroborated)).toBe(true);
    expect(Object.isFrozen(corroborated.sharedIdentityMatches)).toBe(true);
    expect(Object.isFrozen(corroborated.generationAuthorityMatches)).toBe(true);
    expect(Object.isFrozen(product.invocationAuthority)).toBe(true);
    expect(Object.isFrozen(worker.invocationAuthority)).toBe(true);
    expect(corroborated).toMatchObject({
      semanticAuthority: { invocationState: "requested" },
      historicalPhysicalEvidence: { invocationState: "acknowledged" },
      sharedIdentityMatches: {
        contractVersion: "historical-containment-shared-identity-v2",
        matchedFields: [...SHARED_IDENTITY_FIELDS],
      },
      generationAuthorityMatches: {
        contractVersion: "historical-containment-generation-authority-v1",
        matchedFields: [
          "invocation_authority_worker_generation",
          "invocation_authority_environment_operation_id",
        ],
      },
    });
    const physical = new FakePhysical([liveObservation()]);
    const result = await dryRun(fixture, physical);
    expect(result.permittedAction).toBe("exact_cancellation");
    expect(physical.inspectionCalls).toBe(1);
    expect(physical.cancellationCalls).toBe(0);
  });

  test.each([
    [
      "acknowledgement",
      {
        state: "invocation_requested",
        invocation_state: "requested",
        process_json: JSON.stringify(processHandle()),
      },
    ],
    [
      "complete process identity",
      {
        state: "invocation_acknowledged",
        invocation_state: "acknowledged",
        process_json: null,
      },
    ],
  ] as const)("Product-valid evidence cannot replace missing Worker %s", async (_name, workerMutation) => {
    const fixture = await forensicFixture();
    mutateWorkerAttempt(fixture.workerLedger, workerMutation);
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "worker_evidence_mismatch",
    });
    expect(physical.inspectionCalls).toBe(0);
    expect(physical.cancellationCalls).toBe(0);
  });

  test("cross-attempt Product evidence is rejected before physical inspection", async () => {
    const fixture = await forensicFixture({
      product: { setup_attempt_id: randomUUID() },
    });
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "product_evidence_mismatch",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test("independently valid cross-account evidence is corroboration_mismatch", async () => {
    const fixture = await forensicFixture({
      product: {
        provider_account_id: "different-account",
        cancellation_event_provider_account_id: "different-account",
        invocation_requested_event: {
          provider_account_id: "different-account",
          setup_generation: 1,
          state: "invocation_requested",
          invocation_state: "requested",
          details: { observed_state: "invocation_requested" },
          occurred_at: invocationTimestamp(),
        },
      },
    });
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "corroboration_mismatch",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test.each([
    [
      "setup generation",
      {
        setup_generation: 99,
        authorization_setup_generation: 99,
        cancellation_event_setup_generation: 99,
        invocation_requested_event: {
          provider_account_id: "historical-account",
          setup_generation: 99,
          state: "invocation_requested",
          invocation_state: "requested",
          details: { observed_state: "invocation_requested" },
          occurred_at: invocationTimestamp(),
        },
      },
    ],
    ["credential generation", { credential_generation: 99 }],
  ] as const)("%s cross-source mismatch is rejected before physical inspection", async (_name, productMutation) => {
    const fixture = await forensicFixture({ product: productMutation });
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "corroboration_mismatch",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test("same invocation-authority generation corroborates without a reconnect projection", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).resolves.toMatchObject({
      permittedAction: "exact_cancellation",
    });
    expect(physical.inspectionCalls).toBe(1);
  });

  test("later Product reconnect projection preserves exact invocation authority", async () => {
    const fixture = await forensicFixture({
      product: productGenerationProjection(
        7,
        "historical-environment-operation",
        [
          generationRefence(8, "reconnected-environment-operation-8", 2),
          generationRefence(9, "reconnected-environment-operation-9", 4),
        ],
      ),
    });
    const physical = new FakePhysical([liveObservation()]);
    const projected = await dryRun(fixture, physical);
    expect(projected.permittedAction).toBe("exact_cancellation");
    const baseline = await forensicFixture();
    const baselineResult = await dryRun(
      baseline,
      new FakePhysical([liveObservation()]),
    );
    expect(projected.targetIdentityDigest).not.toBe(
      baselineResult.targetIdentityDigest,
    );
    expect(physical.inspectionCalls).toBe(1);
  });

  test.each([
    {
      current_worker_generation: 8,
      current_environment_operation_id: "unproven-environment-operation-8",
    },
    productGenerationProjection(7, "historical-environment-operation", [
      generationRefence(9, "skipped-environment-operation-9", 2),
    ]),
  ])("an unproven Product generation projection is rejected before physical inspection", async (product) => {
    const fixture = await forensicFixture({ product });
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "product_evidence_mismatch",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test.each([
    [8, "historical-environment-operation"],
    [7, "different-invocation-environment-operation"],
  ] as const)("wrong invocation authority generation/operation is not accepted as a handoff", async (generation, operationId) => {
    const fixture = await forensicFixture({
      product: productGenerationProjection(generation, operationId, []),
    });
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "worker_generation_handoff_unproven",
    });
    expect(physical.inspectionCalls).toBe(0);
    expect(physical.cancellationCalls).toBe(0);
  });

  test("sanitized retained 1-to-2-to-3 reconnect projection corroborates generation one invocation", async () => {
    const fixture = await forensicFixture({
      product: productGenerationProjection(
        1,
        "c2ae641c-a5b5-4237-9874-9792ac016c59",
        [
          generationRefence(2, "225f7e51-2782-4cf1-9b9c-b6960f2f2110", 2),
          generationRefence(3, "01b87913-f7c7-4f9a-ae13-6e42f98d024f", 4),
        ],
      ),
    });
    mutateWorkerInvocationAuthority(
      fixture.workerLedger,
      1,
      "c2ae641c-a5b5-4237-9874-9792ac016c59",
    );
    const physical = new FakePhysical([liveObservation()]);
    const result = await dryRun(fixture, physical);
    expect(result.permittedAction).toBe("exact_cancellation");
    expect(physical.inspectionCalls).toBe(1);
    expect(physical.cancellationCalls).toBe(0);
  });

  test("authoritative absence records no cancellation, digest, or fabricated exit status", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([
      absentObservation("environment_absent"),
    ]);
    const result = await dryRun(fixture, physical);
    expect(result).toMatchObject({
      permittedAction: "record_authoritative_absence",
      cancellationSubmission: "not_attempted",
      settlement: "terminal",
      targetIdentityDigest: null,
    });
    expect(physical.cancellationCalls).toBe(0);
    const events = journalEvents(fixture);
    expect(events).toContain("target_observed_terminal");
    expect(readJournalDetails(fixture)).toContain(
      '"exit_status":"unavailable"',
    );
  });

  test.each([
    ["PID reused", "pid_reuse"],
    ["start identity differs", "process_start_identity"],
    ["executable differs", "process_executable"],
  ] as const)("%s produces no reviewable physical digest", async (_name, reason) => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([mismatchObservation(reason)]);
    const reviewed = await dryRun(fixture, physical);
    expect(reviewed.targetIdentityDigest).toBeNull();
    expect(reviewed.permittedAction).toBe("none");
    expect(physical.cancellationCalls).toBe(0);
  });

  test("environment incarnation mismatch fails before physical inspection", async () => {
    const fixture = await forensicFixture();
    mutateEnvironment(fixture.environmentLedger, {
      incarnation: "replacement-incarnation",
    });
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "environment_evidence_incompatible",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test("Worker process generation mismatch fails before physical inspection", async () => {
    const fixture = await forensicFixture();
    mutateWorkerProcess(fixture.workerLedger, {
      processGeneration: "replacement-process-generation",
    });
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "worker_evidence_mismatch",
    });
    expect(physical.inspectionCalls).toBe(0);
  });

  test("absent or wrong Product cancellation authority fails closed", async () => {
    for (const product of [
      { cancellation_request_id: null },
      { cancellation_request_id: randomUUID() },
      { cancellation_requested_event_count: 0 },
    ]) {
      const fixture = await forensicFixture({ product });
      const physical = new FakePhysical([liveObservation()]);
      await expect(dryRun(fixture, physical)).rejects.toMatchObject({
        code: "product_evidence_mismatch",
      });
      expect(physical.inspectionCalls).toBe(0);
      expect(physical.cancellationCalls).toBe(0);
    }
  });

  test.each([
    "product_evidence_read_unavailable",
    "product_evidence_missing",
    "product_evidence_mismatch",
  ] as const)("%s short-circuits before every physical access", async (errorCode) => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([liveObservation()]);
    const product: ProductEvidenceReader = {
      read: async () => {
        throw new ContainmentError(errorCode, "Synthetic Product failure.");
      },
      close: async () => undefined,
    };
    await expect(
      runHistoricalContainment(baseOptions(fixture), {
        productEvidence: product,
        physical,
      }),
    ).rejects.toMatchObject({ code: errorCode });
    expect(physical.inspectionCalls).toBe(0);
    expect(physical.cancellationCalls).toBe(0);
    expect(await Bun.file(fixture.journal).exists()).toBe(false);
  });

  test("one journal binds the historical target to one containment operation", async () => {
    const fixture = await forensicFixture();
    const reviewed = await dryRun(
      fixture,
      new FakePhysical([liveObservation()]),
    );
    await expect(
      runHistoricalContainment(
        {
          ...baseOptions(fixture),
          containmentOperationId: randomUUID(),
          confirmPhysicalIdentityDigest: reviewedDigest(reviewed),
        },
        {
          productEvidence: fixture.product,
          physical: new FakePhysical([liveObservation()]),
        },
      ),
    ).rejects.toMatchObject({ code: "containment_journal_conflict" });

    const environment = new Database(fixture.environmentLedger);
    environment
      .query("UPDATE execution_environments SET marker_digest=?")
      .run("c".repeat(64));
    environment.close();
    await expect(
      runHistoricalContainment(
        {
          ...baseOptions(fixture),
          containmentOperationId: randomUUID(),
        },
        {
          productEvidence: fixture.product,
          physical: new FakePhysical([liveObservation()]),
        },
      ),
    ).rejects.toMatchObject({ code: "containment_journal_conflict" });
  });

  test("an existing cancellation intent prevents replay", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([
      liveObservation(),
      absentObservation("process_absent"),
    ]);
    const reviewed = await dryRun(fixture, physical);
    const journal = new ContainmentJournal(fixture.journal);
    expect(
      journal.recordCancellationIntentOnce(fixture.operationId, {
        target_identity_digest: reviewed.targetIdentityDigest,
      }),
    ).toBe(true);
    journal.append(fixture.operationId, "cancellation_acknowledged", {
      submission_certainty: "acknowledged",
    });
    journal.close();
    const result = await execute(
      fixture,
      physical,
      reviewed.targetIdentityDigest,
    );
    expect(result).toMatchObject({
      mode: "reconcile_only",
      cancellationSubmission: "acknowledged",
      settlement: "terminal",
    });
    expect(physical.cancellationCalls).toBe(0);
  });

  test("a previous uncertain cancellation permits read-only reconciliation only", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([liveObservation(), liveObservation()]);
    const reviewed = await dryRun(fixture, physical);
    const journal = new ContainmentJournal(fixture.journal);
    journal.recordCancellationIntentOnce(fixture.operationId, {
      target_identity_digest: reviewed.targetIdentityDigest,
    });
    journal.append(fixture.operationId, "cancellation_uncertain", {
      submission_certainty: "uncertain",
    });
    journal.close();
    const result = await execute(
      fixture,
      physical,
      reviewed.targetIdentityDigest,
    );
    expect(result).toMatchObject({
      mode: "reconcile_only",
      permittedAction: "read_only_reconciliation",
      cancellationSubmission: "uncertain",
    });
    expect(physical.cancellationCalls).toBe(0);
  });

  test("exact cancellation records intent first and submits one signal", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical(
      [
        liveObservation(),
        liveObservation(),
        absentObservation("process_terminal"),
      ],
      { kind: "acknowledged", observedAt: timestamp() },
      () => {
        expect(journalEvents(fixture)).toContain(
          "cancellation_intent_recorded",
        );
      },
    );
    const reviewed = await dryRun(fixture, physical);
    const result = await execute(
      fixture,
      physical,
      reviewed.targetIdentityDigest,
    );
    expect(result).toMatchObject({
      cancellationSubmission: "acknowledged",
      settlement: "terminal",
    });
    expect(journalEvents(fixture)).toContain("cancellation_submitted");
    expect(physical.cancellationCalls).toBe(1);
    const repeated = await execute(
      fixture,
      physical,
      reviewed.targetIdentityDigest,
    );
    expect(repeated.mode).toBe("reconcile_only");
    expect(physical.cancellationCalls).toBe(1);
  });

  test("acknowledged slow settlement never submits a second signal", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical(
      [
        liveObservation(),
        liveObservation(),
        liveObservation(),
        liveObservation(),
      ],
      { kind: "acknowledged", observedAt: timestamp() },
    );
    const reviewed = await dryRun(fixture, physical);
    const result = await execute(
      fixture,
      physical,
      reviewed.targetIdentityDigest,
      { settlementTimeoutMs: 1, settlementPollMs: 1 },
    );
    expect(result.settlement).toBe("unknown");
    expect(physical.cancellationCalls).toBe(1);
    expect(journalEvents(fixture)).toContain("settlement_unknown");
  });

  test("ambiguous cancellation is journaled and never replayed", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical(
      [
        liveObservation(),
        liveObservation(),
        absentObservation("process_absent"),
      ],
      { kind: "uncertain", observedAt: timestamp() },
    );
    const reviewed = await dryRun(fixture, physical);
    const result = await execute(
      fixture,
      physical,
      reviewed.targetIdentityDigest,
    );
    expect(result).toMatchObject({
      cancellationSubmission: "uncertain",
      settlement: "terminal",
    });
    expect(physical.cancellationCalls).toBe(1);
    await execute(fixture, physical, reviewed.targetIdentityDigest);
    expect(physical.cancellationCalls).toBe(1);
  });

  test("dry-run leaves both forensic SQLite inputs byte-identical", async () => {
    const fixture = await forensicFixture();
    const workerBefore = await fileDigest(fixture.workerLedger);
    const environmentBefore = await fileDigest(fixture.environmentLedger);
    await dryRun(fixture, new FakePhysical([liveObservation()]));
    expect(await fileDigest(fixture.workerLedger)).toBe(workerBefore);
    expect(await fileDigest(fixture.environmentLedger)).toBe(environmentBefore);
    expect(fixture.product.reads).toBe(1);
    expect(fixture.product.writes).toBe(0);
  });

  test("SBX controller uses read-only pidfd inspection and one pidfd signal", async () => {
    const target = fixtureTarget();
    const invocations: Array<{ program: string; environment: unknown }> = [];
    const responses = [
      {
        exitCode: 0,
        stdout: JSON.stringify({
          status: "live_exact",
          pidfdOpened: true,
          startIdentity: target.processStartIdentity,
          observedExecutable: target.observedExecutable,
        }),
        stderr: "",
      },
      {
        exitCode: 0,
        stdout: JSON.stringify({ status: "signalled" }),
        stderr: "",
      },
    ];
    const client = {
      executable: "/synthetic/sbx",
      list: async () => [
        {
          id: target.environmentId,
          name: target.environmentDisplayName,
          agent: target.environmentNativeAgent,
          status: "running",
        },
      ],
      exec: async (
        _name: string,
        command: { args: readonly string[]; environment?: unknown },
      ) => {
        invocations.push({
          program: command.args[2] as string,
          environment: command.environment,
        });
        return responses.shift() as (typeof responses)[number];
      },
    } as unknown as SbxClient;
    const controller = new SbxPidfdPhysicalProcessController(client);
    expect(await controller.inspect(target)).toMatchObject({
      kind: "live_exact",
      pidfdOpened: true,
    });
    const operationId = randomUUID();
    expect(await controller.cancelOnce(target, operationId)).toMatchObject({
      kind: "acknowledged",
    });
    expect(invocations[0]?.program).toBe(PIDFD_INSPECTION_PROGRAM);
    expect(invocations[0]?.program).not.toContain("pidfd_send_signal");
    expect(invocations[1]?.program).toBe(PIDFD_CANCELLATION_PROGRAM);
    expect(invocations[1]?.environment).toEqual({
      QE_PID: target.backendProcessId,
      QE_CANCELLATION_ID: operationId,
    });
    expect(invocations[1]?.program.match(/pidfd_send_signal/g)?.length).toBe(1);
    expect(invocations[1]?.program).not.toContain("os.kill");
  });

  test("SBX pidfd inspection classifies kernel PID reuse before cancellation", async () => {
    const target = fixtureTarget();
    let execCalls = 0;
    const client = {
      executable: "/synthetic/sbx",
      list: async () => [
        {
          id: target.environmentId,
          name: target.environmentDisplayName,
          agent: target.environmentNativeAgent,
          status: "running",
        },
      ],
      exec: async () => {
        execCalls += 1;
        return {
          exitCode: 4,
          stdout: JSON.stringify({
            status: "pid_reuse",
            startIdentity: "replacement-start",
            observedExecutable: target.observedExecutable,
          }),
          stderr: "",
        };
      },
    } as unknown as SbxClient;
    const controller = new SbxPidfdPhysicalProcessController(client);
    expect(await controller.inspect(target)).toEqual({
      kind: "identity_mismatch",
      reason: "pid_reuse",
      observedAt: expect.any(String),
    });
    expect(execCalls).toBe(1);
  });

  test("destructive mode rejects a caller digest without this operation's successful dry run", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([liveObservation()]);
    await expect(
      runHistoricalContainment(
        {
          ...baseOptions(fixture),
          executeCancellation: true,
          confirmCancellationRequestId: HISTORICAL_CANCELLATION_REQUEST_ID,
          confirmPhysicalIdentityDigest: `sha256:${"a".repeat(64)}`,
        },
        { productEvidence: fixture.product, physical },
      ),
    ).rejects.toMatchObject({ code: "execution_interlock_failed" });
    expect(physical.inspectionCalls).toBe(0);
    expect(physical.cancellationCalls).toBe(0);
  });

  test("destructive mode requires exact request and reviewed identity digest", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([liveObservation(), liveObservation()]);
    const reviewed = await dryRun(fixture, physical);
    await expect(
      runHistoricalContainment(
        {
          ...baseOptions(fixture),
          executeCancellation: true,
          confirmCancellationRequestId: randomUUID(),
          confirmPhysicalIdentityDigest: reviewedDigest(reviewed),
        },
        { productEvidence: fixture.product, physical },
      ),
    ).rejects.toMatchObject({ code: "execution_interlock_failed" });
    await expect(
      runHistoricalContainment(
        {
          ...baseOptions(fixture),
          executeCancellation: true,
          confirmCancellationRequestId: HISTORICAL_CANCELLATION_REQUEST_ID,
          confirmPhysicalIdentityDigest: `sha256:${"0".repeat(64)}`,
        },
        { productEvidence: fixture.product, physical },
      ),
    ).rejects.toMatchObject({ code: "execution_interlock_failed" });
    expect(physical.cancellationCalls).toBe(0);
  });

  test("CLI defaults to dry-run and rejects generic force", () => {
    const arguments_ = [
      "--worker-v2-ledger",
      "/evidence/worker.sqlite",
      "--environment-ledger",
      "/evidence/environment.sqlite",
      "--containment-journal",
      "/evidence/journal.sqlite",
      "--product-database-url-env",
      "QE_CONTAINMENT_PRODUCT_DATABASE_URL",
      "--product-database-name",
      HISTORICAL_PRODUCT_DATABASE_NAME,
      "--sbx-executable",
      "/usr/local/bin/sbx",
      "--setup-attempt-id",
      HISTORICAL_SETUP_ATTEMPT_ID,
      "--containment-operation-id",
      randomUUID(),
    ];
    expect(parseContainmentArguments(arguments_).executeCancellation).toBe(
      false,
    );
    expect(() => parseContainmentArguments([...arguments_, "--force"])).toThrow(
      "Unknown argument --force",
    );
    expect(() =>
      parseContainmentArguments(
        arguments_.map((value) =>
          value === HISTORICAL_PRODUCT_DATABASE_NAME
            ? "wrong-product-database"
            : value,
        ),
      ),
    ).toThrow("Product database name does not match");
  });

  test.each([
    FAILED_GATE_ONE_OPERATION_ID,
    FAILED_GATE_ONE_RETRY_OPERATION_ID,
  ])("failed Gate-1 operation ID %s cannot be reused", async (operationId) => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([liveObservation()]);
    await expect(
      runHistoricalContainment(
        {
          ...baseOptions(fixture),
          containmentOperationId: operationId,
        },
        { productEvidence: fixture.product, physical },
      ),
    ).rejects.toMatchObject({ code: "invalid_arguments" });
    expect(fixture.product.reads).toBe(0);
    expect(physical.inspectionCalls).toBe(0);
  });

  test("normal Product, server, and Worker code have no forensic containment dependency", async () => {
    for (const [root, pattern] of [
      [join(process.cwd(), "src"), "**/*.ts"],
      [
        join(
          process.cwd(),
          "../../apps/quest_engineering_server/lib/quest_engineering_server",
        ),
        "**/*.ex",
      ],
    ] as const) {
      const glob = new Bun.Glob(pattern);
      for await (const relative of glob.scan({ cwd: root, absolute: true })) {
        const source = await Bun.file(relative).text();
        expect(source).not.toContain("historical-claude-containment");
        expect(source).not.toContain("readHistoricalWorkerV2Evidence");
        expect(source).not.toContain("ReadOnlyProductEvidenceReader");
      }
    }
    const setupStore = await Bun.file(
      join(process.cwd(), "src/provider-account-setup-store.ts"),
    ).text();
    expect(setupStore).not.toMatch(/version\s*===\s*2/);
    expect(setupStore).not.toContain("migrateVersionTwo");
  });

  test("tool has no login, provider-call, terminal, or generic force capability", async () => {
    const glob = new Bun.Glob("*.ts");
    const root = join(
      process.cwd(),
      "tools/forensic/historical-claude-containment",
    );
    let source = "";
    for await (const relative of glob.scan({ cwd: root, absolute: true }))
      source += await Bun.file(relative).text();
    expect(source).not.toContain("claude auth login");
    expect(source).not.toContain("Bun.spawn");
    expect(source).not.toContain("os.kill");
    expect(source).not.toContain("process.kill");
    expect(source).not.toContain("subprocess");
    expect(source).not.toContain("node-pty");
    expect(source).not.toContain("@anthropic-ai");
    expect(source).not.toContain("api.anthropic.com");
    expect(source).not.toContain("/v1/messages");
    expect(source).not.toContain("provider-account-setup-store");
    expect(source).not.toContain("ExecutionEnvironmentStore");

    const productReader = await Bun.file(
      join(root, "product-evidence.ts"),
    ).text();
    expect(productReader).toContain("repeatable read read only");
    expect(productReader).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|ALTER|VACUUM|TRUNCATE)\b/,
    );
  });
});

interface Fixture {
  root: string;
  workerLedger: string;
  environmentLedger: string;
  journal: string;
  operationId: string;
  product: FakeProductReader;
}

async function forensicFixture(
  options: { product?: Record<string, unknown> } = {},
): Promise<Fixture> {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "historical-containment-test-"));
  roots.push(root);
  const workerLedger = join(root, "provider-account-setups-v2.sqlite");
  const environmentLedger = join(root, "execution-environments.sqlite");
  createWorkerLedger(workerLedger);
  createEnvironmentLedger(environmentLedger);
  const product = new FakeProductReader({
    ...productRow(),
    ...options.product,
  });
  return {
    root,
    workerLedger,
    environmentLedger,
    journal: join(root, "containment-journal.sqlite"),
    operationId: randomUUID(),
    product,
  };
}

function createWorkerLedger(path: string): void {
  const database = new Database(path, { create: true });
  database.exec(`
    CREATE TABLE provider_account_setup_attempts(
      setup_attempt_id TEXT PRIMARY KEY,
      command_json TEXT NOT NULL,
      state TEXT NOT NULL,
      invocation_state TEXT NOT NULL,
      process_json TEXT,
      attention_id TEXT,
      preflight_json TEXT,
      validation_json TEXT,
      failure_code TEXT,
      cancellation_request_id TEXT,
      input_delivery_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE provider_account_setup_events(
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      setup_attempt_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      details_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL
    );
    PRAGMA user_version=2;
  `);
  database
    .query(
      `INSERT INTO provider_account_setup_attempts
       (setup_attempt_id,command_json,state,invocation_state,process_json,attention_id,
        preflight_json,validation_json,failure_code,cancellation_request_id,input_delivery_json,
        created_at,updated_at)
       VALUES (?,?, 'invocation_acknowledged','acknowledged',?,NULL,NULL,NULL,
               NULL,NULL,NULL,?,?)`,
    )
    .run(
      HISTORICAL_SETUP_ATTEMPT_ID,
      JSON.stringify(workerCommand()),
      JSON.stringify(processHandle()),
      timestamp(),
      timestamp(),
    );
  for (const eventType of [
    "authorization_accepted",
    "setup_preparing",
    "login_invocation_requested",
    "login_invocation_acknowledged",
  ])
    database
      .query(
        `INSERT INTO provider_account_setup_events
         (setup_attempt_id,event_type,details_json,occurred_at)
         VALUES (?,?,'{}',?)`,
      )
      .run(HISTORICAL_SETUP_ATTEMPT_ID, eventType, timestamp());
  database.close();
}

function createEnvironmentLedger(path: string): void {
  const database = new Database(path, { create: true });
  database.exec(`
    CREATE TABLE execution_environment_schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
    CREATE TABLE execution_environments(
      record_id TEXT PRIMARY KEY,
      backend_kind TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      owner_generation INTEGER,
      display_name TEXT NOT NULL,
      environment_id TEXT,
      incarnation TEXT NOT NULL,
      profile_id TEXT NOT NULL,
      profile_digest TEXT NOT NULL,
      spec_digest TEXT NOT NULL,
      state TEXT NOT NULL,
      creation_token TEXT NOT NULL,
      creator_pid INTEGER NOT NULL,
      marker_digest TEXT,
      native_version TEXT,
      native_revision TEXT,
      native_api_version TEXT,
      native_agent TEXT,
      capabilities_json TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_verified_at TEXT,
      retired_at TEXT
    );
    INSERT INTO execution_environment_schema_migrations(version,applied_at) VALUES (3,'2026-10-15T00:00:00.000Z');
  `);
  database
    .query(
      `INSERT INTO execution_environments
       (record_id,backend_kind,worker_id,owner_type,owner_id,owner_generation,display_name,
        environment_id,incarnation,profile_id,profile_digest,spec_digest,state,creation_token,
        creator_pid,marker_digest,native_version,native_revision,native_api_version,native_agent,
        capabilities_json,diagnostics_json,created_at,updated_at,last_verified_at,retired_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    )
    .run(
      "environment-record",
      "sbx",
      "historical-worker",
      "provider_account",
      "historical-account",
      2,
      "historical-sandbox",
      HISTORICAL_ENVIRONMENT_ID,
      HISTORICAL_ENVIRONMENT_INCARNATION,
      "qe-claude-account-v1",
      `sha256:${"b".repeat(64)}`,
      `sha256:${"c".repeat(64)}`,
      "running",
      randomUUID(),
      100,
      "a".repeat(64),
      "0.1.0",
      "revision",
      "v1",
      "qe-claude-account-v1",
      "[]",
      "[]",
      timestamp(),
      timestamp(),
      timestamp(),
    );
  database.close();
}

function mutateWorkerAttempt(
  path: string,
  mutation: Readonly<{
    state?: string;
    invocation_state?: string;
    process_json?: string | null;
    created_at?: string;
    updated_at?: string;
  }>,
): void {
  const database = new Database(path);
  if (mutation.state !== undefined)
    database
      .query(
        "UPDATE provider_account_setup_attempts SET state=? WHERE setup_attempt_id=?",
      )
      .run(mutation.state, HISTORICAL_SETUP_ATTEMPT_ID);
  if (mutation.invocation_state !== undefined)
    database
      .query(
        "UPDATE provider_account_setup_attempts SET invocation_state=? WHERE setup_attempt_id=?",
      )
      .run(mutation.invocation_state, HISTORICAL_SETUP_ATTEMPT_ID);
  if (mutation.process_json !== undefined)
    database
      .query(
        "UPDATE provider_account_setup_attempts SET process_json=? WHERE setup_attempt_id=?",
      )
      .run(mutation.process_json, HISTORICAL_SETUP_ATTEMPT_ID);
  if (mutation.created_at !== undefined)
    database
      .query(
        "UPDATE provider_account_setup_attempts SET created_at=? WHERE setup_attempt_id=?",
      )
      .run(mutation.created_at, HISTORICAL_SETUP_ATTEMPT_ID);
  if (mutation.updated_at !== undefined)
    database
      .query(
        "UPDATE provider_account_setup_attempts SET updated_at=? WHERE setup_attempt_id=?",
      )
      .run(mutation.updated_at, HISTORICAL_SETUP_ATTEMPT_ID);
  database.close();
}

function mutateWorkerInvocationAuthority(
  path: string,
  generation: number,
  environmentOperationId: string,
): void {
  const database = new Database(path);
  const row = database
    .query(
      "SELECT command_json FROM provider_account_setup_attempts WHERE setup_attempt_id=?",
    )
    .get(HISTORICAL_SETUP_ATTEMPT_ID) as { command_json: string };
  const command = JSON.parse(row.command_json) as ReturnType<
    typeof workerCommand
  >;
  command.connection_generation = generation;
  command.setup.worker_generation = generation;
  command.setup.environment_operation_id = environmentOperationId;
  database
    .query(
      "UPDATE provider_account_setup_attempts SET command_json=? WHERE setup_attempt_id=?",
    )
    .run(JSON.stringify(command), HISTORICAL_SETUP_ATTEMPT_ID);
  database.close();
}

function mutateWorkerProcess(
  path: string,
  mutation: Partial<ReturnType<typeof processHandle>>,
): void {
  const database = new Database(path);
  const row = database
    .query(
      "SELECT process_json FROM provider_account_setup_attempts WHERE setup_attempt_id=?",
    )
    .get(HISTORICAL_SETUP_ATTEMPT_ID) as { process_json: string };
  database
    .query(
      "UPDATE provider_account_setup_attempts SET process_json=? WHERE setup_attempt_id=?",
    )
    .run(
      JSON.stringify({ ...JSON.parse(row.process_json), ...mutation }),
      HISTORICAL_SETUP_ATTEMPT_ID,
    );
  database.close();
}

function mutateEnvironment(
  path: string,
  values: { incarnation?: string },
): void {
  const database = new Database(path);
  if (values.incarnation)
    database
      .query("UPDATE execution_environments SET incarnation=?")
      .run(values.incarnation);
  database.close();
}

function workerCommand() {
  return {
    type: "prepare_provider_account_setup",
    protocol_version: 18,
    worker_id: "historical-worker",
    connection_generation: 7,
    setup: {
      setup_attempt_id: HISTORICAL_SETUP_ATTEMPT_ID,
      provider_account_id: "historical-account",
      setup_generation: 1,
      authorization_id: "historical-authorization",
      authorization_kind: "provider_account_setup",
      authorized_at: timestamp(),
      credential_generation: 2,
      environment_generation: 3,
      worker_generation: 7,
      environment_operation_id: "historical-environment-operation",
      provider_key: "anthropic",
      environment: {
        backend_kind: "sbx",
        environment_id: HISTORICAL_ENVIRONMENT_ID,
        incarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
      },
      authorized_authentication: {
        state: "authentication_required",
        method: "none",
        configuration_identity: "claude-code-2.1.292-subscription-v1",
        environment_policy: "claude-subscription-explicit-environment-v1",
        evidence_identity: "authentication-evidence",
        inspected_at: timestamp(),
      },
      interaction_public_key: "interaction-public-key",
      state: "authorized",
      invocation_state: "not_requested",
      cancellation_request_id: null,
    },
  };
}

function processHandle() {
  return {
    contractVersion: 1,
    backendKind: "sbx",
    environment: {
      backendKind: "sbx",
      environmentId: HISTORICAL_ENVIRONMENT_ID,
      incarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
      workerId: "historical-worker",
      owner: {
        kind: "provider_account",
        providerAccountId: "historical-account",
        credentialGeneration: 2,
      },
      profile: {
        id: "qe-claude-account-v1",
        digest: `sha256:${"b".repeat(64)}`,
      },
    },
    backendProcessId: HISTORICAL_BACKEND_PROCESS_ID,
    processStartIdentity: HISTORICAL_PROCESS_START_IDENTITY,
    processGeneration: HISTORICAL_PROCESS_GENERATION,
    executable: HISTORICAL_EXECUTABLE,
    observedExecutable: HISTORICAL_EXECUTABLE,
  };
}

function productDatabaseIdentity(): ProductDatabaseIdentity {
  return {
    databaseName: HISTORICAL_PRODUCT_DATABASE_NAME,
    schemaName: "public",
    serverLocality: "local",
    serverPort: 5432,
    schemaMigrationVersion: HISTORICAL_PRODUCT_SCHEMA_MIGRATION,
    schemaMigrationCount: HISTORICAL_PRODUCT_SCHEMA_MIGRATION_COUNT,
  };
}

interface SyntheticGenerationRefence {
  workerGeneration: number;
  environmentOperationId: string;
  environmentEventOccurredAt: string;
  setupEventOccurredAt: string;
}

function generationRefence(
  workerGeneration: number,
  environmentOperationId: string,
  second: number,
): SyntheticGenerationRefence {
  return {
    workerGeneration,
    environmentOperationId,
    environmentEventOccurredAt: syntheticAt(second),
    setupEventOccurredAt: syntheticAt(second + 1),
  };
}

function productGenerationProjection(
  authorityGeneration: number,
  authorityEnvironmentOperationId: string,
  refences: readonly SyntheticGenerationRefence[],
): Record<string, unknown> {
  const current = refences.at(-1);
  return {
    current_worker_generation: current?.workerGeneration ?? authorityGeneration,
    current_environment_operation_id:
      current?.environmentOperationId ?? authorityEnvironmentOperationId,
    authority_generation_event: {
      event_type: "environment_ensured",
      worker_id: "historical-worker",
      worker_generation: authorityGeneration,
      environment_operation_id: authorityEnvironmentOperationId,
      credential_generation: 3,
      backend_kind: "sbx",
      environment_id: HISTORICAL_ENVIRONMENT_ID,
      environment_incarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
      physical_state: "available",
      lifecycle_state: "connected",
      details: { report: "credential_free", canary_persisted: true },
      occurred_at: timestamp(),
    },
    environment_generation_refence_chain: refences.map((refence) => ({
      worker_id: "historical-worker",
      worker_generation: refence.workerGeneration,
      environment_operation_id: refence.environmentOperationId,
      credential_generation: 3,
      backend_kind: "sbx",
      environment_id: HISTORICAL_ENVIRONMENT_ID,
      environment_incarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
      physical_state: "available",
      lifecycle_state: "connected",
      details: {},
      occurred_at: refence.environmentEventOccurredAt,
    })),
    setup_generation_refence_chain: refences.map((refence) => ({
      provider_account_id: "historical-account",
      setup_generation: 1,
      state: "invocation_requested",
      invocation_state: "requested",
      details: {},
      occurred_at: refence.setupEventOccurredAt,
    })),
  };
}

function productRow(): Record<string, unknown> {
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
    attempt_auth_inspected_at: timestamp(),
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
      occurred_at: timestamp(),
    },
    authority_generation_event_count: 1,
    invocation_requested_event: {
      provider_account_id: "historical-account",
      setup_generation: 1,
      state: "invocation_requested",
      invocation_state: "requested",
      details: { observed_state: "invocation_requested" },
      occurred_at: invocationTimestamp(),
    },
    invocation_requested_event_count: 1,
    environment_generation_refence_chain: [],
    setup_generation_refence_chain: [],
    backend_kind: "sbx",
    environment_id: HISTORICAL_ENVIRONMENT_ID,
    environment_incarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
    state: "cancellation_requested",
    invocation_state: "requested",
    invocation_requested_at: invocationTimestamp(),
    cancellation_request_id: HISTORICAL_CANCELLATION_REQUEST_ID,
    failure_code: "setup_cancelled",
    authorization_id: "historical-authorization",
    authorization_kind: "provider_account_setup",
    authorization_setup_generation: 1,
    authorization_authorized_at: timestamp(),
    authorization_auth_configuration_identity:
      "claude-code-2.1.292-subscription-v1",
    authorization_auth_environment_policy:
      "claude-subscription-explicit-environment-v1",
    authorization_auth_inspection_identity: "authentication-evidence",
    authorization_auth_inspected_at: timestamp(),
    authorization_count: 1,
    setup_authorized_event_count: 1,
    cancellation_requested_event_count: 1,
    cancellation_event_provider_account_id: "historical-account",
    cancellation_event_setup_generation: 1,
    cancellation_event_state: "cancellation_requested",
    cancellation_event_invocation_state: "requested",
    cancellation_event_occurred_at: cancellationTimestamp(),
    later_semantic_event_count: 0,
    human_attention_count: 0,
  };
}

class FakeProductReader implements ProductEvidenceReader {
  reads = 0;
  writes = 0;

  constructor(private readonly row: Record<string, unknown>) {}

  async read(
    _setupAttemptId = HISTORICAL_SETUP_ATTEMPT_ID,
  ): Promise<ProductSemanticAuthorityEvidence> {
    this.reads += 1;
    return parseProductEvidenceRow(
      structuredClone(this.row),
      productDatabaseIdentity(),
    );
  }

  async close(): Promise<void> {}
}

class FakePhysical implements PhysicalProcessController {
  inspectionCalls = 0;
  cancellationCalls = 0;

  constructor(
    private readonly observations: PhysicalObservation[],
    private readonly submission: CancellationSubmissionResult = {
      kind: "acknowledged",
      observedAt: timestamp(),
    },
    private readonly beforeCancel?: () => void,
  ) {}

  async inspect(): Promise<PhysicalObservation> {
    this.inspectionCalls += 1;
    const observation =
      this.observations.length > 1
        ? this.observations.shift()
        : this.observations[0];
    if (!observation) throw new Error("Missing synthetic observation.");
    return structuredClone(observation);
  }

  async cancelOnce(): Promise<CancellationSubmissionResult> {
    this.beforeCancel?.();
    this.cancellationCalls += 1;
    return structuredClone(this.submission);
  }
}

async function dryRun(fixture: Fixture, physical: FakePhysical) {
  return runHistoricalContainment(baseOptions(fixture), {
    productEvidence: fixture.product,
    physical,
  });
}

async function execute(
  fixture: Fixture,
  physical: FakePhysical,
  identityDigest: string | null,
  bounds: { settlementTimeoutMs?: number; settlementPollMs?: number } = {},
) {
  if (!identityDigest) throw new Error("Test requires one reviewed digest.");
  return runHistoricalContainment(
    {
      ...baseOptions(fixture),
      ...bounds,
      executeCancellation: true,
      confirmCancellationRequestId: HISTORICAL_CANCELLATION_REQUEST_ID,
      confirmPhysicalIdentityDigest: identityDigest,
    },
    { productEvidence: fixture.product, physical },
  );
}

function reviewedDigest(result: {
  targetIdentityDigest: string | null;
}): string {
  if (!result.targetIdentityDigest)
    throw new Error("Test requires one reviewed physical identity digest.");
  return result.targetIdentityDigest;
}

function baseOptions(fixture: Fixture) {
  return {
    workerLedgerPath: fixture.workerLedger,
    environmentLedgerPath: fixture.environmentLedger,
    journalPath: fixture.journal,
    setupAttemptId: HISTORICAL_SETUP_ATTEMPT_ID,
    containmentOperationId: fixture.operationId,
    executeCancellation: false,
  };
}

function liveObservation(): PhysicalObservation {
  return {
    kind: "live_exact",
    environmentStatus: "running",
    pidfdOpened: true,
    observedStartIdentity: HISTORICAL_PROCESS_START_IDENTITY,
    observedExecutable: HISTORICAL_EXECUTABLE,
    observedAt: timestamp(),
  };
}

function absentObservation(
  reason: Extract<PhysicalObservation, { kind: "target_absent" }>["reason"],
): PhysicalObservation {
  return {
    kind: "target_absent",
    reason,
    environmentStatus: reason === "environment_absent" ? null : "running",
    observedAt: timestamp(),
  };
}

function mismatchObservation(
  reason: Extract<PhysicalObservation, { kind: "identity_mismatch" }>["reason"],
): PhysicalObservation {
  return { kind: "identity_mismatch", reason, observedAt: timestamp() };
}

function fixtureTarget(): HistoricalTargetIdentity {
  const handle = processHandle();
  return {
    setupAttemptId: HISTORICAL_SETUP_ATTEMPT_ID,
    cancellationRequestId: HISTORICAL_CANCELLATION_REQUEST_ID,
    authorizationId: "historical-authorization",
    authorizedAt: timestamp(),
    providerAccountId: "historical-account",
    setupGeneration: 1,
    credentialGeneration: 2,
    environmentGeneration: 3,
    invocationWorkerGeneration: 7,
    invocationEnvironmentOperationId: "historical-environment-operation",
    workerId: "historical-worker",
    backendKind: "sbx",
    environmentId: HISTORICAL_ENVIRONMENT_ID,
    environmentIncarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
    environmentDisplayName: "historical-sandbox",
    environmentMarkerDigest: "a".repeat(64),
    environmentNativeAgent: "qe-claude-account-v1",
    profileId: handle.environment.profile.id,
    profileDigest: handle.environment.profile.digest,
    backendProcessId: HISTORICAL_BACKEND_PROCESS_ID,
    processStartIdentity: HISTORICAL_PROCESS_START_IDENTITY,
    processGeneration: HISTORICAL_PROCESS_GENERATION,
    executable: HISTORICAL_EXECUTABLE,
    observedExecutable: HISTORICAL_EXECUTABLE,
    authConfigurationIdentity: "claude-code-2.1.292-subscription-v1",
    authEnvironmentPolicy: "claude-subscription-explicit-environment-v1",
    authEvidenceIdentity: "authentication-evidence",
    authInspectedAt: timestamp(),
  };
}

function journalEvents(fixture: Fixture): string[] {
  const database = new Database(fixture.journal, { readonly: true });
  const events = (
    database
      .query("SELECT event_type FROM containment_events ORDER BY event_id")
      .all() as Array<{ event_type: string }>
  ).map((row) => row.event_type);
  database.close();
  return events;
}

function readJournalDetails(fixture: Fixture): string {
  const database = new Database(fixture.journal, { readonly: true });
  const values = (
    database
      .query("SELECT details_json FROM containment_events ORDER BY event_id")
      .all() as Array<{ details_json: string }>
  ).map((row) => row.details_json);
  database.close();
  return values.join("\n");
}

async function fileDigest(path: string): Promise<string | null> {
  const bytes = await readFile(path).catch(() => null);
  return bytes ? createHash("sha256").update(bytes).digest("hex") : null;
}

function timestamp(): string {
  return syntheticAt(0);
}

function invocationTimestamp(): string {
  return syntheticAt(1);
}

function cancellationTimestamp(): string {
  return syntheticAt(10);
}

function syntheticAt(second: number): string {
  return `2026-10-15T00:00:${String(second).padStart(2, "0")}.000Z`;
}
