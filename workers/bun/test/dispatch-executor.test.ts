import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DispatchExecutor } from "../src/dispatch/executor.ts";
import {
  type DispatchRecord,
  DispatchRegistry,
  type HarnessLineage,
} from "../src/dispatch/registry.ts";
import { FakeHarness } from "../src/harnesses/fake/adapter.ts";
import { HarnessRegistry } from "../src/harnesses/registry.ts";
import type {
  AgentHarness,
  HarnessDiscovery,
  HarnessEvent,
  HarnessInspection,
  HarnessPreparedExecution,
  HarnessRecoveredExecution,
} from "../src/harnesses/types.ts";
import type { JsonValue, ReconcileDispatch } from "../src/protocol/types.ts";
import { HerdrApiError } from "../src/session-host/herdr/client.ts";
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
            kind: "change_set",
            output_name: "input",
            producer_occurrence_id: "occurrence-1",
            value: { files: ["human-picked.txt"] },
          },
        },
        declared_outputs: [{ name: "verdict", kind: "review_verdict" }],
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

test("explicit cancellation terminalizes while a pending structured result remains absent", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new BlockingProvider(registry);
  const reports: ReconcileDispatch[] = [];
  const executor = new DispatchExecutor(registry, harness, async (dispatch) => {
    reports.push(dispatch);
    return true;
  });
  const dispatch = executor.accept(action()).dispatch;
  const operation = executor.start(dispatch.action.action_id);
  for (let attempt = 0; attempt < 100 && harness.running === 0; attempt += 1)
    await Bun.sleep(1);

  await executor.cancel(dispatch.action.action_id);
  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "failed",
    failure: {
      code: "execution_cancelled",
      classification: "terminal_not_recoverable",
    },
    structuredResultReceivedAt: null,
  });
  expect(harness.interrupts).toBe(1);
  expect(reports.at(-1)).toMatchObject({
    state: "failed",
    failure: { code: "execution_cancelled" },
  });
  harness.releaseAll();
  await operation;
  expect(registry.get(dispatch.action.action_id).state).toBe("failed");
  registry.close();
});

test("Pi and Antigravity selections execute concurrently without Worker-global serialization", async () => {
  const { root, database } = await fixture();
  let harnesses: HarnessRegistry;
  const registry = new DispatchRegistry(
    database,
    root,
    "pi",
    (kind) => harnesses.get(kind).capabilities,
  );
  const pi = new BlockingProvider(registry, "pi");
  const antigravity = new BlockingProvider(registry, "antigravity");
  harnesses = new HarnessRegistry([pi, antigravity]);
  const executor = new DispatchExecutor(registry, harnesses, async () => false);
  const piAction = action();
  piAction.execution.configuration.harness_kind = "pi";
  const agyAction = action({
    action_id: "agy-action",
    run_id: "agy-run",
    occurrence_id: "agy-occurrence",
    attempt_id: "agy-attempt",
  });
  agyAction.execution.configuration.harness_kind = "antigravity";
  const first = executor.accept(piAction).dispatch;
  const second = executor.accept(agyAction).dispatch;

  const operations = [
    executor.start(first.action.action_id),
    executor.start(second.action.action_id),
  ];
  for (
    let attempt = 0;
    attempt < 100 && pi.running + antigravity.running < 2;
    attempt += 1
  )
    await Bun.sleep(1);
  expect(pi.running).toBe(1);
  expect(antigravity.running).toBe(1);
  expect(registry.getLineage(first.lineageId as string).harnessKind).toBe("pi");
  expect(registry.getLineage(second.lineageId as string).harnessKind).toBe(
    "antigravity",
  );

  await pi.interrupt();
  expect(pi.interrupts).toBe(1);
  expect(antigravity.running).toBe(1);
  pi.releaseAll();
  antigravity.releaseAll();
  await Promise.all(operations);
  expect(registry.get(first.action.action_id).state).toBe("completed");
  expect(registry.get(second.action.action_id).state).toBe("completed");
  registry.close();
});

