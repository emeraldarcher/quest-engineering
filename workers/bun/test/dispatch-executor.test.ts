import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DispatchExecutor } from "../src/dispatch/executor.ts";
import {
  type DispatchRecord,
  DispatchRegistry,
  type ProviderLineage,
} from "../src/dispatch/registry.ts";
import type { JsonValue, ReconcileDispatch } from "../src/protocol/types.ts";
import { FakeHarness } from "../src/providers/fake/provider.ts";
import type {
  AgentHarness,
  HarnessEvent,
  HarnessPreparedExecution,
} from "../src/providers/types.ts";
import type { HostedAgent } from "../src/session-host/types.ts";
import { action } from "./support.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture() {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "bun-worker-executor-"));
  roots.push(root);
  return { root, database: join(root, "state.sqlite") };
}

function reviewAction(id = "review-action") {
  const instruction =
    "Review the implementation against the Quest requirements. Do not deliberately invoke the takeover acceptance mechanism; request human assistance only for a genuine blocker.";
  const base = action({
    action_id: id,
    occurrence_id: `${id}-occurrence`,
    attempt_id: `${id}-attempt`,
    semantic_step_key: "review",
    instruction,
    declared_outputs: ["verdict"],
  });
  return action({
    execution: {
      ...base.execution,
      performer: {
        member_key: "reviewer",
        member_name: "Reviewer",
        class_key: "reviewer",
        class_name: "Reviewer",
      },
      work: {
        ...base.execution.work,
        step_instruction: instruction,
        inputs: {
          change_set: {
            id: "change-set-1",
            type: "change_set",
            producer_occurrence_id: "occurrence-1",
            value: { files: ["human-picked.txt"] },
          },
        },
        declared_outputs: ["verdict"],
      },
      context: {
        mode: "fresh",
        source_occurrence_id: null,
        logical_lineage_id: `logical-${id}`,
      },
    },
  });
}

test("independent dispatches enter provider execution concurrently", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const provider = new BlockingProvider(registry);
  const executor = new DispatchExecutor(registry, provider, async () => false);
  const first = executor.accept(action()).dispatch;
  const second = executor.accept(
    action({
      action_id: "action-2",
      run_id: "run-2",
      occurrence_id: "occurrence-2",
      attempt_id: "attempt-2",
    }),
  ).dispatch;

  const firstOperation = executor.start(first.action.action_id);
  const secondOperation = executor.start(second.action.action_id);
  for (let attempt = 0; attempt < 100 && provider.running < 2; attempt += 1)
    await Bun.sleep(1);

  expect(provider.starts).toBe(2);
  expect(provider.running).toBe(2);
  expect(registry.get(first.action.action_id).state).toBe("running");
  expect(registry.get(second.action.action_id).state).toBe("running");
  expect(
    [first, second].map(
      (dispatch) =>
        registry.getLineage(dispatch.lineageId as string).activeActionId,
    ),
  ).toEqual([first.action.action_id, second.action.action_id]);

  provider.releaseAll();
  await Promise.all([firstOperation, secondOperation]);
  registry.close();
});

test("attention in one concurrent harness session does not block another", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root, "fake");
  const harness = new FakeHarness({ change_set: { complete: true } });
  const executor = new DispatchExecutor(registry, harness, async () => false);
  const first = executor.accept(action()).dispatch;
  const second = executor.accept(
    action({
      action_id: "action-2",
      run_id: "run-2",
      occurrence_id: "occurrence-2",
      attempt_id: "attempt-2",
    }),
  ).dispatch;
  const firstLineage = registry.getLineage(first.lineageId as string);
  harness.requestAttention(firstLineage);

  const waiting = executor.start(first.action.action_id);
  await executor.start(second.action.action_id);
  expect(registry.get(first.action.action_id).state).toBe("running");
  expect(registry.get(second.action.action_id).state).toBe("completed");
  expect(registry.getLineage(firstLineage.lineageId).attention).not.toBeNull();

  harness.provideInput(registry.getLineage(firstLineage.lineageId));
  await waiting;
  expect(registry.get(first.action.action_id).state).toBe("completed");
  registry.close();
});

