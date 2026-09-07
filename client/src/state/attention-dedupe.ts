/** Stable identity dedupe; realtime timing and repeated projections are irrelevant. */
export function recordAttentionOnce(
  seenAttentionIds: Set<string>,
  attentionId: string,
): boolean {
  if (seenAttentionIds.has(attentionId)) return false;
  seenAttentionIds.add(attentionId);
  return true;
}
