import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import { HarnessSetupCoordinator } from "../src/harness-setup.ts";
import { HarnessSetupStore } from "../src/harness-setup-store.ts";
import { FakeHarness } from "../src/harnesses/fake/adapter.ts";
import { HarnessRegistry } from "../src/harnesses/registry.ts";
import {
  type PrepareHarnessSetupCommand,
  WORKER_PROTOCOL_VERSION,
} from "../src/protocol/types.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("setup is durable, idempotent, generation-fenced, and becomes exact execution evidence", async () => {
  const fixture = await coordinatorFixture();
  const reports: Array<{ state: string; ephemeral?: string }> = [];
  fixture.setReporter((record, ephemeral) => {
    reports.push({ state: record.state, ...(ephemeral ? { ephemeral } : {}) });
  });

  await fixture.coordinator.prepare(fixture.command);
  expect(fixture.store.get("setup-1").state).toBe("human_interaction_required");
  expect(fixture.store.get("setup-1").invocationState).toBe("acknowledged");
  expect(reports.map((item) => item.state)).toEqual([
    "preparing",
    "invocation_requested",
    "invocation_acknowledged",
    "human_interaction_required",
  ]);
  expect(reports.at(-1)?.ephemeral).toContain("no provider process");
  expect(JSON.stringify(fixture.store.get("setup-1"))).not.toContain(
    "no provider process",
  );

  await fixture.coordinator.prepare(fixture.command);
  expect(fixture.store.get("setup-1").state).toBe("human_interaction_required");

  await expect(
    fixture.coordinator.respond({
      type: "respond_harness_setup",
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: "worker-1",
      connection_generation: 1,
      setup_id: "setup-1",
      setup_generation: 2,
      attention_id: "fake-setup-setup-1-1",
      request_id: "stale-response",
      value: "continue",
    }),
  ).rejects.toThrow("stale");

  const response = {
    type: "respond_harness_setup" as const,
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-1",
    connection_generation: 1,
    setup_id: "setup-1",
    setup_generation: 1,
    attention_id: "fake-setup-setup-1-1",
    request_id: "response-1",
    value: "provider-secret-response-must-not-be-durable",
  };
  await fixture.coordinator.respond(response);
  await eventually(() => fixture.store.get("setup-1").state === "ready");

  const record = fixture.store.get("setup-1");
  expect(record.inspection?.authenticated).toBe(true);
  await expect(fixture.coordinator.respond(response)).resolves.toBeUndefined();
  expect(() =>
    fixture.store.claimResponse(
      "setup-1",
      1,
      "conflicting-response",
      "fake-setup-setup-1-1",
    ),
  ).toThrow("identity conflicts");
  reports.length = 0;
  await fixture.coordinator.prepare(fixture.command);
  expect(fixture.store.get("setup-1").state).toBe("ready");
  expect(reports.map((item) => item.state)).toEqual(["ready"]);
  const environment = record.inspection?.environment;
  expect(environment).not.toBeNull();
  if (!environment || !record.inspection?.configIdentity)
    throw new Error("ready setup evidence missing");
  const binding = {
    setup_id: "setup-1",
    setup_generation: 1,
    physical_lineage_id: "physical-1",
    environment: {
      environment_id: environment.environmentId,
      incarnation: environment.incarnation,
      profile: environment.profile,
    },
    config_identity: record.inspection.configIdentity,
  };
  expect(() =>
    fixture.coordinator.assertExecutionBinding({
      action_id: "action-1",
      run_id: "run-1",
      occurrence_id: "occurrence-1",
      execution: {
        context: {
          mode: "fresh",
          source_occurrence_id: null,
          logical_lineage_id: "logical-1",
        },
      },
      harness_setup: binding,
    }),
  ).not.toThrow();
  expect(() =>
    fixture.coordinator.assertExecutionBinding({
      action_id: "action-1",
      run_id: "another-run",
      occurrence_id: "occurrence-1",
      execution: {
        context: {
          mode: "fresh",
          source_occurrence_id: null,
          logical_lineage_id: "logical-1",
        },
      },
      harness_setup: binding,
    }),
  ).toThrow("stale or incompatible");
  expect(() =>
    fixture.coordinator.assertExecutionBinding({
      action_id: "unrelated-action",
      run_id: "run-1",
      occurrence_id: "unrelated-occurrence",
      execution: {
        context: {
          mode: "fresh",
          source_occurrence_id: null,
          logical_lineage_id: "logical-2",
        },
      },
      harness_setup: binding,
    }),
  ).toThrow("stale or incompatible");
  expect(() =>
    fixture.coordinator.assertExecutionBinding({
      action_id: "action-1",
      run_id: "run-1",
      occurrence_id: "occurrence-1",
      execution: {
        context: {
          mode: "fresh",
          source_occurrence_id: null,
          logical_lineage_id: "logical-1",
        },
      },
      harness_setup: {
        ...binding,
        environment: { ...binding.environment, incarnation: "replacement" },
      },
    }),
  ).toThrow("stale or incompatible");
  expect(() =>
    fixture.coordinator.assertExecutionBinding({
      action_id: "continuation-action",
      run_id: "run-1",
      occurrence_id: "occurrence-2",
      execution: {
        context: {
          mode: "continue_from",
          source_occurrence_id: "occurrence-1",
          logical_lineage_id: "logical-1",
        },
      },
      harness_setup: binding,
    }),
  ).not.toThrow();

  fixture.close();
  const durableBytes = await readFile(
    join(fixture.root, "harness-setups.sqlite"),
  );
  expect(
    durableBytes.includes("provider-secret-response-must-not-be-durable"),
  ).toBe(false);
  expect(
    durableBytes.includes(
      "FAKE SETUP — no provider process or network request",
    ),
  ).toBe(false);
});