test("human assistance keeps the same Attempt, lineage and occupied execution", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root, "fake");
  const harness = new FakeHarness({ change_set: { assisted: true } });
  const sessionStates: string[] = [];
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async (_dispatch, lineage) => {
      sessionStates.push(lineage.sessionState);
      return true;
    },
  );
  const dispatch = executor.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  harness.requestConversationalIntervention(
    lineage,
    "Discuss and choose an option.",
  );

  const operation = executor.start(dispatch.action.action_id);
  for (
    let attempt = 0;
    attempt < 100 &&
    registry.getLineage(lineage.lineageId).sessionState !== "waiting_for_human";
    attempt += 1
  )
    await Bun.sleep(1);

  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "running",
    action: {
      attempt_id: dispatch.action.attempt_id,
      occurrence_id: dispatch.action.occurrence_id,
    },
  });
  expect(registry.list()).toHaveLength(1);
  expect(registry.listLineages()).toHaveLength(1);
  expect(registry.getLineage(lineage.lineageId).activeActionId).toBe(
    dispatch.action.action_id,
  );
  expect(registry.getLineage(lineage.lineageId).attention).toMatchObject({
    category: "needs_input",
    interaction: {
      kind: "conversational_intervention",
      controlState: "intervention_pending",
    },
  });
  expect(registry.getLineage(lineage.lineageId).intervention?.state).toBe(
    "intervention_pending",
  );

  harness.resumeAutomation(registry.getLineage(lineage.lineageId));
  await operation;
  expect(registry.get(dispatch.action.action_id).state).toBe("completed");
  expect(registry.getLineage(lineage.lineageId).activeActionId).toBeNull();
  expect(sessionStates).toContain("waiting_for_human");
  expect(sessionStates.at(-1)).toBe("retained");
  registry.close();
});

test("step-scoped acceptance yields only Implement and gives Review a fresh lineage", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root, "fake");
  const harness = new FakeHarness({
    change_set: { files: ["human-picked.txt"] },
    verdict: { status: "accepted" },
  });
  const deliberateAttentionIds = new Set<string>();
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async (_dispatch, lineage) => {
      if (
        lineage.attention?.interaction?.kind === "conversational_intervention"
      )
        deliberateAttentionIds.add(lineage.attention.attentionId);
      return true;
    },
  );

  const implementAction = action({
    instruction:
      "Before making repository changes, immediately request conversational intervention and wait for explicit /qe-resume before implementing the human guidance.",
  });
  const implement = executor.accept(implementAction).dispatch;
  const builderLineage = registry.getLineage(implement.lineageId as string);
  harness.requestConversationalIntervention(
    builderLineage,
    "Choose a filename and file contents with the Builder.",
  );

  const implementation = executor.start(implement.action.action_id);
  for (
    let attempt = 0;
    attempt < 100 &&
    registry.getLineage(builderLineage.lineageId).sessionState !==
      "waiting_for_human";
    attempt += 1
  )
    await Bun.sleep(1);

  expect(registry.get(implement.action.action_id).state).toBe("running");
  harness.resumeAutomation(registry.getLineage(builderLineage.lineageId));
  await implementation;

  const review = executor.accept(reviewAction()).dispatch;
  const reviewerLineage = registry.getLineage(review.lineageId as string);
  expect(reviewerLineage.lineageId).not.toBe(builderLineage.lineageId);
  expect(reviewerLineage.logicalLineageId).not.toBe(
    builderLineage.logicalLineageId,
  );
  expect(reviewerLineage.attention).toBeNull();
  expect(reviewerLineage.intervention).toBeNull();

  await executor.start(review.action.action_id);

  expect(registry.get(review.action.action_id).state).toBe("completed");
  expect(registry.getLineage(reviewerLineage.lineageId).attention).toBeNull();
  expect(deliberateAttentionIds.size).toBe(1);
  registry.close();
});

test("a genuine synthetic Review blocker can still request conversational attention", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root, "fake");
  const harness = new FakeHarness({ verdict: { status: "accepted" } });
  const executor = new DispatchExecutor(registry, harness, async () => false);
  const review = executor.accept(reviewAction("blocked-review")).dispatch;
  const lineage = registry.getLineage(review.lineageId as string);
  harness.requestConversationalIntervention(
    lineage,
    "A genuine external Review blocker needs human guidance.",
  );

  const operation = executor.start(review.action.action_id);
  for (
    let attempt = 0;
    attempt < 100 &&
    registry.getLineage(lineage.lineageId).sessionState !== "waiting_for_human";
    attempt += 1
  )
    await Bun.sleep(1);

  expect(registry.getLineage(lineage.lineageId).attention).toMatchObject({
    category: "needs_input",
    interaction: { kind: "conversational_intervention" },
  });
  harness.resumeAutomation(registry.getLineage(lineage.lineageId));
  await operation;
  expect(registry.get(review.action.action_id).state).toBe("completed");
  registry.close();
});

