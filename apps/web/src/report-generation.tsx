import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";

export type ReportResponseDiagnostic = {
  attempt: number;
  model: string;
  responseId?: string;
  requestId?: string;
  finishReason?: string;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
  responseChars: number;
  status: "accepted" | "rejected" | "request_failed";
  error?: string;
  content: string;
  contentTruncated?: boolean;
  recordedAt: string;
};

export type ReportGenerationRun = {
  id: string;
  status: string;
  error?: string | null;
  stats?: {
    generationId?: string;
    regeneratingReportId?: string;
    stage?: string;
    totalConversations?: number;
    projectCount?: number;
    responseDiagnostics?: ReportResponseDiagnostic[];
  } | null;
};

export type ReportGenerationState = {
  run: ReportGenerationRun | null;
  loading: boolean;
  submitting: boolean;
  loadError: string;
  submitError: string;
  message: string;
};

const initialState: ReportGenerationState = {
  run: null, loading: true, submitting: false, loadError: "", submitError: "", message: "",
};

function activeRun(run: ReportGenerationRun | null) {
  return run?.status === "queued" || run?.status === "running";
}

function generationKey(run: ReportGenerationRun) {
  return run.stats?.generationId ?? run.id;
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

// The controller owns requests and timers so route changes and retries cannot
// apply responses from an older request to a new generation.
export function createReportGenerationController({
  reportId, onChange, onCompleted, request = api,
}: {
  reportId: string;
  onChange: (state: ReportGenerationState) => void;
  onCompleted: () => void;
  request?: typeof api;
}) {
  let state = { ...initialState };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let readAbort: AbortController | undefined;
  let mutationAbort: AbortController | undefined;
  let readVersion = 0;
  let trackedGeneration: string | null = null;
  let completedGeneration: string | null = null;
  const path = `/api/v1/reports/${encodeURIComponent(reportId)}`;

  function update(patch: Partial<ReportGenerationState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    onChange(state);
  }

  function stopReading() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    readVersion += 1;
    readAbort?.abort();
  }

  function acceptRun(run: ReportGenerationRun | null, submitted = false) {
    if (run && (submitted || activeRun(run))) trackedGeneration = generationKey(run);
    update({ run, loading: false, loadError: "" });
    if (run?.status === "completed" && generationKey(run) === trackedGeneration && completedGeneration !== trackedGeneration) {
      completedGeneration = trackedGeneration;
      update({ message: "重新生成已完成。" });
      onCompleted();
    } else if (activeRun(run)) {
      update({ message: "" });
    }
  }

  function scheduleRead() {
    if (!disposed) timer = setTimeout(() => void read(), 2500);
  }

  async function read() {
    if (disposed || state.submitting) return;
    stopReading();
    const version = readVersion;
    readAbort = new AbortController();
    try {
      const result = await request<{ run: ReportGenerationRun | null }>(`${path}/generation`, { signal: readAbort.signal });
      if (disposed || version !== readVersion) return;
      acceptRun(result.run);
      if (activeRun(result.run)) scheduleRead();
    } catch (reason) {
      if (disposed || version !== readVersion) return;
      update({ loading: false, loadError: `读取生成状态失败：${errorMessage(reason)}` });
      scheduleRead();
    }
  }

  async function regenerate() {
    if (disposed || state.submitting || activeRun(state.run)) return;
    stopReading();
    update({ submitting: true, submitError: "", message: "" });
    mutationAbort = new AbortController();
    try {
      const result = await request<{ run: ReportGenerationRun; jobId: string | null; alreadyActive?: boolean }>(`${path}/regenerate`, {
        method: "POST", signal: mutationAbort.signal,
      });
      if (disposed) return;
      acceptRun(result.run, true);
    } catch (reason) {
      if (disposed) return;
      update({ submitError: `提交重新生成失败：${errorMessage(reason)}` });
    } finally {
      if (!disposed) {
        update({ submitting: false });
        // After a transport error, check whether the server accepted the task.
        // An old completed run must not be treated as a successful submission.
        if (activeRun(state.run) || state.submitError) scheduleRead();
      }
    }
  }

  return {
    start: read,
    regenerate,
    dispose() {
      disposed = true;
      stopReading();
      mutationAbort?.abort();
    },
  };
}