test("fresh initial execution reaches a durable zero-inference gate before one authorized prompt", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root, "pi");
  const harness = new StagedRecoveryHarness(registry, "pi");
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => true,
    async () => true,
  );
  const initial = action({
    action_id: "initial-action",
    attempt_id: "initial-attempt-1",
    operational_recovery: {
      epoch_number: 0,
      attempt_in_epoch: 1,
      attempt_allowance: 2,
      authorization_kind: "initial",
      continuation_mode: "fresh",
      retained_lineage_id: null,
      source_attempt_id: null,
      request_id: null,
    },
  });
  initial.execution.configuration.harness_kind = "pi";
  const dispatch = executor.accept(initial).dispatch;

  await executor.start(dispatch.action.action_id);
  expect(harness.promptSubmissions).toBe(0);
  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "accepted",
    promptAuthorizedAt: null,
    promptIntentAt: null,
    promptAcceptedAt: null,
  });
  expect(registry.getLineage(dispatch.lineageId as string)).toMatchObject({
    sessionState: "waiting_for_human",
    attention: { category: "needs_confirmation" },
  });

  await executor.authorizePrompt(dispatch.action.action_id);
  expect(harness.promptSubmissions).toBe(1);
  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "completed",
    promptAuthorizedAt: expect.any(String),
    promptIntentAt: expect.any(String),
  });
  registry.close();
});

test("fresh human recovery reaches a durable zero-inference gate before one authorized prompt", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root, "antigravity");
  const harness = new StagedRecoveryHarness(registry, "antigravity");
  const reports: ReconcileDispatch[] = [];
  const executor = new DispatchExecutor(
    registry,
    harness,
    async (dispatch) => {
      reports.push(dispatch);
      return true;
    },
    async () => true,
  );
  const recovery = action({
    action_id: "recovery-action",
    attempt_id: "recovery-attempt-3",
    operational_recovery: {
      epoch_number: 2,
      attempt_in_epoch: 1,
      attempt_allowance: 2,
      authorization_kind: "human",
      continuation_mode: "fresh",
      retained_lineage_id: null,
      source_attempt_id: "recovery-attempt-2",
      request_id: "recovery-request-2",
    },
  });
  recovery.execution.configuration.harness_kind = "antigravity";
  const dispatch = executor.accept(recovery).dispatch;

  await executor.start(dispatch.action.action_id);
  expect(harness.promptSubmissions).toBe(0);
  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "accepted",
    promptAuthorizedAt: null,
    promptIntentAt: null,
  });
  expect(registry.getLineage(dispatch.lineageId as string)).toMatchObject({
    sessionState: "waiting_for_human",
    attention: {
      category: "needs_confirmation",
    },
  });
  expect(reports).toHaveLength(0);

  await executor.authorizePrompt(dispatch.action.action_id);
  expect(harness.promptSubmissions).toBe(1);
  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "completed",
    promptAuthorizedAt: expect.any(String),
    promptIntentAt: expect.any(String),
  });
  await executor.authorizePrompt(dispatch.action.action_id);
  expect(harness.promptSubmissions).toBe(1);
  registry.close();
});

