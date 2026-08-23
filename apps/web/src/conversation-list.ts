export type ConversationListQuery = {
  limit: number;
  offset: number;
  q: string;
  provider: string;
  source: string;
  completeness: string;
  captureMode: string;
  projectId: string;
  tagIds: string;
  from: string;
  to: string;
};

const conversationListFilterKeys = [
  "q",
  "provider",
  "source",
  "completeness",
  "captureMode",
  "projectId",
  "tagIds",
  "from",
  "to",
] as const;

export function countActiveConversationListFilters(query: ConversationListQuery): number {
  return conversationListFilterKeys.filter((key) => Boolean(query[key])).length;
}

export function filterConversationTags<T extends { name?: unknown }>(
  tags: T[],
  query: string,
): T[] {
  const terms = query
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return tags;
  return tags.filter((tag) => {
    const name = String(tag.name ?? "").normalize("NFKC").toLocaleLowerCase("zh-CN");
    return terms.every((term) => name.includes(term));
  });
}

function dateParamToIso(value: string): string {
  if (!value) return "";
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function buildConversationListSearch(query: ConversationListQuery): string {
  const from = dateParamToIso(query.from);
  const toDate = query.to ? new Date(`${query.to}T00:00:00`) : null;
  if (toDate && !Number.isNaN(toDate.getTime())) {
    toDate.setDate(toDate.getDate() + 1);
  }
  const to = toDate?.toISOString() ?? "";
  return new URLSearchParams({
    limit: String(query.limit),
    offset: String(Math.max(0, query.offset)),
    ...(query.q ? { q: query.q } : {}),
    ...(query.provider ? { provider: query.provider } : {}),
    ...(query.source ? { source: query.source } : {}),
    ...(query.completeness ? { completeness: query.completeness } : {}),
    ...(query.captureMode ? { captureMode: query.captureMode } : {}),
    ...(query.projectId ? { projectId: query.projectId } : {}),
    ...(query.tagIds ? { tagIds: query.tagIds } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  }).toString();
}