test("acceptance and completion are durable before external side effects and reporting", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const provider = new InspectingProvider(registry);
  let completionReported = false;
  const executor = new DispatchExecutor(
    registry,
    provider,
    async (payload, type) => {
      if (type === "step_completed") {
        completionReported = true;
        const persisted = registry.get(payload.action_id);
        expect(persisted.state).toBe("completed");
        expect(persisted.serverAcknowledgedAt).toBeNull();
        expect(
          registry.getLineage(persisted.lineageId as string).activeActionId,
        ).toBeNull();
      }
      return false;
    },
  );
  const accepted = executor.accept(action());
  await Promise.all([
    executor.start(accepted.dispatch.action.action_id),
    executor.start(accepted.dispatch.action.action_id),
  ]);
  expect(provider.starts).toBe(1);
  expect(provider.sawDurableAcceptance).toBe(true);
  expect(completionReported).toBe(true);
  expect(registry.get("action-1").serverAcknowledgedAt).toBeNull();
  registry.close();

  const restarted = new DispatchRegistry(database, root);
  let resent: ReconcileDispatch | null = null;
  const recovery = new DispatchExecutor(
    restarted,
    new InspectingProvider(restarted),
    async (payload, type) => {
      if (type === "step_completed") resent = payload;
      return true;
    },
  );
  await recovery.start("action-1");
  expect(resent).toMatchObject({
    action_id: "action-1",
    outputs: { change_set: { version: 1 } },
  });
  expect(restarted.get("action-1").serverAcknowledgedAt).not.toBeNull();
  restarted.close();
});

class InspectingProvider implements AgentHarness {
  readonly kind = "fake";
  readonly displayName = "Fake";
  readonly capabilities = {
    canAttachTerminal: false,
    canSendInput: true,
    canInterrupt: true,
    canDetectAttention: true,
    canResume: true,
    canObserveStructuredEvents: true,
    structuredConfirmation: false,
    structuredTextResponse: false,
    structuredChoiceResponse: false,
    structuredMultilineResponse: false,
    nativePromptControl: false,
    conversationalTakeover: false,
    automationResume: false,
  };
  starts = 0;
  sawDurableAcceptance = false;
  constructor(private readonly registry: DispatchRegistry) {}
  async start(
    dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<HarnessPreparedExecution> {
    this.starts += 1;
    this.sawDurableAcceptance =
      this.registry.get(dispatch.action.action_id).state === "accepted";
    return prepared(lineage);
  }
  async continue(
    _dispatch: DispatchRecord,
    lineage: ProviderLineage,
  ): Promise<HarnessPreparedExecution> {
    return prepared(lineage);
  }
  async sendInputAndCollect(
    _dispatch: DispatchRecord,
    _execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    onEvent({ type: "running", inspection: inspection(_execution.lineage) });
    return { change_set: { version: 1 } };
  }
  async recover() {
    return { found: false, detail: "not used" };
  }
  async waitAndCollect() {
    return { change_set: { version: 1 } };
  }
  async interrupt() {}
  async inspect(lineage: ProviderLineage) {
    return inspection(lineage);
  }
  async close() {}
  async clearActiveMetadata() {}
  async discoverAdoptionCandidates() {
    return [];
  }
  attachment(lineage: ProviderLineage) {
    return {
      mode: "local_native_terminal" as const,
      backendKind: "fake",
      terminalSessionId: "fake",
      terminalTargetId: lineage.lineageId,
      supportsObservation: false,
      supportsTakeover: false,
    };
  }
  disconnect() {}
}

class BlockingProvider extends InspectingProvider {
  running = 0;
  private releases: Array<() => void> = [];

  override async sendInputAndCollect(
    _dispatch: DispatchRecord,
    _execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    onEvent({ type: "running", inspection: inspection(_execution.lineage) });
    this.running += 1;
    await new Promise<void>((resolve) => this.releases.push(resolve));
    return { change_set: { version: 1 } };
  }

  releaseAll(): void {
    for (const release of this.releases.splice(0)) release();
  }
}

function inspection(lineage: ProviderLineage) {
  return {
    state: "running" as const,
    agent: prepared(lineage).agent,
    attention: null,
    intervention: null,
    lastActivityAt: new Date().toISOString(),
  };
}

function prepared(lineage: ProviderLineage): HarnessPreparedExecution {
  const agent: HostedAgent = {
    name: lineage.lineageId,
    agent: "pi",
    status: "idle",
    paneId: "pane",
    terminalId: "terminal",
    workspaceId: "workspace",
    tabId: "tab",
  };
  return {
    lineage,
    ref: {
      sessionName: "fake",
      workspaceId: "workspace",
      tabId: "tab",
      paneId: "pane",
      terminalId: "terminal",
      agentName: lineage.lineageId,
    },
    agent,
  };
}
