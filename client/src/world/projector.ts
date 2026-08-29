import type { RunProjection, RunStep, SnapshotMember } from "../api/contracts";

export type VisualActivity =
  | "idle"
  | "moving_to_work"
  | "working"
  | "completed"
  | "failed"
  | "uncertain";
export interface MemberWorldModel {
  member: SnapshotMember;
  visual: VisualActivity;
  activeOccurrenceId: string | null;
  activeStepName: string | null;
  completedOccurrenceIds: string[];
}
export interface WorkOrderMarker {
  occurrenceId: string;
  name: string;
  state: "pending" | "waiting";
}
export interface RunWorldModel {
  runId: string;
  members: MemberWorldModel[];
  orderMarkers: WorkOrderMarker[];
  diagnostics: string[];
}

const factualStates = new Set([
  "scheduled",
  "running",
  "completed",
  "failed",
  "uncertain",
]);
const activeStates = new Set(["scheduled", "running", "failed", "uncertain"]);
const priority: Record<VisualActivity, number> = {
  working: 6,
  moving_to_work: 5,
  uncertain: 4,
  failed: 3,
  completed: 2,
  idle: 1,
};

export function projectRunWorld(run: RunProjection): RunWorldModel {
  const diagnostics: string[] = [];
  const byMember = new Map<string, RunStep[]>();
  const orderMarkers: WorkOrderMarker[] = [];

  for (const step of run.steps) {
    if (step.state === "pending" || step.state === "waiting") {
      orderMarkers.push({
        occurrenceId: step.occurrence_id,
        name: step.name ?? step.semantic_step_key,
        state: step.state,
      });
    }
    if (step.member && factualStates.has(step.state)) {
      const steps = byMember.get(step.member.member_key) ?? [];
      steps.push(step);
      byMember.set(step.member.member_key, steps);
    }
  }

  const members = run.squad.members.map((member) => {
    const steps = byMember.get(member.member_key) ?? [];
    const active = steps.filter((step) => activeStates.has(step.state));
    if (active.length > 1)
      diagnostics.push(`${member.name} has multiple active occurrences.`);
    const selected = [...steps].sort(
      (a, b) => visualFor(b).priority - visualFor(a).priority,
    )[0];
    const presentation = selected
      ? visualFor(selected)
      : { visual: "idle" as const, priority: priority.idle };
    return {
      member,
      visual: active.length > 1 ? "idle" : presentation.visual,
      activeOccurrenceId:
        active.length === 1 ? (selected?.occurrence_id ?? null) : null,
      activeStepName:
        active.length === 1
          ? (selected?.name ?? selected?.semantic_step_key ?? null)
          : null,
      completedOccurrenceIds: steps
        .filter((step) => step.state === "completed")
        .map((step) => step.occurrence_id),
    };
  });

  return { runId: run.id, members, orderMarkers, diagnostics };
}

function visualFor(step: RunStep): {
  visual: VisualActivity;
  priority: number;
} {
  const visual: VisualActivity =
    step.state === "running"
      ? "working"
      : step.state === "scheduled"
        ? "moving_to_work"
        : step.state === "completed"
          ? "completed"
          : step.state === "failed"
            ? "failed"
            : step.state === "uncertain"
              ? "uncertain"
              : "idle";
  return { visual, priority: priority[visual] };
}
