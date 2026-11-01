import type { CaptureSnapshotV1 } from "@ai-archive/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureRuns, conversationRevisions, conversations, conversationSearchChunks, messages, messageSegments } from "../src/schema.js";
import { captureRequestHash, consolidateConversationRevisions, contentIntegrityHash, ingestCapture, messageFingerprint, normalizeCaptureMessagesForStorage, revisionIdentityHash, storedTokenUsage, writeAccumulatedRevision } from "../src/services/capture.js";
import { captureStore } from "./capture-store-fixture.js";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), loadBatch: vi.fn(), loadMessages: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/services/conversation-lineage.js", () => ({ persistConversationParent: vi.fn() }));
vi.mock("../src/services/revision-storage.js", () => ({ loadCaptureRevisionMessages: mocks.loadMessages, loadCaptureRevisionMessagesBatch: mocks.loadBatch }));
vi.mock("../src/services/redaction.js", async (original) => ({ ...await original<typeof import("../src/services/redaction.js")>(), loadEnabledCustomRedactionRules: vi.fn(async () => []) }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = (count: number): CaptureSnapshotV1 => ({
  schemaVersion: 1, provider: "chatgpt", sessionId: "same-conversation", branchFingerprint: "branch-same", title: "Task",
  adapterVersion: "2.4.0", capturedAt: "2026-09-14T00:00:00.000Z", captureMode: "full",
  completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
  messages: Array.from({ length: count }, (_, ordinal) => ({ ordinal, externalMessageId: id(ordinal), role: ordinal % 2 ? "assistant" : "user", segments: [{ type: "text", content: `Message ${ordinal}` }] })),
});

describe("one accumulated conversation body", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves long historical tool content and builds its hash and chunks from the same exact body", async () => {
    const store = captureStore(mocks);
    const historical = source(2);
    const preserved = `old-start\r\r\n${"x".repeat(9_500)}\napi_key=historical-fixture-only\nold-end`;
    historical.messages[1] = { ...historical.messages[1]!, role: "tool", segments: [{ type: "tool_status", content: preserved }] };
    const first = store.seedSnapshot(historical);
    const expanded = { ...source(3), messages: [...historical.messages, source(3).messages[2]!], capturedAt: "2026-09-14T01:00:00.000Z" };
    store.seedSnapshot(expanded);

    await consolidateConversationRevisions(store.rows(conversations)[0].id);
    const row = store.rows(conversationRevisions)[0];
    const hydrated = store.hydrate(first.id);
    expect(hydrated[1]!.segments[0]!.content).toBe(preserved);
    expect(row.contentIntegrityHash).toBe(contentIntegrityHash({ ...expanded, messages: hydrated }, row.mergeEvidence));
    const storedTool = store.rows(messages).find((message) => message.ordinal === 1)!;
    const indexed = store.rows(conversationSearchChunks).filter((chunk) => chunk.messageId === storedTool.id).map((chunk) => chunk.content).join("");
    expect(indexed).toContain("x".repeat(9_500));
    expect(indexed).toContain("old-end");
    expect(indexed).toContain("api_key=historical-fixture-only");
    expect(row.toolTextUnits).toBe(Array.from(preserved).length);
  });

  it("keeps long legacy primary and variant observations intact on the metadata-only upgrade path", async () => {
    const store = captureStore(mocks);
    const historical = source(2);
    historical.messages[1]!.segments = [{ type: "tool_status", content: `start${"p".repeat(9_000)}end` }];
    const variant = { ...historical.messages[1]!, segments: [{ type: "tool_status" as const, content: `other${"v".repeat(10_000)}tail` }] };
    const evidence = { variants: [variant], warnings: [] };
    const first = store.seedSnapshot(historical, { mergeEvidence: evidence });
    const oldRows = structuredClone(store.rows(messages));
    const oldSegments = structuredClone(store.rows(messageSegments));

    await consolidateConversationRevisions(store.rows(conversations)[0].id);
    const row = store.rows(conversationRevisions)[0];
    expect(store.tx.delete).not.toHaveBeenCalled();
    expect(store.tx.insert).not.toHaveBeenCalled();
    expect(store.rows(messages)).toEqual(oldRows);
    expect(store.rows(messageSegments)).toEqual(oldSegments);
    expect(row.mergeEvidence).toEqual(evidence);
    expect(row.contentIntegrityHash).toBe(contentIntegrityHash({ ...historical, messages: store.hydrate(first.id) }, evidence));
  });

  it("retains old content while new incoming tool content still receives the existing redaction and length boundary", async () => {
    const store = captureStore(mocks);
    const historical = source(2);
    const preserved = `legacy${"h".repeat(9_000)}-tail`;
    historical.messages[1]!.segments = [{ type: "tool_status", content: preserved }];
    store.seedSnapshot(historical, { isAccumulated: true });
    const incoming = { ...source(1), capturedAt: "2026-09-14T01:00:00.000Z",
      completeness: { status: "partial" as const, topReached: false, bottomReached: true, stable: true },
      messages: [{ ordinal: 0, externalMessageId: id(40), role: "tool" as const,
        segments: [{ type: "tool_status" as const, content: `api_key=incoming-fixture-only\n${"n".repeat(12_000)}-new-tail` }] }] };
    const receipt = await ingestCapture(incoming, id(900), "new-observation");
    const hydrated = store.hydrate(receipt.revisionId);
    expect(hydrated[1]!.segments[0]!.content).toBe(preserved);
    const newContent = hydrated[2]!.segments[0]!.content;
    expect(newContent).toHaveLength(8_000);
    expect(newContent).toContain("[REDACTED]");
    expect(newContent).not.toContain("incoming-fixture-only");
    expect(newContent).toContain("-new-tail");
    const row = store.rows(conversationRevisions)[0];
    expect(row.contentIntegrityHash).toBe(contentIntegrityHash({ ...incoming, messages: hydrated,
      completeness: { status: row.completeness, topReached: row.topReached, bottomReached: row.bottomReached,
        stable: row.stable, reason: row.completenessReason } }, row.mergeEvidence));
  });

  it("rejects a metadata-only hash update when the exact persisted body differs", async () => {
    const store = captureStore(mocks);
    const historical = source(2);
    const previous = store.seedSnapshot(historical, { isAccumulated: true });
    const changed = structuredClone(historical);
    changed.messages[1]!.model = "new-model";
    const oldRows = structuredClone(store.rows(conversationRevisions));
    await expect(writeAccumulatedRevision(store.tx as any, { conversationId: previous.conversationId,
      existing: previous, snapshot: changed, mergeEvidence: { variants: [], warnings: [] }, replaceBody: false,
      previousBody: historical.messages, deviceId: null })).rejects.toThrow("Cannot skip writing a changed");
    expect(store.tx.update).not.toHaveBeenCalled();
    expect(store.rows(conversationRevisions)).toEqual(oldRows);
    // Internal maintenance callers without a baseline get a real read check.
    changed.messages[1]!.segments[0]!.content = "different content";
    await expect(writeAccumulatedRevision(store.tx as any, { conversationId: previous.conversationId,
      existing: previous, snapshot: changed, mergeEvidence: { variants: [], warnings: [] }, replaceBody: false,
      deviceId: null })).rejects.toThrow("Cannot skip writing a changed");
    expect(mocks.loadMessages).toHaveBeenCalledWith(previous.id, store.tx);
    expect(store.tx.update).not.toHaveBeenCalled();
  });

  it("normalizes repeated carriage returns before LF once while preserving standalone carriage returns and storage hashes", async () => {
    const store = captureStore(mocks);
    const original = source(2);
    original.messages[0]!.segments[0]!.content = "first\r\r\nsecond\r\nthird\rfourth";
    const normalized = normalizeCaptureMessagesForStorage(original.messages);
    expect(normalized[0]!.segments[0]!.content).toBe("first\nsecond\nthird\rfourth");
    expect(normalizeCaptureMessagesForStorage(normalized)).toEqual(normalized);
    expect(messageFingerprint(original.messages[0]!)).toBe(messageFingerprint(normalized[0]!));
    const receipt = await ingestCapture(original, id(900), "mixed-eol");
    expect(store.hydrate(receipt.revisionId)).toEqual(normalized);
    expect(store.rows(conversationRevisions)[0].contentIntegrityHash)
      .toBe(contentIntegrityHash({ ...original, messages: normalized }, { variants: [], warnings: [] }));
  });

  it("can repair a reviewed body through the shared writer while preserving durable IDs, soft deletion and capture receipts", async () => {
    const store = captureStore(mocks);
    const original = source(4);
    original.messages = original.messages.map(({ externalMessageId: _id, ...message }, ordinal) => ({ ...message,
      segments: [{ type: "text", content: ordinal === 1 || ordinal === 2 ? "Repeated observation" : `Message ${ordinal}` }] }));
    const previous = store.seedSnapshot(original, { isAccumulated: true, reportedInputTokens: 70, reportedOutputTokens: 30,
      reportedCachedInputTokens: 0, reportedCacheWriteInputTokens: 0, reportedReasoningOutputTokens: 0, reportedTotalTokens: 100 });
    store.rows(conversations)[0].deletedAt = new Date("2026-09-14T02:00:00.000Z");
    store.rows(captureRuns).push({ id: id(920), status: "complete", messageCount: 4, receipt: { revisionId: previous.id, messageCount: 4 } });
    const oldConversation = structuredClone(store.rows(conversations)[0]);
    const oldReceipts = structuredClone(store.rows(captureRuns));
    const oldMessages = structuredClone(store.rows(messages));
    const repaired = { ...original, tokenUsage: storedTokenUsage(previous)!,
      messages: original.messages.filter((message) => message.ordinal !== 2).map((message, ordinal) => ({ ...message, ordinal })) };

    await writeAccumulatedRevision(store.tx as any, { conversationId: previous.conversationId, existing: previous,
      snapshot: repaired, mergeEvidence: { variants: [], warnings: [] }, replaceBody: true, deviceId: null,
      messageMetadata: oldMessages.map((message) => ({ ...message, fingerprint: messageFingerprint(original.messages[message.ordinal]!) })) });
    expect(store.hydrate(previous.id)).toEqual(repaired.messages);
    expect(store.rows(messages).map((message) => message.id)).toEqual([oldMessages[0].id, oldMessages[1].id, oldMessages[3].id]);
    expect(store.rows(messages).every((message) => message.createdAt.getTime() === new Date(original.capturedAt).getTime())).toBe(true);
    expect(store.rows(conversations)[0]).toEqual(oldConversation);
    expect(store.rows(captureRuns)).toEqual(oldReceipts);
    expect(store.rows(conversationRevisions)[0]).toMatchObject({ id: previous.id, messageCount: 3, reportedTotalTokens: 100,
      contentIntegrityHash: contentIntegrityHash(repaired, { variants: [], warnings: [] }) });
  });

  it("restores a missing original observation with its supplied durable ID and original first-observed time", async () => {
    const store = captureStore(mocks);
    const previous = store.seedSnapshot(source(2), { isAccumulated: true });
    const restoredId = id(930);
    const firstObservedAt = new Date("2026-09-12T05:00:00.000Z");
    const restoredBody = source(3).messages[2]!;
    await writeAccumulatedRevision(store.tx as any, { conversationId: previous.conversationId, existing: previous,
      snapshot: source(3), mergeEvidence: { variants: [], warnings: [] }, replaceBody: true, deviceId: null,
      messageMetadata: [...store.rows(messages), { id: restoredId, revisionId: previous.id, ordinal: 2,
        role: restoredBody.role, externalMessageId: restoredBody.externalMessageId ?? null, model: null,
        sourceCreatedAt: null, createdAt: firstObservedAt, fingerprint: messageFingerprint(restoredBody) }] });
    expect(store.rows(messages).find((message) => message.ordinal === 2)).toMatchObject({ id: restoredId, createdAt: firstObservedAt });
    expect(store.hydrate(previous.id)).toEqual(source(3).messages);
  });

  it("upgrades an unchanged single legacy snapshot without reading metadata or rewriting messages and search chunks", async () => {
    const store = captureStore(mocks);
    const original = source(3);
    original.messages[1] = { ...original.messages[1]!, model: "recorded-model", createdAt: "2026-09-13T23:00:00.000Z" };
    const previous = store.seedSnapshot(original);
    const oldHash = previous.contentIntegrityHash;
    const oldMessages = structuredClone(store.rows(messages));
    const oldSegments = structuredClone(store.rows(messageSegments));
    store.rows(conversationSearchChunks).push({ id: id(910), revisionId: previous.id, messageId: oldMessages[0].id,
      chunkIndex: 0, content: "Message 0", createdAt: new Date(original.capturedAt) });
    const oldChunks = structuredClone(store.rows(conversationSearchChunks));

    expect(await consolidateConversationRevisions(store.rows(conversations)[0].id))
      .toEqual({ revisionId: previous.id, mergedRevisionCount: 0, messageCount: 3, changed: true });
    expect(store.tx.select).toHaveBeenCalledTimes(2); // Conversation and revisions; no message metadata query.
    expect(store.tx.delete).not.toHaveBeenCalled();
    expect(store.tx.insert).not.toHaveBeenCalled();
    expect(store.rows(messages)).toEqual(oldMessages);
    expect(store.rows(messageSegments)).toEqual(oldSegments);
    expect(store.rows(conversationSearchChunks)).toEqual(oldChunks);
    expect(store.hydrate(previous.id)).toEqual(original.messages);
    const canonical = store.rows(conversationRevisions)[0];
    expect(canonical).toMatchObject({ id: previous.id, isAccumulated: true, storageKind: "snapshot", baseRevisionId: null, baseMessageCount: null });
    expect(canonical.contentIntegrityHash).not.toBe(oldHash);
    expect(canonical.contentIntegrityHash).toBe(contentIntegrityHash(original, { variants: [], warnings: [] }));
  });

  it("rewrites a single legacy snapshot when repeated IDs normalize its body and add alternate content", async () => {
    const store = captureStore(mocks);
    const original = source(3);
    original.messages[2]!.externalMessageId = original.messages[1]!.externalMessageId;
    const previous = store.seedSnapshot(original);

    expect(await consolidateConversationRevisions(store.rows(conversations)[0].id))
      .toMatchObject({ revisionId: previous.id, mergedRevisionCount: 0, messageCount: 2, changed: true });
    expect(store.tx.delete).toHaveBeenCalledWith(messages);
    expect(store.tx.insert).toHaveBeenCalledWith(messages);
    expect(store.tx.insert).toHaveBeenCalledWith(conversationSearchChunks);
    expect(store.hydrate(previous.id).map((message) => message.ordinal)).toEqual([0, 1]);
    expect(store.rows(conversationRevisions)[0].mergeEvidence.variants)
      .toEqual([original.messages[2]]);
    expect(store.rows(conversationSearchChunks).map((chunk) => chunk.content).join("\n")).toContain("Message 2");
  });

  it("rewrites a single legacy snapshot when normalization repairs stored ordinals", async () => {
    const store = captureStore(mocks);
    const original = source(2);
    original.messages[1]!.ordinal = 3;
    const previous = store.seedSnapshot(original);

    await consolidateConversationRevisions(store.rows(conversations)[0].id);
    expect(store.tx.delete).toHaveBeenCalledWith(messages);
    expect(store.tx.insert).toHaveBeenCalledWith(messages);
    expect(store.hydrate(previous.id).map((message) => message.ordinal)).toEqual([0, 1]);
  });

  it("retains all 40 archived messages when a later complete-claiming capture omits 11 interior messages", async () => {
    const store = captureStore(mocks);
    const previous = store.seedSnapshot(source(40));
    const oldMessage = { ...store.rows(messages)[20] };
    const incoming = { ...source(40), capturedAt: "2026-09-14T01:00:00.000Z", branchFingerprint: "missing-window",
      messages: source(40).messages.filter((message) => message.ordinal < 8 || message.ordinal > 18).map((message, ordinal) => ({ ...message, ordinal })) };
    const receipt = await ingestCapture(incoming, id(900), "shorter-request");
    expect(receipt).toMatchObject({ revisionId: previous.id, messageCount: 29, completeness: "partial", archiveMessageCount: 40, archiveCompleteness: "complete" });
    expect(receipt.baselineContentHash).toBeUndefined();
    expect(store.rows(conversationRevisions)).toHaveLength(1);
    expect(store.rows(conversationRevisions)[0]).toMatchObject({ isAccumulated: true, storageKind: "snapshot", baseRevisionId: null, baseMessageCount: null });
    expect(store.hydrate(previous.id)).toEqual(source(40).messages);
    expect(store.rows(messages).find((message) => message.externalMessageId === oldMessage.externalMessageId)).toMatchObject({ id: oldMessage.id, createdAt: oldMessage.createdAt });
    const run = store.rows(captureRuns)[0];
    expect(run).toMatchObject({ requestHash: captureRequestHash(incoming), payloadIdentityHash: revisionIdentityHash(incoming), status: "partial", messageCount: 29, receipt });
    const hydrationCount = mocks.loadBatch.mock.calls.length;
    expect(await ingestCapture(incoming, id(900), "shorter-request")).toEqual({ ...receipt, unchanged: true });
    expect(mocks.loadBatch).toHaveBeenCalledTimes(hydrationCount);
    expect(store.rows(captureRuns)).toHaveLength(1);
    await expect(ingestCapture({ ...incoming, title: "Changed request" }, id(900), "shorter-request")).rejects.toThrow(/Idempotency-Key/);
  });

  it("replays an accepted delta before inspecting its now-stale baseline and adds incremental usage once", async () => {
    const store = captureStore(mocks);
    const usage = { scope: "cumulative" as const, inputTokens: 70, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 30, reasoningOutputTokens: 0, totalTokens: 100 };
    const first = await ingestCapture({ ...source(2), tokenUsage: usage }, id(900), "first");
    const delta = {
      schemaVersion: 1, provider: "chatgpt", sessionId: "same-conversation", branchFingerprint: "branch-same", adapterVersion: "2.4.0",
      capturedAt: "2026-09-14T01:00:00.000Z", captureMode: "append", baseRevisionId: first.revisionId,
      baseContentHash: first.baselineContentHash, baseMessageCount: 2, baseLastMessageId: id(1),
      tokenUsage: { ...usage, scope: "incremental", inputTokens: 14, outputTokens: 6, totalTokens: 20 },
      appendedMessages: source(4).messages.slice(2),
    };
    const appended = await ingestCapture(delta, id(900), "append");
    expect(appended).toMatchObject({ revisionId: first.revisionId, messageCount: 4, archiveMessageCount: 4, completeness: "complete" });
    expect(appended.baselineContentHash).not.toBe(first.baselineContentHash);
    expect(store.rows(conversationRevisions)).toHaveLength(1);
    expect(store.rows(conversationRevisions)[0].reportedTotalTokens).toBe(120);
    expect(await ingestCapture(delta, id(900), "append")).toEqual({ ...appended, unchanged: true });
    expect(store.rows(conversationRevisions)[0].reportedTotalTokens).toBe(120);
    expect(store.rows(messages)).toHaveLength(4);
    await expect(ingestCapture(delta, id(900), "stale-new-key")).rejects.toThrow(/content baseline/);
    expect(store.rows(captureRuns)).toHaveLength(2);
  });

  it("requires a full fallback from old clients without a baseline hash and preserves all rows on rejection", async () => {
    const store = captureStore(mocks);
    const first = await ingestCapture(source(2), id(900), "first");
    await expect(ingestCapture({ schemaVersion: 1, provider: "chatgpt", sessionId: "same-conversation", branchFingerprint: "branch-same",
      adapterVersion: "old", capturedAt: "2026-09-14T01:00:00.000Z", captureMode: "append", baseRevisionId: first.revisionId,
      baseMessageCount: 2, baseLastMessageId: id(1), appendedMessages: source(4).messages.slice(2) }, id(900), "legacy-delta"))
      .rejects.toThrow(/content baseline/);
    expect(store.hydrate(first.revisionId)).toEqual(source(2).messages);
    expect(store.rows(captureRuns)).toHaveLength(1);
  });

  it("writes only an appended suffix and preserves every old message, segment and search chunk", async () => {
    const store = captureStore(mocks);
    const first = await ingestCapture(source(2), id(900), "first");
    const previous = [messages, messageSegments, conversationSearchChunks].map((table) => structuredClone(store.rows(table)));
    store.tx.select.mockClear(); store.tx.insert.mockClear(); store.tx.delete.mockClear();
    const appendedMessage = { ...source(3).messages[2]!, segments: [
      { type: "text", content: "Message 2" }, { type: "code", content: "new_code()", language: "python" },
    ] };
    await ingestCapture({ schemaVersion: 1, provider: "chatgpt", sessionId: "same-conversation", branchFingerprint: "branch-same",
      adapterVersion: "2.4.0", capturedAt: "2026-09-14T01:00:00.000Z", captureMode: "append", baseRevisionId: first.revisionId,
      baseContentHash: first.baselineContentHash, baseMessageCount: 2, baseLastMessageId: id(1), appendedMessages: [appendedMessage] }, id(900), "append");

    expect(store.tx.select).toHaveBeenCalledTimes(3); // Receipt, conversation, revisions; no message metadata query.
    expect(store.tx.delete).not.toHaveBeenCalled();
    for (const [index, table] of [messages, messageSegments, conversationSearchChunks].entries()) {
      const oldIds = new Set(previous[index]!.map((row) => row.id));
      expect(store.rows(table).filter((row) => oldIds.has(row.id))).toEqual(previous[index]);
    }
    expect(store.rows(messages)).toHaveLength(3);
    expect(store.rows(messageSegments)).toHaveLength(4);
    expect(store.rows(conversationSearchChunks)).toHaveLength(3);
    expect(store.hydrate(first.revisionId)).toEqual([...source(2).messages, appendedMessage]);
  });

  it.each(["reorder", "prefix", "alternate"])("rewrites the body when a longer capture changes %s evidence", async (change) => {
    const store = captureStore(mocks);
    await ingestCapture(source(2), id(900), "first");
    const oldChunkIds = new Set(store.rows(conversationSearchChunks).map((row) => row.id));
    store.tx.delete.mockClear();
    const incoming = source(change === "alternate" ? 4 : 3);
    if (change === "reorder") incoming.messages = [incoming.messages[1]!, incoming.messages[0]!, incoming.messages[2]!]
      .map((message, ordinal) => ({ ...message, ordinal }));
    else if (change === "prefix") incoming.messages[0]!.segments[0]!.content = "Message 0 expanded";
    else incoming.messages[3] = { ...incoming.messages[3]!, externalMessageId: id(1), segments: [{ type: "text", content: "An alternate answer" }] };

    await ingestCapture({ ...incoming, capturedAt: "2026-09-14T01:00:00.000Z" }, id(900), "changed");
    expect(store.tx.delete).toHaveBeenCalledWith(messages);
    expect(store.rows(conversationSearchChunks).some((row) => oldChunkIds.has(row.id))).toBe(false);
    if (change === "alternate") expect(store.rows(conversationRevisions)[0].mergeEvidence.variants)
      .toEqual([incoming.messages[3]]);
  });

  it("keeps unchanged variants attached to their original search chunks when appending", async () => {
    const store = captureStore(mocks);
    await ingestCapture(source(2), id(900), "first");
    const edited = source(2);
    edited.messages[1]!.segments[0]!.content = "An alternate answer";
    await ingestCapture({ ...edited, capturedAt: "2026-09-14T01:00:00.000Z" }, id(900), "edit");
    const oldChunks = structuredClone(store.rows(conversationSearchChunks));
    const oldEvidence = structuredClone(store.rows(conversationRevisions)[0].mergeEvidence);
    store.tx.delete.mockClear();

    await ingestCapture({ ...edited, messages: [...edited.messages, source(3).messages[2]!], capturedAt: "2026-09-14T02:00:00.000Z" }, id(900), "longer");
    expect(store.tx.delete).not.toHaveBeenCalled();
    expect(store.rows(conversationRevisions)[0].mergeEvidence).toEqual(oldEvidence);
    const oldIds = new Set(oldChunks.map((row) => row.id));
    expect(store.rows(conversationSearchChunks).filter((row) => oldIds.has(row.id))).toEqual(oldChunks);
    expect(store.rows(conversationSearchChunks).filter((row) => !oldIds.has(row.id)).map((row) => row.content)).toEqual(["Message 2"]);
  });

  it("retains an existing source-time observation through partial and full captures without generating more metadata variants", async () => {
    const store = captureStore(mocks);
    const original = source(2);
    original.messages[1] = { ...original.messages[1]!, model: "observed-model", createdAt: "2026-09-13T23:00:00.000Z" };
    await ingestCapture(original, id(900), "first");
    const variant = { ...original.messages[1]!, createdAt: "2026-09-13T22:00:00.000Z" };
    store.rows(conversationRevisions)[0].mergeEvidence = { variants: [variant], warnings: [] };
    const complete = { ...source(3), messages: [...original.messages, source(3).messages[2]!] };
    await ingestCapture({ ...complete, capturedAt: "2026-09-14T01:00:00.000Z" }, id(900), "longer");
    const partial = { ...complete, capturedAt: "2026-09-14T02:00:00.000Z", messages: [{ ...complete.messages[2]!, ordinal: 0 }],
      completeness: { status: "partial", topReached: false, bottomReached: true, stable: true } };
    await ingestCapture(partial, id(900), "partial");
    for (const index of [1, 2]) {
      await ingestCapture({ ...complete, capturedAt: `2026-09-14T0${index + 2}:00:00.000Z`,
        messages: complete.messages.map((message) => message.externalMessageId === id(1)
          ? { ...message, createdAt: "2026-09-14T00:00:00.000Z" } : message) }, id(900), `same-content-${index}`);
      expect(store.rows(conversationRevisions)[0].mergeEvidence.variants).toEqual([variant]);
      expect(store.rows(messages)).toHaveLength(3);
    }
  });

  it("rebuilds search chunks when appending supplies a previously missing variant anchor", async () => {
    const store = captureStore(mocks);
    await ingestCapture(source(2), id(900), "first");
    const evidence = { variants: [{ ...source(3).messages[2]!, segments: [{ type: "text", content: "Preserved alternate" }] }], warnings: [] };
    store.rows(conversationRevisions)[0].mergeEvidence = evidence;
    store.rows(conversationSearchChunks)[0].content += "\nPreserved alternate";
    store.tx.delete.mockClear();

    await ingestCapture({ ...source(3), capturedAt: "2026-09-14T01:00:00.000Z" }, id(900), "longer");
    expect(store.rows(conversationRevisions)[0].mergeEvidence).toEqual(evidence);
    expect(store.tx.delete).toHaveBeenCalledWith(messages);
    const first = store.rows(messages).find((row) => row.ordinal === 0)!;
    const appended = store.rows(messages).find((row) => row.ordinal === 2)!;
    expect(store.rows(conversationSearchChunks).filter((row) => row.messageId === first.id).map((row) => row.content)).toEqual(["Message 0"]);
    expect(store.rows(conversationSearchChunks).filter((row) => row.messageId === appended.id).map((row) => row.content))
      .toEqual(["Message 2\nPreserved alternate"]);
  });

  it("folds legacy delta storage and keeps alternate same-ID answers searchable with their source times", async () => {
    const store = captureStore(mocks);
    const first = store.seedSnapshot(source(2));
    store.seedSnapshot({ ...source(4), capturedAt: "2026-09-14T01:00:00.000Z", captureMode: "append", baseRevisionId: first.id, baseMessageCount: 2 },
      { storageKind: "delta", baseRevisionId: first.id, baseMessageCount: 2 });
    const changed = source(4);
    changed.messages[1]!.segments[0]!.content = "A completely revised answer";
    store.seedSnapshot({ ...changed, capturedAt: "2026-09-14T02:00:00.000Z" });
    const oldestAnswer = { ...store.rows(messages).find((message) => message.revisionId === first.id && message.ordinal === 1) };
    const result = await consolidateConversationRevisions(store.rows(conversations)[0].id);
    expect(result).toMatchObject({ revisionId: first.id, mergedRevisionCount: 2, messageCount: 4, changed: true });
    expect(store.rows(conversationRevisions)).toHaveLength(1);
    const canonical = store.rows(conversationRevisions)[0];
    expect(canonical).toMatchObject({ isAccumulated: true, storageKind: "snapshot", baseRevisionId: null, baseMessageCount: null, completeness: "partial" });
    expect(canonical.mergeEvidence.variants.some((message: any) => message.segments[0].content === "Message 1")).toBe(true);
    expect(store.hydrate(first.id)[1]!.segments[0]!.content).toBe("A completely revised answer");
    expect(store.rows(messages).find((message) => message.ordinal === 1)).toMatchObject({ id: oldestAnswer.id, createdAt: oldestAnswer.createdAt });
    const text = store.rows(conversationSearchChunks).map((chunk) => chunk.content).join("\n");
    expect(text).toContain("Message 1");
    expect(text).toContain("A completely revised answer");
    expect(store.rows(captureRuns)).toHaveLength(0);
  });

  it("can replay a legacy full snapshot after its old revision was physically folded away", async () => {
    const store = captureStore(mocks);
    const old = source(2);
    store.seedSnapshot(old);
    store.seedSnapshot({ ...source(4), capturedAt: "2026-09-14T01:00:00.000Z" });
    store.rows(captureRuns).push({ id: id(901), provider: old.provider, externalSessionId: old.sessionId, deviceId: id(900), idempotencyKey: "old-key",
      snapshotHash: "old-stored-effective-hash", payloadIdentityHash: revisionIdentityHash(old), status: "complete", messageCount: 2, requestHash: null, receipt: null });
    await consolidateConversationRevisions(store.rows(conversations)[0].id);
    const receipt = await ingestCapture(old, id(900), "old-key");
    expect(receipt).toMatchObject({ messageCount: 2, archiveMessageCount: 4, completeness: "partial", unchanged: true });
    expect(store.rows(captureRuns)).toHaveLength(1);
    expect(store.rows(captureRuns)[0].receipt).toEqual(receipt);
    expect(store.rows(conversationRevisions)).toHaveLength(1);
  });

  it("hashes the reconstructable primary body, preserved variants and cumulative usage together", async () => {
    const store = captureStore(mocks);
    const first = await ingestCapture({ ...source(2), tokenUsage: { scope: "cumulative", inputTokens: 60,
      cachedInputTokens: 10, cacheWriteInputTokens: 0, outputTokens: 40, reasoningOutputTokens: 5, totalTokens: 100 } }, id(900), "first");
    const updated = source(2);
    updated.messages[1]!.segments = [{ type: "text", content: "Alternate captured answer" }];
    await ingestCapture({ ...updated, capturedAt: "2026-09-14T01:00:00.000Z" }, id(900), "edited");
    const row = store.rows(conversationRevisions)[0];
    const usage = storedTokenUsage(row)!;
    const reconstructed = {
      ...source(2), branchFingerprint: row.branchFingerprint, capturedAt: row.capturedAt.toISOString(),
      captureMode: row.captureMode, ...(row.triggerReason ? { triggerReason: row.triggerReason } : {}),
      tokenUsage: usage,
      completeness: { status: row.completeness, topReached: row.topReached, bottomReached: row.bottomReached,
        stable: row.stable, ...(row.completenessReason ? { reason: row.completenessReason } : {}) },
      messages: store.hydrate(first.revisionId),
    };
    expect(contentIntegrityHash(reconstructed, row.mergeEvidence)).toBe(row.contentIntegrityHash);
    expect(contentIntegrityHash(reconstructed, { variants: [], warnings: [] })).not.toBe(row.contentIntegrityHash);
    expect(contentIntegrityHash({ ...reconstructed, tokenUsage: { ...usage, totalTokens: 105 } }, row.mergeEvidence)).not.toBe(row.contentIntegrityHash);
  });
});
