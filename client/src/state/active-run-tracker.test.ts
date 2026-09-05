import { expect, test } from "bun:test";
import type { RunProjection, RunSummary } from "../api/contracts";
import { ActiveRunTracker } from "./active-run-tracker";

function projection(
  id: string,
  status: RunProjection["status"] = "running",
): RunProjection {
  const member = {
    member_key: `member-${id}`,
    name: `Member ${id}`,
    class: { id: "class", key: "builder", name: "Builder" },
    loadout: { id: "loadout", key: "coding", name: "Coding" },
  };
  return {
    id,
    status,
    launched_at: "2026-01-01T00:00:00Z",
    revision: 1,
    launch: { id: `launch-${id}` },
    quest: { id: `quest-${id}`, title: `Quest ${id}`, objective: "Work" },
    execution_environment: {
      workspace: { id: "workspace", key: "workspace", name: "Workspace" },
      state: "ready",
      message: "Ready",
      base_revision: "abc",
      branch: `qe/run/${id}`,
      source_dirty_changes_excluded: false,
      issue: null,
    },
    delivery: null,
    squad: {
      id: `squad-${id}`,
      key: `squad-${id}`,
      name: `Squad ${id}`,
      members: [member],
    },
    steps:
      status === "completed" || status === "failed"
        ? []
        : [
            {
              occurrence_id: `occ-${id}`,
              semantic_step_key: "implement",
              name: "Implement",
              instruction: "Work",
              state: "running",
              phase: null,
              remediation_cycle: null,
              control_path: [],
              attempt: null,
              member,
              performer: {
                selector: "class",
                class_key: "builder",
                source_occurrence_id: null,
                source_semantic_step_key: null,
              },
              context: {
                mode: "fresh",
                source_occurrence_id: null,
                source_semantic_step_key: null,
              },
              inputs: [],
              outputs: [],
              issue: null,
            },
          ],
    artifacts: [],
    step_counts: {
      pending: 0,
      waiting: 0,
      scheduled: 0,
      running: status === "completed" || status === "failed" ? 0 : 1,
      completed: status === "completed" ? 1 : 0,
      failed: status === "failed" ? 1 : 0,
      uncertain: 0,
    },
    issues: [],
  };
}

function summary(id: string, status = "running"): RunSummary {
  const value = projection(id, status as RunProjection["status"]);
  return {
    id,
    status,
    quest_title: value.quest.title,
    launched_at: value.launched_at,
    step_counts: value.step_counts,
    delivery: null,
  };
}

async function settle(): Promise<void> {
  await Bun.sleep(0);
}

test("tracks zero, one, and multiple nonterminal Runs without historical details", async () => {
  const calls: string[] = [];
  const watches: string[] = [];
  let latest: string[] = [];
  const tracker = new ActiveRunTracker({
    getRun: async (id) => {
      calls.push(id);
      return projection(id);
    },
    watchRun: (id) => {
      watches.push(id);
      return () => undefined;
    },
    onActivities: (activities) => {
      latest = activities.map((activity) => activity.runId);
    },
  });
  tracker.updateSummaries([]);
  expect(calls).toEqual([]);
  tracker.updateSummaries([summary("a"), summary("old", "completed")]);
  await settle();
  expect(calls).toEqual(["a"]);
  expect(latest).toEqual(["a"]);
  tracker.updateSummaries([
    summary("a"),
    summary("b"),
    summary("old", "completed"),
  ]);
  await settle();
  expect(calls).toEqual(["a", "b"]);
  expect(watches).toEqual(["a", "b"]);
  expect(tracker.trackedRunIds()).toEqual(["a", "b"]);
  expect(latest.sort()).toEqual(["a", "b"]);
});

test("a subscribed Run adds crew only when its occurrence becomes running", async () => {
  let current = projection("a");
  const firstStep = current.steps[0];
  if (!firstStep) throw new Error("Missing fixture Step");
  current = { ...current, steps: [{ ...firstStep, state: "waiting" }] };
  let activeCount = -1;
  const tracker = new ActiveRunTracker({
    getRun: async () => current,
    watchRun: () => () => undefined,
    onActivities: (activities) => {
      activeCount = activities.length;
    },
  });
  tracker.updateSummaries([summary("a", "waiting")]);
  await settle();
  expect(activeCount).toBe(0);
  current = projection("a");
  tracker.invalidate("a");
  await settle();
  expect(activeCount).toBe(1);
});

test("terminal projections unsubscribe and remove active crew promptly", async () => {
  let current = projection("a");
  let releases = 0;
  let activeCount = 0;
  const selectedStatuses: RunProjection["status"][] = [];
  const tracker = new ActiveRunTracker({
    getRun: async () => current,
    watchRun: () => () => {
      releases += 1;
    },
    onActivities: (activities) => {
      activeCount = activities.length;
    },
    onProjection: (value) => {
      selectedStatuses.push(value.status);
    },
  });
  tracker.updateSummaries([summary("a")]);
  await settle();
  expect(activeCount).toBe(1);
  current = projection("a", "completed");
  tracker.invalidate("a");
  await settle();
  expect(activeCount).toBe(0);
  expect(tracker.trackedRunIds()).toEqual([]);
  expect(selectedStatuses.at(-1)).toBe("completed");
  expect(releases).toBe(1);
});

test("duplicate Product invalidation, in-flight invalidation, and reconnect are deduplicated", async () => {
  let calls = 0;
  const resolvers: Array<(value: RunProjection) => void> = [];
  const tracker = new ActiveRunTracker({
    getRun: () => {
      calls += 1;
      return new Promise((resolve) => {
        resolvers.push(resolve);
      });
    },
    watchRun: () => () => undefined,
    onActivities: () => undefined,
  });
  tracker.updateSummaries([summary("a")]);
  tracker.updateSummaries([summary("a")]);
  tracker.invalidate("a");
  tracker.invalidate("a");
  expect(calls).toBe(1);
  resolvers.shift()?.(projection("a"));
  await settle();
  expect(calls).toBe(2);
  resolvers.shift()?.(projection("a"));
  await settle();
  expect(tracker.snapshot()).toHaveLength(1);
  tracker.suspend();
  expect(tracker.snapshot()).toEqual([]);
  tracker.reconnect();
  expect(calls).toBe(3);
});
