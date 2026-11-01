import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), begin: vi.fn() }));
vi.mock("../src/db.js", () => ({ sqlClient: Object.assign(
  (...args: unknown[]) => mocks.query(...args),
  { begin: (fn: unknown) => mocks.begin(fn) },
) }));
import { changeRecaptureJob, nextRecaptureTask, recaptureCooldownMs, reportRecaptureTask, shouldPauseRecapture } from "../src/services/recapture.js";

const deviceId = "11111111-1111-4111-8111-111111111111";
const jobId = "22222222-2222-4222-8222-222222222222";
const itemId = "33333333-3333-4333-8333-333333333333";
const token = "44444444-4444-4444-8444-444444444444";
const conversationId = "55555555-5555-4555-8555-555555555555";

function fixture() {
  const now = new Date();
  const job = { id: jobId, device_id: deviceId, status: "running", message: null as string | null };
  const item = { id: itemId, conversation_id: conversationId, external_session_id: conversationId, title: "Synthetic task",
    status: "running", attempts: 1, lease_token: token as string | null, lease_expires_at: new Date(now.getTime() + 120_000),
    started_at: now, capture_id: null, completed_at: null as Date | string | null, message: null as string | null };
  const safety = { completed_count: 2, pending_count: 1, last_completed_at: new Date(now.getTime() - 5_000), now_at: now, recent_statuses: ["skipped", "failed"] };
  const events: Array<{ metadata: unknown; inTransaction: boolean }> = [];
  let claimed = 0, safetyReads = 0, inTransaction = false;
  const query = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("$").replace(/\s+/g, " ").trim();
    if (text.startsWith("select pg_advisory")) return [];
    if (text.startsWith("with attempted_results")) { safetyReads++; return [safety]; }
    if (text.startsWith("select device_id from recapture_jobs")) return [{ device_id: deviceId }];
    if (text.startsWith("select * from recapture_jobs")) return [job];
    if (text.startsWith("select id from devices")) return [{ id: deviceId }];
    if (text.startsWith("select id from recapture_jobs")) return [];
    if (text.startsWith("select * from recapture_items") && text.includes("status='running'")) return item.status === "running" ? [item] : [];
    if (text.startsWith("select * from recapture_items")) return [item];
    if (text.startsWith("select id from conversations")) return [{ id: conversationId }];
    if (text.startsWith("select receipt from capture_runs")) return [{ receipt: { conversationId, archiveCompleteness: "complete", archiveMessageCount: 12 } }];
    if (text.startsWith("insert into operation_logs")) { events.push({ metadata: JSON.parse(String(values[1])), inTransaction }); return []; }
    if (text.startsWith("update recapture_jobs")) {
      if (text.includes("status='paused'")) { job.status = "paused"; job.message = String(values[0]); }
      if (text.includes("status='running'")) job.status = "running";
      return [];
    }
    if (text.startsWith("update recapture_items i")) return [];
    if (text.startsWith("update recapture_items set lease_expires_at")) return [];
    if (text.startsWith("update recapture_items") && text.includes("set status='running'")) { claimed++; item.status = "running"; return [item]; }
    if (text.startsWith("update recapture_items") && text.includes("set status='pending',attempts=0")) { item.status = "pending"; return [{ id: itemId }]; }
    if (text.startsWith("update recapture_items") && text.includes("set status=$")) {
      item.status = String(values[0]);
      if (text.includes("message=$")) item.message = String(values[1]);
      if (text.includes("capture_id=$")) item.completed_at = values[4] as Date | string | null;
      if (text.includes("lease_token=null")) item.lease_token = null;
      return [];
    }
    throw new Error(`Unexpected synthetic SQL: ${text}`);
  }, { json: (value: unknown) => value });
  mocks.query.mockImplementation(query);
  mocks.begin.mockImplementation(async (fn: (tx: typeof query) => Promise<unknown>) => {
    inTransaction = true;
    try { return await fn(query); } finally { inTransaction = false; }
  });
  return { job, item, safety, events, get claimed() { return claimed; }, get safetyReads() { return safetyReads; } };
}

beforeEach(() => vi.resetAllMocks());

