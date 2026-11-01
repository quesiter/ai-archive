import type { ImportJob } from "../api-types.js";
import { FormEvent, useEffect, useState } from "react";
import { setVisibleInterval } from "../visible-poll";
import { providerLabels } from "@ai-archive/contracts/presentation";
import type { Provider } from "@ai-archive/contracts";
import { api, jsonBody } from "../api.js";
import { PageEnvelope, useLoad, Loading, Pagination, PageHeader, isActiveStatus, statusLabel, statusClass, stageLabel, formatTaskTime, compactErrorMessage } from "../shared-ui.js";

export function importJobPercent(job: ImportJob): number {
  if (["completed", "partial", "failed"].includes(String(job.status))) return 100;
  const stats = job.stats ?? {};
  const total = Number(stats.snapshots ?? 0);
  const processed = Number(stats.imported ?? 0) + Number(stats.unchanged ?? 0);
  if (total <= 0) {
    if (job.status !== "processing") return 0;
    return stats.stage === "importing" ? 15 : 8;
  }
  return Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
}

export function importJobStats(job: ImportJob) {
  const stats = job.stats ?? {};
  const imported = Number(stats.imported ?? 0);
  const unchanged = Number(stats.unchanged ?? 0);
  const total = Number(stats.snapshots ?? 0);
  const processed = imported + unchanged;
  const failed = Number(stats.failed ?? 0);
  return {
    stats,
    imported: Number.isFinite(imported) ? imported : 0,
    unchanged: Number.isFinite(unchanged) ? unchanged : 0,
    total: Number.isFinite(total) ? total : 0,
    processed: Number.isFinite(processed) ? processed : 0,
    failed: Number.isFinite(failed) ? failed : 0,
  };
}

export function importJobText(job: ImportJob): string {
  const { stats, imported, unchanged, failed, total, processed } = importJobStats(job);
  if (job.status === "queued") return "等待 Worker 接手";
  if (job.status === "failed") {
    return `导入失败${job.error ? `：${compactErrorMessage(job.error)}` : ""}`;
  }
  if (job.status === "partial") {
    return `部分完成：成功 ${imported}，未变化 ${unchanged}，失败 ${failed}，总数 ${total || processed + failed}`;
  }
  if (job.status === "completed") {
    return `已完成 ${processed}/${total || processed}，新增 ${imported}，未变 ${unchanged}`;
  }
  if (stats.stage === "parsing" || total <= 0) {
    return "正在解析 ZIP，解析完成后会显示总会话数";
  }
  return `已处理 ${processed}/${total}，新增 ${imported}，未变 ${unchanged}`;
}

export function importJobMetaText(job: ImportJob): string {
  const { stats, imported, unchanged, total, processed } = importJobStats(job);
  const provider = job.provider
    ? providerLabels[job.provider as Provider] ?? job.provider
    : "平台检测中";
  const parts = [
    `来源 ${provider}`,
    total > 0 ? `快照 ${processed}/${total}` : "",
    total > 0 ? `新增 ${imported}` : "",
    total > 0 ? `未变 ${unchanged}` : "",
    stats.stage ? `阶段 ${stageLabel(stats.stage)}` : "",
    `更新 ${formatTaskTime(job.updatedAt ?? job.createdAt)}`,
  ].filter(Boolean);
  return parts.join(" · ");
}

