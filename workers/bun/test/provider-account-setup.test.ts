import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ProviderAccountEnvironmentCommand,
  ProviderAccountEnvironmentManager,
} from "../src/execution-environment/provider-account.ts";
import {
  EnvironmentBackendError,
  type StreamedProcessHandle,
} from "../src/execution-environment/types.ts";
import {
  decodeCancelProviderAccountSetup,
  decodePrepareProviderAccountSetup,
  decodeRespondProviderAccountSetup,
} from "../src/protocol/codec.ts";
import type {
  ProviderAccountSetupCommand,
  RespondProviderAccountSetupCommand,
} from "../src/protocol/types.ts";
import {
  CLAUDE_LOGIN_INTERACTION_IDENTITY,
  ProviderAccountSetupCoordinator,
  type ProviderAccountSetupCoordinatorOptions,
  type ProviderAccountSetupReport,
  recognizeClaudeLoginInteraction,
} from "../src/provider-account-setup.ts";
import {
  PROVIDER_ACCOUNT_SETUP_SCHEMA_VERSION,
  ProviderAccountSetupStore,
} from "../src/provider-account-setup-store.ts";

const roots: string[] = [];
const interactionPublicKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).publicKey.export({ format: "pem", type: "pkcs1" }) as string;
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("ProviderAccount setup", () => {
  test("fresh SQLite bootstraps schema three directly", async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const root = await mkdtemp(join(parent, "provider-account-setup-v3-"));
    roots.push(root);
    const store = new ProviderAccountSetupStore(root);
    store.close();

    const db = new Database(join(root, "provider-account-setups.sqlite"));
    const version = db.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    const columns = (
      db
        .query("PRAGMA table_info(provider_account_setup_attempts)")
        .all() as Array<{
        name: string;
      }>
    ).map((column) => column.name);
    db.close();
    expect(version.user_version).toBe(PROVIDER_ACCOUNT_SETUP_SCHEMA_VERSION);
    expect(columns).toEqual(
      expect.arrayContaining([
        "invocation_worker_generation",
        "invocation_environment_operation_id",
        "cancellation_operation_id",
        "cancellation_invocation_state",
        "cancellation_observation",
        "supervision_failure_code",
      ]),
    );
  });

  test("SQLite rejects schema two unchanged and rejects incomplete schema three", async () => {
    const parent = join(process.cwd(), ".pi", "tmp");
    await mkdir(parent, { recursive: true });
    const staleRoot = await mkdtemp(
      join(parent, "provider-account-setup-stale-"),
    );
    roots.push(staleRoot);
    const stalePath = join(staleRoot, "provider-account-setups.sqlite");
    const stale = new Database(stalePath);
    stale.exec(`
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
      CREATE UNIQUE INDEX provider_account_setup_one_active_per_account
      ON provider_account_setup_attempts(json_extract(command_json,'$.setup.provider_account_id'))
      WHERE state IN ('authorized','preparing','invocation_requested','invocation_acknowledged','human_interaction_required','validating','cancellation_requested');
      CREATE TABLE provider_account_setup_events(
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        setup_attempt_id TEXT NOT NULL REFERENCES provider_account_setup_attempts(setup_attempt_id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
      CREATE INDEX provider_account_setup_events_attempt
      ON provider_account_setup_events(setup_attempt_id,event_id);
      PRAGMA user_version=2;
    `);
    stale
      .query(
        `INSERT INTO provider_account_setup_attempts
         (setup_attempt_id,command_json,state,invocation_state,process_json,attention_id,preflight_json,validation_json,failure_code,cancellation_request_id,input_delivery_json,created_at,updated_at)
         VALUES ('legacy-attempt','{"legacy":"evidence"}','cancellation_requested','acknowledged','{"processGeneration":"legacy-process"}',NULL,NULL,NULL,NULL,'legacy-cancellation',NULL,'2026-10-15T00:00:00.000Z','2026-10-15T00:00:01.000Z')`,
      )
      .run();
    stale.close();
    expect(() => new ProviderAccountSetupStore(staleRoot)).toThrow(
      "schema 2 is stale; expected 3. Recreate Worker state explicitly",
    );
    const preserved = new Database(stalePath);
    const preservedVersion = preserved.query("PRAGMA user_version").get() as {
      user_version: number;
    };
    const preservedColumns = (
      preserved
        .query("PRAGMA table_info(provider_account_setup_attempts)")
        .all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(preservedVersion.user_version).toBe(2);
    expect(preservedColumns).not.toContain("cancellation_operation_id");
    expect(
      preserved
        .query(
          `SELECT setup_attempt_id,command_json,process_json,cancellation_request_id
           FROM provider_account_setup_attempts`,
        )
        .get(),
    ).toEqual({
      setup_attempt_id: "legacy-attempt",
      command_json: '{"legacy":"evidence"}',
      process_json: '{"processGeneration":"legacy-process"}',
      cancellation_request_id: "legacy-cancellation",
    });
    preserved.close();

    const incompleteRoot = await mkdtemp(
      join(parent, "provider-account-setup-incomplete-"),
    );
    roots.push(incompleteRoot);
    const incomplete = new Database(
      join(incompleteRoot, "provider-account-setups.sqlite"),
    );
    incomplete.exec(`
      CREATE TABLE provider_account_setup_attempts(setup_attempt_id TEXT PRIMARY KEY);
      PRAGMA user_version=3;
    `);
    incomplete.close();
    expect(() => new ProviderAccountSetupStore(incompleteRoot)).toThrow(
      "incomplete",
    );
  });

  test("production setup store contains no schema-two conversion path", async () => {
    const source = await Bun.file(
      new URL("../src/provider-account-setup-store.ts", import.meta.url),
    ).text();
    expect(source).not.toContain("migrateVersionTwo");
    expect(source).not.toMatch(/version\s*===\s*2/);
    expect(source).not.toContain("ALTER TABLE provider_account_setup_attempts");
  });

  test("protocol decoder requires exact setup and ephemeral-input fences", async () => {
    const fixture = await setupFixture();
    try {
      expect(
        decodePrepareProviderAccountSetup(
          fixture.setupCommand,
          "worker-setup",
          7,
        ),
      ).toEqual(fixture.setupCommand);
      const waiting = {
        attention: { attention_id: "attention-1" },
        process: { process_generation: "process-1" },
      } as ProviderAccountSetupReport;
      const response = responseCommand(
        fixture.setupCommand,
        waiting,
        "ephemeral-value",
      );
      expect(
        decodeRespondProviderAccountSetup(response, "worker-setup", 7),
      ).toEqual(response);
      expect(() =>
        decodePrepareProviderAccountSetup(
          { ...fixture.setupCommand, unexpected: true },
          "worker-setup",
          7,
        ),
      ).toThrow("unexpected or missing fields");
      expect(() =>
        decodeRespondProviderAccountSetup(
          { ...response, unexpected: true },
          "worker-setup",
          7,
        ),
      ).toThrow("unexpected or missing fields");
      expect(() =>
        decodePrepareProviderAccountSetup(
          {
            ...fixture.setupCommand,
            setup: {
              ...fixture.setupCommand.setup,
              authorized_authentication: {
                ...fixture.setupCommand.setup.authorized_authentication,
                method: "api_key",
              },
            },
          },
          "worker-setup",
          7,
        ),
      ).toThrow("authorized_authentication.method");
      expect(
        decodeCancelProviderAccountSetup(
          {
            type: "cancel_provider_account_setup",
            protocol_version: 19,
            worker_id: "worker-setup",
            connection_generation: 7,
            setup_attempt_id: "setup-attempt-1",
            setup_generation: 1,
            process_generation: null,
            request_id: "cancel-1",
          },
          "worker-setup",
          7,
        ),
      ).toMatchObject({ request_id: "cancel-1" });
      expect(() =>
        decodePrepareProviderAccountSetup(
          fixture.setupCommand,
          "worker-setup",
          8,
        ),
      ).toThrow("connection_generation");
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("runs one exact zero-Run fake login, relays bytes ephemerally, validates, and retains the environment", async () => {
    const fixture = await setupFixture();
    const secretInput = "sensitive-one-time-fake-input";
    try {
      await fixture.coordinator.prepare(fixture.setupCommand);
      const waiting = fixture.reports.at(-1);
      expect(waiting).toMatchObject({
        state: "human_interaction_required",
        invocation_state: "acknowledged",
        credential_generation: 1,
        environment_generation: 1,
      });
      expect(waiting?.ephemeral_output).toMatchObject({
        version: "rsa-oaep-sha256-aes-256-gcm-v1",
      });
      expect(JSON.stringify(waiting?.ephemeral_output)).not.toContain(
        "fake-provider.invalid",
      );
      expect(waiting?.attention?.kind).toBe("provider_authentication");
      expect(fixture.coordinator.authenticated("account-setup", 2, 1)).toBe(
        false,
      );
      const processGeneration = waiting?.process?.process_generation;
      expect(processGeneration).toBeTruthy();

      await fixture.coordinator.respond(
        responseCommand(
          fixture.setupCommand,
          waiting as ProviderAccountSetupReport,
          secretInput,
        ),
      );
      await eventually(() =>
        fixture.reports.some((report) => report.state === "succeeded"),
      );

      const terminal = fixture.reports.at(-1);
      expect(terminal).toMatchObject({
        state: "succeeded",
        invocation_state: "settled",
        validation: { state: "authenticated" },
      });
      expect(terminal?.validation?.evidence_identity).toMatch(
        /^provider-auth-evidence-v1:[a-f0-9]{64}$/,
      );
      expect(fixture.coordinator.authenticated("account-setup", 2, 1)).toBe(
        true,
      );
      fixture.store.transition(
        fixture.setupCommand.setup.setup_attempt_id,
        { state: "uncertain", invocationState: "uncertain" },
        "test_restart_uncertainty",
      );
      expect(fixture.coordinator.authenticated("account-setup", 2, 1)).toBe(
        false,
      );
      expect(fixture.deliveries.map((delivery) => delivery.state)).toEqual([
        "delivery_acknowledged",
      ]);
      expect(
        fixture.store
          .events(fixture.setupCommand.setup.setup_attempt_id)
          .map((event) => event.eventType),
      ).toEqual(
        expect.arrayContaining([
          "authorization_accepted",
          "login_invocation_requested",
          "login_invocation_acknowledged",
          "human_interaction_required",
          "input_delivery_requested",
          "delivery_acknowledged",
          "post_login_validation_requested",
          "post_login_validation_succeeded",
        ]),
      );

      const environment = fixture.manager.reportsFor([
        fixture.environmentCommand,
      ])[0];
      expect(environment).toMatchObject({
        environmentId: fixture.environment.environmentId,
        incarnation: fixture.environment.incarnation,
        physicalState: "available",
        canaryPersisted: true,
      });
      expect(
        fixture.reports.every(
          (report) => !JSON.stringify(report).includes(secretInput),
        ),
      ).toBe(true);

      await fixture.coordinator.close();
      await fixture.manager.close();
      const durableBytes = await readDurableFiles(fixture.root);
      expect(durableBytes).not.toContain(secretInput);
      expect(durableBytes).not.toContain("fake-provider.invalid");
    } finally {
      await fixture.coordinator.close().catch(() => undefined);
      await fixture.manager.close().catch(() => undefined);
    }
  });

  test("post-login validation failure never reports authentication readiness", async () => {
    const fixture = await setupFixture();
    try {
      await fixture.coordinator.prepare(fixture.setupCommand);
      const waiting = fixture.reports.at(-1) as ProviderAccountSetupReport;
      const validateSetup = fixture.manager.validateSetup.bind(fixture.manager);
      fixture.manager.validateSetup = async (identity) => ({
        ...(await validateSetup(identity)),
        state: "authentication_required",
        method: "none",
      });
      await fixture.coordinator.respond(
        responseCommand(fixture.setupCommand, waiting, "invalid-fake-input"),
      );
      await eventually(() =>
        fixture.reports.some((report) => report.state === "failed"),
      );
      expect(fixture.reports.at(-1)).toMatchObject({
        state: "failed",
        invocation_state: "settled",
        validation: { state: "authentication_required", method: "none" },
        failure_code: "setup_validation_failed",
      });
      expect(
        fixture.reports.some(
          (report) => report.validation?.state === "authenticated",
        ),
      ).toBe(false);
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("forbidden, unavailable, incompatible, and already-authenticated preflight physically invoke zero logins", async () => {
    const cases = [
      [
        "forbidden_auth_method",
        "api_key",
        "setup_authentication_method_forbidden",
      ],
      [
        "inspection_unavailable",
        null,
        "setup_authentication_preflight_unavailable",
      ],
      ["incompatible_status", null, "setup_authentication_status_incompatible"],
      [
        "authenticated",
        "provider_account",
        "setup_authentication_already_authenticated",
      ],
    ] as const;

    for (const [state, method, failureCode] of cases) {
      const fixture = await setupFixture({
        fakeAuthentication: () => ({ state, method }),
      });
      try {
        await fixture.coordinator.prepare(fixture.setupCommand);
        expect(fixture.reports.at(-1)).toMatchObject({
          state: "failed",
          invocation_state: "not_requested",
          preflight: { state, method },
          failure_code: failureCode,
          process: null,
        });
        expect(
          fixture.store
            .events(fixture.setupCommand.setup.setup_attempt_id)
            .some((event) => event.eventType === "login_invocation_requested"),
        ).toBe(false);
        expect(
          (fixture.coordinator as unknown as { active: Map<string, unknown> })
            .active.size,
        ).toBe(0);
      } finally {
        await fixture.coordinator.close();
        await fixture.manager.close();
      }
    }
  });

  test("stale authorized evidence is re-inspected and rejected before durable login intent", async () => {
    const fixture = await setupFixture();
    try {
      fixture.setupCommand.setup.authorized_authentication.evidence_identity =
        "provider-auth-evidence-v1:stale";
      await fixture.coordinator.prepare(fixture.setupCommand);
      expect(fixture.reports.at(-1)).toMatchObject({
        state: "failed",
        invocation_state: "not_requested",
        preflight: { state: "authentication_required", method: "none" },
        failure_code: "setup_authentication_preflight_mismatch",
      });
      expect(
        fixture.store
          .events(fixture.setupCommand.setup.setup_attempt_id)
          .some((event) => event.eventType === "login_invocation_requested"),
      ).toBe(false);
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("persists spawn intent before the side effect and never replays a crash-window invocation", async () => {
    const fixture = await setupFixture();
    try {
      let record = fixture.store.accept(fixture.setupCommand);
      record = fixture.store.transition(
        record.setupAttemptId,
        { state: "invocation_requested", invocationState: "requested" },
        "login_invocation_requested",
      );
      expect(record.process).toBeNull();

      await fixture.coordinator.reconcile([fixture.setupCommand]);
      const current = fixture.store.get(record.setupAttemptId);
      expect(current).toMatchObject({
        state: "uncertain",
        invocationState: "uncertain",
        failureCode: "setup_invocation_uncertain",
        process: null,
      });
      expect(
        fixture.store
          .events(record.setupAttemptId)
          .filter((event) => event.eventType === "login_invocation_requested"),
      ).toHaveLength(1);
      expect(fixture.reports.at(-1)?.state).toBe("uncertain");
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("ambiguous spawn/input are terminal and ambiguous cancellation is observed without replay", async () => {
    const spawn = await setupFixture();
    try {
      const beginSetupProcess = spawn.manager.beginSetupProcess.bind(
        spawn.manager,
      );
      spawn.manager.beginSetupProcess = (identity, beforeSpawn) =>
        beginSetupProcess(identity, async (inspection, eligible) => {
          await beforeSpawn(inspection, eligible);
          if (eligible)
            throw new EnvironmentBackendError(
              "injected_failure",
              "ambiguous setup spawn",
              "spawn_streamed",
              "ambiguous",
            );
        });
      await spawn.coordinator.prepare(spawn.setupCommand);
      expect(
        spawn.store.get(spawn.setupCommand.setup.setup_attempt_id),
      ).toMatchObject({
        state: "uncertain",
        invocationState: "uncertain",
        failureCode: "setup_invocation_uncertain",
      });
      await spawn.coordinator.reconcile([spawn.setupCommand]);
      expect(
        spawn.store
          .events(spawn.setupCommand.setup.setup_attempt_id)
          .filter((event) => event.eventType === "login_invocation_requested"),
      ).toHaveLength(1);
    } finally {
      await spawn.coordinator.close();
      await spawn.manager.close();
    }

    const input = await setupFixture();
    try {
      await input.coordinator.prepare(input.setupCommand);
      const waiting = input.reports.at(-1) as ProviderAccountSetupReport;
      activeProcess(input).write = async () => {
        throw new EnvironmentBackendError(
          "streamed_process_write_uncertain",
          "ambiguous setup input",
          "write_streamed",
          "ambiguous",
        );
      };
      await input.coordinator.respond(
        responseCommand(
          input.setupCommand,
          waiting,
          "never-persist-this-input",
        ),
      );
      await eventually(
        () =>
          input.store.get(input.setupCommand.setup.setup_attempt_id)?.state ===
          "uncertain",
      );
      expect(
        input.store.get(input.setupCommand.setup.setup_attempt_id),
      ).toMatchObject({
        state: "uncertain",
        invocationState: "uncertain",
        cancellationInvocationState: "settled",
        cancellationObservation: "exited",
        failureCode: "input_delivery_uncertain",
        inputDelivery: { state: "delivery_uncertain" },
      });
      expect(input.deliveries.map((delivery) => delivery.state)).toEqual([
        "delivery_uncertain",
      ]);
    } finally {
      await input.coordinator.close();
      await input.manager.close();
    }

    const cancellation = await setupFixture(
      {},
      { coordinator: { cancellationSettlementTimeoutMs: 5 } },
    );
    try {
      await cancellation.coordinator.prepare(cancellation.setupCommand);
      let cancellationCalls = 0;
      activeProcess(cancellation).cancel = async () => {
        cancellationCalls += 1;
        throw new EnvironmentBackendError(
          "streamed_process_cancellation_uncertain",
          "ambiguous setup cancellation",
          "cancel_streamed",
          "ambiguous",
        );
      };
      await cancellation.coordinator.cancel({
        type: "cancel_provider_account_setup",
        protocol_version: 19,
        worker_id: cancellation.setupCommand.worker_id,
        connection_generation: cancellation.setupCommand.connection_generation,
        setup_attempt_id: cancellation.setupCommand.setup.setup_attempt_id,
        setup_generation: cancellation.setupCommand.setup.setup_generation,
        process_generation: cancellation.reports.at(-1)?.process
          ?.process_generation as string,
        request_id: "ambiguous-cancel",
      });
      expect(
        cancellation.store.get(
          cancellation.setupCommand.setup.setup_attempt_id,
        ),
      ).toMatchObject({
        state: "cancellation_requested",
        invocationState: "acknowledged",
        cancellationInvocationState: "uncertain",
        cancellationObservation: "running",
      });
      await cancellation.coordinator.cancel({
        type: "cancel_provider_account_setup",
        protocol_version: 19,
        worker_id: cancellation.setupCommand.worker_id,
        connection_generation: cancellation.setupCommand.connection_generation,
        setup_attempt_id: cancellation.setupCommand.setup.setup_attempt_id,
        setup_generation: cancellation.setupCommand.setup.setup_generation,
        process_generation: cancellation.reports.at(-1)?.process
          ?.process_generation as string,
        request_id: "ambiguous-cancel",
      });
      expect(cancellationCalls).toBe(1);
    } finally {
      await cancellation.coordinator.close();
      await cancellation.manager.close();
    }
  });

  test("current generation restart terminates the exact detached older-generation setup without replay", async () => {
    const fixture = await setupFixture();
    try {
      await fixture.coordinator.prepare(fixture.setupCommand);
      expect(fixture.reports.at(-1)?.state).toBe("human_interaction_required");
      const process = activeProcess(fixture);
      const coordinator = fixture.coordinator as unknown as {
        active: Map<string, unknown>;
      };
      coordinator.active.clear();
      const handle = fixture.store.get(
        fixture.setupCommand.setup.setup_attempt_id,
      )?.process;
      if (!handle) throw new Error("Expected a durable setup process handle.");
      let physicallyGone = false;
      fixture.manager.reconcileSetupProcess = async (identity, exact) => {
        expect(identity).toMatchObject({
          workerGeneration: 7,
          environmentOperationId: "environment-operation",
        });
        expect(exact).toEqual(handle);
        return {
          handle,
          process: physicallyGone ? "gone" : "running",
          streamAttachment: "unavailable",
          streamRecovery: "not_recoverable",
        };
      };
      let cancellationCalls = 0;
      fixture.manager.cancelSetupProcess = async (
        identity,
        exact,
        operationId,
      ) => {
        cancellationCalls += 1;
        expect(identity).toMatchObject({
          workerGeneration: 7,
          environmentOperationId: "environment-operation",
        });
        expect(exact).toEqual(handle);
        const receipt = await process.cancel(operationId);
        await process.exit;
        physicallyGone = true;
        return receipt;
      };
      let validations = 0;
      fixture.manager.validateSetup = async () => {
        validations += 1;
        throw new Error("validation must not run after stream loss");
      };

      await fixture.coordinator.reconcile([
        {
          ...fixture.setupCommand,
          connection_generation: 8,
          setup: {
            ...fixture.setupCommand.setup,
            worker_generation: 8,
            environment_operation_id: "reconciled-environment-operation",
            invocation_worker_generation: 7,
            invocation_environment_operation_id: "environment-operation",
            state: "human_interaction_required",
            invocation_state: "acknowledged",
          },
        },
      ]);
      expect(fixture.reports.at(-1)).toMatchObject({
        worker_generation: 8,
        environment_operation_id: "reconciled-environment-operation",
        invocation_worker_generation: 7,
        invocation_environment_operation_id: "environment-operation",
        state: "failed",
        invocation_state: "settled",
        failure_code: "setup_process_lost",
      });
      expect(
        fixture.reports.filter(
          (report) => report.state === "invocation_requested",
        ),
      ).toHaveLength(1);
      expect(cancellationCalls).toBe(1);
      expect(validations).toBe(0);
    } finally {
      await fixture.manager.close();
      await Bun.sleep(10);
      await fixture.coordinator.close();
    }
  });

  test("fresh Worker state never replays Product-acknowledged setup without a process handle", async () => {
    const fixture = await setupFixture();
    try {
      let retired = 0;
      fixture.manager.retireSetupProcesses = async () => {
        retired += 1;
      };
      const acknowledged: ProviderAccountSetupCommand = {
        ...fixture.setupCommand,
        setup: {
          ...fixture.setupCommand.setup,
          state: "human_interaction_required",
          invocation_state: "acknowledged",
        },
      };
      await fixture.coordinator.reconcile([acknowledged]);
      expect(
        fixture.store.get(acknowledged.setup.setup_attempt_id),
      ).toMatchObject({
        state: "uncertain",
        invocationState: "uncertain",
        process: null,
        failureCode: "setup_process_lost",
      });
      expect(
        fixture.store
          .events(acknowledged.setup.setup_attempt_id)
          .some((event) => event.eventType === "login_invocation_requested"),
      ).toBe(false);
      expect(retired).toBe(1);
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("cancels the exact acknowledged process once and rejects stale interaction input", async () => {
    const fixture = await setupFixture();
    try {
      await fixture.coordinator.prepare(fixture.setupCommand);
      const waiting = fixture.reports.at(-1) as ProviderAccountSetupReport;
      await expect(
        fixture.coordinator.respond({
          ...responseCommand(fixture.setupCommand, waiting, "ignored"),
          process_generation: "stale-process-generation",
        }),
      ).rejects.toThrow("stale");
      await expect(
        fixture.coordinator.respond({
          ...responseCommand(fixture.setupCommand, waiting, "ignored"),
          attention_id: "stale-attention",
        }),
      ).rejects.toThrow("stale");

      await fixture.coordinator.cancel({
        type: "cancel_provider_account_setup",
        protocol_version: 19,
        worker_id: fixture.setupCommand.worker_id,
        connection_generation: fixture.setupCommand.connection_generation,
        setup_attempt_id: fixture.setupCommand.setup.setup_attempt_id,
        setup_generation: fixture.setupCommand.setup.setup_generation,
        process_generation: null,
        request_id: "cancel-1",
      });
      await eventually(() =>
        fixture.reports.some((report) => report.state === "cancelled"),
      );
      expect(
        fixture.store.get(fixture.setupCommand.setup.setup_attempt_id),
      ).toMatchObject({
        state: "cancelled",
        invocationState: "settled",
        cancellationRequestId: "cancel-1",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("registers process supervision before an invocation acknowledgement report can fail", async () => {
    const fixture = await setupFixture(
      {},
      { rejectReportState: "invocation_acknowledged" },
    );
    try {
      await expect(
        fixture.coordinator.prepare(fixture.setupCommand),
      ).rejects.toThrow("control-plane report rejection");
      const process = activeProcess(fixture);
      expect(process).toBeDefined();
      const acknowledged = fixture.store.get(
        fixture.setupCommand.setup.setup_attempt_id,
      );
      expect(acknowledged).toMatchObject({
        state: "invocation_acknowledged",
        invocationState: "acknowledged",
      });

      await fixture.coordinator.cancel({
        type: "cancel_provider_account_setup",
        protocol_version: 19,
        worker_id: fixture.setupCommand.worker_id,
        connection_generation: fixture.setupCommand.connection_generation,
        setup_attempt_id: fixture.setupCommand.setup.setup_attempt_id,
        setup_generation: fixture.setupCommand.setup.setup_generation,
        process_generation: acknowledged?.process?.processGeneration as string,
        request_id: "cancel-after-report-loss",
      });
      await eventually(
        () =>
          fixture.store.get(fixture.setupCommand.setup.setup_attempt_id)
            ?.state === "cancelled",
      );
      expect(
        fixture.store
          .events(fixture.setupCommand.setup.setup_attempt_id)
          .map((event) => event.eventType),
      ).toContain("cancellation_invocation_acknowledged");
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("a rejected cancellation report cannot prevent or ambiguate physical settlement", async () => {
    const fixture = await setupFixture(
      {},
      { rejectReportState: "cancellation_requested" },
    );
    try {
      await fixture.coordinator.prepare(fixture.setupCommand);
      const processGeneration = fixture.store.get(
        fixture.setupCommand.setup.setup_attempt_id,
      )?.process?.processGeneration;
      await expect(
        fixture.coordinator.cancel({
          type: "cancel_provider_account_setup",
          protocol_version: 19,
          worker_id: fixture.setupCommand.worker_id,
          connection_generation: fixture.setupCommand.connection_generation,
          setup_attempt_id: fixture.setupCommand.setup.setup_attempt_id,
          setup_generation: fixture.setupCommand.setup.setup_generation,
          process_generation: processGeneration as string,
          request_id: "cancel-with-report-loss",
        }),
      ).rejects.toThrow("control-plane report rejection");
      await eventually(
        () =>
          fixture.store.get(fixture.setupCommand.setup.setup_attempt_id)
            ?.state === "cancelled",
      );
      expect(
        fixture.store.get(fixture.setupCommand.setup.setup_attempt_id),
      ).toMatchObject({
        state: "cancelled",
        cancellationInvocationState: "settled",
        cancellationObservation: "exited",
      });
      expect(
        fixture.store
          .events(fixture.setupCommand.setup.setup_attempt_id)
          .filter(
            (event) => event.eventType === "cancellation_invocation_requested",
          ),
      ).toHaveLength(1);
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("restart-safe cancellation revalidates and physically settles one exact detached process", async () => {
    const fixture = await setupFixture();
    try {
      await fixture.coordinator.prepare(fixture.setupCommand);
      const process = activeProcess(fixture) as ReturnType<
        typeof activeProcess
      > & { exit: Promise<unknown>; handle: StreamedProcessHandle };
      const durable = fixture.store.get(
        fixture.setupCommand.setup.setup_attempt_id,
      );
      if (!durable?.process)
        throw new Error("Expected exact process identity.");
      const durableProcess = durable.process;
      const coordinator = fixture.coordinator as unknown as {
        active: Map<string, unknown>;
      };
      coordinator.active.clear();

      let cancellationCalls = 0;
      let physicallyGone = false;
      fixture.manager.reconcileSetupProcess = async (identity, handle) => {
        expect(identity).toMatchObject({
          setupAttemptId: fixture.setupCommand.setup.setup_attempt_id,
          setupGeneration: fixture.setupCommand.setup.setup_generation,
          providerAccountId: fixture.setupCommand.setup.provider_account_id,
          environmentGeneration:
            fixture.setupCommand.setup.environment_generation,
          backendKind: fixture.setupCommand.setup.environment.backend_kind,
          environmentId: fixture.setupCommand.setup.environment.environment_id,
          environmentIncarnation:
            fixture.setupCommand.setup.environment.incarnation,
        });
        expect(handle).toEqual(durableProcess);
        return {
          handle,
          process: physicallyGone ? "gone" : "running",
          streamAttachment: "unavailable",
          streamRecovery: "not_recoverable",
        };
      };
      fixture.manager.cancelSetupProcess = async (
        identity,
        handle,
        operationId,
      ) => {
        cancellationCalls += 1;
        expect(identity.setupAttemptId).toBe(
          fixture.setupCommand.setup.setup_attempt_id,
        );
        expect(handle).toEqual(durableProcess);
        const receipt = await process.cancel(operationId);
        await process.exit;
        physicallyGone = true;
        return receipt;
      };

      await fixture.coordinator.cancel({
        type: "cancel_provider_account_setup",
        protocol_version: 19,
        worker_id: fixture.setupCommand.worker_id,
        connection_generation: fixture.setupCommand.connection_generation,
        setup_attempt_id: fixture.setupCommand.setup.setup_attempt_id,
        setup_generation: fixture.setupCommand.setup.setup_generation,
        process_generation: durableProcess.processGeneration,
        request_id: "detached-exact-cancel",
      });
      expect(cancellationCalls).toBe(1);
      expect(
        fixture.store.get(fixture.setupCommand.setup.setup_attempt_id),
      ).toMatchObject({
        state: "cancelled",
        cancellationInvocationState: "settled",
        cancellationObservation: "gone",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("no recognized output expires discovery and physically terminates", async () => {
    const fixture = await setupFixture(
      {},
      { coordinator: { interactionDiscoveryTimeoutMs: 5 } },
    );
    try {
      const beginSetupProcess = fixture.manager.beginSetupProcess.bind(
        fixture.manager,
      );
      fixture.manager.beginSetupProcess = async (identity, beforeSpawn) => {
        const beginning = await beginSetupProcess(identity, beforeSpawn);
        if (!beginning.process) return beginning;
        const process = beginning.process;
        const stdout = (async function* () {
          for await (const event of process.stdout)
            if (event.kind !== "data") yield event;
        })();
        return { ...beginning, process: { ...process, stdout } };
      };

      await fixture.coordinator.prepare(fixture.setupCommand);
      await eventually(
        () =>
          fixture.store.get(fixture.setupCommand.setup.setup_attempt_id)
            ?.state === "failed",
      );
      expect(
        fixture.store.get(fixture.setupCommand.setup.setup_attempt_id),
      ).toMatchObject({
        state: "failed",
        cancellationInvocationState: "settled",
        cancellationObservation: "exited",
        failureCode: "setup_interaction_discovery_timed_out",
      });
      expect(
        fixture.reports.some(
          (report) => report.state === "human_interaction_required",
        ),
      ).toBe(false);
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("human-completion expiry physically terminates before reporting failure", async () => {
    const fixture = await setupFixture(
      {},
      { coordinator: { humanCompletionTimeoutMs: 5 } },
    );
    try {
      await fixture.coordinator.prepare(fixture.setupCommand);
      await eventually(
        () =>
          fixture.store.get(fixture.setupCommand.setup.setup_attempt_id)
            ?.state === "failed",
      );
      expect(
        fixture.store.get(fixture.setupCommand.setup.setup_attempt_id),
      ).toMatchObject({
        state: "failed",
        invocationState: "settled",
        cancellationInvocationState: "settled",
        cancellationObservation: "exited",
        failureCode: "setup_human_completion_timed_out",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("recognizes only the pinned Claude 2.1.292 manual OAuth framing", () => {
    const url = new URL("https://claude.com/cai/oauth/authorize");
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    url.searchParams.set("response_type", "code");
    url.searchParams.set(
      "redirect_uri",
      "https://platform.claude.com/oauth/code/callback",
    );
    url.searchParams.set(
      "scope",
      "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins",
    );
    url.searchParams.set("code_challenge", "c".repeat(43));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", "s".repeat(43));
    const prefix =
      "Opening browser to sign in…\nIf the browser didn't open, visit: ";
    const interaction = `${prefix}${url.toString()}\nPaste code here if prompted > `;
    let streamed = "";
    for (const chunk of [
      "Opening browser ",
      "to sign in…\nIf the browser didn't open, visit: ",
      url.toString().slice(0, 30),
      url.toString().slice(30),
      "\nPaste code here if prompted > ",
    ]) {
      streamed += chunk;
      const recognized = recognizeClaudeLoginInteraction(streamed);
      if (streamed === interaction) expect(recognized).toBe(interaction);
      else expect(recognized).toBeNull();
    }
    expect(recognizeClaudeLoginInteraction(interaction)).toBe(interaction);
    expect(() =>
      recognizeClaudeLoginInteraction(
        interaction.replace("https://claude.com", "https://example.invalid"),
      ),
    ).toThrow(CLAUDE_LOGIN_INTERACTION_IDENTITY);
    expect(() =>
      recognizeClaudeLoginInteraction(
        interaction.replace(
          `&state=${"s".repeat(43)}`,
          `&state=${"s".repeat(43)}&state=replacement`,
        ),
      ),
    ).toThrow(CLAUDE_LOGIN_INTERACTION_IDENTITY);
    expect(() =>
      recognizeClaudeLoginInteraction(
        interaction.replace(
          "scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload+user%3Aplugins",
          "scope=user%3Aprofile",
        ),
      ),
    ).toThrow(CLAUDE_LOGIN_INTERACTION_IDENTITY);
    expect(() =>
      recognizeClaudeLoginInteraction(
        `\u001b]8;;${url.toString()}\u0007${interaction}`,
      ),
    ).toThrow(CLAUDE_LOGIN_INTERACTION_IDENTITY);
    expect(() =>
      recognizeClaudeLoginInteraction(`${interaction}\u001b]0;decorated\u0007`),
    ).toThrow(CLAUDE_LOGIN_INTERACTION_IDENTITY);
    expect(() => recognizeClaudeLoginInteraction("unversioned prompt")).toThrow(
      CLAUDE_LOGIN_INTERACTION_IDENTITY,
    );
  });

  test("schema three preserves invocation identity across control-generation reconciliation", async () => {
    const fixture = await setupFixture();
    try {
      let record = fixture.store.accept(fixture.setupCommand);
      record = fixture.store.transition(
        record.setupAttemptId,
        {
          state: "invocation_requested",
          invocationState: "requested",
          invocationWorkerGeneration:
            fixture.setupCommand.setup.worker_generation,
          invocationEnvironmentOperationId:
            fixture.setupCommand.setup.environment_operation_id,
        },
        "login_invocation_requested",
      );
      fixture.store.accept({
        ...fixture.setupCommand,
        connection_generation: 8,
        setup: {
          ...fixture.setupCommand.setup,
          worker_generation: 8,
          environment_operation_id: "reconciled-environment-operation",
        },
      });
      expect(fixture.store.get(record.setupAttemptId)).toMatchObject({
        command: {
          connection_generation: 8,
          setup: {
            worker_generation: 8,
            environment_operation_id: "reconciled-environment-operation",
          },
        },
        invocationWorkerGeneration: 7,
        invocationEnvironmentOperationId: "environment-operation",
      });
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("current routing generation reconciles and cancels one exact older-generation invocation", async () => {
    const fixture = await setupFixture();
    try {
      await fixture.coordinator.prepare(fixture.setupCommand);
      const waiting = fixture.reports.at(-1) as ProviderAccountSetupReport;
      expect(waiting).toMatchObject({
        worker_generation: 7,
        environment_operation_id: "environment-operation",
        invocation_worker_generation: 7,
        invocation_environment_operation_id: "environment-operation",
        state: "human_interaction_required",
        invocation_state: "acknowledged",
      });

      const currentCommand: ProviderAccountSetupCommand = {
        ...fixture.setupCommand,
        connection_generation: 8,
        setup: {
          ...fixture.setupCommand.setup,
          worker_generation: 8,
          environment_operation_id: "reconciled-environment-operation",
          invocation_worker_generation: 7,
          invocation_environment_operation_id: "environment-operation",
          state: "human_interaction_required",
          invocation_state: "acknowledged",
        },
      };
      expect(
        decodePrepareProviderAccountSetup(currentCommand, "worker-setup", 8),
      ).toEqual(currentCommand);

      await fixture.coordinator.reconcile([currentCommand]);
      const reconciled = fixture.reports.at(-1);
      expect(reconciled).toMatchObject({
        worker_generation: 8,
        environment_operation_id: "reconciled-environment-operation",
        invocation_worker_generation: 7,
        invocation_environment_operation_id: "environment-operation",
        process: waiting.process,
        state: "human_interaction_required",
      });

      await expect(
        fixture.coordinator.cancel({
          type: "cancel_provider_account_setup",
          protocol_version: 19,
          worker_id: currentCommand.worker_id,
          connection_generation: 7,
          setup_attempt_id: currentCommand.setup.setup_attempt_id,
          setup_generation: currentCommand.setup.setup_generation,
          process_generation: waiting.process?.process_generation as string,
          request_id: "stale-routing-cancel",
        }),
      ).rejects.toThrow("stale");

      await fixture.coordinator.cancel({
        type: "cancel_provider_account_setup",
        protocol_version: 19,
        worker_id: currentCommand.worker_id,
        connection_generation: 8,
        setup_attempt_id: currentCommand.setup.setup_attempt_id,
        setup_generation: currentCommand.setup.setup_generation,
        process_generation: waiting.process?.process_generation as string,
        request_id: "current-routing-cancel",
      });
      await eventually(
        () =>
          fixture.store.get(currentCommand.setup.setup_attempt_id)?.state ===
          "cancelled",
      );
      const cancelled = fixture.reports.at(-1);
      expect(cancelled).toMatchObject({
        worker_generation: 8,
        invocation_worker_generation: 7,
        state: "cancelled",
        invocation_state: "settled",
      });

      await fixture.coordinator.reconcile([currentCommand]);
      expect(fixture.reports.at(-1)).toMatchObject({
        worker_generation: 8,
        invocation_worker_generation: 7,
        state: "cancelled",
      });
      expect(
        fixture.store
          .events(currentCommand.setup.setup_attempt_id)
          .filter(
            (event) => event.eventType === "cancellation_invocation_requested",
          ),
      ).toHaveLength(1);
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });

  test("serializes one active attempt per account while allowing distinct accounts", async () => {
    const fixture = await setupFixture();
    try {
      fixture.store.accept(fixture.setupCommand);
      expect(() =>
        fixture.store.accept({
          ...fixture.setupCommand,
          setup: {
            ...fixture.setupCommand.setup,
            setup_attempt_id: "setup-second",
            setup_generation: 2,
            authorization_id: "authorization-second",
          },
        }),
      ).toThrow();

      const otherEnvironment = await fixture.manager.apply({
        ...fixture.environmentCommand,
        providerAccountId: "account-other",
        operationId: "environment-other",
      });
      expect(() =>
        fixture.store.accept({
          ...fixture.setupCommand,
          setup: {
            ...fixture.setupCommand.setup,
            setup_attempt_id: "setup-other",
            provider_account_id: "account-other",
            authorization_id: "authorization-other",
            environment_operation_id: "environment-other",
            environment: {
              backend_kind: otherEnvironment.backendKind as string,
              environment_id: otherEnvironment.environmentId as string,
              incarnation: otherEnvironment.incarnation as string,
            },
          },
        }),
      ).not.toThrow();
    } finally {
      await fixture.coordinator.close();
      await fixture.manager.close();
    }
  });
});

function activeProcess(fixture: Awaited<ReturnType<typeof setupFixture>>) {
  const coordinator = fixture.coordinator as unknown as {
    active: Map<
      string,
      {
        process: {
          write: (value: Uint8Array) => Promise<unknown>;
          cancel: (cancellationId?: string) => Promise<{
            certainty: "acknowledged";
            cancellationId: string;
          }>;
          exit: Promise<unknown>;
          handle: StreamedProcessHandle;
        };
      }
    >;
  };
  const active = coordinator.active.get(
    fixture.setupCommand.setup.setup_attempt_id,
  );
  if (!active) throw new Error("Expected an active setup process.");
  return active.process;
}

async function setupFixture(
  options: ConstructorParameters<
    typeof ProviderAccountEnvironmentManager
  >[1] = {},
  fixtureOptions: {
    rejectReportState?: ProviderAccountSetupReport["state"];
    coordinator?: ProviderAccountSetupCoordinatorOptions;
  } = {},
) {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "provider-account-setup-"));
  roots.push(root);
  const manager = new ProviderAccountEnvironmentManager(
    { workerId: "worker-setup", dataRoot: root, provider: "fake" },
    { ...options, fake: true },
  );
  const environmentCommand: ProviderAccountEnvironmentCommand = {
    providerAccountId: "account-setup",
    providerKey: "fake-provider",
    credentialGeneration: 1,
    workerGeneration: 7,
    operationId: "environment-operation",
    desiredState: "available",
    expectedPhysicalIdentity: null,
  };
  const environment = await manager.apply(environmentCommand);
  const setupCommand: ProviderAccountSetupCommand = {
    type: "prepare_provider_account_setup",
    protocol_version: 19,
    worker_id: "worker-setup",
    connection_generation: 7,
    setup: {
      setup_attempt_id: "setup-attempt-1",
      provider_account_id: "account-setup",
      setup_generation: 1,
      authorization_id: "authorization-1",
      authorization_kind: "provider_account_setup",
      authorized_at: "2026-10-15T00:00:00.000Z",
      credential_generation: 1,
      environment_generation: 1,
      worker_generation: 7,
      environment_operation_id: environmentCommand.operationId,
      invocation_worker_generation: null,
      invocation_environment_operation_id: null,
      provider_key: "fake-provider",
      environment: {
        backend_kind: environment.backendKind as string,
        environment_id: environment.environmentId as string,
        incarnation: environment.incarnation as string,
      },
      authorized_authentication: {
        state: "authentication_required",
        method: "none",
        configuration_identity: environment.authentication
          ?.configurationIdentity as string,
        environment_policy: environment.authentication
          ?.environmentPolicy as string,
        evidence_identity: environment.authentication
          ?.evidenceIdentity as string,
        inspected_at: environment.authentication?.inspectedAt as string,
      },
      interaction_public_key: interactionPublicKey,
      state: "authorized",
      invocation_state: "not_requested",
      cancellation_request_id: null,
    },
  };
  const reports: ProviderAccountSetupReport[] = [];
  const deliveries: Array<{ state: string }> = [];
  const store = new ProviderAccountSetupStore(root);
  const coordinator = new ProviderAccountSetupCoordinator(
    store,
    manager,
    async (report) => {
      reports.push(structuredClone(report));
      if (report.state === fixtureOptions.rejectReportState)
        throw new Error("injected control-plane report rejection");
    },
    async (delivery) => {
      deliveries.push(structuredClone(delivery));
    },
    undefined,
    fixtureOptions.coordinator,
  );
  return {
    root,
    manager,
    environment,
    environmentCommand,
    setupCommand,
    reports,
    deliveries,
    store,
    coordinator,
  };
}

function responseCommand(
  setup: ProviderAccountSetupCommand,
  waiting: ProviderAccountSetupReport,
  value: string,
): RespondProviderAccountSetupCommand {
  return {
    type: "respond_provider_account_setup",
    protocol_version: 19,
    worker_id: setup.worker_id,
    connection_generation: setup.connection_generation,
    setup_attempt_id: setup.setup.setup_attempt_id,
    setup_generation: setup.setup.setup_generation,
    attention_id: waiting.attention?.attention_id as string,
    process_generation: waiting.process?.process_generation as string,
    request_generation: 1,
    delivery_attempt_id: "delivery-1",
    value,
  };
}

async function eventually(check: () => boolean, attempts = 100): Promise<void> {
  for (let index = 0; index < attempts; index += 1) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error("Condition did not converge.");
}

async function readDurableFiles(root: string): Promise<string> {
  const names = await readdir(root);
  const files = names.filter(
    (name) => name.endsWith(".sqlite") || name.includes(".sqlite-"),
  );
  const buffers = await Promise.all(
    files.map((name) => readFile(join(root, name))),
  );
  return Buffer.concat(buffers).toString("utf8");
}