test("pre-authorization native input fences the process and fails without submitting the QE prompt", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root, "antigravity");
  const harness = new ContaminatedStagedRecoveryHarness(
    registry,
    "antigravity",
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
  );
  const recovery = action({
    action_id: "contaminated-recovery-action",
    attempt_id: "contaminated-recovery-attempt",
    operational_recovery: {
      epoch_number: 3,
      attempt_in_epoch: 2,
      attempt_allowance: 2,
      authorization_kind: "human",
      continuation_mode: "fresh",
      retained_lineage_id: null,
      source_attempt_id: "source-attempt",
      request_id: "recovery-request",
    },
  });
  recovery.execution.configuration.harness_kind = "antigravity";
  const dispatch = executor.accept(recovery).dispatch;

  await executor.start(dispatch.action.action_id);
  harness.nativeConversationId = "native-conversation-1";
  for (
    let attempt = 0;
    attempt < 100 && registry.get(dispatch.action.action_id).state !== "failed";
    attempt += 1
  )
    await Bun.sleep(10);

  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "failed",
    promptAuthorizedAt: null,
    promptIntentAt: null,
    promptAcceptedAt: null,
    nativeActivityAt: null,
    failure: {
      code: "pre_authorization_native_activity",
      reason: "pre_authorization_native_activity",
      classification: "operator_recovery_required",
      native_conversation_id: "native-conversation-1",
      process_retired: true,
    },
  });
  expect(registry.getLineage(dispatch.lineageId as string)).toMatchObject({
    sessionState: "unavailable",
    nativeSession: {
      source: "antigravity",
      kind: "id",
      value: "native-conversation-1",
    },
  });
  expect(harness.promptSubmissions).toBe(0);
  expect(harness.retirements).toBe(1);
  expect(reports.at(-1)).toMatchObject({
    action_id: dispatch.action.action_id,
    state: "failed",
    failure: { code: "pre_authorization_native_activity" },
  });
  await executor.authorizePrompt(dispatch.action.action_id);
  registry.close();
});

test("terminal pre-prompt recovery adopts one prepared process, records history, and gates one prompt", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root, "antigravity");
  const { source, target, lineageId } = preparedProcessRecovery(registry);
  const harness = new PreparedAdoptionHarness(registry, false);
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => true,
    async () => true,
  );

  await executor.start(target.action.action_id);

  const staged = registry.get(target.action.action_id);
  expect(staged).toMatchObject({
    state: "accepted",
    lineageId,
    promptAuthorizedAt: null,
    promptIntentAt: null,
    promptAcceptedAt: null,
    nativeActivityAt: null,
  });
  expect(staged.resultNonce).not.toBe(source.resultNonce);
  expect(harness.adoptionProofs).toBe(1);
  expect(harness.starts).toBe(0);
  expect(harness.promptSubmissions).toBe(0);
  expect(registry.physicalProcessTransition(target.action.action_id)).toEqual(
    expect.objectContaining({
      sourceActionId: source.action.action_id,
      sourceAttemptId: source.action.attempt_id,
      targetActionId: target.action.action_id,
      targetAttemptId: target.action.attempt_id,
      sourceLineageId: lineageId,
      targetLineageId: lineageId,
      mode: "prepared_process_adopted",
      paneId: "pane-prepared",
      terminalId: "terminal-prepared",
    }),
  );
  expect(registry.get(source.action.action_id)).toMatchObject({
    state: "failed",
    promptIntentAt: null,
    promptAcceptedAt: null,
    nativeActivityAt: null,
  });

  await executor.authorizePrompt(target.action.action_id);
  await executor.authorizePrompt(target.action.action_id);
  expect(harness.promptSubmissions).toBe(1);
  expect(registry.list()).toHaveLength(2);
  registry.close();
});

test("failed prepared-process proof retires it and stages a fresh-process fallback in the same new Attempt", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root, "antigravity");
  const { source, target, lineageId } = preparedProcessRecovery(registry);
  const harness = new PreparedAdoptionHarness(registry, true);
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => true,
    async () => true,
  );

  await executor.start(target.action.action_id);

  const staged = registry.get(target.action.action_id);
  expect(staged.action.attempt_id).toBe(target.action.attempt_id);
  expect(staged.lineageId).not.toBe(lineageId);
  expect(staged.promptIntentAt).toBeNull();
  expect(harness.retirements).toBe(1);
  expect(harness.starts).toBe(1);
  expect(harness.promptSubmissions).toBe(0);
  expect(registry.physicalProcessTransition(target.action.action_id)).toEqual(
    expect.objectContaining({
      sourceActionId: source.action.action_id,
      sourceLineageId: lineageId,
      targetLineageId: staged.lineageId,
      mode: "fresh_process_fallback",
    }),
  );
  expect(registry.list()).toHaveLength(2);
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

