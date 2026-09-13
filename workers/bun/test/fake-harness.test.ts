import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { DispatchRegistry } from "../src/dispatch/registry.ts";
import { FakeHarness } from "../src/harnesses/fake/adapter.ts";
import type { HarnessEvent } from "../src/harnesses/types.ts";
import { action } from "./support.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

test("takeover-capable fake harness escalates a material missing human decision", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fake-escalation-"));
  roots.push(root);
  const harness = new FakeHarness({ change_set: { complete: true } }, 0, {
    autoEscalateMaterialMissingDecision: true,
    conversationalTakeover: true,
  });
  const registry = new DispatchRegistry(
    join(root, "state.sqlite"),
    root,
    harness.kind,
    harness.capabilities,
  );
  const dispatch = registry.accept(
    action({
      execution: {
        ...action().execution,
        work: {
          ...action().execution.work,
          quest_objective:
            "Create a harmless test file according to the instructions you receive during implementation.",
          step_instruction: "Implement the Quest objective.",
        },
      },
    }),
  ).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await harness.start(dispatch, lineage);
  const events: HarnessEvent[] = [];
  const operation = harness.sendInputAndCollect(dispatch, prepared, (event) =>
    events.push(event),
  );
  await Bun.sleep(0);

  expect((await harness.inspect(lineage)).attention).toMatchObject({
    message: "Required filename and file contents are missing.",
    interaction: { kind: "conversational_intervention" },
  });
  expect(
    events.some((event) => event.inspection.state === "waiting_for_human"),
  ).toBe(true);
  harness.resumeAutomation(lineage);
  expect(await operation).toEqual({ change_set: { complete: true } });
  registry.close();
});

test("fake harness degrades missing-decision escalation without claiming takeover", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fake-structured-escalation-"));
  roots.push(root);
  const harness = new FakeHarness({}, 0, {
    autoEscalateMaterialMissingDecision: true,
  });
  const registry = new DispatchRegistry(
    join(root, "state.sqlite"),
    root,
    harness.kind,
    harness.capabilities,
  );
  const base = action();
  const dispatch = registry.accept(
    action({
      execution: {
        ...base.execution,
        work: {
          ...base.execution.work,
          quest_objective:
            "Create a file according to instructions the human will provide.",
          step_instruction: "Implement.",
        },
      },
    }),
  ).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const operation = harness.sendInputAndCollect(
    dispatch,
    await harness.start(dispatch, lineage),
    () => undefined,
  );
  await Bun.sleep(0);
  expect(
    (await harness.inspect(lineage)).attention?.interaction,
  ).toBeUndefined();
  harness.provideInput(lineage);
  await operation;
  registry.close();
});

test("fake escalation policy leaves ordinary engineering choices to the agent", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fake-no-escalation-"));
  roots.push(root);
  const harness = new FakeHarness({ change_set: { complete: true } }, 0, {
    autoEscalateMaterialMissingDecision: true,
    conversationalTakeover: true,
  });
  const registry = new DispatchRegistry(
    join(root, "state.sqlite"),
    root,
    harness.kind,
    harness.capabilities,
  );
  const base = action();
  const dispatch = registry.accept(
    action({
      execution: {
        ...base.execution,
        work: {
          ...base.execution.work,
          quest_objective: "Add focused tests for the existing parser.",
          step_instruction:
            "Use ordinary engineering judgment for internal names and implementation details.",
        },
      },
    }),
  ).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  expect(
    await harness.sendInputAndCollect(
      dispatch,
      await harness.start(dispatch, lineage),
      () => undefined,
    ),
  ).toEqual({ change_set: { complete: true } });
  expect((await harness.inspect(lineage)).attention).toBeNull();
  registry.close();
});

test("fake harness starts, requests attention, resumes, completes, interrupts and recovers", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "fake-harness-"));
  roots.push(root);
  const harness = new FakeHarness({ change_set: { complete: true } });
  const registry = new DispatchRegistry(
    join(root, "state.sqlite"),
    root,
    harness.kind,
    harness.capabilities,
  );
  const dispatch = registry.accept(action()).dispatch;
  const lineage = registry.getLineage(dispatch.lineageId as string);
  const prepared = await harness.start(dispatch, lineage);
  const attention = harness.requestAttention(
    lineage,
    "needs_input",
    "Choose an option.",
  );
  const events: HarnessEvent[] = [];
  let completed = false;
  const operation = harness
    .sendInputAndCollect(dispatch, prepared, (event) => events.push(event))
    .then((outputs) => {
      completed = true;
      return outputs;
    });
  await Bun.sleep(0);

  expect(completed).toBe(false);
  expect((await harness.inspect(lineage)).attention?.attentionId).toBe(
    attention.attention?.attentionId,
  );
  harness.provideInput(lineage);
  harness.emitOutput(lineage);
  expect(await operation).toEqual({ change_set: { complete: true } });
  expect(events.map((event) => event.inspection.state)).toEqual([
    "running",
    "waiting_for_human",
    "running",
    "running",
  ]);

  await harness.interrupt(lineage);
  expect((await harness.inspect(lineage)).state).toBe("retained");
  expect((await harness.recover(lineage)).found).toBe(true);
  await harness.close(lineage);
  expect((await harness.inspect(lineage)).state).toBe("closed");
  expect((await harness.recover(lineage)).found).toBe(false);

  const failedDispatch = registry.accept(
    action({
      action_id: "failed-action",
      occurrence_id: "failed-occurrence",
      attempt_id: "failed-attempt",
    }),
  ).dispatch;
  const failedLineage = registry.getLineage(failedDispatch.lineageId as string);
  harness.failNext("simulated failure");
  await expect(
    harness.sendInputAndCollect(
      failedDispatch,
      await harness.start(failedDispatch, failedLineage),
      () => undefined,
    ),
  ).rejects.toThrow("simulated failure");
  registry.close();
});
