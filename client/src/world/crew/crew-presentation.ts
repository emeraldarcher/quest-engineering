import type { CrewActivityCategory } from "../authored/map-schema";
import { squadIdentity } from "../visual-identity";
import type { ActiveCrewActivity } from "./active-crew";
import {
  type CrewWorkAnimationTag,
  crewActivityPolicy,
} from "./crew-activity-policy";

export interface ActiveCrewPresentation {
  actorId: string;
  activityId: string;
  runId: string;
  occurrenceId: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  memberKey: string;
  memberName: string;
  classKey: string;
  className: string;
  squadKey: string;
  squadName: string;
  squadAccentColor: number;
  questTitle: string;
  stepName: string;
  activityCategory: CrewActivityCategory;
  workAnimationTag: CrewWorkAnimationTag;
}

/** Keeps execution DTO interpretation outside Pixi. */
export function projectCrewPresentation(
  activities: readonly ActiveCrewActivity[],
): ActiveCrewPresentation[] {
  return activities.map((activity) => {
    const policy = crewActivityPolicy({
      stepKey: activity.stepKey,
      stepName: activity.stepName,
      stepInstruction: activity.stepInstruction,
      classKey: activity.member.class.key,
      className: activity.member.class.name,
    });
    return {
      actorId: activity.actorId,
      activityId: activity.activityId,
      runId: activity.runId,
      occurrenceId: activity.occurrenceId,
      projectId: activity.project.id,
      projectKey: activity.project.key,
      projectName: activity.project.name,
      memberKey: activity.member.member_key,
      memberName: activity.member.name,
      classKey: activity.member.class.key,
      className: activity.member.class.name,
      squadKey: activity.squad.key,
      squadName: activity.squad.name,
      squadAccentColor: squadIdentity(activity.squad.key).accentColor,
      questTitle: activity.quest.title,
      stepName: activity.stepName,
      activityCategory: policy.category,
      workAnimationTag: policy.workAnimationTag,
    };
  });
}
