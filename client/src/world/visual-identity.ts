import { idleHomes, workSites } from "./town-layout";

export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function memberIdentity(squadKey: string, memberKey: string) {
  const hash = stableHash(`${squadKey}\0${memberKey}`);
  return {
    hash,
    spriteIndex: hash % 8,
    accentIndex: Math.floor(hash / 8) % 6,
    home: idleHomes[Math.floor(hash / 48) % idleHomes.length] ?? idleHomes[0],
  };
}

export function assignWorkSites(
  assignments: Array<{ occurrenceId: string; memberKey: string }>,
): Map<string, (typeof workSites)[number]> {
  const occupied = new Set<number>();
  const result = new Map<string, (typeof workSites)[number]>();
  for (const assignment of [...assignments].sort((a, b) =>
    a.occurrenceId.localeCompare(b.occurrenceId),
  )) {
    const start =
      stableHash(`${assignment.occurrenceId}\0${assignment.memberKey}`) %
      workSites.length;
    let selected = start;
    for (let offset = 0; offset < workSites.length; offset += 1) {
      const candidate = (start + offset) % workSites.length;
      if (!occupied.has(candidate)) {
        selected = candidate;
        break;
      }
    }
    occupied.add(selected);
    result.set(assignment.occurrenceId, workSites[selected] ?? workSites[0]);
  }
  return result;
}
