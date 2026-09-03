import type { Quest } from "../../api/contracts";

export interface TownHudCounts {
  activeQuests: number;
  workingQuests: number;
  attentionQuests: number;
  reviewQuests: number;
  preparingReviewQuests: number;
}

export function townHudCounts(quests: Quest[]): TownHudCounts {
  const active = quests.filter((quest) => quest.archived_at === null);
  return {
    activeQuests: active.filter((quest) => quest.lifecycle.state !== "complete")
      .length,
    workingQuests: active.filter((quest) => quest.lifecycle.state === "working")
      .length,
    attentionQuests: active.filter(
      (quest) => quest.lifecycle.state === "needs_attention",
    ).length,
    reviewQuests: active.filter(
      (quest) => quest.lifecycle.state === "awaiting_review",
    ).length,
    preparingReviewQuests: active.filter(
      (quest) => quest.lifecycle.state === "preparing_review",
    ).length,
  };
}

export function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
