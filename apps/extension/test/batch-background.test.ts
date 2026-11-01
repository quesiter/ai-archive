import { afterEach, expect, it, vi } from "vitest";
vi.mock("../lib/packaged-origin", () => ({ packagedServerOrigin: () => "https://archive.example" }));
import { startBatchBackground } from "../lib/batch-background";
import { batchTaskUrl, type BatchRunnerState } from "../lib/batch-capture";
afterEach(() => { vi.clearAllTimers(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it("does not start a second queue runner in a split incognito context", () => {
  const create = vi.fn(); vi.stubGlobal("browser", { extension: { inIncognitoContext: true }, alarms: { create } });
  startBatchBackground(); expect(create).not.toHaveBeenCalled();
});
it.each([true, false])("registers its wake listener immediately and preserves an existing alarm (%s)", async (exists) => {
  vi.useFakeTimers();
  const create = vi.fn();
  const addListener = vi.fn();
  let resolveAlarm!: (value: unknown) => void;
  const get = vi.fn(() => new Promise(resolve => { resolveAlarm = resolve; }));
  vi.stubGlobal("browser", {
    alarms: { get, create, onAlarm: { addListener } },
    storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  });
  startBatchBackground();
  expect(addListener).toHaveBeenCalledTimes(1);
  expect(create).not.toHaveBeenCalled();
  resolveAlarm(exists ? { name: "batch-recapture" } : undefined);
  await vi.advanceTimersByTimeAsync(0);
  expect(create).toHaveBeenCalledTimes(exists ? 0 : 1);
  // A persisted alarm can wake a newly created worker and execute the runner.
  const storageGet = browser.storage.local.get as ReturnType<typeof vi.fn>;
  storageGet.mockClear();
  addListener.mock.calls[0]![0]({ name: "batch-recapture" });
  await vi.advanceTimersByTimeAsync(0);
  expect(storageGet).toHaveBeenCalledWith("batchRunner");
});

function pendingReportBrowser() {
  const state: BatchRunnerState = { task: { jobId: "job", itemId: "item", sessionId: "session-123",
    leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Source", url: "https://chatgpt.com/c/session-123", startedAt: new Date().toISOString() },
    tabId: 7, result: { captureId: "pending-receipt" } };
  const stored: Record<string, unknown> = { deviceToken: "synthetic-device-token", batchRunner: state };
  const close = vi.fn(async () => {});
  vi.stubGlobal("browser", {
    alarms: { get: vi.fn(async () => ({ name: "batch-recapture" })), create: vi.fn(), onAlarm: { addListener: vi.fn() } },
    storage: { local: { get: vi.fn(async (key: string) => ({ [key]: structuredClone(stored[key]) })),
      set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(stored, structuredClone(value)); }) } },
    tabs: { get: vi.fn(async () => ({ url: batchTaskUrl(state.task), status: "complete" })),
      sendMessage: vi.fn(async () => ({ ok: true })), remove: close },
  });
  return { stored, close };
}

it("keeps the fast retry loop after worker startup with an unacknowledged report, without polling next", async () => {
  vi.useFakeTimers();
  const fixture = pendingReportBrowser();
  const fetch = vi.fn(async (_url: unknown) => { throw new Error("response lost after commit"); });
  vi.stubGlobal("fetch", fetch);
  startBatchBackground(); await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls.every(call => String(call[0]).endsWith("/recapture/report"))).toBe(true);
  expect((fixture.stored.batchRunner as BatchRunnerState).result?.captureId).toBe("pending-receipt");
  expect(fixture.close).not.toHaveBeenCalled();
});

it("preserves HTTP conflict status so a cancelled lease is released instead of looping forever", async () => {
  vi.useFakeTimers();
  const fixture = pendingReportBrowser();
  const fetch = vi.fn(async (_url: unknown) => new Response(JSON.stringify({ error: "补采队列已取消" }), { status: 409, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  startBatchBackground(); await vi.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledOnce();
  expect(String(fetch.mock.calls[0]![0])).toContain("/recapture/report");
  expect(fixture.stored.batchRunner).toBeNull();
  expect(fixture.close).toHaveBeenCalledWith(7);
});

it("retains a known active job's fast loop when next temporarily fails between completed items", async () => {
  vi.useFakeTimers();
  const fixture = pendingReportBrowser(); fixture.stored.batchRunner = null;
  const fetch = vi.fn(async (_url: unknown): Promise<Response> => { throw new Error("temporary network error"); });
  fetch.mockResolvedValueOnce(new Response(JSON.stringify({ job: { id: "job", status: "running", message: null }, task: null, busy: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  startBatchBackground(); await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(3_000);
  await vi.advanceTimersByTimeAsync(3_000);
  expect(fetch).toHaveBeenCalledTimes(3);
});