export function useReportGeneration(reportId: string, onCompleted: () => void) {
  const [state, setState] = useState<ReportGenerationState>(initialState);
  const controller = useRef<ReturnType<typeof createReportGenerationController> | null>(null);
  useEffect(() => {
    setState({ ...initialState });
    const next = createReportGenerationController({ reportId, onChange: setState, onCompleted });
    controller.current = next;
    void next.start();
    return () => {
      next.dispose();
      if (controller.current === next) controller.current = null;
    };
  }, [reportId, onCompleted]);
  return { state, regenerate: () => controller.current?.regenerate() };
}

export function ReportRegenerateButton({ state, onRegenerate }: {
  state: ReportGenerationState;
  onRegenerate: () => unknown;
}) {
  const active = activeRun(state.run);
  return <button type="button" disabled={state.loading || state.submitting || active} onClick={() => void onRegenerate()}>
    {state.submitting ? "正在提交…" : active ? "重新生成中…" : "重新生成"}
  </button>;
}

export function ReportGenerationDetails({ state }: { state: ReportGenerationState }) {
  const { run } = state;
  const diagnostics = run?.stats?.responseDiagnostics ?? [];
  const status = ({ queued: "等待处理", running: "生成中", completed: "已完成", failed: "失败", cancelled: "已取消" } as Record<string, string>)[run?.status ?? ""] ?? run?.status;
  return <section className="panel" aria-label="报告生成状态">
    {state.loadError && <div className="alert error" role="alert">{state.loadError}，稍后会自动重试。</div>}
    {state.submitError && <div className="alert error" role="alert">{state.submitError}</div>}
    {state.message && <div className="alert success" role="status">{state.message}</div>}
    <p className="panel-subtitle">重新生成本报告周期的内容，通过完整性校验后更新正文。此次操作不会发送邮件。</p>
    {state.loading ? <p className="muted">加载生成状态中…</p> : run ? <>
      <p role="status">最近一次生成：<strong>{status}</strong>
        {typeof run.stats?.totalConversations === "number" && ` · ${run.stats.totalConversations} 个会话`}
        {typeof run.stats?.projectCount === "number" && ` · ${run.stats.projectCount} 个项目`}
        {activeRun(run) && "。完成后自动刷新正文。"}
      </p>
      {run.status === "failed" && <div className="alert error" role="alert">生成失败，已保留当前正文。{run.error || "可点击“重新生成”重试。"}</div>}
      <details className="other-capture-details">
        <summary>最近一次生成诊断{diagnostics.length > 0 ? `（${diagnostics.length} 次尝试）` : ""}</summary>
        {diagnostics.length === 0 ? <p className="muted">本次暂无响应诊断记录；早期生成任务未记录原始响应。</p> : diagnostics.map((item, index) => <div key={`${item.attempt}-${index}`}>
          <p><strong>第 {item.attempt} 次尝试 · {({ accepted: "通过校验", rejected: "未通过校验", request_failed: "请求失败" })[item.status]}</strong></p>
          <p className="panel-subtitle">模型：{item.model || "未提供"} · 结束原因：{item.finishReason || "未提供"} · 响应长度：{item.responseChars} 字符
            {typeof item.usage?.completionTokens === "number" && ` · 输出 token：${item.usage.completionTokens}`}
          </p>
          {item.error && <p className="failed-text">{item.error}</p>}
          <details className="other-capture-details">
            <summary>原始响应（已脱敏{item.contentTruncated ? "，已截断" : ""}）</summary>
            {(item.responseId || item.requestId) && <p className="panel-subtitle">{item.responseId && `响应 ID：${item.responseId}`}{item.requestId && ` 请求 ID：${item.requestId}`}</p>}
            <pre className="redaction-preview">{item.content || "未取得响应内容"}</pre>
          </details>
        </div>)}
      </details>
    </> : !state.loadError && <p className="muted">暂无生成记录。</p>}
  </section>;
}