test("ready revalidation fails closed without replay when authentication is lost", async () => {
  const harness = new FakeHarness();
  const fixture = await coordinatorFixture(harness);
  await fixture.coordinator.prepare(fixture.command);
  await fixture.coordinator.respond({
    type: "respond_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-1",
    connection_generation: 1,
    setup_id: "setup-1",
    setup_generation: 1,
    attention_id: "fake-setup-setup-1-1",
    request_id: "ready-before-revalidation",
    value: "continue",
  });
  await eventually(() => fixture.store.get("setup-1").state === "ready");

  const inspect = harness.setup?.inspect;
  const begin = harness.setup?.begin;
  if (!harness.setup || !inspect || !begin)
    throw new Error("fake setup unavailable");
  let invocationCount = 0;
  harness.setup.inspect = async (prepared) => ({
    ...(await inspect(prepared)),
    state: "preparing",
    authenticated: false,
  });
  harness.setup.begin = async (...args) => {
    invocationCount += 1;
    return begin(...args);
  };

  await fixture.coordinator.prepare(fixture.command);
  expect(fixture.store.get("setup-1").state).toBe("failed");
  expect(fixture.store.get("setup-1").failure?.code).toBe(
    "setup_readiness_lost",
  );
  expect(invocationCount).toBe(0);
  fixture.close();
});

test("settled readiness survives control-plane report loss", async () => {
  const fixture = await coordinatorFixture();
  fixture.setReporter((record) => {
    if (record.state === "ready")
      throw new Error("injected setup report transport loss");
  });
  await fixture.coordinator.prepare(fixture.command);
  await fixture.coordinator.respond({
    type: "respond_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-1",
    connection_generation: 1,
    setup_id: "setup-1",
    setup_generation: 1,
    attention_id: "fake-setup-setup-1-1",
    request_id: "response-before-report-loss",
    value: "continue",
  });
  await eventually(() => fixture.store.get("setup-1").state === "ready");
  expect(fixture.store.get("setup-1").failure).toBeNull();
  fixture.close();
});

test("cancellation fences late setup completion", async () => {
  const fixture = await coordinatorFixture();
  await fixture.coordinator.prepare(fixture.command);
  await fixture.coordinator.cancel({
    type: "cancel_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-1",
    connection_generation: 1,
    setup_id: "setup-1",
    setup_generation: 1,
    request_id: "cancel-1",
  });
  await Bun.sleep(5);
  expect(fixture.store.get("setup-1").state).toBe("cancelled");
  expect(fixture.store.get("setup-1").inspection?.authenticated).toBe(false);
  fixture.close();
});

