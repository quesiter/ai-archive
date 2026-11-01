import type { RecaptureNext, RecaptureReport, RecaptureTask } from "@ai-archive/contracts";

export interface BatchCaptureResult { captureId?: string; outcome?: "failed" | "attention" | "skipped"; message?: string }
export class BatchRecaptureHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "BatchRecaptureHttpError"; }
}
export interface BatchRunnerState {
  task: RecaptureTask;
  tabId?: number;
  result?: BatchCaptureResult;
  parked?: boolean;
}
export interface BatchRunnerDependencies {
  loadSafety?(): Promise<BatchSafetyState | null>;
  saveSafety?(state: BatchSafetyState): Promise<void>;
  load(): Promise<BatchRunnerState | null>;
  save(state: BatchRunnerState | null): Promise<void>;
  next(token?: string): Promise<RecaptureNext>;
  report(report: RecaptureReport): Promise<unknown>;
  open(url: string): Promise<number>;
  findOwned(url: string): Promise<number | undefined>;
  tab(id: number): Promise<{ url?: string | undefined; status?: string | undefined } | null>;
  close(id: number): Promise<void>;
  send(id: number, message: unknown): Promise<any>;
  status(message: string, jobId?: string): Promise<void>;
  now(): number;
}
export interface BatchSafetyState {
  jobId: string;
  completed: number;
  consecutiveErrors: number;
  nextAllowedAt: number;
  lastItemId?: string;
}
export function batchTaskUrl(task: RecaptureTask) {
  // Both the origin and session path are independently checked in the runner.
  const safe = `https://chatgpt.com/c/${encodeURIComponent(task.sessionId)}`;
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(task.sessionId) || task.url !== safe) throw new Error("补采链接无效");
  return `${safe}#ai-archive-batch=${task.leaseToken}`;
}
export function ownsBatchTab(url: string | undefined, task: RecaptureTask): boolean {
  return url === batchTaskUrl(task);
}
function isNormalizedBatchSource(url: string | undefined, task: RecaptureTask): boolean {
  try {
    const current = new URL(url ?? ""); const source = new URL(task.url);
    return current.origin === source.origin && current.pathname === source.pathname &&
      current.search === source.search && current.hash === "";
  } catch { return false; }
}
function provesBatchDocument(page: any, task: RecaptureTask): boolean {
  return page?.batchOwner === task.leaseToken || page?.operationId === task.leaseToken;
}
function isChatGptHome(url: string | undefined): boolean {
  try { const parsed = new URL(url ?? ""); return parsed.origin === "https://chatgpt.com" && parsed.pathname === "/"; }
  catch { return false; }
}

