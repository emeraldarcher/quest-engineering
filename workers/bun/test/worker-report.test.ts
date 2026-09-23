import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ReconcileDispatch } from "../src/protocol/types.ts";
import {
  cancellationServerGeneration,
  dispatchReportMessage,
  retainedDiffFingerprint,
} from "../src/worker.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const dispatch: ReconcileDispatch = {
  action_id: "action-1",
  occurrence_id: "occurrence-1",
  attempt_id: "attempt-1",
  state: "running",
};

test("cancellation fencing uses the durable server generation after a process restart", () => {
  const channel = {
    isCurrentGeneration: (generation: number) => generation === 1,
    currentServerGeneration: () => 4,
  };

  expect(cancellationServerGeneration(channel, 1)).toBe(4);
  expect(() => cancellationServerGeneration(channel, 2)).toThrow("stale");
  expect(() =>
    cancellationServerGeneration(
      { ...channel, currentServerGeneration: () => null },
      1,
    ),
  ).toThrow("server registration generation");
});

test("running dispatch state omits terminal fields", () => {
  expect(dispatchReportMessage("worker-1", dispatch, "dispatch_state")).toEqual(
    {
      type: "dispatch_state",
      protocol_version: 9,
      worker_id: "worker-1",
      action_id: "action-1",
      occurrence_id: "occurrence-1",
      attempt_id: "attempt-1",
      state: "running",
    },
  );
});

test("uncertain dispatch state includes the structured failure required by protocol v9", () => {
  expect(
    dispatchReportMessage(
      "worker-1",
      {
        ...dispatch,
        state: "uncertain",
        failure: {
          reason: "provider_execution_failed",
          message: "Pi settled without a structured step result.",
        },
      },
      "dispatch_state",
    ),
  ).toMatchObject({
    type: "dispatch_state",
    state: "uncertain",
    failure: {
      reason: "provider_execution_failed",
      message: "Pi settled without a structured step result.",
    },
  });
});

test("retained recovery fingerprints tracked and untracked content without changing it", async () => {
  const parent = join(process.cwd(), ".pi", "tmp");
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "retained-diff-"));
  roots.push(root);
  const git = async (...args: string[]) => {
    const child = Bun.spawn(["git", "-C", root, ...args], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const error = await new Response(child.stderr).text();
    if ((await child.exited) !== 0) throw new Error(error);
  };
  await git("init", "-q");
  await git("config", "user.name", "QE Test");
  await git("config", "user.email", "qe@example.invalid");
  await writeFile(join(root, "tracked.txt"), "base\n");
  await git("add", "tracked.txt");
  await git("commit", "-qm", "base");
  await writeFile(join(root, "tracked.txt"), "changed\n");
  await writeFile(join(root, "untracked.txt"), "one\n");

  const first = await retainedDiffFingerprint(root);
  const repeated = await retainedDiffFingerprint(root);
  expect(first.changed).toBe(true);
  expect(repeated.digest).toBe(first.digest);
  await writeFile(join(root, "untracked.txt"), "two\n");
  expect((await retainedDiffFingerprint(root)).digest).not.toBe(first.digest);
});

test("uncertain dispatch state receives an object fallback failure", () => {
  expect(
    dispatchReportMessage(
      "worker-1",
      { ...dispatch, state: "uncertain" },
      "dispatch_state",
    ),
  ).toMatchObject({
    state: "uncertain",
    failure: { reason: "execution_uncertain" },
  });
});
