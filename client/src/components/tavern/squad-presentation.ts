import type {
  ClassDefinition,
  Loadout,
  SquadMember,
} from "../../api/contracts";
import {
  accessLabel,
  modelLabel,
  reasoningLabel,
} from "../forge/loadout-presentation";

export interface DefinitionReference<T> {
  definition: T | null;
  state: "active" | "archived" | "unavailable";
}

export function classReference(
  member: SquadMember,
  classes: ClassDefinition[],
): DefinitionReference<ClassDefinition> {
  const definition =
    classes.find((item) => item.id === member.class_id) ?? null;
  return {
    definition,
    state: !definition
      ? "unavailable"
      : definition.archived_at
        ? "archived"
        : "active",
  };
}

export function loadoutReference(
  member: SquadMember,
  loadouts: Loadout[],
): DefinitionReference<Loadout> {
  const definition =
    loadouts.find((item) => item.id === member.loadout_id) ?? null;
  return {
    definition,
    state: !definition
      ? "unavailable"
      : definition.archived_at
        ? "archived"
        : "active",
  };
}

export function loadoutModelSummary(loadout: Loadout): string {
  return `${modelLabel(loadout.model.model)} · ${reasoningLabel(loadout.reasoning)}`;
}

export function loadoutAccessSummary(loadout: Loadout): string {
  return accessLabel(loadout.workspace_access);
}

export function activeQuestUsageLabel(count: number): string {
  return `Used by ${count} active ${count === 1 ? "Quest" : "Quests"}`;
}
