import type {
  RunProjection,
  RunStep,
  SnapshotMember,
} from "../../api/contracts";

export interface ActiveCrewActivity {
  activityId: string;
  actorId: string;
  runId: string;
  quest: RunProjection["quest"];
  project: RunProjection["execution_environment"]["workspace"];
  squad: Pick<RunProjection["squad"], "id" | "key" | "name">;
  member: SnapshotMember;
  occurrenceId: string;
  stepKey: string;
  stepName: string;
  stepInstruction: string | null;
  state: "running";
}

export function isActiveCrewStep(
  step: RunStep,
): step is RunStep & { state: "running"; member: SnapshotMember } {
  return step.state === "running" && step.member !== null;
}

export function projectActiveCrewActivities(
  runs: readonly RunProjection[],
): ActiveCrewActivity[] {
  return runs
    .flatMap((run) =>
      run.steps.filter(isActiveCrewStep).map((step) => ({
        activityId: `${run.id}\0${step.occurrence_id}`,
        actorId: `${run.id}\0${run.squad.id}\0${step.member.member_key}`,
        runId: run.id,
        quest: { ...run.quest },
        project: { ...run.execution_environment.workspace },
        squad: { id: run.squad.id, key: run.squad.key, name: run.squad.name },
        member: step.member,
        occurrenceId: step.occurrence_id,
        stepKey: step.semantic_step_key,
        stepName: step.name ?? step.semantic_step_key,
        stepInstruction: step.instruction,
        state: "running" as const,
      })),
    )
    .sort((a, b) => a.activityId.localeCompare(b.activityId));
}
