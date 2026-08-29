import { expect, test } from "bun:test";
import type { RunProjection } from "../api/contracts";
import { projectRunWorld } from "./projector";

const member = (key: string) => ({
  member_key: key,
  name: key,
  class: { id: `${key}-class`, key: "builder", name: "Builder" },
  loadout: { id: `${key}-loadout`, key: "coding", name: "Coding" },
});
const base = (): RunProjection => ({
  id: "run-1",
  status: "running",
  launched_at: "2026-01-01T00:00:00Z",
  revision: 1,
  quest: { id: "quest", title: "Quest", objective: "Work" },
  execution_environment: {
    workspace: { id: "workspace", key: "workspace", name: "Workspace" },
    state: "ready",
    message: "Run workspace ready.",
    base_revision: "abc",
    branch: "qe/run/test",
    source_dirty_changes_excluded: false,
    issue: null,
  },
  squad: {
    id: "squad",
    key: "squad",
    name: "Squad",
    members: [member("alice"), member("bob")],
  },
  artifacts: [],
  issues: [],
  step_counts: {
    pending: 0,
    waiting: 0,
    scheduled: 0,
    running: 0,
    completed: 0,
    failed: 0,
    uncertain: 0,
  },
  steps: [],
});
const step = (
  state: "pending" | "waiting" | "scheduled" | "running",
  bound = false,
) => ({
  occurrence_id: `occ-${state}`,
  semantic_step_key: state,
  name: state,
  instruction: "Work",
  state,
  phase: null,
  remediation_cycle: null,
  control_path: [],
  member: bound ? member("alice") : null,
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
});

test("pending and waiting remain work orders without fabricated Member assignment", () => {
  const run = base();
  run.steps = [step("pending"), step("waiting")];
  const world = projectRunWorld(run);
  expect(world.members.map((item) => item.visual)).toEqual(["idle", "idle"]);
  expect(world.orderMarkers.map((item) => item.state)).toEqual([
    "pending",
    "waiting",
  ]);
});

test("parallel bound running work projects simultaneously", () => {
  const run = base();
  run.steps = [
    step("running", true),
    {
      ...step("scheduled", false),
      occurrence_id: "occ-bob",
      member: member("bob"),
    },
  ];
  const world = projectRunWorld(run);
  expect(world.members.map((item) => item.visual)).toEqual([
    "working",
    "moving_to_work",
  ]);
});
