import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { conversationRevisions } from "../src/schema.js";
import { guardFullSnapshotHistory, historyGapCandidateFilter, interiorHistoryGap, INTERIOR_HISTORY_GAP_REASON } from "../src/services/capture-history-guard.js";
import { messageFingerprint } from "../src/services/capture.js";

const mocks = vi.hoisted(() => ({ loadMessages: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: {} }));
vi.mock("../src/services/revision-storage.js", () => ({ loadCaptureRevisionMessages: mocks.loadMessages }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const reference: CaptureMessage[] = Array.from({ length: 40 }, (_, index) => ({
  ordinal: index, externalMessageId: id(index), role: index % 2 ? "assistant" : "user",
  segments: [{ type: "text", content: `message ${index}` }],
}));
const incoming = reference.filter((message) => message.ordinal < 8 || message.ordinal > 18)
  .map((message, ordinal) => ({ ...message, ordinal }));
const snapshot: CaptureSnapshotV1 = {
  schemaVersion: 1, provider: "chatgpt", sessionId: "session-1", branchFingerprint: "incoming-different-branch",
  adapterVersion: "2.3.4", capturedAt: "2026-09-13T23:09:07.245+08:00", captureMode: "full",
  completeness: { status: "complete", topReached: true, bottomReached: true, stable: true }, messages: incoming,
};
function gap(candidate: CaptureMessage[], previous = reference) {
  return interiorHistoryGap({ incoming: candidate, reference: previous, fingerprint: messageFingerprint });
}
function transaction(candidates: Array<{ id: string }> = [{ id: "reference" }]) {
  const query = { from: () => query, where: () => query, orderBy: () => query, limit: vi.fn(async () => candidates) };
  const select = vi.fn(() => query);
  return { tx: { select } as unknown as Parameters<typeof guardFullSnapshotHistory>[0], select, query };
}

describe("strict ChatGPT interior history guard", () => {
  beforeEach(() => vi.clearAllMocks());

  it("proves 29 messages omit exactly the 11 interior messages from a 40-message path", () => {
    expect(gap(incoming)).toEqual({ missingMessageIds: Array.from({ length: 11 }, (_, index) => id(index + 8)), referenceMessageCount: 40 });
  });

  it("does not infer a gap from message count, a shorter prefix, or a different terminal message", () => {
    expect(gap(reference.slice(0, 29))).toBeNull();
    expect(gap(reference.slice(11))).toBeNull();
    expect(gap([...incoming.slice(0, -1), { ...incoming.at(-1)!, externalMessageId: id(99) }])).toBeNull();
    expect(gap(reference)).toBeNull();
  });

  it.each(["content", "role", "href", "language", "order", "new-id"])("preserves a genuine changed path (%s)", (change) => {
    const candidate = structuredClone(incoming);
    if (change === "content") candidate[10]!.segments[0]!.content = "edited answer";
    if (change === "role") candidate[10]!.role = "system";
    if (change === "href") candidate[10]!.segments[0]!.href = "https://example.com/new";
    if (change === "language") candidate[10]!.segments[0]!.language = "typescript";
    if (change === "new-id") candidate[10]!.externalMessageId = id(99);
    if (change === "order") {
      [candidate[10], candidate[11]] = [candidate[11]!, candidate[10]!];
      candidate[10]!.ordinal = 10;
      candidate[11]!.ordinal = 11;
    }
    expect(gap(candidate)).toBeNull();
  });

  it("requires unique stable IDs in both paths", () => {
    const duplicate = structuredClone(incoming);
    duplicate[10]!.externalMessageId = duplicate[9]!.externalMessageId;
    expect(gap(duplicate)).toBeNull();
    const duplicateReference = structuredClone(reference);
    duplicateReference[12]!.externalMessageId = duplicateReference[11]!.externalMessageId;
    expect(gap(incoming, duplicateReference)).toBeNull();
    expect(gap(incoming.map((message) => ({ ...message, externalMessageId: undefined })))).toBeNull();
    expect(gap(incoming.map((message, ordinal) => ({ ...message, externalMessageId: `turn-${ordinal}` })))).toBeNull();
  });

  it("compares normalized segments without treating code whitespace as equivalent", () => {
    const whitespace = structuredClone(incoming);
    whitespace[3]!.segments[0]!.content = "  message 3\r\n";
    expect(gap(whitespace)).not.toBeNull();
    const codeReference = structuredClone(reference);
    codeReference[3]!.segments = [{ type: "code", content: "x()" }];
    whitespace[3]!.segments = [{ type: "code", content: "x() " }];
    expect(gap(whitespace, codeReference)).toBeNull();
  });

  it("queries longer complete histories, prefiltering stored snapshot endpoints but allowing inherited delta endpoints", () => {
    const query = new QueryBuilder().select({ id: conversationRevisions.id }).from(conversationRevisions)
      .where(historyGapCandidateFilter("conversation-id", snapshot)).toSQL();
    expect(query.params).toEqual(["conversation-id", "complete", 29, "delta", "snapshot", id(0), id(39)]);
    expect(query.sql).toContain('("conversation_revisions"."storage_kind" = $4 or ("conversation_revisions"."storage_kind" = $5 and exists');
    expect(query.sql).toContain("first_message.ordinal = 0");
    expect(query.sql).toContain('first_message.revision_id = "conversation_revisions"."id"');
    expect(query.sql).toContain('last_message.ordinal = "conversation_revisions"."message_count" - 1');
    expect(query.sql).not.toContain("branch_fingerprint");
  });

  it("uses a hydrated complete delta42 to prove one interior omission from an incoming full41", async () => {
    const { tx } = transaction([{ id: "complete-delta-42" }]);
    const deltaHistory = [...reference, ...Array.from({ length: 2 }, (_, index) => ({
      ordinal: index + 40, externalMessageId: id(index + 40), role: index ? "assistant" as const : "user" as const,
      segments: [{ type: "text" as const, content: `appended ${index}` }],
    }))];
    // The first 40 messages are inherited from the base snapshot; only the
    // final two have physical rows on the candidate delta itself.
    mocks.loadMessages.mockResolvedValue(deltaHistory);
    const full41 = { ...snapshot, messages: deltaHistory.filter((message) => message.ordinal !== 20)
      .map((message, ordinal) => ({ ...message, ordinal })) };
    const guarded = await guardFullSnapshotHistory(tx, "conversation-id", full41, messageFingerprint);
    expect(guarded.completeness.status).toBe("partial");
    expect(guarded.completeness.reason).toBe(INTERIOR_HISTORY_GAP_REASON);
    expect(guarded.messages).toBe(full41.messages);
    expect(mocks.loadMessages).toHaveBeenCalledWith("complete-delta-42", tx);
  });

  it("downgrades the observed capture without changing its body or requiring a matching branch hash", async () => {
    const { tx, query } = transaction();
    mocks.loadMessages.mockResolvedValue(reference);
    const guarded = await guardFullSnapshotHistory(tx, "conversation-id", snapshot, messageFingerprint);
    expect(guarded.completeness).toEqual({ ...snapshot.completeness, status: "partial", reason: INTERIOR_HISTORY_GAP_REASON });
    expect(guarded.messages).toBe(snapshot.messages);
    expect(guarded.branchFingerprint).toBe(snapshot.branchFingerprint);
    expect(snapshot.completeness.status).toBe("complete");
    expect(query.limit).toHaveBeenCalledWith(20);
  });

  it("leaves unrelated providers, append/import captures and already-partial captures unchanged", async () => {
    const { tx, select } = transaction();
    for (const candidate of [
      { ...snapshot, provider: "codex" as const },
      { ...snapshot, captureMode: "append" as const },
      { ...snapshot, captureMode: "import" as const },
      { ...snapshot, completeness: { ...snapshot.completeness, status: "partial" as const } },
    ]) expect(await guardFullSnapshotHistory(tx, "conversation-id", candidate, messageFingerprint)).toBe(candidate);
    expect(select).not.toHaveBeenCalled();
  });
});
