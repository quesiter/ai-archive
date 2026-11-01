// @vitest-environment node
import "fake-indexeddb/auto";
import type { CaptureDeltaV1, CaptureSnapshotV1 } from "@ai-archive/contracts";
import { describe, expect, it } from "vitest";
import {
  enqueue,
  listRecords,
  markAuthRevoked,
  markFailed,
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
  it("queues a new manual observation even when its body is unchanged", async () => {
    const manual = { ...snapshot, sessionId: "manual-observation-session", triggerReason: "manual_retry" as const };
    const firstId = await enqueue(manual);
    const laterId = await enqueue({ ...manual, capturedAt: "2026-07-24T13:00:00.000Z" });

    expect(laterId).not.toBe(firstId);
    expect((await listRecords()).filter((record) => record.payload.sessionId === manual.sessionId)).toHaveLength(2);
    expect(await enqueue({ ...manual, triggerReason: "new_messages" })).not.toBe(firstId);
  });

  it("keeps the same manual payload identity through duplicate enqueue and network retry", async () => {
    const manual = { ...snapshot, sessionId: "manual-network-retry-session", triggerReason: "manual_retry" as const };
    const id = await enqueue(manual);
    expect(await enqueue(structuredClone(manual))).toBe(id);

    await markFailed(id, "Network request failed", 1);
    const failed = (await listRecords()).find((record) => record.id === id);
    expect(failed).toMatchObject({ id, attempts: 1, payload: manual });
    expect(failed?.nextAttemptAt).toBeGreaterThan(Date.now());

    await retryRecord(id);
    const retried = (await listRecords()).filter((record) => record.payload.sessionId === manual.sessionId);
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ id, attempts: 1, payload: manual });
    expect(retried[0]?.nextAttemptAt).toBeLessThanOrEqual(Date.now());
  });

  it("deduplicates automatic observations with unchanged content across timestamps and triggers", async () => {
    const automatic = { ...snapshot, sessionId: "automatic-observation-session" };
    const id = await enqueue({ ...automatic, triggerReason: "new_messages" });

    expect(await enqueue({ ...automatic, capturedAt: "2026-07-24T13:00:00.000Z", triggerReason: "branch_changed" })).toBe(id);
    expect((await listRecords()).filter((record) => record.payload.sessionId === automatic.sessionId)).toHaveLength(1);
  });

  it("does not reuse an append request identity after the server content baseline changes", async () => {
    const delta: CaptureDeltaV1 = {
      schemaVersion: 1, provider: "chatgpt", sessionId: "baseline-token-session", captureMode: "append",
      branchFingerprint: "branch-fingerprint", adapterVersion: "test", capturedAt: new Date().toISOString(),
      triggerReason: "new_messages",
      baseMessageCount: 2, baseContentHash: "a".repeat(64),
      appendedMessages: [{ ordinal: 2, role: "user", segments: [{ type: "text", content: "Follow-up" }] }],
    };
    expect(await enqueue({ ...delta, baseContentHash: "b".repeat(64) })).not.toBe(await enqueue(delta));
  });
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
