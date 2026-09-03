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
