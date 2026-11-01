import type { CaptureDeltaV1, CaptureMessage, CaptureSnapshotV1, TokenUsage } from "@ai-archive/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { conversationRevisions } from "../src/schema.js";
import { ingestCapture } from "../src/services/capture.js";
import { mergeConversationMessages } from "../src/services/conversation-merge.js";
import { captureStore } from "./capture-store-fixture.js";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), loadMessages: vi.fn(), loadBatch: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/services/revision-storage.js", () => ({ loadCaptureRevisionMessages: mocks.loadMessages, loadCaptureRevisionMessagesBatch: mocks.loadBatch }));
vi.mock("../src/services/redaction.js", async (original) => ({
  ...await original<typeof import("../src/services/redaction.js")>(), loadEnabledCustomRedactionRules: vi.fn(async () => []),
}));

const usage = (total: number, scope: TokenUsage["scope"] = "cumulative"): TokenUsage => ({
  scope, inputTokens: total, cachedInputTokens: 0, cacheWriteInputTokens: 0,
  outputTokens: 0, reasoningOutputTokens: 0, totalTokens: total,
});
const anonymous = (...contents: string[]): CaptureMessage[] => contents.map((content, ordinal) => ({
  ordinal, role: "user", segments: [{ type: "text", content }],
}));

describe("independent accumulated archive regressions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("does not duplicate repeated anonymous turns when the full source grows", () => {
    const previous = anonymous("continue", "answer", "continue", "answer");
    const next = anonymous("continue", "answer", "continue", "answer", "new answer");
    const merged = mergeConversationMessages(previous, next);
    expect(merged.messages).toEqual(next);
    expect(mergeConversationMessages(merged.messages, next).changed).toBe(false);
  });

  it("retains new anonymous repetitions instead of mapping an append back onto a prior occurrence", () => {
    const previous = anonymous("continue", "answer", "continue", "answer");
    const next = anonymous("continue", "answer", "continue", "answer", "continue", "answer");
    const merged = mergeConversationMessages(previous, next);
    expect(merged.messages).toEqual(next);
    expect(mergeConversationMessages(merged.messages, next).changed).toBe(false);
  });

  it("invalidates a token-only delta baseline even when its source timestamp predates the archive", async () => {
    const store = captureStore(mocks);
    const snapshot: CaptureSnapshotV1 = {
      schemaVersion: 1, provider: "openclaw", sessionId: "review-session", branchFingerprint: "review-branch",
      adapterVersion: "review", capturedAt: "2026-09-14T10:00:00.000Z", captureMode: "full",
      completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
      tokenUsage: usage(100), messages: [{ ...anonymous("question")[0]!, externalMessageId: "q" }],
    };
    const deviceId = "88888888-8888-4888-8888-888888888888";
    const first = await ingestCapture(snapshot, deviceId, "review-base");
    const delta: CaptureDeltaV1 = {
      schemaVersion: 1, provider: snapshot.provider, sessionId: snapshot.sessionId,
      branchFingerprint: snapshot.branchFingerprint, adapterVersion: snapshot.adapterVersion,
      capturedAt: "2026-09-14T09:59:00.000Z", captureMode: "append", triggerReason: "local_file_appended",
      baseRevisionId: first.revisionId, baseMessageCount: 1, baseLastMessageId: "q",
      baseContentHash: first.baselineContentHash!, tokenUsage: usage(5, "incremental"), appendedMessages: [],
    };
    const receipt = await ingestCapture(delta, deviceId, "review-token-update");
    expect(store.rows(conversationRevisions)[0].reportedTotalTokens).toBe(105);
    expect(receipt.baselineContentHash).not.toBe(first.baselineContentHash);
    await expect(ingestCapture(delta, deviceId, "review-same-source-new-key")).rejects.toThrow(/baseline/);
    expect(store.rows(conversationRevisions)[0].reportedTotalTokens).toBe(105);
  });
});
