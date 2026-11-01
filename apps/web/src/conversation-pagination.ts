import type { PaginationData } from "./api-types.js";

export const CONVERSATION_MESSAGE_PAGE_SIZE = 50;

export function conversationMessageQuery(search: string, hash: string): string {
  const query = new URLSearchParams(search);
  const offset = Number(query.get("messageOffset") ?? 0);
  const result = new URLSearchParams({
    messageLimit: String(CONVERSATION_MESSAGE_PAGE_SIZE),
    messageOffset: String(Number.isSafeInteger(offset) && offset >= 0 ? offset : 0),
  });
  const match = /^#message-(\d+)$/.exec(hash);
  if (match?.[1] && Number.isSafeInteger(Number(match[1]))) result.set("messageOrdinal", match[1]);
  return result.toString();
}

export function conversationPageSearch(search: string, offset: number): string {
  const query = new URLSearchParams(search);
  query.delete("revisionId");
  query.set("messageOffset", String(Math.max(0, Math.floor(offset))));
  return `?${query}`;
}

export function messageTargetOrdinal(hash: string): number | undefined {
  const match = /^#message-(\d+)$/.exec(hash);
  const ordinal = match?.[1] ? Number(match[1]) : NaN;
  return Number.isSafeInteger(ordinal) && ordinal >= 0 ? ordinal : undefined;
}

export function fallbackMessagePagination(total: number): PaginationData {
  return { total, limit: CONVERSATION_MESSAGE_PAGE_SIZE, offset: 0, hasMore: false };
}

export function messageContainsSearchText(message: { segments: ReadonlyArray<{ content: string }> }, query: string): boolean {
  return message.segments.map(segment => segment.content).join("\n").toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

export function conversationTargetInEvidence(messages: ReadonlyArray<{
  ordinal: number; storedOrdinal?: number | null; segments: ReadonlyArray<{ content: string }>;
}>, ordinal: number | undefined, query: string): boolean {
  if (ordinal === undefined) return false;
  const message = messages.find(message => (message.storedOrdinal ?? message.ordinal) === ordinal);
  return !message || Boolean(query.trim()) && !messageContainsSearchText(message, query);
}
