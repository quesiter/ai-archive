import type { BackgroundTask, TaskStats, PaginationData } from "./api-types.js";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { providerLabels } from "@ai-archive/contracts/presentation";
import type { Provider } from "@ai-archive/contracts";
import { ApiError } from "./api.js";


export type { PaginationData, PageEnvelope } from "./api-types.js";

export const WEB_VERSION = "V2.4.12";

export function useLoad<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const requestIdRef = useRef(0);
  const reload = useCallback(() => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError("");
    void loader()
      .then((value) => {
        if (requestId === requestIdRef.current) setData(value);
      })
      .catch((reason) => {
        if (requestId === requestIdRef.current) setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, dependencies);
  useEffect(() => {
    reload();
    return () => { requestIdRef.current += 1; };
  }, [reload]);
  return { data, error, loading, reload };
}

export function Loading({ label = "加载中…" }: { label?: string }) {
  return <div className="empty-state">{label}</div>;
}

export function ErrorBanner({ message }: { message: string }) {
  return message ? <div className="alert error">{message}</div> : null;
}

export function Pagination({
  pagination,
  loading = false,
  onOffsetChange,
}: {
  pagination?: PaginationData | null | undefined;
  loading?: boolean;
  onOffsetChange: (offset: number) => void;
}) {
  if (!pagination) return null;
  const start = pagination.total > 0 ? pagination.offset + 1 : 0;
  const end = Math.min(pagination.total, pagination.offset + pagination.limit);
  return (
    <div className="conversation-pagination" aria-label="分页">
      <span className="toolbar-count">
        {loading ? "加载中" : `第 ${start}-${end} 条，共 ${pagination.total} 条`}
      </span>
      <button
        className="secondary small"
        disabled={loading || pagination.offset <= 0}
        onClick={() => onOffsetChange(Math.max(0, pagination.offset - pagination.limit))}
        type="button"
      >
        上一页
      </button>
      <button
        className="secondary small"
        disabled={loading || !pagination.hasMore}
        onClick={() => onOffsetChange(pagination.offset + pagination.limit)}
        type="button"
      >
        下一页
      </button>
    </div>
  );
}

export function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previousActiveElement = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const firstField = panelRef.current?.querySelector<HTMLElement>("input, select, textarea");
    (firstField ?? panelRef.current)?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
      previousActiveElement?.focus();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <div
        aria-label={title}
        aria-modal="true"
        className="modal-panel"
        ref={panelRef}
        role="dialog"
        tabIndex={-1}
      >
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button aria-label="关闭弹窗" className="modal-close" onClick={onClose} type="button">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions}</header>;
}

export function isActiveStatus(status: unknown): boolean {
  return status === "queued" || status === "running" || status === "processing";
}

export let instanceTimeZone = "Asia/Shanghai";

export function reportPeriodLabel(periodStart: unknown, periodEnd: unknown): string {
  const start = new Date(String(periodStart));
  const exclusiveEnd = new Date(String(periodEnd));
  if (Number.isNaN(start.getTime()) || Number.isNaN(exclusiveEnd.getTime())) return "日期未知";
  const inclusiveEnd = new Date(exclusiveEnd.getTime() - 1);
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: instanceTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return `${formatter.format(start)} — ${formatter.format(inclusiveEnd)}`;
}

export function statusLabel(status: unknown): string {
  return ({
    queued: "已入队",
    running: "运行中",
    processing: "处理中",
    validating: "校验中",
    validated: "校验通过",
    restoring: "替换数据中",
    rebuilding_search: "重建检索中",
    verifying: "恢复后验证中",
    recovery_required: "需要恢复处理",
    cancelled: "已取消",
    completed: "已完成",
    complete: "完整",
    partial: "部分完成",
    active: "有效",
    revoked: "已撤销",
    deleted: "已删除",
    failed: "失败",
  } as Record<string, string>)[String(status)] ?? String(status ?? "未知");
}

export function statusClass(status: unknown): string {
  return (
    {
      completed: "complete",
      complete: "complete",
      active: "complete",
      running: "partial",
      processing: "partial",
      validating: "partial",
      validated: "partial",
      restoring: "partial",
      rebuilding_search: "partial",
      verifying: "partial",
      recovery_required: "failed",
      queued: "partial",
      partial: "partial",
      revoked: "failed",
      deleted: "failed",
      cancelled: "failed",
      failed: "failed",
    } as Record<string, string>
  )[String(status)] ?? "partial";
}

