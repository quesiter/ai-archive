import type { Report, AnalysisRun } from "../api-types.js";
import { useEffect, useState } from "react";
import { MarkdownContent } from "../markdown-content.js";
import { setVisibleInterval } from "../visible-poll";
import { Link, useParams } from "react-router-dom";
import { api, jsonBody } from "../api.js";
import { ReportGenerationDetails, ReportRegenerateButton, useReportGeneration } from "../report-generation.js";
import { PageEnvelope, useLoad, Loading, ErrorBanner, Pagination, PageHeader, isActiveStatus, reportPeriodLabel, statusLabel, statusClass, stageLabel, formatTaskTime, useTaskClock, deferredAiTaskMessage, compactErrorMessage, safeExternalHref } from "../shared-ui.js";

export function Reports() {
  const [offset, setOffset] = useState(0);
  const state = useLoad(
    () => api<PageEnvelope<Report>>(`/api/v1/reports?limit=50&offset=${offset}`),
    [offset],
  );
  const runsState = useLoad(
    () =>
      Promise.all([
        api<PageEnvelope<AnalysisRun>>("/api/v1/analysis/runs?kind=weekly&limit=1"),
        api<PageEnvelope<AnalysisRun>>("/api/v1/analysis/runs?kind=monthly&limit=1"),
      ]).then(([weekly, monthly]) =>
        [...weekly.items, ...monthly.items].sort(
          (left, right) =>
            new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime(),
        ),
      ),
    [],
  );
  const [reportMessage, setReportMessage] = useState("");
  const activeRuns = runsState.data?.filter((run) => isActiveStatus(run.status)) ?? [];
  const reportClock = useTaskClock(activeRuns.length > 0);
  const activeRunIds = activeRuns.map((run) => run.id).join(",");

  useEffect(() => {
    if (!activeRunIds) return;
    const timer = setVisibleInterval(() => {
      runsState.reload();
      state.reload();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeRunIds, runsState.reload, state.reload]);

  async function run(kind: "weekly"|"monthly") {
    setReportMessage(`${kind === "weekly" ? "周报" : "月报"}正在加入队列…`);
    try {
      const payload = await api<{ jobId: string | null; run: AnalysisRun }>("/api/v1/analysis/run", {method:"POST",...jsonBody({kind})});
      setReportMessage(`${kind === "weekly" ? "周报" : "月报"}${statusLabel(payload.run.status)}，下方会持续刷新运行状态`);
      runsState.reload();
    } catch (reason) {
      setReportMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function retryReportEmail(report: Report) {
    setReportMessage(`正在重新发送“${report.title}”…`);
    try {
      await api(`/api/v1/reports/${report.id}/email/retry`, { method: "POST" });
      setReportMessage("邮件任务已进入队列，下方状态将随刷新更新。");
      state.reload();
    } catch (reason) {
      setReportMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function runProgress(run: AnalysisRun): number {
    if (run.status === "completed") return 100;
    const stats = run.stats ?? {};
    const total = Number(stats.totalConversations ?? 0);
    const processed = Number(stats.processedConversations ?? 0);
    if (total > 0) return Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
    return run.status === "running" ? 15 : run.status === "queued" ? 0 : 100;
  }

  const weeklyActive = activeRuns.some((run) => run.kind === "weekly");
  const monthlyActive = activeRuns.some((run) => run.kind === "monthly");
  return (
    <>
      <PageHeader
        title="报告"
        subtitle="每周会话进展与每月项目演进"
        actions={
          <div className="button-group">
            <button disabled={weeklyActive} onClick={() => void run("weekly")}>
              {weeklyActive ? "周报处理中" : "立即生成周报"}
            </button>
            <button
              className="secondary"
              disabled={monthlyActive}
              onClick={() => void run("monthly")}
            >
              {monthlyActive ? "月报处理中" : "立即生成月报"}
            </button>
          </div>
        }
      />
      {reportMessage && <div className="alert success">{reportMessage}</div>}
      <section className="panel">
        <h2>生成状态</h2>
        <p className="panel-subtitle">仅显示最新一次周报和最新一次月报的生成状态。</p>
        {runsState.loading ? (
          <Loading label="加载运行状态中…" />
        ) : runsState.error ? (
          <ErrorBanner message={runsState.error} />
        ) : runsState.data?.length ? (
          <div className="run-list">
            {runsState.data.map((run) => {
              const percent = runProgress(run);
              const stats = run.stats ?? {};
              const deferredMessage = deferredAiTaskMessage(stats, reportClock);
              const error = deferredMessage ? "" : compactErrorMessage(run.error);
              return (
                <div className="run-row" key={run.id}>
                  <div>
                    <strong>
                      {run.kind === "weekly" ? "周报" : "月报"} · {statusLabel(run.status)}
                    </strong>
                    <span>
                      {reportPeriodLabel(run.windowStart, run.windowEnd)}
                    </span>
                  </div>
                  <div className="run-progress">
                    <div className="progress-bar">
                      <span style={{ width: `${percent}%` }} />
                    </div>
                    <small className={deferredMessage ? "ai-deferred-inline" : ""}>
                      {deferredMessage ||
                        `${
                          stats.stage
                            ? stageLabel(stats.stage)
                            : formatTaskTime(run.updatedAt ?? run.createdAt)
                        }${
                          typeof stats.analyzedConversations === "number"
                            ? ` · 会话 ${stats.analyzedConversations}`
                            : ""
                        }${
                          typeof stats.tagCount === "number"
                            ? ` · 标签 ${stats.tagCount}`
                            : ""
                        }${error ? ` · ${error}` : ""}`}
                    </small>
                  </div>
                  <span className={`pill ${statusClass(run.status)}`}>
                    {statusLabel(run.status)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted">还没有报告生成任务</p>
        )}
      </section>
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorBanner message={state.error} />
      ) : (
        <div className="card-list">
          {state.data!.items.map((report) => (
            <article className="report-card" key={report.id}>
              <span className="pill">{report.kind}</span>
              <h3><Link to={`/reports/${report.id}`}>{report.title}</Link></h3>
              <p>{report.summary}</p>
              <time>{formatTaskTime(report.createdAt)}</time>
              <div className="button-group">
                <Link className="button-link secondary small" to={`/reports/${report.id}`}>查看</Link>
                <a className="button-link secondary small" href={`/api/v1/reports/${report.id}/download`}>下载 Markdown</a>
                <span className={`pill ${report.emailStatus === "sent" ? "complete" : report.emailStatus === "failed" ? "failed" : "partial"}`}>邮件：{({sent:"已发送",queued:"等待发送",sending:"发送中",failed:"失败",not_configured:"未配置"} as Record<string, string>)[report.emailStatus] ?? report.emailStatus}</span>
                {report.emailStatus === "failed" && <button className="secondary small" onClick={() => void retryReportEmail(report)}>重试邮件</button>}
              </div>
              {report.emailError && <small className="failed-text">{report.emailError}</small>}
            </article>
          ))}
        </div>
      )}
      <Pagination
        loading={state.loading}
        pagination={state.data?.pagination}
        onOffsetChange={setOffset}
      />
    </>
  );
}

export function ReportDetail() {
  const { id } = useParams();
  const state = useLoad(() => api<Report>(`/api/v1/reports/${id}`), [id]);
  const generation = useReportGeneration(id ?? "", state.reload);
  if (state.data?.id !== id && state.loading) return <Loading />;
  if (!state.data || state.data.id !== id) return <ErrorBanner message={state.error} />;
  const report = state.data;
  return <>
    <PageHeader title={report.title} subtitle={`${report.kind} · ${reportPeriodLabel(report.periodStart, report.periodEnd)}`} actions={<div className="button-group">
      <ReportRegenerateButton state={generation.state} onRegenerate={generation.regenerate} />
      <a className="button-link secondary" href={`/api/v1/reports/${id}/download`}>下载 Markdown</a>
    </div>} />
    <ReportGenerationDetails state={generation.state} />
    {state.error && <ErrorBanner message={`刷新报告正文失败：${state.error}`} />}
    <article className="report-body" aria-busy={state.loading}>
      <p className="report-summary">{report.summary}</p>
      <MarkdownContent skipHtml components={{
        a: ({ href, children }) => { const safeHref = safeExternalHref(href); return safeHref ? <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>; },
        img: ({ alt }) => <span>{alt ?? "[图片已隐藏]"}</span>,
      }}>{String(report.bodyMarkdown ?? "")}</MarkdownContent>
    </article>
  </>;
}
