export interface TimelineRevisionCandidate {
  id: string;
  conversationId: string;
  capturedAt: Date;
  createdAt: Date;
  completeness: "complete" | "partial" | string;
}

export function selectLatestTimelineRevisions<T extends TimelineRevisionCandidate>(
  revisions: readonly T[],
): Map<string, T> {
  const sorted = [...revisions].sort((left, right) => {
    const completeness = Number(right.completeness === "complete") - Number(left.completeness === "complete");
    if (completeness) return completeness;
    const capturedAt = right.capturedAt.getTime() - left.capturedAt.getTime();
    if (capturedAt) return capturedAt;
    const createdAt = right.createdAt.getTime() - left.createdAt.getTime();
    if (createdAt) return createdAt;
    return right.id.localeCompare(left.id);
  });
  const selected = new Map<string, T>();
  for (const revision of sorted) {
    if (!selected.has(revision.conversationId)) selected.set(revision.conversationId, revision);
  }
  return selected;
}
