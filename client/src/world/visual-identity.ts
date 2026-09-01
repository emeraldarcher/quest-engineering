export interface AuthoredSlot {
  id: string;
  x: number;
  y: number;
}

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
  };
}

function assignUniqueSlots<T extends AuthoredSlot>(
  assignments: Array<{ id: string; identity: string }>,
  slots: readonly T[],
): Map<string, T> {
  if (!slots.length) return new Map();
  const occupied = new Set<number>();
  const result = new Map<string, T>();
  for (const assignment of [...assignments].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    const start =
      stableHash(`${assignment.id}\0${assignment.identity}`) % slots.length;
    let selected = start;
    for (let offset = 0; offset < slots.length; offset += 1) {
      const candidate = (start + offset) % slots.length;
      if (!occupied.has(candidate)) {
        selected = candidate;
        break;
      }
    }
    occupied.add(selected);
    const slot = slots[selected];
    if (slot) result.set(assignment.id, slot);
  }
  return result;
}

export function assignWorkSites<T extends AuthoredSlot>(
  assignments: Array<{ occurrenceId: string; memberKey: string }>,
  sites: readonly T[],
): Map<string, T> {
  return assignUniqueSlots(
    assignments.map((assignment) => ({
      id: assignment.occurrenceId,
      identity: assignment.memberKey,
    })),
    sites,
  );
}

export function assignMemberHomes<T extends AuthoredSlot>(
  squadKey: string,
  memberKeys: string[],
  homes: readonly T[],
): Map<string, T> {
  return assignUniqueSlots(
    memberKeys.map((memberKey) => ({
      id: memberKey,
      identity: `${squadKey}\0${memberKey}`,
    })),
    homes,
  );
}