test("pre-prompt backend loss retries the same Action once without duplicate prompt work", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new PrePromptUnavailableHarness(registry);
  const sessionStates: string[] = [];
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async (_dispatch, lineage) => {
      sessionStates.push(lineage.sessionState);
      return true;
    },
    null,
    0,
  );
  const dispatch = executor.accept(action()).dispatch;

  await executor.start(dispatch.action.action_id);

  expect(registry.list()).toHaveLength(1);
  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "completed",
    action: { attempt_id: dispatch.action.attempt_id },
  });
  expect(harness.starts).toBe(2);
  expect(harness.promptSubmissions).toBe(1);
  expect(sessionStates).toEqual(
    expect.arrayContaining(["unavailable", "recovering"]),
  );
  registry.close();
});

test("persistent pre-prompt backend loss uses normal auto-retryable Attempt accounting", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new AlwaysUnavailableHarness(registry);
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async () => true,
    null,
    0,
  );
  const dispatch = executor.accept(action()).dispatch;

  await executor.start(dispatch.action.action_id);

  expect(registry.list()).toHaveLength(1);
  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "failed",
    promptIntentAt: null,
    action: { attempt_id: dispatch.action.attempt_id },
    failure: {
      code: "backend_unavailable",
      classification: "auto_retryable",
    },
  });
  expect(harness.starts).toBe(2);
  registry.close();
});

test("ambiguous native launch is uncertain and never retried or prompted", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new UncertainLaunchHarness(registry);
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async () => true,
    null,
    0,
  );
  const dispatch = executor.accept(action()).dispatch;

  await executor.start(dispatch.action.action_id);

  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "uncertain",
    promptIntentAt: null,
    failure: {
      code: "agent_launch_uncertain",
      classification: "operator_recovery_required",
    },
  });
  expect(harness.starts).toBe(1);
  expect(harness.promptSubmissions).toBe(0);
  registry.close();
});

test("post-prompt backend loss recovers the exact lineage without resubmission", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new PostPromptUnavailableHarness(registry, false);
  const sessionStates: string[] = [];
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async (_dispatch, lineage) => {
      sessionStates.push(lineage.sessionState);
      return true;
    },
    null,
    0,
  );
  const dispatch = executor.accept(action()).dispatch;

  await executor.start(dispatch.action.action_id);

  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "completed",
    outputs: { change_set: { recovered: true } },
  });
  expect(harness.promptSubmissions).toBe(1);
  expect(harness.recoveries).toBe(1);
  expect(sessionStates).toEqual(
    expect.arrayContaining(["unavailable", "recovering"]),
  );
  registry.close();
});

test("one session.snapshot timeout recovers the exact lineage without false uncertainty", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new SnapshotObservationHarness(registry, 0);
  let recoveredDiagnostic: Record<string, JsonValue> | null = null;
  const executor = new DispatchExecutor(
    registry,
    harness,
    async (payload) => {
      if (payload.state === "running")
        recoveredDiagnostic = registry.get(payload.action_id).failure;
      return true;
    },
    async () => true,
    null,
    0,
  );
  const dispatch = executor.accept(action()).dispatch;

  await executor.start(dispatch.action.action_id);

  expect(registry.get(dispatch.action.action_id).state).toBe("completed");
  expect(harness.promptSubmissions).toBe(1);
  expect(harness.recoveries).toBe(1);
  expect(recoveredDiagnostic).toMatchObject({
    code: "timeout",
    capability: "session.inventory",
  });
  registry.close();
});

test("multiple transient snapshot failures use bounded exact-lineage recovery", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new SnapshotObservationHarness(registry, 2);
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => true,
    async () => true,
    null,
    0,
  );
  const dispatch = executor.accept(action()).dispatch;

  await executor.start(dispatch.action.action_id);

  expect(registry.get(dispatch.action.action_id).state).toBe("completed");
  expect(harness.promptSubmissions).toBe(1);
  expect(harness.recoveries).toBe(3);
  registry.close();
});

