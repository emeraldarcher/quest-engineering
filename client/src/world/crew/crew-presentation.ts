import type { ActiveCrewActivity } from "./active-crew";

export interface ActiveCrewPresentation {
  actorId: string;
  activityId: string;
  runId: string;
  memberKey: string;
  memberName: string;
  className: string;
  squadName: string;
  questTitle: string;
  stepName: string;
}

/** Keeps execution DTO interpretation outside Pixi. */
export function projectCrewPresentation(
  activities: readonly ActiveCrewActivity[],
): ActiveCrewPresentation[] {
  return activities.map((activity) => ({
    actorId: activity.actorId,
    activityId: activity.activityId,
    runId: activity.runId,
    memberKey: activity.member.member_key,
    memberName: activity.member.name,
    className: activity.member.class.name,
    squadName: activity.squad.name,
    questTitle: activity.quest.title,
    stepName: activity.stepName,
  }));
}