describe("server-side recapture safety", () => {
  it("uses a persisted one-minute interval and a ten-minute break at every tenth attempted result", () => {
    const finished = new Date("2026-10-26T00:00:00Z");
    const thirtySecondsLater = new Date(finished.getTime() + 30_000);
    expect(recaptureCooldownMs(9, finished, thirtySecondsLater)).toBe(30_000);
    expect(recaptureCooldownMs(10, finished, thirtySecondsLater)).toBe(570_000);
    expect(recaptureCooldownMs(20, finished, thirtySecondsLater)).toBe(570_000);
    expect(recaptureCooldownMs(11, finished, new Date(finished.getTime() + 60_000))).toBe(0);
    expect(recaptureCooldownMs(0, null, thirtySecondsLater)).toBe(0);
    expect(recaptureCooldownMs(10, finished.toISOString(), thirtySecondsLater.toISOString())).toBe(570_000);
  });

  it("pauses only after three consecutive unavailable/failed results, with successful partial captures breaking the chain", () => {
    expect(shouldPauseRecapture("skipped", ["failed", "skipped"])).toBe(true);
    expect(shouldPauseRecapture("failed", ["skipped", "failed"])).toBe(true);
    expect(shouldPauseRecapture("skipped", ["skipped"])).toBe(false);
    expect(shouldPauseRecapture("failed", ["partial", "skipped"])).toBe(false);
    expect(shouldPauseRecapture("complete", ["failed", "skipped"])).toBe(false);
  });

  it("withholds new leases from an old client during the database cooldown", async () => {
    const store = fixture(); store.item.status = "pending";
    const result = await nextRecaptureTask(deviceId);
    expect(result.task).toBeNull();
    expect(result.job?.status).toBe("running");
    expect(result.job?.message).toContain("服务端保守补采间隔");
    expect(store.claimed).toBe(0);
    expect(store.item.status).toBe("pending");
    expect(store.events).toHaveLength(0);
  });

  it("continues renewing an existing live lease while new work is cooling down", async () => {
    const store = fixture();
    const result = await nextRecaptureTask(deviceId, token);
    expect(result.task?.leaseToken).toBe(token);
    expect(store.safetyReads).toBe(0);
    expect(store.claimed).toBe(0);
  });

  it("keeps the third denied item pending and pauses atomically without turning a report retry into a reset", async () => {
    const store = fixture();
    const report = { jobId, itemId, leaseToken: token, outcome: "skipped" as const, message: "Synthetic access denied" };
    expect((await reportRecaptureTask(deviceId, report)).status).toBe("pending");
    expect(store.job.status).toBe("paused");
    expect(store.item.message).toContain("Synthetic access denied");
    expect(store.item.completed_at).toBeNull();
    expect((await reportRecaptureTask(deviceId, report)).status).toBe("pending");
    expect(store.safetyReads).toBe(1);
    expect(store.events).toHaveLength(0);
  });

  it("accepts and preserves exact capture receipts and idempotent acknowledgements despite a prior failure streak", async () => {
    const store = fixture();
    const report = { jobId, itemId, leaseToken: token, captureId: "synthetic-receipt" };
    expect((await reportRecaptureTask(deviceId, report)).status).toBe("complete");
    expect((await reportRecaptureTask(deviceId, report)).status).toBe("complete");
    expect(store.safetyReads).toBe(0);
    expect(store.job.status).toBe("running");
    expect(store.events).toHaveLength(0);
  });

  it("records a failure baseline only within an explicit user resume or retry transaction", async () => {
    const store = fixture(); store.job.status = "paused"; store.item.status = "pending";
    await changeRecaptureJob(jobId, "resume");
    expect(store.events).toEqual([{ metadata: { event: "recapture_safety_reset", action: "resume" }, inTransaction: true }]);
    await changeRecaptureJob(jobId, "pause");
    expect(store.events).toHaveLength(1);
    await changeRecaptureJob(jobId, "retry_failed");
    expect(store.events[1]).toEqual({ metadata: { event: "recapture_safety_reset", action: "retry_failed" }, inTransaction: true });
  });

  it("also brakes three exhausted browser leases without dispatching another item", async () => {
    const store = fixture(); store.item.attempts = 3; store.item.lease_expires_at = new Date(0);
    const result = await nextRecaptureTask(deviceId);
    expect(result.task).toBeNull();
    expect(result.job?.status).toBe("paused");
    expect(store.item.status).toBe("pending");
    expect(store.claimed).toBe(0);
    expect(store.events).toHaveLength(0);
  });
});
