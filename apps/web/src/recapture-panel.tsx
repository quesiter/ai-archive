import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { RecaptureJob, RecaptureItemStatus } from "@ai-archive/contracts";
import { api, ApiError, jsonBody } from "./api.js";
import { setVisibleInterval } from "./visible-poll.js";

const labels: Record<RecaptureItemStatus, string> = { pending: "待处理", running: "正在采集", complete: "已完整", partial: "仍不完整", failed: "失败", skipped: "已跳过" };
const jobLabels: Record<RecaptureJob["status"], string> = { running: "执行中", paused: "已暂停", completed: "已完成", cancelled: "已终止" };
interface Device { id: string; name: string; kind: string; revokedAt: string | null; lastSeenAt: string | null; clientVersion?: string | null }
type RecaptureAction = "pause" | "resume" | "skip_current" | "cancel" | "retry_failed" | "retry_partial" | "retry_skipped";
const actionLabels: Record<RecaptureAction, string> = { pause: "暂停任务", resume: "继续任务", skip_current: "跳过当前条并继续", cancel: "终止任务", retry_failed: "重试失败条目", retry_partial: "重试不完整条目", retry_skipped: "重试已跳过条目" };

export interface RecaptureState {
  devices: Device[];
  deviceId: string;
  jobs: RecaptureJob[];
  busy: boolean;
  loading: boolean;
  refreshing: boolean;
  devicesLoading: boolean;
  message: string;
  jobsError: string;
  devicesError: string;
  actionError: string;
  lastUpdatedAt: number | null;
  autoRefreshBlocked: boolean;
}

function initialState(): RecaptureState {
  return { devices: [], deviceId: "", jobs: [], busy: false, loading: true, refreshing: false, devicesLoading: true,
    message: "", jobsError: "", devicesError: "", actionError: "", lastUpdatedAt: null, autoRefreshBlocked: false };
}

export function recaptureRequestError(source: string, reason: unknown): string {
  const status = reason instanceof ApiError ? reason.status : undefined;
  const raw = reason instanceof Error ? reason.message.trim() : typeof reason === "string" ? reason.trim() : "";
  const fallback = status === 401 ? "登录已过期，请重新登录。" : status === 403 ? "当前账号无权执行此请求。"
    : status === 429 ? "请求过于频繁，请稍后重试。" : status && status >= 500 ? "服务器暂时无法处理请求。" : "网络连接或响应异常，请稍后重试。";
  return `${source}失败${status && status > 0 ? `（HTTP ${status}）` : ""}：${raw && !/^error$/i.test(raw) ? raw : fallback}`;
}

