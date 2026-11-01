import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureRuns, conversationRevisions, conversations, messages } from "../src/schema.js";
import { captureRequestHash, consolidateConversationRevisions, contentIntegrityHash, ingestCapture } from "../src/services/capture.js";
import { captureStore } from "./capture-store-fixture.js";
import { projectSourceReview, sourceReviewBodyHash } from "../src/services/source-review.js";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), loadBatch: vi.fn(), loadMessages: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/services/conversation-lineage.js", () => ({ persistConversationParent: vi.fn() }));
vi.mock("../src/services/revision-storage.js", () => ({ loadCaptureRevisionMessages: mocks.loadMessages, loadCaptureRevisionMessagesBatch: mocks.loadBatch }));
vi.mock("../src/services/redaction.js", async (original) => ({ ...await original<typeof import("../src/services/redaction.js")>(), loadEnabledCustomRedactionRules: vi.fn(async () => []) }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const source = (count = 4): CaptureSnapshotV1 => ({
  schemaVersion: 1, provider: "chatgpt", sessionId: "order-evidence", branchFingerprint: "branch-stable",
  adapterVersion: "2.4.0", capturedAt: "2026-09-14T00:00:00.000Z", captureMode: "full",
  completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
  messages: Array.from({ length: count }, (_, ordinal) => ({ ordinal, externalMessageId: id(ordinal),
    role: ordinal % 2 ? "assistant" : "user", createdAt: "2026-09-13T23:00:00.000Z",
    segments: [{ type: "text", content: `Message ${ordinal}` }] })),
});
const reorder = (body: readonly CaptureMessage[], positions: number[]) => positions.map((position, ordinal) => ({ ...body[position]!, ordinal }));
const oldOrder = { type: "order" as const, messageIds: [id(0), id(1), id(2), id(3)] };
const oldDisconnected = { type: "disconnected" as const, messageIds: [id(2), id(3)] };
const partial = (snapshot: CaptureSnapshotV1): CaptureSnapshotV1 => ({ ...snapshot,
  completeness: { status: "partial", topReached: true, bottomReached: false, stable: true } });

describe("verified full captures resolve only proven historical order evidence", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([false, true])("archives all available source content regardless of source generation status (existing=%s)", async existing => {
    const store = captureStore(mocks);
    if (existing) store.seedSnapshot(partial(source(51)), { isAccumulated: true });
    const native: CaptureSnapshotV1 = { ...source(40), sourceKind: "chatgpt_current_branch",
      canonicalUrl: "https://chatgpt.com/c/order-evidence", capturedAt: "2026-10-08T00:00:00.000Z",
      completeness: { status: "partial", topReached: true, bottomReached: true, stable: true,
        reason: "已读取当前分支全部 40 条消息，顺序和原始时间已保留；1 条在原会话中未标记完成，请在原会话核对" } };
    native.messages[39]!.segments.push({ type: "text", content: "[原会话未将此消息标记为完成；已保存当前可读取的正文]" });
    const receipt = await ingestCapture(native, id(900), "available-content");
    const row = store.rows(conversationRevisions)[0];
    expect(receipt.archiveCompleteness).toBe("complete");
    expect(receipt.baselineContentHash).toBeUndefined();
    expect(row.mergeEvidence.sourceReview).toMatchObject({ contentComplete: false, captureComplete: true });
    expect(row.completeness).toBe("complete");
    expect(row.completenessReason).toBe("1 条原回答在源站未标记完成；已归档当前分支全部 40 条消息及源站返回的正文。");
    const projected = projectSourceReview({ provider: "chatgpt", sessionId: native.sessionId,
      primaryMessages: store.hydrate(row.id), ...row.mergeEvidence });
    expect(projected.projectedMessages).toEqual(native.messages);
    const window = { ...native, capturedAt: "2026-10-08T00:01:00.000Z", messages: native.messages.slice(-6)
      .map((message, ordinal) => ({ ...message, ordinal })), completeness: { ...native.completeness, topReached: false } };
    delete window.sourceKind;
    expect((await ingestCapture(window, id(900), "known-window")).archiveCompleteness).toBe("complete");
  });

  it.each(["unsupported", "mismatched_count", "missing_marker", "dom", "unstable"])("does not promote a %s partial capture", async kind => {
    const store = captureStore(mocks);
    const native: CaptureSnapshotV1 = { ...source(4), sourceKind: "chatgpt_current_branch",
      canonicalUrl: "https://chatgpt.com/c/order-evidence",
      completeness: { status: "partial", topReached: true, bottomReached: true, stable: true,
        reason: "已读取当前分支全部 4 条消息，顺序和原始时间已保留；1 条在原会话中未标记完成，请在原会话核对" } };
    if (kind !== "missing_marker") native.messages[3]!.segments.push({ type: "text", content: "[原会话未将此消息标记为完成；已保存当前可读取的正文]" });
    if (kind === "unsupported") native.completeness.reason = native.completeness.reason!.replace("，请", "；1 条含暂无法解析的内容，请");
    if (kind === "mismatched_count") native.completeness.reason = native.completeness.reason!.replace("全部 4", "全部 40");
    if (kind === "dom") delete native.sourceKind;
    if (kind === "unstable") { delete native.sourceKind; native.completeness.stable = false; }
    expect((await ingestCapture(native, id(900), kind)).archiveCompleteness).toBe("partial");
  });

  it("accepts the updated adapter's complete content snapshot with a separate source-generation notice", async () => {
    const store = captureStore(mocks);
    const native: CaptureSnapshotV1 = { ...source(2), sourceKind: "chatgpt_current_branch", adapterVersion: "1.2.15",
      canonicalUrl: "https://chatgpt.com/c/order-evidence",
      completeness: { ...source().completeness, reason: "1 条原回答在源站未标记完成；已归档当前分支全部 2 条消息及源站返回的正文。" } };
    native.messages[1]!.segments.push({ type: "text", content: "[原会话未将此消息标记为完成；已保存当前可读取的正文]" });
    const receipt = await ingestCapture(native, id(900), "new-adapter-available-body");
    expect(receipt.archiveCompleteness).toBe("complete");
    expect(store.rows(conversationRevisions)[0].mergeEvidence.sourceReview).toMatchObject({ contentComplete: false, captureComplete: true });
  });

  it.each(["partial", "complete"] as const)("recovers 40 native messages from 51 stored rows including four anonymous fragments (%s)", async status => {
    const store = captureStore(mocks);
    const old = partial(source(51));
    for (const message of old.messages) delete message.createdAt;
    for (const ordinal of [41, 43, 45, 47]) delete old.messages[ordinal]!.externalMessageId;
    old.messages = [...old.messages].reverse().map((message, ordinal) => ({ ...message, ordinal }));
    const variants = old.messages.filter(message => message.externalMessageId).slice(0, 32)
      .map(message => ({ ...message, segments: [{ type: "text" as const, content: `Old rendering ${message.externalMessageId}` }] }));
    const beforeBodies = [...old.messages, ...variants].map(sourceReviewBodyHash);
    const previous = store.seedSnapshot(old, { isAccumulated: true, mergeEvidence: { variants, warnings: [oldOrder] } });
    const native: CaptureSnapshotV1 = { ...source(40), sourceKind: "chatgpt_current_branch",
      canonicalUrl: "https://chatgpt.com/c/order-evidence", capturedAt: "2026-10-07T15:00:00.000Z",
      completeness: { status, topReached: true, bottomReached: true, stable: true,
        ...(status === "partial" ? { reason: "1 条在原会话中未标记完成" } : {}) } };
    const receipt = await ingestCapture(native, id(900), `native-anonymous-${status}`,
      { revisionId: previous.id, contentIntegrityHash: previous.contentIntegrityHash });
    const row = store.rows(conversationRevisions)[0];
    const observed = [...store.hydrate(previous.id), ...row.mergeEvidence.variants];
    expect(observed.map(sourceReviewBodyHash)).toEqual(expect.arrayContaining(beforeBodies));
    expect(store.hydrate(previous.id)).toHaveLength(51);
    const projected = projectSourceReview({ provider: "chatgpt", sessionId: native.sessionId,
      primaryMessages: store.hydrate(previous.id), ...row.mergeEvidence });
    expect(projected.validation.valid).toBe(true);
    expect(projected.fullyApplicable).toBe(true);
    expect(projected.unresolvedWarnings).toEqual([]);
    expect(projected.projectedMessages).toEqual(native.messages);
    expect(projected.inactiveMessages).toHaveLength(11);
    expect(row.mergeEvidence.sourceReview.inactiveAnonymousBodies).toHaveLength(4);
    expect(row.completenessReason).toBe(native.completeness.reason ?? null);
    expect(receipt.archiveCompleteness).toBe(status);
    expect(receipt.baselineContentHash).toBeUndefined();
    expect(contentIntegrityHash({ ...native, messages: store.hydrate(previous.id) }, row.mergeEvidence)).toBe(row.contentIntegrityHash);
  });

  it("rejects a maintenance replay when its audited archive baseline changed", async () => {
    const store = captureStore(mocks);
    const previous = store.seedSnapshot(partial(source()), { isAccumulated: true });
    await expect(ingestCapture(source(), id(900), "stale-replay",
      { revisionId: previous.id, contentIntegrityHash: "outdated" })).rejects.toThrow("Archive changed");
    expect(store.rows(captureRuns)).toHaveLength(0);
    expect(store.rows(conversationRevisions)[0].contentIntegrityHash).toBe(previous.contentIntegrityHash);
  });

  it("preserves an anonymous observation when native ingestion assigns its stable identity", async () => {
    const store = captureStore(mocks);
    const old = partial(source(4));
    delete old.messages[1]!.externalMessageId;
    const anonymousHash = sourceReviewBodyHash(old.messages[1]!);
    const previous = store.seedSnapshot(old, { isAccumulated: true });
    const native: CaptureSnapshotV1 = { ...source(4), sourceKind: "chatgpt_current_branch",
      canonicalUrl: "https://chatgpt.com/c/order-evidence", capturedAt: "2026-10-07T15:00:00.000Z" };
    await ingestCapture(native, id(900), "native-assign-identity");
    const row = store.rows(conversationRevisions)[0];
    const projected = projectSourceReview({ provider: "chatgpt", sessionId: native.sessionId,
      primaryMessages: store.hydrate(previous.id), ...row.mergeEvidence });
    expect(projected.fullyApplicable).toBe(true);
    expect(row.mergeEvidence.variants.map(sourceReviewBodyHash)).toContain(anonymousHash);
    expect(projected.projectedMessages).toEqual(native.messages);
  });

  it("recovers the native branch order and September dates from 51 mixed October DOM observations without deleting history", async () => {
    const store = captureStore(mocks);
    const original = partial(source(51));
    original.messages = reorder(original.messages, [0, 1, ...Array.from({ length: 47 }, (_, n) => n + 4), 2, 3]);
    for (const message of original.messages) delete message.createdAt;
    original.messages[0]!.segments[0]!.content = "Message 0 plus a DOM attachment preview";
    const previous = store.seedSnapshot(original, { isAccumulated: true,
      mergeEvidence: { variants: [], warnings: [oldOrder, oldDisconnected] } });
    const native: CaptureSnapshotV1 = { ...source(42), sourceKind: "chatgpt_current_branch",
      canonicalUrl: "https://chatgpt.com/c/order-evidence", capturedAt: "2026-10-07T15:00:00.000Z" };
    const receipt = await ingestCapture(native, id(900), "native-recovery");
    const projection = () => {
      const row = store.rows(conversationRevisions)[0];
      return projectSourceReview({ provider: native.provider, sessionId: native.sessionId,
        primaryMessages: store.hydrate(previous.id), ...row.mergeEvidence });
    };
    expect(receipt.archiveCompleteness).toBe("complete");
    expect(receipt.baselineContentHash).toBeUndefined(); // physical history is larger than the active branch
    expect(store.hydrate(previous.id)).toHaveLength(51);
    expect(projection().fullyApplicable).toBe(true);
    expect(projection().projectedMessages.map(sourceReviewBodyHash)).toEqual(native.messages.map(sourceReviewBodyHash));
    expect(projection().projectedMessages[0]!.createdAt).toBe("2026-09-13T23:00:00.000Z");
    expect(projection().inactiveMessages).toHaveLength(9);
    expect(projection().remainderObservations.some(row => row.message.segments[0]!.content.includes("DOM attachment preview"))).toBe(true);
    const passive = partial({ ...native, capturedAt: "2026-10-07T15:01:00.000Z",
      messages: native.messages.slice(-6).map((message, ordinal) => ({ ...message, ordinal })) });
    delete passive.sourceKind;
    const autoReceipt = await ingestCapture(passive, id(900), "passive-window");
    expect(autoReceipt.archiveCompleteness).toBe("complete");
    expect(projection().projectedMessages.map(sourceReviewBodyHash)).toEqual(native.messages.map(sourceReviewBodyHash));
    expect(store.hydrate(previous.id)).toHaveLength(51);
  });

  it.each(["older", "dom"])("does not establish a native branch from an %s observation", async kind => {
    const store = captureStore(mocks);
    store.seedSnapshot(partial(source(51)), { isAccumulated: true });
    const incoming: CaptureSnapshotV1 = { ...source(42), sourceKind: "chatgpt_current_branch",
      canonicalUrl: "https://chatgpt.com/c/order-evidence", capturedAt: "2026-10-07T15:00:00.000Z" };
    if (kind === "older") incoming.capturedAt = "2026-09-13T00:00:00.000Z";
    if (kind === "dom") delete incoming.sourceKind;
    await ingestCapture(incoming, id(900), `not-native-${kind}`);
    expect(store.rows(conversationRevisions)[0].mergeEvidence.sourceReview).toBeUndefined();
  });

  it("uses a verified native chain to correct order and dates even while one body remains unfinished", async () => {
    const store = captureStore(mocks);
    const old = partial(source(51));
    old.messages = [...old.messages].reverse().map((message, ordinal) => ({ ...message, ordinal }));
    for (const message of old.messages) delete message.createdAt;
    const previous = store.seedSnapshot(old, { isAccumulated: true });
    const native: CaptureSnapshotV1 = { ...source(42), sourceKind: "chatgpt_current_branch",
      canonicalUrl: "https://chatgpt.com/c/order-evidence", capturedAt: "2026-10-07T15:00:00.000Z",
      completeness: { status: "partial", topReached: true, bottomReached: true, stable: true, reason: "1 条在原会话中未标记完成" } };
    const receipt = await ingestCapture(native, id(900), "unfinished-native");
    const row = store.rows(conversationRevisions)[0];
    const projected = projectSourceReview({ provider: "chatgpt", sessionId: native.sessionId,
      primaryMessages: store.hydrate(previous.id), ...row.mergeEvidence });
    expect(receipt.archiveCompleteness).toBe("partial");
    expect(receipt.baselineContentHash).toBeUndefined();
    expect(row.mergeEvidence.sourceReview.contentComplete).toBe(false);
    expect(row.completenessReason).toBe(native.completeness.reason);
    expect(projected.projectedMessages.map(message => message.externalMessageId)).toEqual(native.messages.map(message => message.externalMessageId));
    expect(projected.projectedMessages[0]!.createdAt).toMatch(/^2026-09-/);
    expect(projected.inactiveMessages).toHaveLength(9);
    const complete = { ...native, capturedAt: "2026-10-07T15:01:00.000Z", completeness: source().completeness };
    expect((await ingestCapture(complete, id(900), "finished-native")).archiveCompleteness).toBe("complete");
    expect(store.rows(conversationRevisions)[0].mergeEvidence.sourceReview.contentComplete).toBe(true);
  });

  it("uses one full capture to correct all known order, preserve alternatives and issue the matching complete baseline", async () => {
    const store = captureStore(mocks);
    const original = partial(source());
    const variant = { ...original.messages[1]!, segments: [{ type: "text" as const, content: "A distinct historical answer" }] };
    const contentWarning = { type: "content" as const, messageIds: [id(1), id(1)] };
    const previous = store.seedSnapshot(original, { isAccumulated: true,
      mergeEvidence: { variants: [variant], warnings: [oldOrder, oldDisconnected, contentWarning] } });
    const oldHash = previous.contentIntegrityHash;
    const oldMetadata = new Map(store.rows(messages).map((message) => [message.externalMessageId, { id: message.id,
      createdAt: message.createdAt, sourceCreatedAt: message.sourceCreatedAt, model: message.model }]));
    const incoming = { ...source(), capturedAt: "2026-09-14T01:00:00.000Z", messages: reorder(original.messages, [2, 0, 3, 1]) };

    const receipt = await ingestCapture(incoming, id(900), "verified-order");
    const row = store.rows(conversationRevisions)[0];
    expect(row.mergeEvidence).toEqual({ variants: [variant], warnings: [contentWarning] });
    expect(store.hydrate(previous.id)).toEqual(incoming.messages);
    expect(store.rows(conversationRevisions)).toHaveLength(1);
    for (const message of store.rows(messages)) expect(message).toMatchObject(oldMetadata.get(message.externalMessageId)!);
    expect(receipt).toMatchObject({ revisionId: previous.id, completeness: "complete", archiveCompleteness: "complete",
      messageCount: 4, archiveMessageCount: 4, baselineContentHash: row.contentIntegrityHash });
    expect(row.contentIntegrityHash).not.toBe(oldHash);
    expect(row.contentIntegrityHash).toBe(contentIntegrityHash(incoming, row.mergeEvidence));
    expect(store.rows(captureRuns)[0]).toMatchObject({ status: "complete", receipt });
    const acceptedRows = structuredClone(store.rows(messages));
    expect(await ingestCapture(incoming, id(900), "verified-order")).toEqual({ ...receipt, unchanged: true });
    expect(store.rows(messages)).toEqual(acceptedRows);
    expect(store.rows(captureRuns)).toHaveLength(1);
  });

  it("clears only scoped old order warnings even when the full body does not change", async () => {
    const store = captureStore(mocks);
    const unscoped = { type: "order" as const, messageIds: [] };
    const outside = { type: "disconnected" as const, messageIds: [id(99)] };
    const content = { type: "content" as const, messageIds: [id(1)] };
    const previous = store.seedSnapshot(partial(source()), { isAccumulated: true,
      mergeEvidence: { variants: [], warnings: [oldOrder, oldDisconnected, unscoped, outside, content] } });
    // Equal capture times are permitted; an older observation is not.
    const incoming = source();
    const receipt = await ingestCapture(incoming, id(900), "same-body");
    const row = store.rows(conversationRevisions)[0];
    expect(row.mergeEvidence.warnings).toEqual([unscoped, outside, content]);
    expect(store.hydrate(previous.id)).toEqual(incoming.messages);
    expect(receipt.baselineContentHash).toBe(contentIntegrityHash(incoming, row.mergeEvidence));
  });

  it.each(["complete", "partial"] as const)("retains 42/43 evidence for a %s source claim and a later seven-message partial", async (status) => {
    const store = captureStore(mocks);
    const original = partial(source(43));
    const previous = store.seedSnapshot(original, { isAccumulated: true,
      mergeEvidence: { variants: [], warnings: [oldOrder, oldDisconnected] } });
    for (const [index, count] of [42, 7].entries()) {
      const incoming = { ...(index || status === "partial" ? partial(source(43)) : source(43)),
        capturedAt: `2026-09-14T0${index + 1}:00:00.000Z`,
        triggerReason: index ? "branch_changed" as const : "manual_retry" as const,
        messages: source(43).messages.slice(43 - count).map((message, ordinal) => ({ ...message, ordinal })) };
      const receipt = await ingestCapture(incoming, id(900), `partial-${count}`);
      expect(receipt).toMatchObject({ completeness: "partial", messageCount: count, archiveMessageCount: 43 });
      expect(receipt.baselineContentHash).toBeUndefined();
      expect(store.rows(conversationRevisions)[0].mergeEvidence.warnings).toEqual([oldOrder, oldDisconnected]);
      expect(store.hydrate(previous.id)).toEqual(original.messages);
    }
  });

  const insufficient: Array<[string, (existing: CaptureSnapshotV1, incoming: CaptureSnapshotV1) => void]> = [
    ["partial despite complete coverage", (_old, incoming) => { incoming.completeness.status = "partial"; }],
    ["older capture", (_old, incoming) => { incoming.capturedAt = "2026-09-13T23:00:00.000Z"; }],
    ["import", (_old, incoming) => { incoming.captureMode = "import"; }],
    ["missing source ID", (_old, incoming) => { delete incoming.messages[0]!.externalMessageId; }],
    ["missing archived ID", (old) => { delete old.messages[0]!.externalMessageId; }],
    ["anonymous observations", (old, incoming) => {
      for (const message of [...old.messages, ...incoming.messages]) delete message.externalMessageId;
    }],
    ["duplicate source ID", (_old, incoming) => {
      incoming.messages.push({ ...incoming.messages[0]!, ordinal: incoming.messages.length });
    }],
    ["duplicate archived ID", (old) => { old.messages.push({ ...old.messages[0]!, ordinal: old.messages.length }); }],
    ["omitted historical identity", (_old, incoming) => { incoming.messages.pop(); }],
    ["changed role", (_old, incoming) => { incoming.messages[0]!.role = "assistant"; }],
    ["new content conflict", (_old, incoming) => { incoming.messages[1]!.segments[0]!.content = "A conflicting answer"; }],
  ];
  it.each(insufficient)("does not resolve historical order for %s", async (_name, change) => {
    const store = captureStore(mocks);
    const original = partial(source());
    const incoming = { ...source(), capturedAt: "2026-09-14T01:00:00.000Z" };
    change(original, incoming);
    store.seedSnapshot(original, { isAccumulated: true, mergeEvidence: { variants: [], warnings: [oldOrder, oldDisconnected] } });
    await ingestCapture(incoming, id(900), "unproven");
    expect(store.rows(conversationRevisions)[0].mergeEvidence.warnings).toEqual(expect.arrayContaining([oldOrder, oldDisconnected]));
    if (_name === "new content conflict") {
      expect(store.rows(conversationRevisions)[0].mergeEvidence.variants).toContainEqual(original.messages[1]);
      expect(store.rows(captureRuns)[0].status).toBe("partial");
      expect(store.rows(captureRuns)[0].receipt.baselineContentHash).toBeUndefined();
    }
  });

  it.each(["turn", "conversation-turn"])("retains warnings whose fully covered IDs are positional %s-N values", async (prefix) => {
    const store = captureStore(mocks);
    const original = partial(source());
    original.messages = original.messages.map((message) => ({ ...message, externalMessageId: `${prefix}-${message.ordinal}` }));
    const ids = original.messages.map((message) => message.externalMessageId!);
    const warnings = [{ type: "order" as const, messageIds: ids }, { type: "disconnected" as const, messageIds: ids.slice(2) }];
    store.seedSnapshot(original, { isAccumulated: true, mergeEvidence: { variants: [], warnings } });
    await ingestCapture({ ...source(), messages: original.messages, capturedAt: "2026-09-14T01:00:00.000Z" }, id(900), "positional");
    expect(store.rows(conversationRevisions)[0].mergeEvidence.warnings).toEqual(warnings);
  });

  it.each(["topReached", "bottomReached", "stable"] as const)("rejects a complete claim without %s before changing evidence", async (flag) => {
    const store = captureStore(mocks);
    store.seedSnapshot(partial(source()), { isAccumulated: true, mergeEvidence: { variants: [], warnings: [oldOrder] } });
    const oldRows = structuredClone(store.rows(conversationRevisions));
    const incoming = source(); incoming.completeness[flag] = false;
    await expect(ingestCapture(incoming, id(900), "invalid-complete")).rejects.toThrow("complete captures require");
    expect(store.rows(conversationRevisions)).toEqual(oldRows);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("never uses a reconstructed append baseline as new proof of the old prefix order", async () => {
    const store = captureStore(mocks);
    const original = source();
    const previous = store.seedSnapshot(original, { isAccumulated: true,
      mergeEvidence: { variants: [], warnings: [oldOrder, oldDisconnected] } });
    const receipt = await ingestCapture({ schemaVersion: 1, provider: original.provider, sessionId: original.sessionId,
      branchFingerprint: original.branchFingerprint, adapterVersion: original.adapterVersion, captureMode: "append",
      capturedAt: "2026-09-14T01:00:00.000Z", baseRevisionId: previous.id,
      baseContentHash: previous.contentIntegrityHash, baseMessageCount: 4, baseLastMessageId: id(3),
      appendedMessages: source(5).messages.slice(4) }, id(900), "append");
    expect(receipt).toMatchObject({ completeness: "complete", archiveMessageCount: 5 });
    expect(store.rows(conversationRevisions)[0].mergeEvidence.warnings).toEqual([oldOrder, oldDisconnected]);
  });

  it("does not turn historical consolidation into a new order verification", async () => {
    const store = captureStore(mocks);
    const original = partial(source());
    const previous = store.seedSnapshot(original, { mergeEvidence: { variants: [], warnings: [oldOrder, oldDisconnected] } });
    store.seedSnapshot({ ...source(), capturedAt: "2026-09-14T01:00:00.000Z", messages: reorder(original.messages, [2, 0, 3, 1]) });
    await consolidateConversationRevisions(store.rows(conversations)[0].id);
    expect(store.rows(conversationRevisions)[0].mergeEvidence.warnings).toEqual(expect.arrayContaining([oldOrder, oldDisconnected]));
    expect(store.hydrate(previous.id)).toHaveLength(4);
  });

  it("replays an old receipt unchanged; a fresh observation key is required to verify its order", async () => {
    const store = captureStore(mocks);
    const previous = store.seedSnapshot(partial(source()), { isAccumulated: true,
      mergeEvidence: { variants: [], warnings: [oldOrder] } });
    const incoming = source();
    const oldReceipt = { conversationId: previous.conversationId, revisionId: previous.id, unchanged: false,
      completeness: "partial" as const, messageCount: 4, archiveMessageCount: 4, archiveCompleteness: "partial" as const,
      captureMode: "full" as const, triggerReason: null };
    store.rows(captureRuns).push({ id: id(901), deviceId: id(900), idempotencyKey: "old-observation",
      requestHash: captureRequestHash(incoming), receipt: oldReceipt, status: "partial" });
    expect(await ingestCapture(incoming, id(900), "old-observation")).toEqual({ ...oldReceipt, unchanged: true });
    expect(store.rows(conversationRevisions)[0].mergeEvidence.warnings).toEqual([oldOrder]);
    expect(store.rows(captureRuns)[0].receipt).toEqual(oldReceipt);
    const newReceipt = await ingestCapture(incoming, id(900), "fresh-observation");
    expect(newReceipt.completeness).toBe("complete");
    expect(store.rows(conversationRevisions)[0].mergeEvidence.warnings).toEqual([]);
    expect(store.rows(captureRuns)[0].receipt).toEqual(oldReceipt);
  });
});
