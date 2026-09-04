import { expect, test } from "bun:test";
import type { RunProjection, RunStep, StepState } from "../../api/contracts";
import { projectActiveCrewActivities } from "./active-crew";

function run(id: string, squadId: string, states: StepState[]): RunProjection {
  const member = {
    member_key: "alex",
    name: "Alex",
    class: { id: `class-${squadId}`, key: "builder", name: "Builder" },
    loadout: { id: "loadout", key: "coding", name: "Coding" },
  };
  const steps: RunStep[] = states.map((state, index) => ({
    occurrence_id: `${id}-occ-${index}`,
    semantic_step_key: index ? "review" : "implement",
    name: index ? "Review" : "Implement",
    instruction: "Work",
    state,
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
  }));
  return {
    id,
    status: "running",
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
      id: squadId,
      key: squadId,
      name: `Squad ${squadId}`,
      members: [member],
    },
    steps,
    artifacts: [],
    step_counts: {
      pending: 0,
      waiting: 0,
      scheduled: 0,
      running: states.filter((state) => state === "running").length,
      completed: 0,
      failed: 0,
      uncertain: 0,
    },
    issues: [],
  };
}

test("only running occurrences with a named Member become active crew", () => {
  const value = run("one", "squad-a", [
    "pending",
    "waiting",
    "scheduled",
    "running",
    "completed",
    "failed",
    "uncertain",
  ]);
  const activities = projectActiveCrewActivities([value]);
  expect(activities).toHaveLength(1);
  expect(activities[0]?.state).toBe("running");
  expect(activities[0]?.project).toEqual(value.execution_environment.workspace);
  value.steps[3] = { ...(value.steps[3] as RunStep), member: null };
  expect(projectActiveCrewActivities([value])).toEqual([]);
});

test("multiple Runs project independently without display-name collisions", () => {
  const activities = projectActiveCrewActivities([
    run("run-a", "squad-a", ["running"]),
    run("run-b", "squad-b", ["running"]),
  ]);
  expect(activities).toHaveLength(2);
  expect(new Set(activities.map((activity) => activity.actorId)).size).toBe(2);
  expect(activities.every((activity) => activity.member.name === "Alex")).toBe(
    true,
  );
});

test("zero running occurrences means zero active crew", () => {
  expect(
    projectActiveCrewActivities([run("run", "squad", ["waiting"])]),
  ).toEqual([]);
});
