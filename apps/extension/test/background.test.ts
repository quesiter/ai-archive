// @vitest-environment node
import { setImmediate as yieldIO } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapturePayloadV1, CaptureSnapshotV1 } from "@ai-archive/contracts";
import type { ExtensionMessage } from "../lib/messages";

const outbox = vi.hoisted(() => ({ records: new Map<string, { id: string; payload: CapturePayloadV1; attempts: number }>() }));
vi.mock("wxt/utils/define-background", () => ({ defineBackground: (main: () => void) => ({ main }) }));
vi.mock("../lib/batch-background", () => ({ startBatchBackground: vi.fn() }));
vi.mock("../lib/device-heartbeat", () => ({ startDeviceHeartbeat: vi.fn() }));
vi.mock("../lib/packaged-origin", () => ({ packagedServerOrigin: () => "https://archive.example" }));
vi.mock("../lib/outbox", () => ({
  enqueue: async (payload: CapturePayloadV1) => {
    const id = payload.sessionId;
    outbox.records.set(id, { id, payload, attempts: 0 });
    return id;
  },
  dueRecords: async () => [...outbox.records.values()],
  remove: async (id: string) => { outbox.records.delete(id); },
  outboxCount: async () => outbox.records.size,
  listRecords: async () => [...outbox.records.values()],
  markFailed: vi.fn(), markAuthRevoked: vi.fn(), retryAllRecords: vi.fn(), retryRecord: vi.fn(),
}));

function snapshot(sessionId: string, count = 2): CaptureSnapshotV1 {
  return {
    schemaVersion: 1, provider: "chatgpt", sessionId, branchFingerprint: "test-branch",
    adapterVersion: "1.2.2", capturedAt: new Date().toISOString(), captureMode: "full",
    completeness: { status: "partial", topReached: false, bottomReached: true, stable: true },
    messages: Array.from({ length: count }, (_, ordinal) => ({
      ordinal, role: ordinal % 2 ? "assistant" : "user", segments: [{ type: "text", content: `Message ${ordinal}` }],
    })),
  };
}

let listener: (message: ExtensionMessage, sender: { id: string }) => unknown;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let statuses: Array<Record<string, unknown>>;
const send = (message: ExtensionMessage) => listener(message, { id: "extension" }) as Promise<{
  lastResult?: { revisionId: string; messageCount: number };
  requiresFullCapture?: boolean;
}>;

beforeEach(async () => {
  vi.resetModules();
  outbox.records.clear();
  statuses = [];
  vi.stubGlobal("CompressionStream", undefined);
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("browser", {
    runtime: { id: "extension", onMessage: { addListener: (fn: typeof listener) => { listener = fn; } } },
    storage: {
      sync: { remove: vi.fn() },
      local: {
        get: async () => ({ deviceToken: "test-device-token", serverUrl: "https://archive.example" }),
        set: async (value: Record<string, unknown>) => { if (value.lastStatus) statuses.push(value.lastStatus as Record<string, unknown>); },
        remove: vi.fn(),
      },
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
    alarms: { create: vi.fn(), onAlarm: { addListener: vi.fn() } },
  });
  const { default: background } = await import("../entrypoints/background");
  background.main();
  await yieldIO();
});
afterEach(() => vi.unstubAllGlobals());

describe("upload results stay tied to the requesting conversation", () => {
  it("passes the source baseline hash and separate archive counts through the upload receipt", async () => {
    fetchMock.mockResolvedValue(Response.json({ revisionId: "source-revision", messageCount: 2, completeness: "complete",
      baselineContentHash: "a".repeat(64), archiveMessageCount: 2, archiveCompleteness: "complete" }));
    const result = await send({ type: "enqueueCapture", payload: snapshot("source") });
    expect(result.lastResult).toMatchObject({ messageCount: 2, completeness: "complete", baselineContentHash: "a".repeat(64), archiveMessageCount: 2 });
    fetchMock.mockResolvedValue(Response.json({ revisionId: "archive-revision", messageCount: 2, completeness: "partial", archiveMessageCount: 40, archiveCompleteness: "complete" }));
    const partialSnapshot = snapshot("partial-source");
    const partialResult = await send({ type: "enqueueCapture", payload: partialSnapshot });
    expect(statuses.at(-1)).toMatchObject({ status: "complete", messageCount: 2, archiveMessageCount: 40, archiveCompleteness: "complete" });
    expect(statuses.at(-1)?.message).toBe("本次保存 2 条消息，累计归档 40 条（完整）");
    expect(partialResult.lastResult).toMatchObject({ completeness: "partial", messageCount: 2, archiveMessageCount: 40 });
    expect(partialResult.lastResult).not.toHaveProperty("baselineContentHash");
    expect(partialSnapshot.completeness.status).toBe("partial");
    const sentPayload = JSON.parse(await (fetchMock.mock.calls.at(-1)![1]!.body as Blob).text()) as CaptureSnapshotV1;
    expect(sentPayload.completeness.status).toBe("partial");
  });
  it("serializes concurrent tabs and returns each tab its own revision", async () => {
    let active = 0;
    let peak = 0;
    fetchMock.mockImplementation(async (_, init) => {
      active += 1;
      peak = Math.max(peak, active);
      await yieldIO();
      const body = JSON.parse(await (init!.body as Blob).text()) as CaptureSnapshotV1;
      active -= 1;
      return Response.json({ revisionId: body.sessionId, messageCount: body.messages.length, completeness: "partial" });
    });
    const first = send({ type: "enqueueCapture", payload: snapshot("first", 2) });
    const second = send({ type: "enqueueCapture", payload: snapshot("second", 4) });
    const results = await Promise.all([first, second]);
    expect(results[0]?.lastResult).toMatchObject({ revisionId: "first", messageCount: 2 });
    expect(results[1]?.lastResult).toMatchObject({ revisionId: "second", messageCount: 4 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(peak).toBe(1);
    expect(outbox.records.size).toBe(0);
    expect(statuses.filter((state) => state.status === "complete")).toHaveLength(0);
  });

  it("does not report an unrelated queued conversation as the current upload result", async () => {
    outbox.records.set("old", { id: "old", payload: snapshot("old", 8), attempts: 0 });
    fetchMock.mockImplementation(async (_, init) => {
      const body = JSON.parse(await (init!.body as Blob).text()) as CaptureSnapshotV1;
      return body.sessionId === "old"
        ? Response.json({ revisionId: "old-revision", messageCount: 8, completeness: "partial" })
        : new Response("{}", { status: 500 });
    });
    const result = await send({ type: "enqueueCapture", payload: snapshot("current") });
    expect(result.lastResult).toBeUndefined();
    expect(outbox.records.has("current")).toBe(true);
  });

  it("does not reuse a cached receipt for a newly enqueued retry", async () => {
    fetchMock.mockResolvedValue(Response.json({ revisionId: "revision", messageCount: 2, completeness: "partial" }));
    await send({ type: "enqueueCapture", payload: snapshot("current") });
    await send({ type: "enqueueCapture", payload: snapshot("current") });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outbox.records.size).toBe(0);
  });
});
