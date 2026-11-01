import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureSnapshotV1 } from "@ai-archive/contracts";
import { ingestCapture } from "../src/services/capture.js";
import { conversationRevisions, messages } from "../src/schema.js";
import { captureStore } from "./capture-store-fixture.js";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), loadBatch: vi.fn(), loadMessages: vi.fn(), persistParent: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/services/conversation-lineage.js", () => ({ persistConversationParent: mocks.persistParent }));
vi.mock("../src/services/revision-storage.js", () => ({ loadCaptureRevisionMessages: mocks.loadMessages, loadCaptureRevisionMessagesBatch: mocks.loadBatch }));
vi.mock("../src/services/redaction.js", async (original) => ({ ...await original<typeof import("../src/services/redaction.js")>(), loadEnabledCustomRedactionRules: vi.fn(async () => []) }));
const snapshot: CaptureSnapshotV1 = {
  schemaVersion: 1, provider: "codex", sessionId: "child-session", branchFingerprint: "branch-fingerprint", title: "Child task",
  adapterVersion: "2.4.0", capturedAt: "2026-09-14T00:00:00.000Z", captureMode: "full",
  completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
  messages: [{ ordinal: 0, externalMessageId: "user", role: "user", segments: [{ type: "text", content: "Task" }] },
    { ordinal: 1, externalMessageId: "answer", role: "assistant", segments: [{ type: "text", content: "Done" }] }],
};
const deviceId = "00000000-0000-4000-8000-000000000003";
describe("capture parent metadata with one accumulated body", () => {
  beforeEach(() => vi.clearAllMocks());
  it("backfills parent metadata through both content dedup and immutable receipt replay", async () => {
    const store = captureStore(mocks);
    const first = await ingestCapture(snapshot, deviceId, "first");
    const messageIds = store.rows(messages).map((message) => message.id);
    for (const key of ["first", "recaptured"]) {
      expect(await ingestCapture({ ...snapshot, parentSessionId: "parent-session" }, deviceId, key))
        .toMatchObject({ revisionId: first.revisionId, unchanged: true, messageCount: 2 });
      expect(mocks.persistParent).toHaveBeenLastCalledWith(store.tx, first.conversationId, expect.objectContaining({ parentSessionId: "parent-session" }));
    }
    expect(store.rows(conversationRevisions)).toHaveLength(1);
    expect(store.rows(messages).map((message) => message.id)).toEqual(messageIds);
  });
  it("accepts a parent-only delta with a valid baseline without adding body rows", async () => {
    const store = captureStore(mocks);
    const first = await ingestCapture(snapshot, deviceId, "first");
    const result = await ingestCapture({ schemaVersion: 1, provider: "codex", sessionId: "child-session", parentSessionId: "parent-session",
      branchFingerprint: snapshot.branchFingerprint, adapterVersion: snapshot.adapterVersion, capturedAt: "2026-09-14T01:00:00.000Z",
      captureMode: "append", baseRevisionId: first.revisionId, baseContentHash: first.baselineContentHash,
      baseMessageCount: 2, baseLastMessageId: "answer", appendedMessages: [] }, deviceId, "parent-only");
    expect(result).toMatchObject({ revisionId: first.revisionId, unchanged: true, messageCount: 2, captureMode: "append" });
    expect(mocks.persistParent).toHaveBeenLastCalledWith(store.tx, first.conversationId, expect.objectContaining({ parentSessionId: "parent-session" }));
    expect(store.rows(messages)).toHaveLength(2);
    expect(store.rows(conversationRevisions)).toHaveLength(1);
  });
});