export function Imports() {
  const [offset, setOffset] = useState(0);
  const state = useLoad(
    () => api<PageEnvelope<ImportJob>>(`/api/v1/imports?limit=50&offset=${offset}`),
    [offset],
  );
  const [message, setMessage] = useState("");
  const jobs = state.data?.items ?? [];
  const activeJobs = jobs.filter((job) => isActiveStatus(job.status));
  const activeKey = jobs
    .filter((job) => isActiveStatus(job.status))
    .map((job) => `${job.id}:${job.status}:${JSON.stringify(job.stats ?? {})}`)
    .join(",");

  useEffect(() => {
    if (!activeKey) return;
    const timer = setVisibleInterval(() => state.reload(), 2500);
    return () => window.clearInterval(timer);
  }, [activeKey, state.reload]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setMessage("上传中…");
    try {
      await api("/api/v1/imports", { method: "POST", body: form });
      setMessage("已进入导入队列");
      state.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function retryImport(job: ImportJob) {
    setMessage("正在重新入队…");
    try {
      await api(`/api/v1/imports/${job.id}/retry`, { method: "POST" });
      setMessage("失败任务已重新入队");
      state.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function cleanupImports(includeUnexpired = false) {
    if (includeUnexpired && !window.confirm("确认立即删除 Processed 和 Failed 中的全部 ZIP？导入的数据不会删除。")) return;
    setMessage("正在清理导入文件…");
    try {
      const result = await api<{ processed?: { files: number }; failed?: { files: number } }>("/api/v1/imports/cleanup", {
        method: "POST",
        ...jsonBody({ scope: "all", includeUnexpired }),
      });
      setMessage(`已清理 ${Number(result.processed?.files ?? 0) + Number(result.failed?.files ?? 0)} 个 ZIP`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <>
      <PageHeader title="历史导入" subtitle="支持 ChatGPT、Gemini Takeout 与 Chat Memo 多平台 ZIP" />
      <section className="panel">
        <form className="upload-box" onSubmit={upload}>
          <input type="file" name="file" accept=".zip,application/zip" required />
          <button>上传归档</button>
          <span>{message}</span>
        </form>
        <p className="muted">也可以把 ZIP 放入 Synology Drive 对应的 imports/inbox 目录，Worker 每五分钟自动发现。</p>
      </section>
      <section className="panel">
        <div className="section-title-row">
          <h2>导入记录</h2>
          <div className="button-group import-toolbar">
            {activeJobs.length > 0 && (
              <span className="live-indicator">
                <span className="live-dot" />
                {activeJobs.length} 个导入正在运行，2.5 秒自动刷新
              </span>
            )}
            <button className="secondary small" onClick={() => state.reload()}>刷新</button>
            <button className="ghost small" onClick={() => void cleanupImports(false)}>清理过期文件</button>
            <button className="danger small" onClick={() => void cleanupImports(true)}>立即清理全部 ZIP</button>
          </div>
        </div>
        {state.loading ? (
          <Loading />
        ) : jobs.length ? (
          <div className="run-list">
            {jobs.map((job) => {
              const percent = importJobPercent(job);
              const stats = job.stats ?? {};
              const active = isActiveStatus(job.status);
              return (
                <div className={`run-row import-run-row ${active ? "active" : ""}`} key={job.id}>
                  <div>
                    <strong>{job.filename}</strong>
                    <span>
                      {statusLabel(job.status)}
                      {stats.stage ? ` · ${stageLabel(stats.stage)}` : ""}
                      {active ? " · 正在运行" : ""}
                    </span>
                  </div>
                  <div className="run-progress">
                    <div className="import-progress-head">
                      <small>{importJobText(job)}</small>
                      <strong>{percent}%</strong>
                    </div>
                    <div className="progress-bar"><span style={{ width: `${percent}%` }} /></div>
                    <small>{importJobMetaText(job)}</small>
                  </div>
                  <div className="button-group">
                    <span className={`pill ${statusClass(job.status)}`}>
                      {active && <span className="live-dot inline" />}
                      {statusLabel(job.status)}
                    </span>
                    {(job.status === "failed" || job.status === "partial") && (
                      <button className="secondary small" onClick={() => void retryImport(job)}>重试</button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted">还没有导入记录</p>
        )}
        <Pagination
          loading={state.loading}
          pagination={state.data?.pagination}
          onOffsetChange={setOffset}
        />
      </section>
    </>
  );
}
