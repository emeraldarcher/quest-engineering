import { describe, expect, test } from "bun:test";
import type { Quest, RunProjection, RunStep } from "../../api/contracts";
import {
  acceptedPlan,
  artifactPreview,
  canCleanUp,
  canRunAgain,
  currentReviewResult,
  diagnosticPresentation,
  documentContent,
  effortLabel,
  executionPresentation,
  implementationPlanInput,
  latestReviewArtifact,
  questPresentation,
  stepDisplayName,
  toolPolicyLabel,
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
    review_gate: {
      required: false,
      status: "not_required",
      occurrence_id: null,
      attempt_id: null,
      artifact_id: null,
    },
    step_counts: {
      pending: 0,
      waiting: 0,
      scheduled: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
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
  test("cancelled execution is terminal without being presented as failure", () => {
    expect(executionPresentation("cancelled")).toEqual({
      label: "Cancelled",
      description: "Execution was cancelled by the Product operator.",
      tone: "neutral",
    });
  });

  test("reports unsupported effort and native authorization without exact-subset claims", () => {
    const execution = {
      harness: "antigravity",
      model: { provider: "antigravity", model: "claude-sonnet-4-6" },
      reasoning: null,
      reasoning_capability: { kind: "unsupported" as const },
      tool_policy: { kind: "native_permissions" as const },
      tool_enforcement: "native_permissions" as const,
      resolved_tool_profile: {
        tools: ["workspace.filesystem", "workspace.search", "terminal.shell"],
      },
      workspace_permission: "read_write" as const,
      worker_id: "worker-a",
    };

    expect(effortLabel(execution)).toBe("Effort not configurable");
    expect(toolPolicyLabel(execution)).toBe("Tool policy: native permissions");
    expect(toolPolicyLabel(execution)).not.toContain("exact");
  });

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

  test("semantic remediation occurrences use visible cycle numbers", () => {
    const step = (id: string, cycle: number): RunStep => ({
      occurrence_id: id,
      semantic_step_key: "review",
      name: "Review",
      instruction: "Review.",
      state: "completed",
      phase: "check",
      remediation_cycle: cycle,
      control_path: [],
      attempt: {
        id: `attempt-${id}`,
        number: 1,
        state: "completed",
        started_at: null,
        finished_at: null,
        outputs: [],
        output_produced: false,
        resolution: null,
        retry_of_attempt_id: null,
        execution: null,
      },
      attempts: [
        {
          id: `attempt-${id}`,
          number: 1,
          state: "completed",
          started_at: null,
          finished_at: null,
          outputs: [],
          output_produced: false,
          resolution: null,
          retry_of_attempt_id: null,
          execution: null,
        },
      ],
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
    const steps = [step("first", 0), step("second", 1)];
    expect(stepDisplayName(steps, 0)).toBe("Review 1");
    expect(stepDisplayName(steps, 1)).toBe("Review 2");
  });

  test("accepted immutable Plan is readable and is explicit implementation provenance", () => {
    const value = run();
    const plan = {
      id: "plan-v2",
      type: "quest_plan",
      producer_occurrence_id: "revise-plan-1",
      producer_attempt_id: "revise-plan-1-attempt-1",
      version: 2,
      supersedes_artifact_id: "plan-v1",
      content_hash: "sha256:abc",
      media_type: "text/markdown",
      filename: "quest-plan.md",
      title: "Quest Plan",
      preview: { kind: "document", filename: "quest-plan.md" },
    };
    value.artifacts = [plan];
    value.planning = {
      accepted_plan: plan,
      history: [
        {
          artifact_id: plan.id,
          version: 2,
          status: "accepted",
          verdict_artifact_id: "plan-verdict-2",
          findings: null,
          supersedes_artifact_id: "plan-v1",
        },
      ],
    };
    const implement = {
      occurrence_id: "implement",
      semantic_step_key: "implement",
      name: "Implement",
      instruction: "Implement.",
      state: "completed" as const,
      phase: "root",
      remediation_cycle: null,
      control_path: [],
      attempt: null,
      attempts: [],
      member: null,
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
      inputs: [{ name: "plan", type: "quest_plan", artifact_id: plan.id }],
      outputs: [],
      issue: null,
    };

    expect(acceptedPlan(value)?.id).toBe("plan-v2");
    expect(implementationPlanInput(implement, value.artifacts)?.version).toBe(
      2,
    );
    expect(artifactPreview(plan)).toContain("v2");
    expect(
      documentContent({
        ...plan,
        value: { kind: "document", content: "# Plan v2" },
      }),
    ).toBe("# Plan v2");
  });

  test("latest Review result follows semantic occurrence order, not artifact order", () => {
    const value = run();
    const rejected = {
      id: "verdict-rejected",
      type: "review_verdict",
      producer_occurrence_id: "review-1",
      producer_attempt_id: "review-1-attempt-1",
      preview: { kind: "review_verdict", status: "rejected" },
    };
    const accepted = {
      id: "verdict-accepted",
      type: "review_verdict",
      producer_occurrence_id: "review-2",
      producer_attempt_id: "review-2-attempt-1",
      preview: { kind: "review_verdict", status: "accepted" },
    };
    const review = (id: string, artifactId: string): RunStep => ({
      occurrence_id: id,
      semantic_step_key: "review",
      name: "Review",
      instruction: "Review.",
      state: "completed",
      phase: "check",
      remediation_cycle: id === "review-1" ? 0 : 1,
      control_path: [],
      attempt: null,
      attempts: [],
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
      outputs: [
        { name: "verdict", type: "review_verdict", artifact_id: artifactId },
      ],
      issue: null,
    });
    value.steps = [
      review("review-1", rejected.id),
      review("review-2", accepted.id),
    ];
    value.artifacts = [accepted, rejected];
    value.review_gate = {
      required: true,
      status: "accepted",
      occurrence_id: "review-2",
      attempt_id: "review-2-attempt-1",
      artifact_id: accepted.id,
    };

    expect(latestReviewArtifact(value.steps, value.artifacts)?.id).toBe(
      accepted.id,
    );
    expect(currentReviewResult(value)?.label).toBe("Accepted");

    const latest = value.steps[1];
    if (!latest) throw new Error("Expected latest Review");
    latest.state = "running";
    latest.outputs = [];
    expect(latestReviewArtifact(value.steps, value.artifacts)?.id).toBe(
      rejected.id,
    );
  });
});