test("persisted session.snapshot uncertainty is reversible only after exact recovery", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const unavailable = new SnapshotObservationHarness(registry, 99);
  const first = new DispatchExecutor(
    registry,
    unavailable,
    async () => true,
    async () => true,
    null,
    0,
  );
  const dispatch = first.accept(action()).dispatch;
  await first.start(dispatch.action.action_id);
  registry.fail(
    dispatch.action.action_id,
    {
      reason: "harness_execution_failed",
      code: "timeout",
      classification: "auto_retryable",
      message: "Herdr request timed out: session.snapshot",
    },
    true,
  );

  const recovered = new NativePermissionRecoveryHarness(registry);
  let recoveredSession: HarnessLineage | null = null;
  const second = new DispatchExecutor(
    registry,
    recovered,
    async () => true,
    async (_dispatch, lineage) => {
      if (lineage.sessionState === "waiting_for_human")
        recoveredSession = lineage;
      return true;
    },
    null,
    0,
  );
  await second.start(dispatch.action.action_id);

  expect(registry.get(dispatch.action.action_id).state).toBe("completed");
  expect(unavailable.promptSubmissions).toBe(1);
  expect(recovered.promptSubmissions).toBe(0);
  expect(recovered.recoveries).toBe(1);
  expect(recoveredSession).toMatchObject({
    sessionState: "waiting_for_human",
    attention: {
      attentionId: "native-step-18",
      category: "needs_permission",
    },
  });
  registry.close();
});

test("post-prompt recovery uncertainty never duplicates model work", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new PostPromptUnavailableHarness(registry, true);
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async () => true,
    null,
    0,
  );
  const dispatch = executor.accept(action()).dispatch;

  await executor.start(dispatch.action.action_id);

  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "uncertain",
    failure: {
      code: "backend_unavailable",
      classification: "auto_retryable",
    },
  });
  expect(harness.promptSubmissions).toBe(1);
  expect(harness.recoveries).toBe(1);

  const replacement = new SnapshotObservationHarness(registry, 0, false);
  await new DispatchExecutor(
    registry,
    replacement,
    async () => true,
    async () => true,
    null,
    0,
  ).start(dispatch.action.action_id);
  expect(registry.get(dispatch.action.action_id).state).toBe("uncertain");
  expect(replacement.recoveries).toBe(0);
  expect(replacement.promptSubmissions).toBe(0);
  registry.close();
});

test("a known post-acceptance harness violation is failed, not uncertain", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new AcceptedContractFailureHarness(registry);
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async () => true,
    null,
    0,
  );
  const dispatch = executor.accept(action()).dispatch;

  await executor.start(dispatch.action.action_id);

  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "failed",
    failure: {
      code: "harness_contract_violation",
      classification: "terminal_not_recoverable",
    },
  });
  registry.close();
});

test("restart projects terminal uncertainty with an exited native process as unavailable", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new ExitedNativeHarness(registry);
  const dispatch = registry.accept(action()).dispatch;
  registry.occupy(dispatch.lineageId as string, dispatch.action.action_id);
  registry.fail(
    dispatch.action.action_id,
    {
      code: "harness_contract_violation",
      classification: "terminal_not_recoverable",
    },
    true,
  );
  const reported: HarnessLineage[] = [];
  await new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async (_dispatch, lineage) => {
      reported.push(lineage);
      return true;
    },
  ).recoverAll();

  expect(harness.starts).toBe(0);
  expect(registry.get(dispatch.action.action_id).state).toBe("uncertain");
  expect(registry.getLineage(dispatch.lineageId as string).sessionState).toBe(
    "unavailable",
  );
  expect(reported[0]?.sessionState).toBe("unavailable");
  registry.close();
});

