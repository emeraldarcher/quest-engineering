import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  collectStepResult,
  readControl,
  type StepResultEnvelope,
  writeControlAtomic,
  writeStepResultAtomic,
} from "../src/providers/pi/result-envelope.ts";
import { action } from "./support.ts";

const roots: string[] = [];
async function root() {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const value = await mkdtemp(join(parent, "bun-worker-result-"));
  roots.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

test("atomically replaces one lineage control file for a continued Action", async () => {
  const directory = await root();
  const path = join(directory, "lineage", "control.json");
  const first = action();
  await writeControlAtomic(path, {
    protocolVersion: 1,
    workerId: first.worker_id,
    lineageId: "lineage",
    action: first,
    nonce: "nonce-1",
    resultDirectory: join(directory, "result-1"),
  });
  const second = action({
    action_id: "action-2",
    occurrence_id: "occurrence-2",
    attempt_id: "attempt-2",
  });
  await writeControlAtomic(path, {
    protocolVersion: 1,
    workerId: second.worker_id,
    lineageId: "lineage",
    action: second,
    nonce: "nonce-2",
    resultDirectory: join(directory, "result-2"),
  });
  expect(await readControl(path)).toMatchObject({
    lineageId: "lineage",
    action: { action_id: "action-2" },
    nonce: "nonce-2",
  });
});

test("collects exactly one nonce-bound result and rejects wrong output sets", async () => {
  const directory = await root();
  const dispatch = {
    action: action(),
    resultNonce: "nonce",
    resultDirectory: join(directory, "result"),
  };
  const envelope: StepResultEnvelope = {
    protocolVersion: 1,
    kind: "quest_engineering_step_result",
    workerId: dispatch.action.worker_id,
    actionId: dispatch.action.action_id,
    runId: dispatch.action.run_id,
    occurrenceId: dispatch.action.occurrence_id,
    attemptId: dispatch.action.attempt_id,
    nonce: dispatch.resultNonce,
    createdAt: new Date().toISOString(),
    outputs: { change_set: { version: 1 } },
  };
  await writeStepResultAtomic(dispatch.resultDirectory, "call", envelope);
  expect((await collectStepResult(dispatch)).envelope.outputs).toEqual(
    envelope.outputs,
  );

  const malformed = {
    ...dispatch,
    resultDirectory: join(directory, "malformed"),
  };
  await writeStepResultAtomic(malformed.resultDirectory, "call", {
    ...envelope,
    outputs: { undeclared: true },
  });
  await expect(collectStepResult(malformed)).rejects.toThrow("do not match");
});

test("rejects missing, duplicate, and wrong-nonce results", async () => {
  const directory = await root();
  const dispatch = {
    action: action(),
    resultNonce: "nonce",
    resultDirectory: join(directory, "result"),
  };
  await expect(collectStepResult(dispatch)).rejects.toThrow(
    "without a structured",
  );
  const envelope: StepResultEnvelope = {
    protocolVersion: 1,
    kind: "quest_engineering_step_result",
    workerId: "worker-test",
    actionId: "action-1",
    runId: "run-1",
    occurrenceId: "occurrence-1",
    attemptId: "attempt-1",
    nonce: "wrong",
    createdAt: new Date().toISOString(),
    outputs: { change_set: {} },
  };
  await writeStepResultAtomic(dispatch.resultDirectory, "one", envelope);
  await expect(collectStepResult(dispatch)).rejects.toThrow("identity");
  await writeStepResultAtomic(dispatch.resultDirectory, "two", {
    ...envelope,
    nonce: "nonce",
  });
  await expect(collectStepResult(dispatch)).rejects.toThrow("exactly one");
});