test("persisted cancellation overrides locally settled readiness not yet accepted by the server", async () => {
  const fixture = await coordinatorFixture();
  await fixture.coordinator.prepare(fixture.command);
  await fixture.coordinator.respond({
    type: "respond_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-1",
    connection_generation: 1,
    setup_id: "setup-1",
    setup_generation: 1,
    attention_id: "fake-setup-setup-1-1",
    request_id: "settle-before-cancel",
    value: "continue",
  });
  await eventually(() => fixture.store.get("setup-1").state === "ready");

  await fixture.coordinator.cancel({
    type: "cancel_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-1",
    connection_generation: 1,
    setup_id: "setup-1",
    setup_generation: 1,
    request_id: "server-cancellation-won",
  });

  const cancelled = fixture.store.get("setup-1");
  expect(cancelled.state).toBe("cancelled");
  expect(cancelled.invocationState).toBe("settled");
  fixture.close();
});

test("Run cleanup invalidates setup authority and retires an unclaimed lineage", async () => {
  const fixture = await coordinatorFixture();
  await fixture.coordinator.prepare(fixture.command);
  await fixture.coordinator.invalidateRun("run-1");
  await Bun.sleep(5);
  expect(fixture.store.get("setup-1").state).toBe("invalidated");
  expect(fixture.store.get("setup-1").inspection?.authenticated).toBe(false);
  expect(fixture.registry.getLineage("physical-1").sessionState).toBe("closed");
  fixture.close();
});