test("incompatible backend contract fails visibly without transient retry", async () => {
  const { root, database } = await fixture();
  const registry = new DispatchRegistry(database, root);
  const harness = new IncompatibleBackendHarness(registry);
  const executor = new DispatchExecutor(
    registry,
    harness,
    async () => false,
    async () => true,
    null,
    0,
  );
  const dispatch = executor.accept(action()).dispatch;

  await executor.start(dispatch.action.action_id);

  expect(registry.get(dispatch.action.action_id)).toMatchObject({
    state: "failed",
    failure: {
      code: "backend_incompatible",
      classification: "operator_recovery_required",
      message: expect.stringContaining("agent.prompt"),
    },
  });
  expect(harness.starts).toBe(1);
  expect(registry.getLineage(dispatch.lineageId as string).sessionState).toBe(
    "unavailable",
  );
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
  readonly displayName: string;
  readonly integrationStrategy = "native_rpc" as const;
  readonly capabilities = {
    structuredResult: true,
    continuation: true,
    retainedSessionRecovery: true,
    structuredAttention: false,
    nativeBlocking: false,
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
  interrupts = 0;
  sawDurableAcceptance = false;
  constructor(
    private readonly registry: DispatchRegistry,
    readonly kind = "fake",
  ) {
    this.displayName = kind;
  }
  async discover(): Promise<HarnessDiscovery> {
    return {
      kind: this.kind,
      displayName: this.displayName,
      strategy: this.integrationStrategy,
      integration: {
        status: "ready" as const,
        detail: "Test adapter ready.",
        installed: true,
        authenticated: true,
      },
      models: [
        {
          provider: "fake",
          model: "test",
          displayName: "Test",
          accountAvailability: "verified_available",
          reasoningCapability: { kind: "enumerated", values: ["medium"] },
        },
      ],
      capabilities: this.capabilities,
    };
  }
  async start(
    dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    this.starts += 1;
    this.sawDurableAcceptance =
      this.registry.get(dispatch.action.action_id).state === "accepted";
    return prepared(lineage);
  }
  async continue(
    _dispatch: DispatchRecord,
    lineage: HarnessLineage,
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
  async recover(_lineage: HarnessLineage): Promise<HarnessRecoveredExecution> {
    return { found: false, detail: "not used" };
  }
  async waitAndCollect(): Promise<Record<string, JsonValue>> {
    return { change_set: { version: 1 } };
  }
  async interrupt() {
    this.interrupts += 1;
  }
  async inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    return inspection(lineage);
  }
  async close() {}
  async clearActiveMetadata() {}
  async discoverAdoptionCandidates() {
    return [];
  }
  attachment(lineage: HarnessLineage) {
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

class StagedRecoveryHarness extends InspectingProvider {
  promptSubmissions = 0;

  override async recover(
    lineage: HarnessLineage,
  ): Promise<HarnessRecoveredExecution> {
    return {
      found: true,
      agent: prepared(lineage).agent,
      detail: "Recovered staged zero-inference process.",
    };
  }

  override async sendInputAndCollect(
    _dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    this.promptSubmissions += 1;
    onEvent({ type: "running", inspection: inspection(execution.lineage) });
    return { change_set: { staged: true } };
  }
}

class ContaminatedStagedRecoveryHarness extends StagedRecoveryHarness {
  nativeConversationId: string | null = null;
  retirements = 0;

  async observePreAuthorizationActivity() {
    if (!this.nativeConversationId) return null;
    return {
      observedAt: "2026-09-19T02:06:44.382Z",
      nativeSession: {
        source: "antigravity" as const,
        agent: "agy",
        kind: "id" as const,
        value: this.nativeConversationId,
      },
      evidence: "native_user_message" as const,
    };
  }

  async retire(): Promise<void> {
    this.retirements += 1;
  }
}

class PreparedAdoptionHarness extends StagedRecoveryHarness {
  adoptionProofs = 0;
  retirements = 0;

  constructor(
    registry: DispatchRegistry,
    private readonly rejectAdoption: boolean,
  ) {
    super(registry, "antigravity");
  }

  async provePreparedProcessAdoption(): Promise<void> {
    this.adoptionProofs += 1;
    if (this.rejectAdoption)
      throw Object.assign(new Error("Prepared process provenance differs."), {
        code: "prepared_process_adoption_rejected",
      });
  }

  async retire(): Promise<void> {
    this.retirements += 1;
  }
}

function preparedProcessRecovery(registry: DispatchRegistry) {
  const sourceAction = action({
    action_id: "prepared-source-action",
    attempt_id: "prepared-attempt-3",
  });
  sourceAction.execution.configuration.harness_kind = "antigravity";
  const source = registry.accept(sourceAction).dispatch;
  const lineageId = source.lineageId as string;
  registry.recordHost(lineageId, {
    herdrSession: "qe-worker-test",
    herdrSessionIncarnation: "session-incarnation-1",
    workspaceId: "workspace-prepared",
    tabId: "tab-prepared",
    paneId: "pane-prepared",
    terminalId: "terminal-prepared",
    agentName: "agent-prepared",
  });
  registry.occupy(lineageId, source.action.action_id);
  registry.fail(source.action.action_id, {
    code: "execution_control_readiness_failed",
    reason: "execution_control_readiness_failed",
    classification: "operator_recovery_required",
  });

  const targetAction = action({
    action_id: "prepared-target-action",
    attempt_id: "prepared-attempt-4",
    operational_recovery: {
      epoch_number: 3,
      attempt_in_epoch: 1,
      attempt_allowance: 2,
      authorization_kind: "human",
      continuation_mode: "retained",
      retained_lineage_id: lineageId,
      source_attempt_id: source.action.attempt_id,
      request_id: "prepared-recovery-request",
    },
  });
  targetAction.execution.configuration.harness_kind = "antigravity";
  targetAction.execution.context.logical_lineage_id =
    source.action.execution.context.logical_lineage_id;
  const target = registry.accept(targetAction).dispatch;
  return { source, target, lineageId };
}

class PrePromptUnavailableHarness extends InspectingProvider {
  promptSubmissions = 0;

  override async start(
    _dispatch: DispatchRecord,
    lineage: HarnessLineage,
  ): Promise<HarnessPreparedExecution> {
    this.starts += 1;
    if (this.starts === 1)
      throw new HerdrApiError(
        "backend_unavailable",
        "Herdr temporarily unavailable before launch.",
      );
    return prepared(lineage);
  }

  override async sendInputAndCollect(
    _dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    this.promptSubmissions += 1;
    onEvent({ type: "running", inspection: inspection(execution.lineage) });
    return { change_set: { recovered: true } };
  }
}

class AlwaysUnavailableHarness extends InspectingProvider {
  override async start(): Promise<HarnessPreparedExecution> {
    this.starts += 1;
    throw new HerdrApiError(
      "backend_unavailable",
      "Herdr remained unavailable before launch.",
    );
  }
}

class UncertainLaunchHarness extends InspectingProvider {
  promptSubmissions = 0;

  override async start(): Promise<HarnessPreparedExecution> {
    this.starts += 1;
    throw new HerdrApiError(
      "agent_launch_uncertain",
      "Herdr accepted launch but native inventory was unavailable.",
      "agent.interactive_launch",
    );
  }

  override async sendInputAndCollect(): Promise<Record<string, JsonValue>> {
    this.promptSubmissions += 1;
    return {};
  }
}

class PostPromptUnavailableHarness extends InspectingProvider {
  promptSubmissions = 0;
  recoveries = 0;

  constructor(
    registry: DispatchRegistry,
    private readonly recoveryUnavailable: boolean,
  ) {
    super(registry);
  }

  override async sendInputAndCollect(
    _dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    this.promptSubmissions += 1;
    onEvent({
      type: "prompt_accepted",
      acceptedAt: new Date().toISOString(),
      inspection: inspection(execution.lineage),
    });
    throw new HerdrApiError(
      "backend_unavailable",
      "Herdr disconnected after prompt intent.",
    );
  }

  override async recover(
    lineage: HarnessLineage,
  ): Promise<HarnessRecoveredExecution> {
    this.recoveries += 1;
    if (this.recoveryUnavailable)
      throw new HerdrApiError(
        "backend_unavailable",
        "Herdr remained unavailable during exact-lineage recovery.",
      );
    return {
      found: true,
      agent: { ...prepared(lineage).agent, status: "working" as const },
      detail: "Recovered exact test lineage.",
    };
  }

  override async waitAndCollect(): Promise<Record<string, JsonValue>> {
    return { change_set: { recovered: true } };
  }
}

class SnapshotObservationHarness extends InspectingProvider {
  promptSubmissions = 0;
  recoveries = 0;

  constructor(
    registry: DispatchRegistry,
    private readonly transientRecoveryFailures: number,
    private readonly failInitialCollection = true,
  ) {
    super(registry);
  }

  override async sendInputAndCollect(
    _dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    this.promptSubmissions += 1;
    onEvent({
      type: "prompt_accepted",
      acceptedAt: new Date().toISOString(),
      inspection: inspection(execution.lineage),
    });
    if (this.failInitialCollection) throw snapshotTimeout();
    return { change_set: { recovered: true } };
  }

  override async recover(
    lineage: HarnessLineage,
  ): Promise<HarnessRecoveredExecution> {
    this.recoveries += 1;
    if (this.recoveries <= this.transientRecoveryFailures)
      throw snapshotTimeout();
    return {
      found: true,
      agent: { ...prepared(lineage).agent, status: "working" as const },
      detail:
        "Recovered the exact lineage after inventory observation resumed.",
    };
  }

  override async waitAndCollect(): Promise<Record<string, JsonValue>> {
    return { change_set: { recovered: true } };
  }
}

class NativePermissionRecoveryHarness extends SnapshotObservationHarness {
  constructor(registry: DispatchRegistry) {
    super(registry, 0, false);
  }

  override async inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    return {
      ...inspection(lineage),
      state: "waiting_for_human" as const,
      attention: {
        attentionId: "native-step-18",
        category: "needs_permission" as const,
        message: "RunCommand requires approval in Antigravity.",
        requestedAt: "2026-09-17T04:55:58.365Z",
        interaction: {
          kind: "conversational_intervention" as const,
          controlState: "intervention_pending" as const,
        },
      },
    };
  }
}

function snapshotTimeout(): HerdrApiError {
  return new HerdrApiError(
    "timeout",
    "Herdr request timed out: session.snapshot",
    "session.inventory",
  );
}

class AcceptedContractFailureHarness extends InspectingProvider {
  override async sendInputAndCollect(
    _dispatch: DispatchRecord,
    execution: HarnessPreparedExecution,
    onEvent: (event: HarnessEvent) => void,
  ): Promise<Record<string, JsonValue>> {
    onEvent({
      type: "prompt_accepted",
      acceptedAt: new Date().toISOString(),
      inspection: inspection(execution.lineage),
    });
    throw new HerdrApiError(
      "harness_contract_violation",
      "The native turn settled without an authorized result.",
    );
  }
}

class ExitedNativeHarness extends InspectingProvider {
  override async inspect(lineage: HarnessLineage): Promise<HarnessInspection> {
    return { ...inspection(lineage), state: "unavailable" };
  }
}

class IncompatibleBackendHarness extends InspectingProvider {
  override async start(): Promise<HarnessPreparedExecution> {
    this.starts += 1;
    throw new HerdrApiError(
      "backend_incompatible",
      "Herdr cannot prove QE capability 'agent.prompt'.",
      "agent.prompt",
    );
  }
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

function inspection(lineage: HarnessLineage) {
  return {
    state: "running" as const,
    agent: prepared(lineage).agent,
    attention: null,
    intervention: null,
    lastActivityAt: new Date().toISOString(),
  };
}

function prepared(lineage: HarnessLineage): HarnessPreparedExecution {
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
