export function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export const SQUAD_PRESENTATION_PALETTE = [
  0x4e8ca0, 0xd98545, 0x845d99, 0x4d9468, 0xc35458, 0xd99a45,
] as const;

export function squadIdentity(squadKey: string) {
  const hash = stableHash(squadKey);
  return {
    hash,
    accentIndex: hash % SQUAD_PRESENTATION_PALETTE.length,
    accentColor:
      SQUAD_PRESENTATION_PALETTE[hash % SQUAD_PRESENTATION_PALETTE.length] ??
      SQUAD_PRESENTATION_PALETTE[0],
  };
}

export function memberIdentity(squadKey: string, memberKey: string) {
  const hash = stableHash(`${squadKey}\0${memberKey}`);
  return {
    hash,
    spriteIndex: hash % 8,
    accentIndex: Math.floor(hash / 8) % 6,
  };
}
