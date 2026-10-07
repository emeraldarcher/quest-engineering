import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DispatchExecutor } from "../src/dispatch/executor.ts";
import {
  type DispatchRecord,
  DispatchRegistry,
  type HarnessLineage,
} from "../src/dispatch/registry.ts";
import {
  controlDescriptorPath,
  HarnessControlAuthority,
} from "../src/harnesses/control/authority.ts";
import { HarnessControlClient } from "../src/harnesses/control/client.ts";
import { collectStepResult } from "../src/harnesses/control/result-envelope.ts";
import { HarnessControlServer } from "../src/harnesses/control/server.ts";
import { StructuredCompletionWaitPolicy } from "../src/harnesses/turn-lifecycle.ts";
import type {
  AgentHarness,
  HarnessDiscovery,
  HarnessEvent,
  HarnessInspection,
  HarnessPreparedExecution,
} from "../src/harnesses/types.ts";
import type { JsonValue, ReconcileDispatch } from "../src/protocol/types.ts";
import { action } from "./support.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("long provider turn and delayed completion succeed without a transport lifetime deadline", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "delayed-structured-result-"));
  roots.push(root);
  const fixtureRoot = join(root, "fixture");
  await mkdir(join(fixtureRoot, "src"), { recursive: true });
  await mkdir(join(fixtureRoot, "test"), { recursive: true });
  await writeFile(
    join(fixtureRoot, "src", "greeting.js"),
    "export const greeting = (name) => `Hi, $" + "{name}.`;\n",
  );
  await writeFile(
    join(fixtureRoot, "test", "greeting.test.js"),
    'import { expect, test } from "bun:test";\nimport { greeting } from "../src/greeting.js";\ntest("greeting", () => expect(greeting("Ada")).toBe("Hello, Ada!"));\n',
  );
  const replay = JSON.parse(
    await readFile(
      join(
        import.meta.dir,
        "fixtures",
        "pi-sol-structured-completion-replay.json",
      ),
      "utf8",
    ),
  ) as {
    containsConversationContent: boolean;
    events: Array<{ kind: string; offsetMs: number }>;
  };
  expect(replay.containsConversationContent).toBe(false);
  const providerOffset = replay.events.find(
    (event) => event.kind === "provider_turn_settled",
  )?.offsetMs;
  const resultOffset = replay.events.find(
    (event) => event.kind === "structured_result_invoked",
  )?.offsetMs;
  if (providerOffset === undefined || resultOffset === undefined)
    throw new Error("Replay fixture lacks lifecycle offsets.");
  const resultDelayMs = resultOffset - providerOffset;
  expect(resultDelayMs).toBeGreaterThanOrEqual(17_000);

  const registry = new DispatchRegistry(
    join(root, "dispatches.sqlite"),
    root,
    "fake",
  );
  const exportEvents: string[] = [];
  const authority = new HarnessControlAuthority(registry, 2, {
    async verifyAndPrepare({ dispatch, outputs, assertCurrent }) {
      exportEvents.push("semantic_result_accepted");
      const source = await readFile(
        join(fixtureRoot, "src", "greeting.js"),
        "utf8",
      );
      const fingerprint = createHash("sha256").update(source).digest("hex");
      exportEvents.push("workspace_fingerprint");
      const tree = createHash("sha256")
        .update(`tree:${fingerprint}`)
        .digest("hex");
      exportEvents.push("resulting_tree");
      const checkpointId = `checkpoint-${tree.slice(0, 12)}`;
      exportEvents.push("checkpoint");
      const exportId = `export-${dispatch.action.action_id}`;
      return {
        outputs: {
          ...outputs,
          change_set: {
            ...(outputs.change_set as Record<string, JsonValue>),
            physical: {
              workspace_fingerprint: fingerprint,
              resulting_tree: tree,
              checkpoint_id: checkpointId,
              export_id: exportId,
            },
          },
        },
        commit: () => {
          assertCurrent();
          exportEvents.push("export");
        },
      };
    },
  });
  const controlServer = new HarnessControlServer(authority);
  await controlServer.start();
  const clock = new ManualClock(Date.parse("2026-10-02T06:32:15.546Z"));
  const harness = new DelayedStructuredHarness(
    fixtureRoot,
    resultDelayMs,
    clock,
  );
  const reports: ReconcileDispatch[] = [];
  const executor = new DispatchExecutor(
    registry,
    harness,
    async (dispatch) => {
      reports.push(dispatch);
      return true;
    },
    async () => true,
    authority,
  );
  const request = action();
  request.execution.execution_workspace.canonical_root = fixtureRoot;
  const dispatch = executor.accept(request).dispatch;
  const operation = executor.start(dispatch.action.action_id);

  await waitFor(
    () =>
      registry.get(dispatch.action.action_id).providerTurnSettledAt !== null,
  );
  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "running",
    structuredResultReceivedAt: null,
  });
  expect(registry.getLineage(dispatch.lineageId as string).activeActionId).toBe(
    dispatch.action.action_id,
  );
  const pendingClient = new HarnessControlClient(
    controlDescriptorPath(registry.getLineage(dispatch.lineageId as string)),
  );
  expect(await pendingClient.completionStatus()).toMatchObject({
    accepted: true,
    completed: false,
  });
  harness.releaseCompletion();

  await operation;
  const completed = registry.get(dispatch.action.action_id);
  expect(completed).toMatchObject({
    state: "completed",
    providerTurnSettledAt: expect.any(String),
    nativeIdleAt: expect.any(String),
    structuredResultReceivedAt: expect.any(String),
    settledAt: expect.any(String),
    serverAcknowledgedAt: expect.any(String),
  });
  expect(harness).toMatchObject({
    prompts: 1,
    providerCycles: 0,
    localTests: 1,
    completionAcknowledged: true,
    mailboxLiveImmediatelyBeforeResult: true,
    oldTransportLifetimeCrossedWhileActive: true,
    completionGraceRemainedOpen: true,
  });
  expect(exportEvents).toEqual([
    "semantic_result_accepted",
    "workspace_fingerprint",
    "resulting_tree",
    "checkpoint",
    "export",
  ]);
  expect(
    (await collectStepResult(completed)).envelope.outputs.change_set,
  ).toMatchObject({
    files: ["src/greeting.js"],
    physical: {
      workspace_fingerprint: expect.any(String),
      resulting_tree: expect.any(String),
      checkpoint_id: expect.stringContaining("checkpoint-"),
      export_id: expect.stringContaining("export-"),
    },
  });
  expect(reports.at(-1)).toMatchObject({
    state: "completed",
    outputs: { change_set: { physical: { export_id: expect.any(String) } } },
  });
  expect(registry.getLineage(dispatch.lineageId as string)).toMatchObject({
    activeActionId: null,
    sessionState: "retained",
  });
  expect(harness.finalInspection).toMatchObject({
    state: "retained",
    activity: { state: "idle" },
    interactive: null,
  });

  await controlServer.stop();
  registry.close();
}, 30_000);

