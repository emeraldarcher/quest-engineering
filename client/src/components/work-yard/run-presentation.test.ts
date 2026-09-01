import { describe, expect, test } from "bun:test";
import type { Quest, RunProjection, RunStep } from "../../api/contracts";
import {
  canCleanUp,
  canRunAgain,
  diagnosticPresentation,
  questPresentation,
  stepDisplayName,
} from "./run-presentation";

function run(): RunProjection {
  return {
    id: "run-current",
    status: "completed",
    launched_at: "2026-09-01T12:00:00Z",
    revision: 1,
    launch: { id: "launch-current" },
    quest: { id: "quest-1", title: "Quest", objective: "Work" },
    execution_environment: {
      workspace: { id: "workspace", key: "workspace", name: "Project" },
      state: "retained",
      message: "Retained.",
      base_revision: "abc",
      branch: "qe/run/current",
      source_dirty_changes_excluded: null,
      issue: null,
    },
    delivery: {
      state: "closed_unmerged",
      changes: null,
      review: null,
      revisions: { base: null, head: null },
      issue: null,
      can_retry: false,
    },
    squad: { id: "squad", key: "squad", name: "Squad", members: [] },
    steps: [],
    artifacts: [],
    step_counts: {
      pending: 0,
      waiting: 0,
      scheduled: 0,
      running: 0,
      completed: 0,
      failed: 0,
      uncertain: 0,
    },
    issues: [],
  };
}

function quest(
  currentRunId: string | null,
  action: Quest["lifecycle"]["primary_action"],
): Quest {
  return {
    id: "quest-1",
    title: "Quest",
    objective: "Work",
    workspace_id: "workspace",
    squad_id: "squad",
    tactic_source: { type: "inline", body: {} },
    completion: { completed_at: null, completed_by_run_id: null },
    lifecycle: {
      state: "needs_attention",
      label: "Needs Attention",
      current_run_id: currentRunId,
      primary_action: action,
    },
    archived_at: null,
  };
}

describe("Work Yard operational presentation", () => {
  test("Run Again requires the selected Run to be the authoritative current eligible Run", () => {
    expect(canRunAgain(run(), quest("run-older", "run_again"))).toBe(false);
    expect(canRunAgain(run(), quest("run-current", "retry_publishing"))).toBe(
      false,
    );
    expect(canRunAgain(run(), quest("run-current", "run_again"))).toBe(true);
  });

  test("cleanup uses only retained and known-positive Delivery states", () => {
    const value = run();
    expect(canCleanUp(value)).toBe(true);
    value.execution_environment.state = "ready";
    expect(canCleanUp(value)).toBe(false);
    value.execution_environment.state = "retained";
    if (!value.delivery) throw new Error("Expected Delivery");
    value.delivery.state = "attention_required";
    expect(canCleanUp(value)).toBe(false);
  });

  test("merged Delivery proves Quest completion without a loaded current Quest", () => {
    const value = run();
    if (!value.delivery) throw new Error("Expected Delivery");
    value.delivery.state = "merged";
    expect(questPresentation(value, null)?.label).toBe("Complete");
    value.delivery.state = "no_changes";
    expect(questPresentation(value, null)).toBeNull();
  });

  test("known diagnostics get stable copy while preserving safe server text", () => {
    const diagnostic = diagnosticPresentation({
      code: "base_branch_unresolved",
      message: "The Run base branch is unavailable.",
    });
    expect(diagnostic.title).toBe("Base branch couldn't be determined");
    expect(diagnostic.description).toContain("Run base branch is unavailable");
  });

  test("repeated semantic occurrences are passes, not fabricated attempt history", () => {
    const step = (id: string): RunStep => ({
      occurrence_id: id,
      semantic_step_key: "review",
      name: "Review",
      instruction: "Review.",
      state: "completed",
      phase: "check",
      remediation_cycle: 1,
      control_path: [],
      attempt: { id: `attempt-${id}`, number: 1, state: "completed" },
      member: null,
      performer: {
        selector: null,
        class_key: null,
        source_occurrence_id: null,
        source_semantic_step_key: null,
      },
      context: {
        mode: null,
        source_occurrence_id: null,
        source_semantic_step_key: null,
      },
      inputs: [],
      outputs: [],
      issue: null,
    });
    const steps = [step("first"), step("second")];
    expect(stepDisplayName(steps, 0)).toBe("Review");
    expect(stepDisplayName(steps, 1)).toBe("Review · second pass");
  });
});
