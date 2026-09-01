import type { SquadInput } from "../../api/client";
import type {
  ClassDefinition,
  Loadout,
  Squad,
  SquadMember,
} from "../../api/contracts";
import { availableProductKey } from "../management/management-key";

export interface SquadDraft {
  name: string;
  description: string;
  members: SquadMember[];
}

export interface ReferenceIssue {
  memberIndex: number;
  memberName: string;
  kind: "class" | "loadout";
  state: "archived" | "unavailable";
  definitionName: string | null;
}

export function emptySquadDraft(): SquadDraft {
  return { name: "", description: "", members: [] };
}

export function draftFromSquad(squad: Squad): SquadDraft {
  return {
    name: squad.name,
    description: squad.description,
    members: squad.members.map(copyMember),
  };
}

export function copyMember(member: SquadMember): SquadMember {
  return {
    member_key: member.member_key,
    name: member.name,
    class_id: member.class_id,
    loadout_id: member.loadout_id,
  };
}

export function generatedMemberKey(
  name: string,
  reservedKeys: Iterable<string>,
): string {
  return availableProductKey(name, reservedKeys, "member");
}

export function moveRosterMember(
  members: SquadMember[],
  index: number,
  direction: -1 | 1,
): SquadMember[] {
  const nextIndex = index + direction;
  if (
    index < 0 ||
    index >= members.length ||
    nextIndex < 0 ||
    nextIndex >= members.length
  )
    return members.map(copyMember);
  const reordered = members.map(copyMember);
  const current = reordered[index];
  const adjacent = reordered[nextIndex];
  if (!current || !adjacent) return reordered;
  reordered[index] = adjacent;
  reordered[nextIndex] = current;
  return reordered;
}

export function squadInput(
  draft: SquadDraft,
): Omit<Required<SquadInput>, "key"> {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    members: draft.members.map(copyMember),
  };
}

export function referenceIssues(
  members: SquadMember[],
  classes: ClassDefinition[],
  loadouts: Loadout[],
): ReferenceIssue[] {
  const classById = new Map(
    classes.map((definition) => [definition.id, definition]),
  );
  const loadoutById = new Map(
    loadouts.map((definition) => [definition.id, definition]),
  );
  const issues: ReferenceIssue[] = [];

  members.forEach((member, memberIndex) => {
    const classDefinition = classById.get(member.class_id);
    if (!classDefinition || classDefinition.archived_at) {
      issues.push({
        memberIndex,
        memberName: member.name,
        kind: "class",
        state: classDefinition?.archived_at ? "archived" : "unavailable",
        definitionName: classDefinition?.name ?? null,
      });
    }

    const loadout = loadoutById.get(member.loadout_id);
    if (!loadout || loadout.archived_at) {
      issues.push({
        memberIndex,
        memberName: member.name,
        kind: "loadout",
        state: loadout?.archived_at ? "archived" : "unavailable",
        definitionName: loadout?.name ?? null,
      });
    }
  });

  return issues;
}
