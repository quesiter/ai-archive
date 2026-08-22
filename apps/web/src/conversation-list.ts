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

function dateParamToIso(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

export function buildConversationListSearch(query: ConversationListQuery): string {
  const from = dateParamToIso(query.from);
  const to = dateParamToIso(query.to);
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
