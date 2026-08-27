// @vitest-environment node
import "fake-indexeddb/auto";
import type { CaptureSnapshotV1 } from "@ai-archive/contracts";
import { describe, expect, it } from "vitest";
import {
  enqueue,
  listRecords,
  markAuthRevoked,
  remove,
  retryRecord,
} from "../lib/outbox";

const snapshot: CaptureSnapshotV1 = {
  schemaVersion: 1,
  provider: "chatgpt",
  sessionId: "chatgpt-title-session",
  branchFingerprint: "unchanged-message-content",
  title: "Old title",
  canonicalUrl: "https://chatgpt.com/c/chatgpt-title-session",
  adapterVersion: "1.2.1",
  capturedAt: "2026-07-24T12:00:00.000Z",
  captureMode: "full",
  completeness: {
    status: "complete",
    topReached: true,
    bottomReached: true,
    stable: true,
  },
  messages: [
    {
      ordinal: 0,
      role: "user",
      segments: [{ type: "text", content: "Question" }],
    },
    {
      ordinal: 1,
      role: "assistant",
      segments: [{ type: "text", content: "Answer" }],
    },
  ],
};

describe("capture outbox identity", () => {
  it("queues a title repair even when the messages are unchanged", async () => {
    const oldTitleId = await enqueue(snapshot);
    const repairedTitleId = await enqueue({ ...snapshot, title: "Actual sidebar title" });
    const laterScanId = await enqueue({
      ...snapshot,
      capturedAt: "2026-07-24T13:00:00.000Z",
    });

    expect(repairedTitleId).not.toBe(oldTitleId);
    expect(laterScanId).toBe(oldTitleId);
  });

  it("keeps revoked-device captures until re-pair and explicit retry", async () => {
    const id = await enqueue({ ...snapshot, sessionId: "revoked-device-session" });
    await markAuthRevoked(id, "AUTH_REVOKED", 3);
    let record = (await listRecords()).find((item) => item.id === id);
    expect(record).toMatchObject({
      attempts: 3,
      lastStatusCode: 401,
      authRevoked: true,
    });
    expect(record?.nextAttemptAt).toBe(Number.MAX_SAFE_INTEGER);

    await retryRecord(id);
    record = (await listRecords()).find((item) => item.id === id);
    expect(record?.authRevoked).toBe(false);
    expect(record?.nextAttemptAt).toBeLessThanOrEqual(Date.now());
    await remove(id);
  });
});
