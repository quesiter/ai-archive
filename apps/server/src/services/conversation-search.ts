export function searchExcerpt(content: string, query: string): string {
  const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return content.slice(0, 160);
  const start = Math.max(0, index - 54);
  const end = Math.min(content.length, index + query.length + 90);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

export function conversationIdsMatchingAllTags(
  links: ReadonlyArray<{ conversationId: string; tagId: string }>,
  requiredTagIds: readonly string[],
): string[] {
  if (!requiredTagIds.length) return [];
  const required = new Set(requiredTagIds);
  const matched = new Map<string, Set<string>>();
  for (const link of links) {
    if (!required.has(link.tagId)) continue;
    const tagIds = matched.get(link.conversationId) ?? new Set<string>();
    tagIds.add(link.tagId);
    matched.set(link.conversationId, tagIds);
  }
  return [...matched]
    .filter(([, tagIds]) => tagIds.size === required.size)
    .map(([conversationId]) => conversationId);
}

export function buildConversationSearchHit(input: {
  query: string;
  title: string | null;
  titleMatched: boolean;
  latestRevisionId: string | null;
  bodyHit?: { revisionId: string; ordinal: number; content: string } | null;
}) {
  if (input.titleMatched) {
    return {
      reason: "标题命中",
      revisionId: input.latestRevisionId,
      messageOrdinal: null,
      excerpt: searchExcerpt(input.title ?? "", input.query),
    };
  }
  if (input.bodyHit) {
    return {
      reason: "正文命中",
      revisionId: input.bodyHit.revisionId,
      messageOrdinal: input.bodyHit.ordinal,
      excerpt: searchExcerpt(input.bodyHit.content, input.query),
    };
  }
  return null;
}
