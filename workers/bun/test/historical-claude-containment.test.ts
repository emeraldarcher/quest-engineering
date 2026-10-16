import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import type { SbxClient } from "../src/execution-environment/sbx-client.ts";
import { parseContainmentArguments } from "../tools/forensic/historical-claude-containment/cli.ts";
import { readHistoricalWorkerV2Evidence } from "../tools/forensic/historical-claude-containment/evidence.ts";
import { ContainmentJournal } from "../tools/forensic/historical-claude-containment/journal.ts";
import {
  PIDFD_CANCELLATION_PROGRAM,
  PIDFD_INSPECTION_PROGRAM,
  SbxPidfdPhysicalProcessController,
} from "../tools/forensic/historical-claude-containment/physical.ts";
import { runHistoricalContainment } from "../tools/forensic/historical-claude-containment/procedure.ts";
import { parseProductEvidenceRow } from "../tools/forensic/historical-claude-containment/product-evidence.ts";
import {
  type CancellationSubmissionResult,
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
  type ProductCancellationEvidence,
  type ProductEvidenceReader,
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
    expect(evidence.target).toMatchObject({
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
    ).rejects.toMatchObject({ code: "historical_evidence_incompatible" });
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
      expect(evidence.target.setupAttemptId).toBe(HISTORICAL_SETUP_ATTEMPT_ID);
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

  test("authoritative absence records no cancellation and no fabricated exit status", async () => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([
      absentObservation("environment_absent"),
      absentObservation("environment_absent"),
    ]);
    const reviewed = await dryRun(fixture, physical);
    const result = await execute(
      fixture,
      physical,
      reviewed.targetIdentityDigest,
    );
    expect(result).toMatchObject({
      permittedAction: "record_authoritative_absence",
      cancellationSubmission: "not_attempted",
      settlement: "terminal",
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
  ] as const)("%s rejects destructive execution", async (_name, reason) => {
    const fixture = await forensicFixture();
    const physical = new FakePhysical([
      mismatchObservation(reason),
      mismatchObservation(reason),
    ]);
    const reviewed = await dryRun(fixture, physical);
    await expect(
      execute(fixture, physical, reviewed.targetIdentityDigest),
    ).rejects.toMatchObject({ code: "physical_identity_mismatch" });
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

  test("process generation mismatch fails before physical inspection", async () => {
    const fixture = await forensicFixture({
      product: { process_generation: "replacement-process-generation" },
    });
    const physical = new FakePhysical([liveObservation()]);
    await expect(dryRun(fixture, physical)).rejects.toMatchObject({
      code: "cancellation_authority_invalid",
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
      await expect(
        dryRun(fixture, new FakePhysical([liveObservation()])),
      ).rejects.toMatchObject({ code: "cancellation_authority_invalid" });
    }
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
          confirmPhysicalIdentityDigest: reviewed.targetIdentityDigest,
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
          confirmPhysicalIdentityDigest: reviewed.targetIdentityDigest,
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
  });

  test("normal production Worker has no dependency on forensic containment", async () => {
    const glob = new Bun.Glob("**/*.ts");
    for await (const relative of glob.scan({
      cwd: join(process.cwd(), "src"),
      absolute: true,
    })) {
      const source = await Bun.file(relative).text();
      expect(source).not.toContain("historical-claude-containment");
      expect(source).not.toContain("readHistoricalWorkerV2Evidence");
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
    worker_generation: 7,
    environment_operation_id: "historical-environment-operation",
    backend_kind: "sbx",
    environment_id: HISTORICAL_ENVIRONMENT_ID,
    environment_incarnation: HISTORICAL_ENVIRONMENT_INCARNATION,
    state: "cancellation_requested",
    invocation_state: "acknowledged",
    process_backend_id: HISTORICAL_BACKEND_PROCESS_ID,
    process_start_identity: HISTORICAL_PROCESS_START_IDENTITY,
    process_generation: HISTORICAL_PROCESS_GENERATION,
    process_executable: HISTORICAL_EXECUTABLE,
    invocation_requested_at: timestamp(),
    invocation_acknowledged_at: timestamp(),
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
    human_attention_count: 0,
    transaction_read_only: "on",
  };
}

class FakeProductReader implements ProductEvidenceReader {
  reads = 0;
  writes = 0;

  constructor(private readonly row: Record<string, unknown>) {}

  async read(): Promise<ProductCancellationEvidence> {
    this.reads += 1;
    return parseProductEvidenceRow(structuredClone(this.row));
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
  identityDigest: string,
  bounds: { settlementTimeoutMs?: number; settlementPollMs?: number } = {},
) {
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
  return "2026-10-15T00:00:00.000Z";
}