test("cancellation requested while invocation acknowledgement is pending wins", async () => {
  const harness = new FakeHarness();
  const begin = harness.setup?.begin;
  if (!harness.setup || !begin) throw new Error("fake setup unavailable");
  let releaseBegin!: () => void;
  let markEntered!: () => void;
  const beginGate = new Promise<void>((resolve) => {
    releaseBegin = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  harness.setup.begin = async (...args) => {
    markEntered();
    await beginGate;
    return begin(...args);
  };
  const fixture = await coordinatorFixture(harness);
  const preparing = fixture.coordinator.prepare(fixture.command);
  await entered;
  const cancellation = fixture.coordinator.cancel({
    type: "cancel_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-1",
    connection_generation: 1,
    setup_id: "setup-1",
    setup_generation: 1,
    request_id: "cancel-during-begin",
  });
  await eventually(
    () => fixture.store.get("setup-1").state === "cancellation_requested",
  );
  releaseBegin();
  await Promise.all([preparing, cancellation]);
  expect(fixture.store.get("setup-1").state).toBe("cancelled");
  expect(fixture.store.get("setup-1").inspection?.authenticated).toBe(false);
  fixture.close();
});

test("known pre-invocation failure is retryable only as a new explicit setup generation", async () => {
  const harness = new FakeHarness();
  const prepare = harness.setup?.prepare;
  if (!harness.setup || !prepare) throw new Error("fake setup unavailable");
  harness.setup.prepare = async () => {
    throw new Error("deterministic pre-invocation failure");
  };
  const fixture = await coordinatorFixture(harness);
  await fixture.coordinator.prepare(fixture.command);
  const failed = fixture.store.get("setup-1");
  expect(failed.state).toBe("failed");
  expect(failed.invocationState).toBe("not_requested");
  expect(failed.failure?.code).toBe("setup_preparation_failed");

  harness.setup.prepare = prepare;
  const retry = setupCommand();
  retry.setup.setup_id = "setup-2";
  retry.setup.setup_generation = 2;
  retry.setup.authorization_id = "authorization-2";
  await fixture.coordinator.prepare(retry);
  expect(fixture.store.get("setup-2").state).toBe("human_interaction_required");
  expect(fixture.store.get("setup-2").invocationState).toBe("acknowledged");
  fixture.close();
});

test("restart never replays an acknowledged setup invocation and cancellation is terminal", async () => {
  const fixture = await coordinatorFixture();
  await fixture.coordinator.prepare(fixture.command);
  expect(fixture.store.get("setup-1").invocationState).toBe("acknowledged");
  fixture.coordinator.close();

  const restartedStore = new HarnessSetupStore(fixture.root);
  const reports: string[] = [];
  const restarted = new HarnessSetupCoordinator(
    restartedStore,
    fixture.registry,
    new HarnessRegistry([new FakeHarness()]),
    async (record) => {
      reports.push(record.state);
    },
  );
  await restarted.reconcile();
  expect(restartedStore.get("setup-1").state).toBe("uncertain");
  expect(restartedStore.get("setup-1").failure?.code).toBe(
    "setup_invocation_outcome_uncertain",
  );
  reports.length = 0;
  await restarted.reconcile();
  expect(restartedStore.get("setup-1").state).toBe("uncertain");
  expect(reports).toEqual([]);

  await expect(
    restarted.cancel({
      type: "cancel_harness_setup",
      protocol_version: WORKER_PROTOCOL_VERSION,
      worker_id: "worker-1",
      connection_generation: 1,
      setup_id: "setup-1",
      setup_generation: 2,
      request_id: "stale-cancel",
    }),
  ).rejects.toThrow("stale");

  restarted.close();
  fixture.registry.close();
});

test("restart preserves cancellation precedence and does not invent a stop acknowledgement", async () => {
  const fixture = await coordinatorFixture();
  await fixture.coordinator.prepare(fixture.command);
  fixture.store.transition("setup-1", 1, "cancellation_requested", {
    attentionId: null,
  });
  fixture.coordinator.close();

  const restartedStore = new HarnessSetupStore(fixture.root);
  const reports: string[] = [];
  const restarted = new HarnessSetupCoordinator(
    restartedStore,
    fixture.registry,
    new HarnessRegistry([new FakeHarness()]),
    async (record) => {
      reports.push(record.state);
    },
  );
  await restarted.reconcile();
  expect(restartedStore.get("setup-1").state).toBe("cancellation_requested");
  expect(reports).toEqual(["cancellation_requested"]);

  await restarted.cancel({
    type: "cancel_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-1",
    connection_generation: 2,
    setup_id: "setup-1",
    setup_generation: 1,
    request_id: "cancel-after-restart",
  });
  expect(restartedStore.get("setup-1").state).toBe("uncertain");
  expect(restartedStore.get("setup-1").failure?.code).toBe(
    "setup_cancellation_uncertain",
  );

  restarted.close();
  fixture.registry.close();
});

async function coordinatorFixture(harness: FakeHarness = new FakeHarness()) {
  const parent = resolve(".pi/tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "harness-setup-"));
  roots.push(root);
  const store = new HarnessSetupStore(root);
  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "fake",
  );
  const harnesses = new HarnessRegistry([harness]);
  let reporter: (
    record: ReturnType<HarnessSetupStore["get"]>,
    ephemeral?: string,
  ) => void = () => {};
  const coordinator = new HarnessSetupCoordinator(
    store,
    registry,
    harnesses,
    async (record, ephemeral) => reporter(record, ephemeral),
  );
  const command = setupCommand();
  return {
    root,
    store,
    registry,
    coordinator,
    command,
    setReporter(value: typeof reporter) {
      reporter = value;
    },
    close() {
      coordinator.close();
      registry.close();
    },
  };
}

function setupCommand(): PrepareHarnessSetupCommand {
  return {
    type: "prepare_harness_setup",
    protocol_version: WORKER_PROTOCOL_VERSION,
    worker_id: "worker-1",
    connection_generation: 1,
    setup: {
      setup_id: "setup-1",
      setup_generation: 1,
      authorization_id: "authorization-1",
      authorization_kind: "human_harness_setup",
      authorized_at: new Date().toISOString(),
      action_id: "action-1",
      run_id: "run-1",
      occurrence_id: "occurrence-1",
      member_key: "member-1",
      harness_kind: "fake",
      physical_lineage_id: "physical-1",
      logical_lineage_id: "logical-1",
      workspace_id: "workspace-1",
      worktree_id: "worktree-1",
      workspace_binding_id: "binding-1",
      canonical_root: "/workspace/run-1",
      workspace_access: "read_write",
      profile: { id: "fake-profile", digest: "sha256:fake" },
      configuration: {
        model: { provider: "fake", model: "test" },
        reasoning: "medium",
        reasoning_capability: {
          kind: "enumerated",
          values: ["low", "medium", "high"],
        },
        tool_policy: { kind: "exact", tools: ["workspace.filesystem"] },
        tool_enforcement: "exact",
        resolved_tool_profile: { tools: ["workspace.filesystem"] },
      },
    },
  };
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await Bun.sleep(2);
  }
  throw new Error("condition did not become true");
}