test("fake clock starts grace only after settlement and suspends it for Stop continuation", () => {
  const clock = new ManualClock(0);
  const policy = new StructuredCompletionWaitPolicy(1_000, clock.now);

  clock.advance(60_000);
  expect(policy.phase()).toBe("provider_active");
  expect(policy.expired()).toBe(false);

  policy.providerSettled();
  clock.advance(999);
  expect(policy.phase()).toBe("awaiting_structured_completion");
  expect(policy.expired()).toBe(false);
  clock.advance(1);
  expect(policy.expired()).toBe(true);

  policy.continuationStarted();
  clock.advance(60_000);
  expect(policy.phase()).toBe("continuation_active");
  expect(policy.expired()).toBe(false);

  policy.providerSettled();
  clock.advance(1_000);
  expect(policy.expired()).toBe(true);

  policy.resultAccepted();
  clock.advance(60_000);
  expect(policy.phase()).toBe("exporting");
  expect(policy.expired()).toBe(false);
  policy.exportCompleted();
  expect(policy.phase()).toBe("completed");
});

class DelayedStructuredHarness implements AgentHarness {
  readonly kind = "fake";
  readonly displayName = "Delayed structured fake";
  readonly integrationStrategy = "native_rpc" as const;
  readonly capabilities = {
    structuredResult: true,
    continuation: false,
    retainedSessionRecovery: false,
    structuredAttention: false,
    nativeBlocking: false,
    canAttachTerminal: false,
    canSendInput: true,
    canInterrupt: true,
    canDetectAttention: true,
    canResume: false,
    canObserveStructuredEvents: true,
    structuredConfirmation: false,
    structuredTextResponse: false,
    structuredChoiceResponse: false,
    structuredMultilineResponse: false,
    nativePromptControl: false,
    conversationalTakeover: false,
    automationResume: false,
  };
  prompts = 0;
  providerCycles = 0;
  localTests = 0;
  completionAcknowledged = false;
  mailboxLiveImmediatelyBeforeResult = false;
  oldTransportLifetimeCrossedWhileActive = false;
  completionGraceRemainedOpen = false;
  finalInspection: HarnessInspection | null = null;
  private releaseAfterSettlement!: () => void;
  private readonly afterSettlement = new Promise<void>((resolve) => {
    this.releaseAfterSettlement = resolve;
  });

  constructor(
    private readonly fixtureRoot: string,
    private readonly resultDelayMs: number,
    private readonly clock: ManualClock,
  ) {}

  releaseCompletion(): void {
    this.releaseAfterSettlement();
  }