export function storageRedactionMessage(message: unknown): string {
  return String(message ?? "")
    .replace("正在清理已有归档", "正在脱敏历史归档")
    .replace("已有归档敏感信息清理完成", "历史归档敏感信息脱敏完成")
    .replace("已有归档敏感信息清理已入队", "历史归档敏感信息脱敏已入队");
}

export const sourceLabels: Record<string, string> = {
  web: "网页",
  openclaw: "OpenClaw",
  codex: "Codex",
  claude_code: "Claude Code",
  grok_build: "Grok Build",
  historical_import: "历史导入",
};

export const captureModeLabels: Record<string, string> = {
  full: "完整",
  append: "增量",
  import: "导入",
};

export const triggerReasonLabels: Record<string, string> = {
  new_session: "新会话",
  new_messages: "新消息",
  stream_finished: "生成结束",
  branch_changed: "分支变化",
  adapter_upgraded: "适配器升级",
  manual_retry: "手动重试",
  incremental_base_mismatch: "增量基线不一致",
  historical_import: "历史导入",
  local_file_appended: "本地追加",
  local_file_rewritten: "本地重写",
};

export function stageLabel(stage: unknown): string {
  return (
    {
      queued: "等待执行",
      parsing: "解析文件",
      importing: "写入归档",
      preparing: "准备数据",
      extracting: "提取会话信息",
      rebuilding: "整理项目与标签",
      consolidating: "汇总归档信息",
      deferred: "等待 AI 额度恢复",
      reporting: "生成报告",
      completed: "完成",
    } as Record<string, string>
  )[String(stage)] ?? String(stage ?? "");
}

export function taskPercent(task: BackgroundTask | null): number {
  if (!task) return 0;
  if (task.status === "completed") return 100;
  if (task.status === "failed") return 100;
  const total = Number(task.totalCount ?? 0);
  const processed = Number(task.processedCount ?? 0);
  if (total <= 0) return task.status === "running" ? 8 : 0;
  return Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
}

export function formatTaskTime(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { timeZone: instanceTimeZone });
}

export function adapterVersionLabel(value: unknown): string {
  const version = String(value ?? "").trim();
  return version && version.toLowerCase() !== "unknown" ? version : "版本未上报";
}

export function useTaskClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