export function createBatchRunner(deps: BatchRunnerDependencies) {
  let running: Promise<void> | undefined;
  let safety: BatchSafetyState | null = null;
  async function cleanup(state: BatchRunnerState) {
    if (state.tabId === undefined) return;
    const tab = await deps.tab(state.tabId);
    if (!ownsBatchTab(tab?.url, state.task)) {
      const page = await deps.send(state.tabId, { type: "getBatchCaptureState", operationId: state.task.leaseToken }).catch(() => null);
      if (isNormalizedBatchSource(tab?.url, state.task)) {
        if (!provesBatchDocument(page, state.task)) return;
      } else {
        if (!isChatGptHome(tab?.url) || state.result?.outcome !== "skipped") return;
        // A same-document source redirect retains our token. Never close a new
        // document or user-navigated page merely because it shares a tab ID.
        if (page?.batchOwner !== state.task.leaseToken || page?.pageIssue?.outcome !== "skipped") return;
      }
    }
    await deps.send(state.tabId, { type: "cancelBatchCapture", operationId: state.task.leaseToken }).catch(() => {});
    // Ownership checks can await a message round trip. Preserve a tab the user
    // navigated while that check or cancellation was in flight.
    if ((await deps.tab(state.tabId))?.url !== tab?.url) return;
    await deps.close(state.tabId).catch(() => {});
  }
  function ensureSafety(task: RecaptureTask) {
    if (safety?.jobId !== task.jobId) safety = { jobId: task.jobId, completed: 0, consecutiveErrors: 0, nextAllowedAt: 0 };
    return safety;
  }
  async function settleResult(state: BatchRunnerState) {
    // Commit a fresh safety value only after durable storage succeeds. Mutating
    // the in-memory lastItemId first would suppress a retry after a storage error.
    const currentSafety = { ...ensureSafety(state.task) };
    const errors = state.result?.outcome === "skipped" || state.result?.outcome === "failed"
      ? currentSafety.lastItemId === state.task.itemId ? currentSafety.consecutiveErrors : currentSafety.consecutiveErrors + 1
      : 0;
    if (errors >= 3) {
      state.result = { outcome: "attention", message: `连续 3 条无法采集，队列已暂停，请检查账户与原会话。最后原因：${state.result?.message ?? "未知"}` };
      await deps.save(state);
    }
    let acknowledgment: unknown;
    try {
      acknowledgment = await deps.report({ jobId: state.task.jobId, itemId: state.task.itemId, leaseToken: state.task.leaseToken, ...state.result });
    } catch (error) {
      if (!(error instanceof BatchRecaptureHttpError) || error.status !== 409) throw error;
      if (/补采任务已失效|补采队列已取消/.test(error.message)) {
        // A definitive lease rejection is not a transient lost receipt. Release
        // only our page and leave a conservative interval before polling again.
        currentSafety.nextAllowedAt = Math.max(currentSafety.nextAllowedAt, deps.now() + 60_000);
        await deps.saveSafety?.(currentSafety);
        safety = currentSafety;
        await cleanup(state);
        await deps.save(null);
        await deps.status("原补采租约已结束，稍后重新检查队列", state.task.jobId);
        return;
      }
      if (state.result?.captureId && deps.now() - Date.parse(state.task.startedAt) > 9 * 60_000) {
        state.result = { outcome: "attention", message: "采集回执迟迟未获服务器确认，队列已暂停；请检查上传状态后重试" };
        await deps.save(state);
      }
      throw error;
    }
    if (!acknowledgment || typeof acknowledgment !== "object" || !("ok" in acknowledgment) || acknowledgment.ok !== true) {
      throw new Error("补采结果尚未获服务器确认，将保留回执重试");
    }
    if (state.result?.outcome === "attention") {
      currentSafety.consecutiveErrors = 0;
      currentSafety.nextAllowedAt = deps.now() + 10 * 60_000;
      await deps.saveSafety?.(currentSafety);
      safety = currentSafety;
      delete state.result;
      state.parked = true;
      await deps.save(state);
      return;
    }
    if (currentSafety.lastItemId !== state.task.itemId) {
      currentSafety.completed += 1;
      currentSafety.consecutiveErrors = errors;
      currentSafety.lastItemId = state.task.itemId;
      currentSafety.nextAllowedAt = deps.now() + (currentSafety.completed % 10 === 0 ? 10 * 60_000 : 60_000);
      await deps.saveSafety?.(currentSafety);
      safety = currentSafety;
    }
    await cleanup(state);
    await deps.save(null);
  }
  async function tickOnce() {
    let state = await deps.load();
    safety = await deps.loadSafety?.() ?? safety;
    if (state?.result) {
      batchTaskUrl(state.task);
      // Report the exact persisted result until acknowledged before asking the
      // server for a lease. A committed report can have lost its HTTP response.
      await settleResult(state);
      return;
    }
    if ((!state || state.parked) && safety && deps.now() < safety.nextAllowedAt) {
      await deps.status(`保守采集间隔：${Math.ceil((safety.nextAllowedAt - deps.now()) / 1000)} 秒后继续`, safety.jobId);
      return;
    }
    const next = await deps.next(state?.task.leaseToken);
    if (!next.task) {
      if (state && !next.busy && !(state.parked && next.job?.status === "paused")) { await cleanup(state); await deps.save(null); }
      await deps.status(next.job?.message ?? "暂无执行中的批量补采队列", next.job?.id);
      return;
    }
    batchTaskUrl(next.task);
    if (state?.task.leaseToken !== next.task.leaseToken) {
      if (state) await cleanup(state);
      state = { task: next.task };
      await deps.save(state);
    }
    if (!state) return;
    safety = ensureSafety(state.task);
    await deps.status(`正在补采：${state.task.title}`, state.task.jobId);
    if (deps.now() - Date.parse(state.task.startedAt) > 9 * 60_000) {
      state.result = { outcome: "failed", message: "本条处理超时，请在结果列表重试" };
      await deps.save(state);
    }
    if (state.result) {
      await settleResult(state);
      return;
    }
    if (state.tabId === undefined) {
      if (deps.now() < safety.nextAllowedAt) {
        await deps.status("队列处于保守冷却期，稍后继续", state.task.jobId);
        return;
      }
      const url = batchTaskUrl(state.task);
      // Recover a tab created just before an MV3 worker was suspended, even
      // when Chrome did not give us time to persist its numeric tab ID.
      state.tabId = await deps.findOwned(url) ?? await deps.open(url);
      await deps.save(state);
      return;
    }
    const tab = await deps.tab(state.tabId);
    if (!tab) {
      state.result = { outcome: "attention", message: "专用标签页已关闭、跳转或需要登录，请检查 ChatGPT 后继续队列" };
      await deps.save(state);
      return;
    }
    if (tab.status === "loading") return;
    const response = await deps.send(state.tabId, { type: "getBatchCaptureState", operationId: state.task.leaseToken }).catch(() => null);
    const owned = ownsBatchTab(tab.url, state.task) ||
      (isNormalizedBatchSource(tab.url, state.task) && provesBatchDocument(response, state.task));
    if (owned && response?.result) {
      state.result = response.result;
      await deps.save(state);
      return;
    }
    if (owned || isChatGptHome(tab.url)) {
      if (response?.pageIssue) {
        state.result = response.pageIssue;
        await deps.save(state);
        return;
      }
    }
    if (!owned) {
      if (isChatGptHome(tab.url)) {
        // Allow redirects and transient notices to settle before treating an
        // inaccessible conversation as a local failure.
        if (deps.now() - Date.parse(state.task.startedAt) <= 90_000) return;
        state.result = response ? { outcome: "attention", message: "原会话跳回首页且未能加载，队列已暂停，请检查账户和页面" }
          : { outcome: "attention", message: "无法连接 ChatGPT 页面，请检查扩展或登录后继续" };
      } else state.result = { outcome: "attention", message: "专用标签页已跳转，请检查登录、验证或页面后继续队列" };
      await deps.save(state);
      return;
    }
    if (response?.running) return;
    const content = await deps.send(state.tabId, { type: "getContentState" }).catch(() => null);
    if (content?.scanning) return;
    if (!content || content.scanning || content.provider !== "chatgpt" || content.sessionId !== state.task.sessionId || !content.messageCount) {
      if (deps.now() - Date.parse(state.task.startedAt) > 90_000) {
        state.result = content?.provider === "chatgpt" && content.sessionId === state.task.sessionId ? { outcome: "attention", message: "原会话在 90 秒内未能加载内容，队列已暂停，请检查页面" }
          : { outcome: "attention", message: "无法连接 ChatGPT 页面，请检查扩展或登录后继续" };
        await deps.save(state);
      }
      return;
    }
    const accepted = await deps.send(state.tabId, { type: "startBatchCapture", operationId: state.task.leaseToken,
      itemId: state.task.itemId, sessionId: state.task.sessionId }).catch(() => null);
    if (accepted?.error) {
      state.result = { outcome: "attention", message: String(accepted.error).slice(0,500) };
      await deps.save(state);
    }
  }
  return {
    tick(): Promise<void> {
      if (running) return running;
      running = tickOnce().catch(async (error) => {
        await deps.status(error instanceof Error ? error.message : "批量补采连接中断，恢复连接后继续");
      }).finally(() => { running = undefined; });
      return running;
    },
  };
}