/** Keep GET recovery separate from mutations; no mutation is ever replayed. */
export function createRecaptureController({ onChange, request = api, now = Date.now }: {
  onChange: (state: RecaptureState) => void;
  request?: typeof api;
  now?: () => number;
}) {
  let state = initialState();
  let disposed = false;
  let jobsSequence = 0;
  let devicesSequence = 0;
  let jobsRead: { abort: AbortController; promise: Promise<boolean>; timeout: ReturnType<typeof setTimeout> } | null = null;
  let devicesAbort: AbortController | null = null;
  let devicesTimeout: ReturnType<typeof setTimeout> | null = null;
  let mutationAbort: AbortController | null = null;
  let mutationTimeout: ReturnType<typeof setTimeout> | null = null;
  let nextPollAt = 0;
  let consecutiveFailures = 0;
  let submittedAwaitingRefresh: string | null = null;
  function update(patch: Partial<RecaptureState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    onChange(state);
  }
  function invalidateJobsRead() {
    jobsSequence += 1;
    if (jobsRead) clearTimeout(jobsRead.timeout);
    jobsRead?.abort.abort();
    jobsRead = null;
  }
  function loadJobs(force = false): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    if (jobsRead && !force) return jobsRead.promise;
    if (!force && (state.autoRefreshBlocked || now() < nextPollAt)) return Promise.resolve(false);
    if (force) invalidateJobsRead();
    const sequence = ++jobsSequence;
    const abort = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 20_000);
    update({ refreshing: true });
    const promise = (async () => {
      try {
        const jobs = await request<RecaptureJob[]>("/api/v1/recapture/jobs", { signal: abort.signal });
        if (disposed || sequence !== jobsSequence) return false;
        consecutiveFailures = 0;
        nextPollAt = 0;
        update({ jobs, loading: false, jobsError: "", lastUpdatedAt: now(), autoRefreshBlocked: false,
          ...(submittedAwaitingRefresh ? { message: submittedAwaitingRefresh } : {}) });
        submittedAwaitingRefresh = null;
        return true;
      } catch (reason) {
        if (disposed || sequence !== jobsSequence || (abort.signal.aborted && !timedOut)) return false;
        consecutiveFailures += 1;
        const status = reason instanceof ApiError ? reason.status : 0;
        const retryAfter = reason instanceof ApiError ? (reason as ApiError & { retryAfterMs?: number }).retryAfterMs : undefined;
        nextPollAt = now() + (status === 429 && retryAfter !== undefined && Number.isFinite(retryAfter)
          ? Math.max(0, retryAfter) : Math.min(60_000, 5_000 * 2 ** Math.min(consecutiveFailures - 1, 4)));
        update({ loading: false, jobsError: recaptureRequestError("任务进度刷新", timedOut ? new Error("请求超过 20 秒，请检查网络或服务器后重试。") : reason),
          autoRefreshBlocked: status >= 400 && status < 500 && status !== 429 });
        return false;
      } finally {
        clearTimeout(timeout);
        if (!disposed && sequence === jobsSequence) {
          jobsRead = null;
          update({ refreshing: false });
        }
      }
    })();
    jobsRead = { abort, promise, timeout };
    return promise;
  }
  async function loadDevices(): Promise<void> {
    if (disposed) return;
    const sequence = ++devicesSequence;
    if (devicesTimeout !== null) clearTimeout(devicesTimeout);
    devicesAbort?.abort();
    devicesAbort = new AbortController();
    const abort = devicesAbort;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 20_000);
    devicesTimeout = timeout;
    update({ devicesLoading: true });
    try {
      const result = await request<Device[]>("/api/v1/devices", { signal: abort.signal });
      if (disposed || sequence !== devicesSequence) return;
      const devices = result.filter(device => device.kind === "chrome_extension" && !device.revokedAt)
        .sort((a, b) => (Date.parse(b.lastSeenAt ?? "") || 0) - (Date.parse(a.lastSeenAt ?? "") || 0));
      update({ devices, deviceId: devices.some(device => device.id === state.deviceId) ? state.deviceId : devices[0]?.id ?? "", devicesError: "" });
    } catch (reason) {
      if (!disposed && sequence === devicesSequence && (!abort.signal.aborted || timedOut)) update({ devicesError: recaptureRequestError("执行设备加载", timedOut ? new Error("请求超过 20 秒，请检查网络或服务器后重试。") : reason) });
    } finally {
      clearTimeout(timeout);
      if (!disposed && sequence === devicesSequence) { devicesTimeout = null; update({ devicesLoading: false }); }
    }
  }
  async function mutate(label: string, operation: (signal: AbortSignal) => Promise<string>): Promise<boolean> {
    if (disposed || state.busy) return false;
    invalidateJobsRead();
    mutationAbort = new AbortController();
    const abort = mutationAbort;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; abort.abort(); }, 30_000);
    mutationTimeout = timeout;
    submittedAwaitingRefresh = null;
    update({ busy: true, refreshing: false, actionError: "", message: "" });
    try {
      const submitted = await operation(abort.signal);
      clearTimeout(timeout);
      if (disposed) return false;
      submittedAwaitingRefresh = submitted;
      update({ message: submitted });
      const refreshed = await loadJobs(true);
      if (!disposed && !refreshed) update({ message: `${submitted} 进度刷新失败，请刷新查看结果；无需重复提交本次操作。` });
      return true;
    } catch (reason) {
      if (!disposed) update({ actionError: recaptureRequestError(label, timedOut ? new Error("请求超过 30 秒，操作结果未确认。") : reason), message: "操作结果未确认，请先刷新任务状态再决定是否重试。" });
      return false;
    } finally {
      clearTimeout(timeout);
      mutationTimeout = null;
      mutationAbort = null;
      update({ busy: false });
    }
  }
  return {
    getState: () => state,
    start: () => Promise.all([loadJobs(), loadDevices()]),
    poll: () => state.busy ? Promise.resolve(false) : loadJobs(),
    refresh: () => state.busy ? Promise.resolve([]) : Promise.all([loadJobs(true), loadDevices()]),
    selectDevice: (deviceId: string) => update({ deviceId }),
    create: (all: boolean, selectedIds: string[]) => mutate("新建补采任务", async signal => {
      const result = await request<{ count: number; excluded: number }>("/api/v1/recapture/jobs", { method: "POST", signal,
        ...jsonBody({ deviceId: state.deviceId, ...(all ? { allIncomplete: true } : { conversationIds: selectedIds }) }) });
      return `操作已提交：已加入 ${result.count} 条 ChatGPT 会话${result.excluded ? `，另 ${result.excluded} 条不符合补采条件` : ""}。`;
    }),
    action: (jobId: string, action: RecaptureAction) => mutate(actionLabels[action], async signal => {
      await request(`/api/v1/recapture/jobs/${encodeURIComponent(jobId)}`, { method: "POST", signal, ...jsonBody({ action }) });
      return `操作已提交：${actionLabels[action]}。`;
    }),
    dispose() {
      disposed = true;
      invalidateJobsRead();
      devicesSequence += 1;
      devicesAbort?.abort();
      if (devicesTimeout !== null) clearTimeout(devicesTimeout);
      mutationAbort?.abort();
      if (mutationTimeout !== null) clearTimeout(mutationTimeout);
    },
  };
}