export function formatRetryCountdown(milliseconds: number): string {
  if (milliseconds <= 0) return "即将";
  const totalMinutes = Math.max(1, Math.ceil(milliseconds / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  return [
    days ? `${days}天` : "",
    hours ? `${hours}小时` : "",
    minutes ? `${minutes}分钟` : "",
  ].filter(Boolean).join("");
}

export function deferredAiTaskMessage(stats: TaskStats, now: number): string {
  if (stats.stage !== "deferred" || typeof stats.retryAt !== "string") return "";
  const retryAt = new Date(stats.retryAt);
  if (Number.isNaN(retryAt.getTime())) return "";
  const retryWindow = String(stats.retryWindow ?? "rate_limit");
  const subject =
    retryWindow === "weekly"
      ? "当前 Token Plan 周额度已用完"
      : retryWindow === "five_hour"
        ? "当前 Token Plan 5 小时额度已用完"
        : "当前 AI 请求频率受限";
  const countdown = formatRetryCountdown(retryAt.getTime() - now);
  const bufferMinutes = Math.round(Number(stats.retryBufferMs ?? 0) / 60_000);
  const buffer = bufferMinutes > 0 ? `，已包含${bufferMinutes}分钟缓冲` : "";
  return `${subject}，将在${countdown}后继续该任务（预计 ${retryAt.toLocaleString()}${buffer}）。`;
}

export function toFiniteNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function formatCount(value: unknown): string {
  return new Intl.NumberFormat("zh-CN").format(Math.round(toFiniteNumber(value)));
}

export function formatCompactCount(value: unknown): string {
  const numeric = Math.round(toFiniteNumber(value));
  if (numeric >= 100_000_000) return `${(numeric / 100_000_000).toFixed(1)}亿`;
  if (numeric >= 10_000) return `${(numeric / 10_000).toFixed(1)}万`;
  return formatCount(numeric);
}

export function providerCountsFromRows(rows: ReadonlyArray<{ provider: unknown; count: unknown }> | null | undefined) {
  const counts: Record<string, number> = {};
  for (const row of rows ?? []) {
    if (typeof row.provider !== "string") continue;
    counts[row.provider] = toFiniteNumber(row.count);
  }
  return counts;
}

export function providerLabelWithCount(
  provider: string,
  counts: Record<string, number>,
): string {
  return `${providerLabels[provider as Provider] ?? provider}（${formatCount(counts[provider] ?? 0)}）`;
}

export function shortValue(value: unknown, max = 18): string {
  if (value === null || value === undefined || value === "") return "-";
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(4, max - 7))}…${text.slice(-4)}`;
}

export function taskStats(task: BackgroundTask | null): TaskStats {
  return task?.stats && typeof task.stats === "object" ? task.stats : {};
}

export function taskFailureSamples(task: BackgroundTask | null) {
  const samples = taskStats(task).failureSamples;
  return Array.isArray(samples) ? samples.slice(0, 5) : [];
}

export const classificationScopeLabels: Record<string, string> = {
  incremental: "增量候选",
  all: "完整重评",
};

export const classificationCandidateReasonLabels: Record<string, string> = {
  full: "完整重评",
  unassigned: "未归类",
  missing_tags: "尚无标签",
  low_confidence: "低置信度",
  changed: "内容已更新",
};

export function taskCandidateReasonEntries(task: BackgroundTask | null) {
  const reasons = taskStats(task).candidateReasons;
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) return [];
  const order = ["unassigned", "missing_tags", "changed", "low_confidence", "full"];
  return Object.entries(reasons as Record<string, unknown>)
    .map(([key, value]) => ({ key, count: toFiniteNumber(value) }))
    .filter((item) => item.count > 0)
    .sort((left, right) => {
      const leftIndex = order.indexOf(left.key);
      const rightIndex = order.indexOf(right.key);
      return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
    });
}

export function compactErrorMessage(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "";
  const trimmed = value.trim();
  const jsonStart = trimmed.indexOf("[");
  const candidate = jsonStart >= 0 ? trimmed.slice(jsonStart) : trimmed;
  try {
    const issues = JSON.parse(candidate) as unknown;
    if (Array.isArray(issues)) {
      const missing = issues
        .map((issue) =>
          issue &&
          typeof issue === "object" &&
          "path" in issue &&
          Array.isArray((issue as { path?: unknown }).path)
            ? (issue as { path: unknown[] }).path.join(".")
            : "",
        )
        .filter(Boolean)
        .slice(0, 4);
      if (missing.length) return `模型返回格式不完整：缺少 ${missing.join("、")}`;
    }
  } catch {
    // Fall through to text cleanup below.
  }
  return trimmed
    .replace(/^Model JSON did not match expected schema:\s*/i, "模型返回格式不匹配：")
    .replace(/; response excerpt:.+$/i, "")
    .slice(0, 260);
}

export function responseDownloadFilename(response: Response, fallback: string): string {
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const utf8Name = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf8Name) {
    try {
      return decodeURIComponent(utf8Name);
    } catch {
      // Keep the safe fallback when an upstream filename is malformed.
    }
  }
  const quotedName = disposition.match(/filename="([^"]+)"/i)?.[1];
  return quotedName || fallback;
}

export function saveDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking synchronously can cancel a download in some Chromium builds.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export async function downloadResponse(
  path: string,
  init: RequestInit,
  fallbackFilename: string,
): Promise<void> {
  const response = await fetch(path, { ...init, credentials: "include" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({})) as { error?: string };
    throw new ApiError(payload.error ?? response.statusText, response.status);
  }
  const blob = await response.blob();
  saveDownload(blob, responseDownloadFilename(response, fallbackFilename));
}

export function ExportLinks({ path }: { path: string }) {
  const [downloading, setDownloading] = useState<"csv" | "md" | "xlsx" | null>(null);
  const [downloadError, setDownloadError] = useState("");

  async function download(format: "csv" | "md" | "xlsx"): Promise<void> {
    if (downloading) return;
    setDownloading(format);
    setDownloadError("");
    try {
      await downloadResponse(
        `${path}?format=${format}`,
        {},
        `conversation-export.${format}`,
      );
    } catch (reason) {
      setDownloadError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDownloading(null);
    }
  }

  return <div className="export-links" aria-label="导出对话记录">
    <span>{downloading ? `正在生成 ${downloading.toUpperCase()}…` : "导出"}</span>
    {(["csv", "md", "xlsx"] as const).map((format) => (
      <button
        className="secondary small"
        disabled={downloading !== null}
        key={format}
        type="button"
        onClick={() => void download(format)}
      >
        {format === "md" ? "Markdown" : format.toUpperCase()}
      </button>
    ))}
    {downloadError && <span className="export-error" role="alert" title={downloadError}>导出失败：{downloadError}</span>}
  </div>;
}

export function setInstanceTimeZone(value: unknown): void {
  if (typeof value === "string" && value.trim()) instanceTimeZone = value;
}

export function safeExternalHref(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