  async discover(): Promise<HarnessDiscovery> {
    return {
      kind: this.kind,
      displayName: this.displayName,
      strategy: this.integrationStrategy,
      integration: {
        status: "ready",
        detail: "Local deterministic lifecycle replay.",
        installed: true,
        authenticated: true,
      },
      models: [
        {
          provider: "fake",
          model: "test",
          displayName: "No-inference fake",
          accountAvailability: "verified_available",
          reasoningCapability: { kind: "enumerated", values: ["medium"] },
        },
      ],
      capabilities: this.capabilities,
    };
  }

  async start(
    _dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    return {
      lineage,
      handle: {
        schemaVersion: 1,
        harnessKind: this.kind,
        executionId: lineage.lineageId,
      },
    };
  }

  async sendInputAndCollect(
    dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    this.prompts += 1;
    const completionWait = new StructuredCompletionWaitPolicy(
      this.resultDelayMs + 1_000,
      this.clock.now,
    );
    onEvent({
      type: "prompt_accepted",
      acceptedAt: this.clock.iso(),
      inspection: activeInspection(execution.lineage, this.clock.iso()),
    });
    onEvent({
      type: "native_activity",
      observedAt: this.clock.iso(),
      inspection: activeInspection(execution.lineage, this.clock.iso()),
    });

    this.clock.advance(12_000);
    this.oldTransportLifetimeCrossedWhileActive = !completionWait.expired();
    onEvent({
      type: "native_activity",
      observedAt: this.clock.iso(),
      inspection: activeInspection(execution.lineage, this.clock.iso()),
    });
    await writeFile(
      join(this.fixtureRoot, "src", "greeting.js"),
      "export const greeting = (name) => `Hello, $" + "{name}!`;\n",
    );
    const testRun = Bun.spawn(
      [process.execPath, "test", "test/greeting.test.js"],
      {
        cwd: this.fixtureRoot,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env },
      },
    );
    const [exitCode, stderr] = await Promise.all([
      testRun.exited,
      new Response(testRun.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`Local fake test failed: ${stderr}`);
    this.localTests += 1;
    completionWait.providerSettled();
    onEvent({
      type: "provider_turn_settled",
      observedAt: this.clock.iso(),
      inspection: activeInspection(execution.lineage, this.clock.iso()),
    });
    await this.afterSettlement;
    this.clock.advance(this.resultDelayMs);
    this.completionGraceRemainedOpen = !completionWait.expired();

    const client = new HarnessControlClient(
      controlDescriptorPath(execution.lineage),
    );
    this.mailboxLiveImmediatelyBeforeResult =
      (await client.completionStatus()).completed === false;
    const acknowledgement = await client.completeStep(
      { change_set: { files: ["src/greeting.js"] } },
      "delayed-structured-result",
    );
    this.completionAcknowledged = acknowledgement.semanticAccepted === true;
    completionWait.resultAccepted();
    await waitForAsync(
      async () => (await client.completionStatus()).completed === true,
    );
    const collected = await collectStepResult(dispatch);
    completionWait.exportCompleted();
    onEvent({
      type: "structured_result_received",
      observedAt: collected.envelope.createdAt,
      inspection: activeInspection(execution.lineage, this.clock.iso()),
    });
    this.finalInspection = idleInspection(execution.lineage, this.clock.iso());
    onEvent({
      type: "native_idle",
      observedAt: this.clock.iso(),
      inspection: this.finalInspection,
    });
    return collected.envelope.outputs;
  }

  async inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    return this.finalInspection ?? activeInspection(lineage);
  }

  async close(): Promise<void> {}
  async clearActiveMetadata(): Promise<void> {}
  async discoverAdoptionCandidates() {
    return [];
  }
  disconnect(): void {}
}

function activeInspection(
  lineage: HarnessLineage,
  observedAt = new Date().toISOString(),
): HarnessInspection {
  return {
    state: "running",
    activity: { state: "active" },
    nativeSession: lineage.nativeSession,
    health: "healthy",
    attention: null,
    intervention: null,
    lastActivityAt: observedAt,
    interactive: null,
  };
}

function idleInspection(
  lineage: HarnessLineage,
  observedAt = new Date().toISOString(),
): HarnessInspection {
  return {
    state: "retained",
    activity: { state: "idle" },
    nativeSession: lineage.nativeSession,
    health: "healthy",
    attention: null,
    intervention: null,
    lastActivityAt: observedAt,
    interactive: null,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  if (!predicate()) throw new Error("condition was not observed");
}

async function waitForAsync(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!(await predicate()) && Date.now() < deadline) await Bun.sleep(5);
  if (!(await predicate())) throw new Error("condition was not observed");
}

class ManualClock {
  constructor(private value: number) {}

  readonly now = () => this.value;

  advance(durationMs: number): void {
    this.value += durationMs;
  }

  iso(): string {
    return new Date(this.value).toISOString();
  }
}
