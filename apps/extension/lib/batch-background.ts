import type { RecaptureNext } from "@ai-archive/contracts";
import { BatchRecaptureHttpError, createBatchRunner, type BatchRunnerState, type BatchSafetyState } from "./batch-capture";
import { packagedServerOrigin } from "./packaged-origin";

export function startBatchBackground() {
  // Incognito split contexts share local storage with the regular extension.
  // Only the regular context may own the durable server queue.
  if (browser.extension?.inIncognitoContext) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let activeJob = false;
  const runner = createBatchRunner({
    async loadSafety() { return (await browser.storage.local.get("batchSafety")).batchSafety as BatchSafetyState | null ?? null; },
    async saveSafety(state) { await browser.storage.local.set({ batchSafety: state }); },
    async load() {
      const state = (await browser.storage.local.get("batchRunner")).batchRunner as BatchRunnerState | null ?? null;
      if (state) activeJob = !state.parked;
      return state;
    },
    async save(state) { await browser.storage.local.set({ batchRunner: state }); },
    async next(leaseToken) {
      const next = await request("next", leaseToken ? { leaseToken } : {}) as RecaptureNext;
      activeJob = next.job?.status === "running";
      return next;
    },
    async report(body) { return request("report", body); },
    async open(url) { const tab = await browser.tabs.create({ url, active: false }); if (tab.id === undefined) throw new Error("无法创建补采标签页"); return tab.id; },
    async findOwned(url) { return (await browser.tabs.query({})).find(tab => tab.url === url)?.id; },
    async tab(id) { return browser.tabs.get(id).catch(() => null); },
    async close(id) { await browser.tabs.remove(id); },
    async send(id, message) { return browser.tabs.sendMessage(id, message); },
    async status(message, jobId) {
      const prior = (await browser.storage.local.get("batchStatus")).batchStatus as { message?: string } | undefined;
      if (prior?.message !== message) await browser.storage.local.set({ batchStatus: { message, jobId, updatedAt: new Date().toISOString() } });
    },
    now: Date.now,
  });
  async function request(path: string, body: unknown) {
    const { deviceToken } = await browser.storage.local.get("deviceToken");
    if (!deviceToken) {
      if (path === "report") throw new BatchRecaptureHttpError("批量补采设备未配对，请重新配对后继续上报", 401);
      return { job: null, task: null };
    }
    const response = await fetch(`${packagedServerOrigin()}/api/v1/recapture/${path}`, {
      method: "POST", headers: { Authorization: `Bearer ${deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    const data = await response.json();
    if (!response.ok) throw new BatchRecaptureHttpError(response.status === 401 ? "批量补采设备授权失效，请重新配对" : data.error ?? "批量补采连接中断", response.status);
    return data;
  }
  async function tick() {
    if (timer) clearTimeout(timer);
    try {
      await runner.tick();
    } catch (error) {
      console.warn("批量补采后台暂时中断，将自动重试", error);
    } finally {
      // A transient storage/request failure must not terminate the fast loop.
      if (activeJob) timer = setTimeout(() => void tick(), 3_000);
    }
  }
  // Register wake-up listeners synchronously on every MV3 worker start.
  browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === "batch-recapture") void tick(); });
  // Preserve the existing deadline: recreating the alarm on each worker start
  // can repeatedly postpone the very event needed to resume the queue.
  void browser.alarms.get("batch-recapture").then(alarm => {
    if (!alarm) return browser.alarms.create("batch-recapture", { periodInMinutes: 0.5 });
  });
  void tick();
}