export function RecapturePage() {
  const location = useLocation();
  const selectedIds = Array.isArray(location.state?.conversationIds)
    ? [...new Set<string>(location.state.conversationIds.filter((id: unknown): id is string => typeof id === "string"))]
    : [];
  const [state, setState] = useState<RecaptureState>(initialState);
  const controller = useRef<ReturnType<typeof createRecaptureController> | null>(null);
  useEffect(() => {
    const next = createRecaptureController({ onChange: setState });
    controller.current = next;
    void next.start();
    const timer = setVisibleInterval(() => void next.poll(), 5_000);
    return () => { clearInterval(timer); next.dispose(); controller.current = null; };
  }, []);
  return <RecaptureView state={state} selectedIds={selectedIds}
    onRefresh={() => void controller.current?.refresh()}
    onSelectDevice={deviceId => controller.current?.selectDevice(deviceId)}
    onCreate={all => void controller.current?.create(all, selectedIds)}
    onAction={(jobId, action) => void controller.current?.action(jobId, action)} />;
}

export function RecaptureView({ state, selectedIds, onRefresh, onSelectDevice, onCreate, onAction }: {
  state: RecaptureState; selectedIds: string[];
  onRefresh: () => void; onSelectDevice: (deviceId: string) => void; onCreate: (all: boolean) => void;
  onAction: (jobId: string, action: RecaptureAction) => void;
}) {
  const { devices, deviceId, jobs, busy, loading, message } = state;
  const active = jobs.some(job => job.deviceId === deviceId && ["running", "paused"].includes(job.status));
  const currentJobs = jobs.filter(job => ["running", "paused"].includes(job.status));
  const historyJobs = jobs.filter(job => ["completed", "cancelled"].includes(job.status));
  const action = (job: RecaptureJob, value: RecaptureAction) => onAction(job.id, value);
  const selectedDevice = devices.find(device => device.id === deviceId);

  function renderJob(job: RecaptureJob) {
      const total = Object.values(job.counts).reduce((a, b) => a + b, 0);
      const done = total - job.counts.pending - job.counts.running;
      const online = job.lastRunnerSeenAt && Date.now() - Date.parse(job.lastRunnerSeenAt) < 90_000;
      return <details className="recapture-job" key={job.id} open={["running", "paused"].includes(job.status)}>
        <summary><strong>{job.deviceName} · {jobLabels[job.status]} · {done}/{total}</strong></summary>
        <div className="section-title-row">
          <div className="button-group">
            {job.status === "running" && <button className="secondary small" disabled={busy} onClick={() => void action(job, "pause")}>暂停</button>}
            {job.status === "paused" && <button className="small" disabled={busy} onClick={() => void action(job, "resume")}>继续</button>}
            {job.status === "paused" && !job.counts.running && job.items.some(item => item.status === "pending" && item.attempts > 0) && <button className="secondary small" disabled={busy} onClick={() => void action(job, "skip_current")}>跳过当前条并继续</button>}
            {["running", "paused"].includes(job.status) && <button className="danger small" disabled={busy} title="停止剩余补采，保留已归档内容" onClick={() => void action(job, "cancel")}>终止任务</button>}
            {job.counts.failed > 0 && <button className="secondary small" disabled={busy} onClick={() => void action(job, "retry_failed")}>重试失败（{job.counts.failed}）</button>}
            {job.counts.partial > 0 && <button className="secondary small" disabled={busy} onClick={() => void action(job, "retry_partial")}>重试仍不完整（{job.counts.partial}）</button>}
            {job.status !== "cancelled" && job.counts.skipped > 0 && <button className="secondary small" disabled={busy} onClick={() => void action(job, "retry_skipped")}>重试已跳过（{job.counts.skipped}）</button>}
          </div>
        </div>
        <progress value={done} max={Math.max(total, 1)} aria-label="补采进度" />
        <p>{job.status === "running" && !online ? <>等待 {job.deviceName} 连接；请确认扩展的设备名称一致，并在<Link to="/devices">设备页</Link>核对最新 Chrome 扩展和连接状态。</> : job.message}</p>
        <p className="muted">正在采集 {job.counts.running} · 待处理 {job.counts.pending} · 已完整 {job.counts.complete} · 仍不完整 {job.counts.partial} · 失败 {job.counts.failed} · 跳过 {job.counts.skipped}</p>
        <details><summary>查看逐条结果</summary><div className="recapture-items">{job.items.map(item => <div key={item.id}>
          <span>{item.ordinal + 1}. {item.conversationId ? <a href={`/conversations/${item.conversationId}`}>{item.title}</a> : item.title}</span>
          <span>{labels[item.status]}{item.messageCount !== null ? ` · ${item.messageCount} 条消息` : ""}</span>
          {item.message && <small>{item.message}</small>}
        </div>)}</div></details>
      </details>;
  }

  return <>
    <header className="page-header">
      <div><h1>批量补采</h1><p>集中管理 ChatGPT 不完整会话的补采任务和处理结果。</p></div>
      <div className="button-group">
        <Link className="button-link secondary small" to="/conversations">返回会话</Link>
        <button className="secondary small" disabled={busy || loading || state.refreshing || state.devicesLoading} onClick={onRefresh}>刷新</button>
      </div>
    </header>
    <section className="panel recapture-panel" aria-label="新建补采任务">
      <div className="section-title-row"><div><h2>新建任务</h2><p className="panel-subtitle">指定设备需安装最新 Chrome 扩展、登录 ChatGPT，并保持 Chrome 打开。</p></div></div>
      <div className="toolbar">
        <label>执行设备 <select aria-label="补采执行设备" value={deviceId} disabled={busy || state.devicesLoading} onChange={event => onSelectDevice(event.target.value)}>
          {!devices.length && <option value="">请先配对 Chrome 扩展</option>}
          {devices.map(device => <option key={device.id} value={device.id}>{device.name}{device.lastSeenAt ? ` · 最近连接 ${new Date(device.lastSeenAt).toLocaleString()}` : " · 尚未连接"}</option>)}
        </select></label>
        {selectedIds.length > 0 && <button className="secondary small" disabled={busy || loading || state.devicesLoading || !deviceId || active} onClick={() => onCreate(false)}>补采已选会话（{selectedIds.length}）</button>}
        <button className="small" disabled={busy || loading || state.devicesLoading || !deviceId || active} onClick={() => onCreate(true)}>补采全部 ChatGPT 不完整会话</button>
      </div>
      <p className="muted">每次使用一个专用标签页，逐条采集并更新原归档。一次最多 500 条；“全部”不受会话列表筛选条件限制。也可在<Link to="/conversations">会话页</Link>勾选后进入本页补采。</p>
      <p className="muted">无权访问、已删除或加载超时的单条会话会自动跳过，记录原因后继续；登录失效、验证码或限流时暂停。请在<Link to="/devices">设备页</Link>下载最新 Chrome 扩展。</p>
      {selectedDevice && <p className="muted">执行设备上报版本：{selectedDevice.clientVersion?.trim() || "未上报"}。</p>}
      {active && <p className="muted">该设备已有进行中的任务，可在下方查看进度。</p>}
    </section>
    {message && <p role="status">{message}</p>}
    {state.devicesError && <p className="alert error" role="alert" data-error-source="devices">{state.devicesError}</p>}
    {state.actionError && <p className="alert error" role="alert" data-error-source="action">{state.actionError}</p>}
    {state.jobsError && <p className="alert error" role="alert" data-error-source="jobs">{state.jobsError}{state.lastUpdatedAt !== null && <> 正在显示 {new Date(state.lastUpdatedAt).toLocaleTimeString()} 的任务进度。</>}{state.autoRefreshBlocked ? " 请根据上方原因处理后点击刷新。" : " 页面会自动重试，也可手动刷新。"}</p>}
    <section className="panel recapture-panel" aria-label="当前补采任务">
      <div className="section-title-row"><h2>当前任务{currentJobs.length > 0 ? `（${currentJobs.length}）` : ""}</h2></div>
      {loading ? <p className="muted">正在加载任务…</p> : currentJobs.length ? currentJobs.map(renderJob) : <p className="muted">{state.jobsError && !jobs.length ? "任务进度暂不可用，请刷新重试。" : "暂无进行中的任务。"}</p>}
    </section>
    {historyJobs.length > 0 && <details className="panel recapture-panel recapture-history">
      <summary><strong>历史任务（{historyJobs.length}）</strong><span className="muted">已完成 {historyJobs.filter(job => job.status === "completed").length} · 已终止 {historyJobs.filter(job => job.status === "cancelled").length}</span></summary>
      {historyJobs.map(renderJob)}
    </details>}
  </>;
}
