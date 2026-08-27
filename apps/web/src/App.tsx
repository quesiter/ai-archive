import {
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import ReactMarkdown from "react-markdown";
import {
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import {
  providerLabels,
  stripInternalConversationMetadata,
  type Provider,
} from "@ai-archive/contracts";
import { api, ApiError, jsonBody } from "./api.js";
import {
  buildConversationListSearch,
  countActiveConversationListFilters,
  filterConversationTags,
} from "./conversation-list.js";
import { releaseNotes } from "./release-notes.js";

type UnknownRecord = Record<string, any>;
type PaginationData = {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
};
type PageEnvelope = { items: UnknownRecord[]; pagination: PaginationData };
const WEB_VERSION = "V2.3.0";

function useLoad<T>(loader: () => Promise<T>, dependencies: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reload = useCallback(() => {
    setLoading(true);
    setError("");
    void loader()
      .then(setData)
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, dependencies);
  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}

function Loading({ label = "加载中…" }: { label?: string }) {
  return <div className="empty-state">{label}</div>;
}

function ErrorBanner({ message }: { message: string }) {
  return message ? <div className="alert error">{message}</div> : null;
}

function Pagination({
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

function Modal({
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

function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const status = useLoad(() => api<{ initialized: boolean; instance?: { timezone?: string } }>("/api/v1/auth/status"), []);
  const [bootstrapResult, setBootstrapResult] = useState<{
    secret: string;
    otpauthUrl: string;
  } | null>(null);
  const [error, setError] = useState("");

  if (status.loading) return <Loading />;
  if (status.error) return <ErrorBanner message={status.error} />;
  instanceTimeZone = status.data?.instance?.timezone || instanceTimeZone;
  const initialized = Boolean(status.data?.initialized);

  async function bootstrap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      setBootstrapResult(
        await api("/api/v1/auth/bootstrap", {
          method: "POST",
          ...jsonBody({
            username: form.get("username"),
            password: form.get("password"),
          }),
        }),
      );
      status.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      await api("/api/v1/auth/login", {
        method: "POST",
        ...jsonBody({
          username: form.get("username"),
          password: form.get("password"),
          totpCode: form.get("totpCode"),
        }),
      });
      onAuthenticated();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return (
    <main className="auth-shell">
      <div className="auth-layout">
        <section className="auth-brand-panel">
          <div className="auth-brand-heading">
            <img className="auth-brand-logo" src="/brand/logo.png" alt="" />
            <span className="auth-brand-kicker">个人 AI 知识归档</span>
          </div>
          <div className="auth-brand-copy">
            <h1>知言归藏</h1>
            <p className="auth-tagline">汇智能之言，成项目之知。</p>
            <p>把分散在不同 AI 平台与本地工具里的对话，沉淀为可检索、可演进、可复用的项目历史。</p>
          </div>
          <div className="auth-feature-grid" aria-label="产品能力">
            <div><span>01</span><strong>完整归档</strong><small>保存跨平台会话与修订</small></div>
            <div><span>02</span><strong>项目演进</strong><small>用项目、标签与报告组织</small></div>
            <div><span>03</span><strong>私有部署</strong><small>数据留在自己的服务器</small></div>
          </div>
          <small className="auth-version">AI Conversation Archive · {WEB_VERSION}</small>
        </section>

        <section className="auth-form-panel">
          <div className="auth-form-content">
            <header className="auth-form-header">
              <span>{initialized ? "安全登录" : "首次使用"}</span>
              <h2>{initialized ? "欢迎回来" : "创建管理员"}</h2>
              <p>{initialized ? "使用管理员账号与六位动态验证码进入归档。" : "创建首个管理员账号，开始建立你的私人 AI 归档。"}</p>
            </header>
            <ErrorBanner message={error} />
            {initialized ? (
              <>
                {bootstrapResult && (
                  <div className="alert success">
                    <strong>请立即加入验证器：</strong>
                    <code className="breakable">{bootstrapResult.secret}</code>
                    <details><summary>OTP URI</summary><code className="breakable">{bootstrapResult.otpauthUrl}</code></details>
                  </div>
                )}
                <form onSubmit={login} className="auth-form stack">
                  <label><span>用户名</span><input name="username" autoComplete="username" placeholder="请输入管理员用户名" autoFocus required /></label>
                  <label><span>密码</span><input name="password" type="password" autoComplete="current-password" placeholder="请输入密码" required /></label>
                  <label><span>六位验证码</span><input name="totpCode" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="000000" required /></label>
                  <button type="submit">登录归档 <span aria-hidden="true">→</span></button>
                </form>
              </>
            ) : (
              <form onSubmit={bootstrap} className="auth-form stack">
                <label><span>用户名</span><input name="username" autoComplete="username" minLength={3} placeholder="至少 3 个字符" autoFocus required /></label>
                <label><span>密码</span><input name="password" type="password" autoComplete="new-password" minLength={12} placeholder="至少 12 个字符" required /></label>
                <button type="submit">创建并初始化 <span aria-hidden="true">→</span></button>
              </form>
            )}
            <div className="auth-security-note"><span aria-hidden="true">◎</span><p><strong>本地身份保护</strong><small>密码与 TOTP 双重验证，动态响应不缓存。</small></p></div>
          </div>
        </section>
      </div>
    </main>
  );
}

const navigation = [
  ["/", "总览", "⌂"],
  ["/conversations", "会话", "◫"],
  ["/activity", "活动", "↻"],
  ["/projects", "项目", "◇"],
  ["/tags", "标签", "#"],
  ["/reports", "报告", "▤"],
  ["/imports", "导入", "⇧"],
  ["/devices", "设备", "⌘"],
  ["/logs", "日志", "☰"],
  ["/trash", "回收站", "⌫"],
  ["/settings", "设置", "⚙"],
] as const;

function Shell({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <img className="sidebar-brand-mark" src="/brand/logo.png" alt="" />
          <div className="sidebar-brand-copy">
            <strong>知言归藏</strong>
            <small>汇智能之言，成项目之知。</small>
          </div>
        </div>
        <nav>
          {navigation.map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <span>{icon}</span>{label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-meta">
          <div className="sidebar-version" aria-label={`系统版本 ${WEB_VERSION}`}>
            <span>系统版本</span>
            <strong>{WEB_VERSION}</strong>
          </div>
          <NavLink className="sidebar-changelog-link" to="/changelog">更新记录</NavLink>
        </div>
        <button className="ghost" onClick={onLogout}>退出登录</button>
      </aside>
      <main className="content">{children}</main>
    </div>
  );
}

function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>{actions}</header>;
}

function ChangelogPage() {
  return (
    <>
      <PageHeader
        title="更新记录"
        subtitle="依据发布记录与 Git 提交历史整理，按发布时间倒序展示。"
        actions={<Link className="button-link secondary small" to="/">返回总览</Link>}
      />
      <section className="release-overview panel">
        <div>
          <span>当前版本</span>
          <strong>{WEB_VERSION}</strong>
        </div>
        <p>后续发布继续采用语义化版本：V2.1.3、V2.2.0……</p>
      </section>
      <div className="release-timeline">
        {releaseNotes.map((note, index) => (
          <article className="release-entry panel" key={`${note.date}-${note.version}`}>
            <div className="release-marker" aria-hidden="true" />
            <header>
              <div className="release-meta">
                <span className={`pill ${index === 0 ? "complete" : ""}`}>{note.version}</span>
                <time dateTime={note.date}>{note.date}</time>
              </div>
              {note.title && <h2>{note.title}</h2>}
            </header>
            <div className="release-body"><ReactMarkdown>{note.body}</ReactMarkdown></div>
          </article>
        ))}
      </div>
    </>
  );
}

function isActiveStatus(status: unknown): boolean {
  return status === "queued" || status === "running" || status === "processing";
}

let instanceTimeZone = "Asia/Shanghai";

function reportPeriodLabel(periodStart: unknown, periodEnd: unknown): string {
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

function statusLabel(status: unknown): string {
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

function statusClass(status: unknown): string {
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

function storageRedactionMessage(message: unknown): string {
  return String(message ?? "")
    .replace("正在清理已有归档", "正在脱敏历史归档")
    .replace("已有归档敏感信息清理完成", "历史归档敏感信息脱敏完成")
    .replace("已有归档敏感信息清理已入队", "历史归档敏感信息脱敏已入队");
}

const sourceLabels: Record<string, string> = {
  web: "网页",
  openclaw: "OpenClaw",
  codex: "Codex",
  claude_code: "Claude Code",
  historical_import: "历史导入",
};

const captureModeLabels: Record<string, string> = {
  full: "完整",
  append: "增量",
  import: "导入",
};

const triggerReasonLabels: Record<string, string> = {
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

function sourceDeviceLabel(value: UnknownRecord | null | undefined): string {
  if (!value) return "未记录设备";
  if (typeof value.sourceDeviceName === "string") return value.sourceDeviceName;
  if (value.sourceDevice && typeof value.sourceDevice.name === "string") {
    return value.sourceDevice.name;
  }
  return "未记录设备";
}

function stageLabel(stage: unknown): string {
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

function taskPercent(task: UnknownRecord | null): number {
  if (!task) return 0;
  if (task.status === "completed") return 100;
  if (task.status === "failed") return 100;
  const total = Number(task.totalCount ?? 0);
  const processed = Number(task.processedCount ?? 0);
  if (total <= 0) return task.status === "running" ? 8 : 0;
  return Math.min(100, Math.max(0, Math.round((processed / total) * 100)));
}

function formatTaskTime(value: unknown): string {
  if (typeof value !== "string" && !(value instanceof Date)) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString("zh-CN", { timeZone: instanceTimeZone });
}

function useTaskClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [enabled]);
  return now;
}

function formatRetryCountdown(milliseconds: number): string {
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

function deferredAiTaskMessage(stats: UnknownRecord, now: number): string {
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

function toFiniteNumber(value: unknown): number {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatCount(value: unknown): string {
  return new Intl.NumberFormat("zh-CN").format(Math.round(toFiniteNumber(value)));
}

function formatCompactCount(value: unknown): string {
  const numeric = Math.round(toFiniteNumber(value));
  if (numeric >= 100_000_000) return `${(numeric / 100_000_000).toFixed(1)}亿`;
  if (numeric >= 10_000) return `${(numeric / 10_000).toFixed(1)}万`;
  return formatCount(numeric);
}

function providerCountsFromRows(rows: UnknownRecord[] | null | undefined) {
  const counts: Record<string, number> = {};
  for (const row of rows ?? []) {
    if (typeof row.provider !== "string") continue;
    counts[row.provider] = toFiniteNumber(row.count);
  }
  return counts;
}

function providerLabelWithCount(
  provider: string,
  counts: Record<string, number>,
): string {
  return `${providerLabels[provider as Provider] ?? provider}（${formatCount(counts[provider] ?? 0)}）`;
}

function shortValue(value: unknown, max = 18): string {
  if (value === null || value === undefined || value === "") return "-";
  const text = String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(4, max - 7))}…${text.slice(-4)}`;
}

function taskStats(task: UnknownRecord | null): UnknownRecord {
  return task?.stats && typeof task.stats === "object" ? task.stats : {};
}

function taskFailureSamples(task: UnknownRecord | null): UnknownRecord[] {
  const samples = taskStats(task).failureSamples;
  return Array.isArray(samples) ? samples.slice(0, 5) : [];
}

const classificationScopeLabels: Record<string, string> = {
  incremental: "增量候选",
  all: "完整重评",
};

const classificationCandidateReasonLabels: Record<string, string> = {
  full: "完整重评",
  unassigned: "未归类",
  missing_tags: "尚无标签",
  low_confidence: "低置信度",
  changed: "内容已更新",
};

function taskCandidateReasonEntries(task: UnknownRecord | null) {
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

function compactErrorMessage(value: unknown): string {
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

function Dashboard() {
  const state = useLoad(() => api<UnknownRecord>("/api/v1/dashboard"), []);
  const reliabilityState = useLoad(
    () => api<UnknownRecord>("/api/v1/reliability/summary"),
    [],
  );
  if (state.loading) return <Loading />;
  if (state.error) return <ErrorBanner message={state.error} />;
  const data = state.data!;
  const captureProviders = Array.isArray(data.captureProviders24h)
    ? data.captureProviders24h
    : [];
  const captureStatus = data.captureStatus24h ?? {};
  const counts = data.counts ?? {};
  const textStats = data.textStats ?? {};
  const categoryTotals = data.categoryTotals ?? {};
  const categoryStats = Array.isArray(data.categoryStats)
    ? data.categoryStats
    : [];
  const tagCount = toFiniteNumber(counts.tags);
  const calibrationSampleCount = toFiniteNumber(
    textStats.calibrationSampleCount,
  );
  const hasTokenCalibration = calibrationSampleCount > 0;
  const displayedModelTokens = hasTokenCalibration
    ? textStats.calibratedEstimatedTokens
    : textStats.estimatedTokens;
  const topCategories = categoryStats.slice(0, 12);
  const maxCategoryCount = Math.max(
    1,
    ...topCategories.map((category: UnknownRecord) =>
      toFiniteNumber(category.conversationCount),
    ),
  );
  return (
    <>
      <PageHeader title="总览" subtitle="归档规模、组织状态、采集健康与最近报告" />
      <section className="metric-grid dashboard-metrics">
        <article className="metric">
          <span>总会话</span>
          <strong>{formatCount(counts.conversations)}</strong>
          <small>已去重 Session</small>
        </article>
        <article className="metric">
          <span>总项目</span>
          <strong>{formatCount(counts.projects)}</strong>
          <small>{formatCount(categoryTotals.activeCategoryCount)} 个已有会话</small>
        </article>
        <article className="metric">
          <span>已归类会话</span>
          <strong>{formatCount(categoryTotals.categorizedConversationCount)}</strong>
          <small>未归类 {formatCount(categoryTotals.unclassifiedConversationCount)}</small>
        </article>
        <article className="metric">
          <span>归档文本量</span>
          <strong>{formatCompactCount(textStats.textUnits)}</strong>
          <small>含正文、思考与工具过程</small>
        </article>
        <article className="metric">
          <span>{hasTokenCalibration ? "模型 token（校准）" : "模型 token"}</span>
          <strong>{formatCompactCount(displayedModelTokens)}</strong>
          <small>
            {hasTokenCalibration
              ? `区间 ${formatCompactCount(textStats.calibratedEstimatedTokensLow)}–${formatCompactCount(textStats.calibratedEstimatedTokensHigh)}`
              : toFiniteNumber(textStats.usageBackedConversationCount) > 0
                ? `源端 usage ${formatCount(textStats.usageBackedConversationCount)} 个会话；其余含过程估算`
              : (textStats.tokenEstimateRule ?? "含思考与工具过程估算")}
          </small>
        </article>
        <article className="metric">
          <span>标签</span>
          <strong>{formatCount(tagCount)}</strong>
          <small>跨项目复用的细粒度主题</small>
        </article>
        <article className="metric">
          <span>活跃设备</span>
          <strong>{formatCount(counts.devices)}</strong>
          <small>当前未撤销的采集端</small>
        </article>
      </section>
      <section className="panel">
        <div className="section-title-row">
          <div>
            <h2>需要处理</h2>
            <p className="panel-subtitle">归档完整性、失败恢复和设备在线状态优先于规模指标。</p>
          </div>
          <strong>{formatCount(reliabilityState.data?.needsAttention ?? 0)} 项</strong>
        </div>
        {reliabilityState.loading ? <Loading label="检查归档可靠性…" /> : reliabilityState.error ? (
          <ErrorBanner message={reliabilityState.error} />
        ) : (
          <div className="metric-grid">
            {(reliabilityState.data?.items ?? []).map((item: UnknownRecord) => (
              <Link className="metric" key={item.key} to={item.href}>
                <span>{item.label}</span>
                <strong>{formatCount(item.count)}</strong>
                <small>{Number(item.count) > 0 ? "点击定位并处理" : "当前正常"}</small>
              </Link>
            ))}
          </div>
        )}
      </section>
      <section className="dashboard-main-grid">
        <article className="panel category-overview-panel">
          <div className="section-title-row">
            <div>
              <h2>最近活跃项目</h2>
              <p className="panel-subtitle">
                 {formatCount(categoryStats.length)} 个项目，近 7 日新增或更新 {formatCount(categoryTotals.growth7d)} 条会话
              </p>
            </div>
            <Link className="button-link secondary small" to="/projects">查看项目</Link>
          </div>
          {topCategories.length ? (
            <div className="category-dashboard-list">
              {topCategories.map((category: UnknownRecord) => {
                const conversationCount = toFiniteNumber(category.conversationCount);
                const growth7d = toFiniteNumber(category.growth7d);
                const width = Math.max(3, Math.round((conversationCount / maxCategoryCount) * 100));
                return (
                  <div className="category-dashboard-row" key={category.projectId}>
                    <div className="category-dashboard-main">
                      <strong>{category.projectName}</strong>
                      <span>{category.description || "暂无描述"}</span>
                      <div className="category-share-bar">
                        <span style={{ width: `${width}%` }} />
                      </div>
                    </div>
                    <div className="category-dashboard-count">
                      <strong>{formatCount(conversationCount)}</strong>
                      <span>会话</span>
                    </div>
                    <div className={`category-dashboard-growth ${growth7d ? "" : "zero"}`}>
                      <strong>+{formatCount(growth7d)}</strong>
                      <span>近 7 日</span>
                    </div>
                    <span className="pill">{formatCount(category.tagCount)} 标签</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted">还没有项目数据，可在“项目”页运行一次整理。</p>
          )}
        </article>
        <article className="panel archive-value-panel">
          <h2>归档可复用状态</h2>
          <div className="archive-value-count-line">
            <strong>{formatCount(tagCount)}</strong>
            <span>当前标签</span>
          </div>
          <p>原始会话和 Revision 始终是事实来源。项目负责长期归属，标签负责细粒度交叉检索。</p>
          <p className="muted">需要继续工作时，可从项目时间线打开原文，或生成 PROJECT-CONTEXT.md 交给其他 AI。</p>
          <div className="button-group">
            <Link className="button-link secondary small" to="/projects">浏览项目</Link>
            <Link className="button-link secondary small" to="/tags">浏览标签</Link>
            <Link className="button-link secondary small" to="/conversations">搜索历史</Link>
          </div>
        </article>
      </section>
      <section className="two-column">
        <article className="panel">
          <div className="section-title-row">
            <div>
              <h2>近 24 小时采集</h2>
              <p className="panel-subtitle">按平台汇总，不重复展示具体 Session</p>
            </div>
            <Link className="button-link secondary small" to="/logs?scope=capture">
              采集日志
            </Link>
          </div>
          <div className="capture-health-summary">
            <span className="pill complete">完整 {captureStatus.complete ?? 0}</span>
            <span className="pill partial">不完整 {captureStatus.partial ?? 0}</span>
            <span className="pill failed">失败 {captureStatus.failed ?? 0}</span>
          </div>
          {captureProviders.length ? (
            <div className="capture-provider-list">
              {captureProviders.map((item: UnknownRecord) => (
                <div className="capture-provider-row" key={item.provider}>
                  <strong>
                    {providerLabels[item.provider as Provider] ?? item.provider}
                  </strong>
                  <div className="capture-provider-counts">
                    <span className="pill complete">完整 {item.complete ?? 0}</span>
                    <span className="pill partial">不完整 {item.partial ?? 0}</span>
                    <span className="pill failed">失败 {item.failed ?? 0}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">近 24 小时暂无采集记录</p>
          )}
        </article>
        <article className="panel">
          <h2>最近报告</h2>
          {data.recentReports.length ? (
            data.recentReports.map((report: UnknownRecord) => (
              <Link className="report-link" key={report.id} to={`/reports/${report.id}`}>
                <strong>{report.title}</strong>
                <span>{new Date(report.createdAt).toLocaleString()}</span>
              </Link>
            ))
          ) : (
            <p className="muted">尚未生成报告</p>
          )}
        </article>
      </section>
    </>
  );
}

const logScopeLabels: Record<string, string> = {
  analysis: "分析",
  capture: "采集",
  classification: "归类",
  device: "设备",
  import: "导入",
  system: "系统",
};

const logLevelLabels: Record<string, string> = {
  info: "信息",
  warning: "警告",
  error: "错误",
};

function Logs() {
  const [searchParams, setSearchParams] = useSearchParams();
  const scope = searchParams.get("scope") ?? "";
  const level = searchParams.get("level") ?? "";
  const provider = searchParams.get("provider") ?? "";
  const deviceId = searchParams.get("deviceId") ?? "";
  const status = searchParams.get("status") ?? "";
  const q = searchParams.get("q") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const range = searchParams.get("range") ?? "";
  const offset = Math.max(0, Number(searchParams.get("offset") ?? 0) || 0);
  const [draftQ, setDraftQ] = useState(q);
  const params = new URLSearchParams({
    limit: "120",
    ...(scope ? { scope } : {}),
    ...(level ? { level } : {}),
    ...(provider ? { provider } : {}),
    ...(deviceId ? { deviceId } : {}),
    ...(status ? { status } : {}),
    ...(q ? { q } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(range ? { range } : {}),
    ...(offset ? { offset: String(offset) } : {}),
  });
  const state = useLoad(
    () => api<PageEnvelope>(`/api/v1/logs?${params}`),
    [scope, level, provider, deviceId, status, q, from, to, range, offset],
  );
  const providerCountsState = useLoad(
    () => api<UnknownRecord[]>("/api/v1/conversations/provider-counts"),
    [],
  );
  const devicesState = useLoad(
    () => api<UnknownRecord[]>("/api/v1/devices"),
    [],
  );

  useEffect(() => {
    const timer = window.setInterval(() => state.reload(), 5000);
    return () => window.clearInterval(timer);
  }, [state.reload]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    updateQuery({ q: draftQ.trim() });
  }

  function updateQuery(next: Record<string, string | number>) {
    const merged = { scope, level, provider, deviceId, status, q, from, to, range, offset, ...next };
    const updated = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) updated.set(key, String(value));
    }
    setSearchParams(updated, { replace: true });
  }

  const items = state.data?.items ?? [];
  const providerCounts = providerCountsFromRows(providerCountsState.data);
  const providerTotal = Object.values(providerCounts).reduce(
    (sum, value) => sum + value,
    0,
  );
  return (
    <>
      <PageHeader title="日志" subtitle="采集、导入、归类、报告和设备事件" />
      <form className="toolbar" onSubmit={submitSearch}>
        <select
          value={scope}
          onChange={(event) => updateQuery({ scope: event.target.value })}
        >
          <option value="">全部范围</option>
          {Object.entries(logScopeLabels).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select
          value={deviceId}
          onChange={(event) => updateQuery({ deviceId: event.target.value })}
        >
          <option value="">全部设备</option>
          {(devicesState.data ?? []).map((device) => (
            <option key={device.id} value={device.id}>{device.name}</option>
          ))}
        </select>
        <select
          value={level}
          onChange={(event) => updateQuery({ level: event.target.value })}
        >
          <option value="">全部等级</option>
          {Object.entries(logLevelLabels).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select
          value={provider}
          onChange={(event) => updateQuery({ provider: event.target.value })}
        >
          <option value="">全部平台（{formatCount(providerTotal)}）</option>
          {Object.entries(providerLabels).map(([key]) => (
            <option key={key} value={key}>
              {providerLabelWithCount(key, providerCounts)}
            </option>
          ))}
        </select>
        <select
          value={status}
          onChange={(event) => updateQuery({ status: event.target.value })}
        >
          <option value="">全部状态</option>
          {[
            "queued",
            "running",
            "processing",
            "completed",
            "complete",
            "partial",
            "failed",
            "active",
            "revoked",
            "deleted",
          ].map((item) => (
            <option key={item} value={item}>{statusLabel(item)}</option>
          ))}
        </select>
        <input
          value={draftQ}
          onChange={(event) => setDraftQ(event.target.value)}
          placeholder="搜索日志…"
        />
        <select
          aria-label="日志时间范围"
          value={range}
          onChange={(event) => {
            updateQuery({ range: event.target.value, from: "", to: "", offset: 0 });
          }}
        >
          <option value="">不限时间</option>
          <option value="1h">最近 1 小时</option>
          <option value="24h">最近 24 小时</option>
          <option value="7d">最近 7 天</option>
          <option value="30d">最近 30 天</option>
        </select>
        <input aria-label="日志开始日期" type="date" value={from} onChange={(event) => updateQuery({ from: event.target.value, range: "", offset: 0 })} />
        <input aria-label="日志结束日期" type="date" value={to} onChange={(event) => updateQuery({ to: event.target.value, range: "", offset: 0 })} />
        <button className="secondary small" type="submit">搜索</button>
        <button
          className="secondary small"
          type="button"
          onClick={() => {
            state.reload();
            providerCountsState.reload();
          }}
        >
          刷新
        </button>
      </form>
      <section className="panel log-panel">
        {state.loading ? (
          <Loading label="加载日志中…" />
        ) : state.error ? (
          <ErrorBanner message={state.error} />
        ) : items.length ? (
          <div className="log-table">
            <div className="log-table-head">
              <span>时间</span>
              <span>范围</span>
              <span>等级</span>
              <span>平台</span>
              <span>设备来源</span>
              <span>状态</span>
              <span>对象</span>
              <span>消息</span>
            </div>
            {items.map((item) => {
              const metadata =
                item.metadata && typeof item.metadata === "object"
                  ? item.metadata
                  : null;
              const metadataProvider =
                metadata && typeof metadata.provider === "string"
                  ? metadata.provider
                  : metadata && typeof metadata.sourceProvider === "string"
                    ? metadata.sourceProvider
                    : metadata && typeof metadata.conversationProvider === "string"
                      ? metadata.conversationProvider
                      : "";
              const entityLabel = item.entityType
                ? `${item.entityType} ${shortValue(item.entityId)}`
                : shortValue(item.entityId);
              const deviceName = typeof item.device?.name === "string"
                ? item.device.name
                : metadata && typeof metadata.name === "string" && item.entityType === "device"
                  ? metadata.name
                  : item.scope === "capture"
                    ? "未知设备"
                    : "系统服务";
              const deviceKind = typeof item.device?.kind === "string"
                ? item.device.kind
                : metadata && typeof metadata.kind === "string"
                  ? metadata.kind
                  : "";
              return (
                <article className={`log-table-row ${item.level ?? "info"}`} key={item.id}>
                  <time>{formatTaskTime(item.createdAt)}</time>
                  <span>{logScopeLabels[String(item.scope)] ?? item.scope}</span>
                  <span className="log-level-cell">
                    {logLevelLabels[String(item.level)] ?? item.level}
                  </span>
                  <span className="log-provider-cell">
                    {metadataProvider
                      ? providerLabels[metadataProvider as Provider] ?? metadataProvider
                      : "-"}
                  </span>
                  <span className="log-device-cell" title={deviceName}>
                    <strong>{deviceName}</strong>
                    {deviceKind && <small>{deviceKind === "chrome_extension" ? "Chrome 扩展" : deviceKind === "openclaw_sync" ? "同步代理" : deviceKind}</small>}
                  </span>
                  <span>
                    {item.status ? (
                      <span className={`pill ${statusClass(item.status)}`}>
                        {statusLabel(item.status)}
                      </span>
                    ) : (
                      "-"
                    )}
                  </span>
                  <span className="log-entity-cell" title={item.entityId || entityLabel}>
                    {entityLabel}
                  </span>
                  <div className="log-message-cell">
                    <strong>{item.message}</strong>
                    {metadata && Object.keys(metadata).length > 0 && (
                      <details className="log-metadata">
                        <summary>元数据</summary>
                        <pre>{JSON.stringify(metadata, null, 2)}</pre>
                      </details>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <p className="muted">暂无日志</p>
        )}
        <Pagination
          loading={state.loading}
          pagination={state.data?.pagination}
          onOffsetChange={(nextOffset) => updateQuery({ offset: nextOffset })}
        />
      </section>
    </>
  );
}

function Conversations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [tagQuery, setTagQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchProjectId, setBatchProjectId] = useState("");
  const [batchTagId, setBatchTagId] = useState("");
  const [batchMessage, setBatchMessage] = useState("");
  const [selectedSavedSearchId, setSelectedSavedSearchId] = useState("");
  const tagSearchRef = useRef<HTMLInputElement>(null);
  const q = searchParams.get("q") ?? "";
  const provider = searchParams.get("provider") ?? "";
  const source = searchParams.get("source") ?? "";
  const completeness = searchParams.get("completeness") ?? "";
  const captureMode = searchParams.get("captureMode") ?? "";
  const projectId = searchParams.get("projectId") ?? "";
  const tagIds = searchParams.get("tagIds") ?? "";
  const selectedTagIds = tagIds.split(",").filter(Boolean);
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const limit = 100;
  const rawOffset = Number(searchParams.get("offset") ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const conversationQuery = {
    limit,
    offset,
    q,
    provider,
    source,
    completeness,
    captureMode,
    projectId,
    tagIds,
    from,
    to,
  };
  const conversationSearch = buildConversationListSearch(conversationQuery);
  const state = useLoad(
    () =>
      api<PageEnvelope>(
        `/api/v1/conversations?${conversationSearch}`,
      ),
    [conversationSearch],
  );
  const providerCountsState = useLoad(
    () => api<UnknownRecord[]>("/api/v1/conversations/provider-counts"),
    [conversationSearch],
  );
  const projectsState = useLoad(() => api<UnknownRecord[]>("/api/v1/projects/options"), []);
  const tagsState = useLoad(() => api<UnknownRecord[]>("/api/v1/tags"), []);
  const savedSearchesState = useLoad(() => api<UnknownRecord[]>("/api/v1/saved-searches"), []);

  useEffect(() => {
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible") return;
      state.reload();
      providerCountsState.reload();
    };
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => document.removeEventListener("visibilitychange", refreshWhenVisible);
  }, [state.reload, providerCountsState.reload]);

  function updateQuery(next: Record<string, string | number>) {
    const merged = {
      q,
      provider,
      source,
      completeness,
      captureMode,
      projectId,
      tagIds,
      from,
      to,
      offset,
      ...next,
    };
    const params = new URLSearchParams();
    if (merged.q) params.set("q", String(merged.q));
    if (merged.provider) params.set("provider", String(merged.provider));
    if (merged.source) params.set("source", String(merged.source));
    if (merged.completeness) params.set("completeness", String(merged.completeness));
    if (merged.captureMode) params.set("captureMode", String(merged.captureMode));
    if (merged.projectId) params.set("projectId", String(merged.projectId));
    if (merged.tagIds) params.set("tagIds", String(merged.tagIds));
    if (merged.from) params.set("from", String(merged.from));
    if (merged.to) params.set("to", String(merged.to));
    if (Number(merged.offset) > 0) params.set("offset", String(merged.offset));
    setSearchParams(params);
  }

  const conversations = state.data?.items ?? [];
  const providerCounts = providerCountsFromRows(providerCountsState.data);
  const providerTotal = Object.values(providerCounts).reduce(
    (sum, value) => sum + value,
    0,
  );
  const tags = tagsState.data ?? [];
  const matchingTags = filterConversationTags(tags, tagQuery);
  const displayedTags = [...matchingTags].sort(
    (left, right) =>
      Number(selectedTagIds.includes(String(right.id))) -
      Number(selectedTagIds.includes(String(left.id))),
  );
  const activeFilterCount = countActiveConversationListFilters(conversationQuery);

  function resetFilters() {
    setSearchParams(new URLSearchParams());
  }

  async function saveCurrentSearch() {
    const name = window.prompt("为当前搜索条件命名");
    if (!name?.trim()) return;
    const query = Object.fromEntries(
      [...searchParams.entries()].filter(([key]) => key !== "offset"),
    );
    try {
      await api("/api/v1/saved-searches", {
        method: "POST",
        ...jsonBody({ name, query }),
      });
      savedSearchesState.reload();
    } catch (reason) {
      setBatchMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function deleteSavedSearch() {
    if (!selectedSavedSearchId) return;
    const saved = savedSearchesState.data?.find((item) => item.id === selectedSavedSearchId);
    if (!window.confirm(`删除常用视图“${saved?.name ?? "未命名"}”？`)) return;
    try {
      await api(`/api/v1/saved-searches/${selectedSavedSearchId}`, { method: "DELETE" });
      setSelectedSavedSearchId("");
      savedSearchesState.reload();
    } catch (reason) {
      setBatchMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function batchProject() {
    if (!selectedIds.size) return;
    await api("/api/v1/conversations/batch/project", {
      method: "POST",
      ...jsonBody({ conversationIds: [...selectedIds], projectId: batchProjectId || null }),
    });
    setBatchMessage(`已更新 ${selectedIds.size} 个会话的项目`);
    state.reload();
  }

  async function batchTags(operation: "add" | "remove") {
    if (!selectedIds.size || !batchTagId) return;
    await api("/api/v1/conversations/batch/tags", {
      method: "POST",
      ...jsonBody({ conversationIds: [...selectedIds], tagIds: [batchTagId], operation }),
    });
    setBatchMessage(`已${operation === "add" ? "添加" : "移除"}标签`);
    state.reload();
  }

  async function batchExport(format: "csv" | "md" | "xlsx") {
    if (!selectedIds.size) return;
    const response = await fetch(`/api/v1/conversations/batch/export?format=${format}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationIds: [...selectedIds] }),
    });
    if (!response.ok) throw new Error("批量导出失败");
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `已选会话-${selectedIds.size}.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <PageHeader title="会话" subtitle="按 Session 自动去重的完整可见分支" />
      <section className="conversation-filter-panel" aria-label="会话筛选">
        <div className="conversation-filter-grid">
          <label className="conversation-filter-field conversation-filter-search">
            <span>关键词</span>
            <input
              key={q}
              aria-label="搜索全部会话"
              placeholder="搜索标题、内容或 Session…"
              defaultValue={q}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  updateQuery({ q: event.currentTarget.value.trim(), offset: 0 });
                }
              }}
            />
          </label>
          <label className="conversation-filter-field">
            <span>平台</span>
            <select
              value={provider}
              onChange={(event) => updateQuery({ provider: event.target.value, offset: 0 })}
            >
              <option value="">全部平台（{formatCount(providerTotal)}）</option>
              {Object.entries(providerLabels).map(([key]) => (
                <option key={key} value={key}>
                  {providerLabelWithCount(key, providerCounts)}
                </option>
              ))}
            </select>
          </label>
          <label className="conversation-filter-field">
            <span>来源</span>
            <select
              value={source}
              onChange={(event) => updateQuery({ source: event.target.value, offset: 0 })}
            >
              <option value="">全部来源</option>
              {Object.entries(sourceLabels).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
          </label>
          <label className="conversation-filter-field">
            <span>完整性</span>
            <select
              value={completeness}
              onChange={(event) => updateQuery({ completeness: event.target.value, offset: 0 })}
            >
              <option value="">全部状态</option>
              <option value="complete">完整</option>
              <option value="partial">不完整</option>
            </select>
          </label>
          <label className="conversation-filter-field">
            <span>采集方式</span>
            <select
              value={captureMode}
              onChange={(event) => updateQuery({ captureMode: event.target.value, offset: 0 })}
            >
              <option value="">全部方式</option>
              <option value="full">完整采集</option>
              <option value="append">增量采集</option>
              <option value="import">历史导入</option>
            </select>
          </label>
          <label className="conversation-filter-field conversation-filter-project">
            <span>项目</span>
            <select
              value={projectId}
              onChange={(event) => updateQuery({ projectId: event.target.value, offset: 0 })}
            >
              <option value="">全部项目</option>
              {(projectsState.data ?? []).filter(
                (project) => !project.archived || project.id === projectId,
              ).map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <div className="conversation-filter-field conversation-filter-tags">
            <span>标签</span>
            <details
              className="tag-filter-popover"
              onToggle={(event) => {
                if (event.currentTarget.open) {
                  requestAnimationFrame(() => tagSearchRef.current?.focus());
                } else {
                  setTagQuery("");
                }
              }}
            >
              <summary>
                {selectedTagIds.length ? `已选 ${selectedTagIds.length} 个标签` : "全部标签"}
              </summary>
              <div className="tag-filter-menu">
                <div className="tag-filter-search">
                  <input
                    ref={tagSearchRef}
                    aria-label="搜索标签"
                    type="search"
                    value={tagQuery}
                    placeholder="搜索标签名称…"
                    onChange={(event) => setTagQuery(event.target.value)}
                  />
                </div>
                <div className="tag-filter-menu-meta">
                  <span>
                    {tagQuery.trim()
                      ? `找到 ${matchingTags.length} 个标签`
                      : `共 ${tags.length} 个标签`}
                  </span>
                  {selectedTagIds.length > 0 && (
                    <button
                      type="button"
                      className="tag-filter-clear"
                      onClick={() => updateQuery({ tagIds: "", offset: 0 })}
                    >
                      清除已选（{selectedTagIds.length}）
                    </button>
                  )}
                </div>
                <div className="tag-filter-options">
                  {displayedTags.length ? displayedTags.map((tag) => {
                    const selected = selectedTagIds.includes(String(tag.id));
                    return (
                      <label className={selected ? "selected" : ""} key={tag.id}>
                        <input
                          className="tag-filter-native-check"
                          type="checkbox"
                          checked={selected}
                          onChange={() => {
                            const next = selected
                              ? selectedTagIds.filter((id) => id !== String(tag.id))
                              : [...selectedTagIds, String(tag.id)];
                            updateQuery({ tagIds: next.join(","), offset: 0 });
                          }}
                        />
                        <span className="tag-filter-check" aria-hidden="true">
                          {selected ? "✓" : ""}
                        </span>
                        <span className="tag-filter-name">{tag.name}</span>
                        <small>{formatCount(tag.conversationCount ?? 0)} 会话</small>
                      </label>
                    );
                  }) : (
                    <div className="tag-filter-empty">
                      <strong>没有匹配的标签</strong>
                      <span>换个关键词试试</span>
                    </div>
                  )}
                </div>
              </div>
            </details>
          </div>
        </div>
        <div className="conversation-filter-footer">
          <div className="conversation-date-filter" aria-label="会话更新时间范围">
            <span className="conversation-filter-label">更新时间</span>
            <label>
              <span>从</span>
              <input
                aria-label="更新时间起始日期"
                type="date"
                value={from}
                onChange={(event) => updateQuery({ from: event.target.value, offset: 0 })}
              />
            </label>
            <label>
              <span>至</span>
              <input
                aria-label="更新时间结束日期"
                type="date"
                value={to}
                onChange={(event) => updateQuery({ to: event.target.value, offset: 0 })}
              />
            </label>
          </div>
          <div className="conversation-filter-actions">
            <select
              aria-label="常用视图"
              value={selectedSavedSearchId}
              onChange={(event) => {
                setSelectedSavedSearchId(event.target.value);
                const saved = savedSearchesState.data?.find((item) => item.id === event.target.value);
                if (saved?.query) setSearchParams(new URLSearchParams(saved.query));
              }}
            >
              <option value="">常用视图</option>
              {(savedSearchesState.data ?? []).map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}
            </select>
            <button className="secondary small" type="button" onClick={() => void saveCurrentSearch()}>保存当前搜索</button>
            <button className="ghost small" disabled={!selectedSavedSearchId} type="button" onClick={() => void deleteSavedSearch()}>删除视图</button>
            <span className="conversation-filter-summary">
              {activeFilterCount ? `已启用 ${activeFilterCount} 项筛选` : "当前显示全部会话"}
            </span>
            <button
              type="button"
              className="secondary small conversation-filter-reset"
              disabled={!activeFilterCount}
              onClick={resetFilters}
            >
              重置筛选
            </button>
            <Pagination
              loading={state.loading}
              pagination={state.data?.pagination}
              onOffsetChange={(nextOffset) => updateQuery({ offset: nextOffset })}
            />
          </div>
        </div>
      </section>
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorBanner message={state.error} />
      ) : conversations.length ? (
        <section className="panel conversation-list-panel">
          <div className="toolbar">
            <strong>{selectedIds.size} 个会话已选中</strong>
            <button className="secondary small" onClick={() => setSelectedIds(new Set(conversations.map((item) => String(item.id))))}>选择本页</button>
            <button className="ghost small" onClick={() => setSelectedIds(new Set())}>清空</button>
            <select value={batchProjectId} onChange={(event) => setBatchProjectId(event.target.value)}>
              <option value="">待归类</option>
              {(projectsState.data ?? []).filter((project) => !project.archived).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <button className="secondary small" disabled={!selectedIds.size} onClick={() => void batchProject().catch((reason) => setBatchMessage(String(reason)))}>设置项目</button>
            <select value={batchTagId} onChange={(event) => setBatchTagId(event.target.value)}>
              <option value="">选择标签</option>
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
            <button className="secondary small" disabled={!selectedIds.size || !batchTagId} onClick={() => void batchTags("add").catch((reason) => setBatchMessage(String(reason)))}>添加标签</button>
            <button className="ghost small" disabled={!selectedIds.size || !batchTagId} onClick={() => void batchTags("remove").catch((reason) => setBatchMessage(String(reason)))}>移除标签</button>
            {(["csv", "md", "xlsx"] as const).map((format) => <button className="ghost small" key={format} disabled={!selectedIds.size} onClick={() => void batchExport(format).catch((reason) => setBatchMessage(String(reason)))}>导出 {format.toUpperCase()}</button>)}
          </div>
          <ErrorBanner message={batchMessage} />
          <div className="conversation-list-header">
            <span>会话</span>
            <span>项目与标签</span>
            <span>采集</span>
            <span>状态</span>
            <span>更新时间</span>
          </div>
          <div className="conversation-compact-list">
            {conversations.map((conversation) => {
              const confidence =
                typeof conversation.projectConfidence === "number"
                  ? `${Math.round(conversation.projectConfidence * 100)}%`
                  : "";
              const classification = conversation.projectName
                ? `${conversation.projectName}${
                    conversation.projectLocked
                      ? " · 人工"
                      : confidence
                        ? ` · AI ${confidence}`
                        : " · AI"
                  }`
                : conversation.suggestedProjectName
                  ? `建议：${conversation.suggestedProjectName}${
                      confidence ? ` · ${confidence}` : ""
                    }`
                  : "待归类";
              const revision = conversation.latestRevision;
              const searchHit = conversation.searchHit;
              const completeness =
                ({ complete: "完整", partial: "不完整", failed: "失败" } as Record<
                  string,
                  string
                >)[revision?.completeness] ?? "无版本";
              return (
                <Link
                  to={`/conversations/${conversation.id}${
                    searchHit?.revisionId ? `?revisionId=${searchHit.revisionId}` : ""
                  }${typeof searchHit?.messageOrdinal === "number" ? `#message-${searchHit.messageOrdinal}` : ""}`}
                  className="conversation-compact-row"
                  key={conversation.id}
                >
                  <div className="conversation-compact-main">
                    <input
                      aria-label={`选择 ${conversation.title || conversation.externalSessionId}`}
                      checked={selectedIds.has(String(conversation.id))}
                      onChange={() => toggleSelected(String(conversation.id))}
                      onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}
                      type="checkbox"
                    />
                    <span className="provider-badge">
                      {providerLabels[conversation.provider as Provider]}
                    </span>
                    <div>
                      <strong>{conversation.title || conversation.externalSessionId}</strong>
                      <code>{conversation.externalSessionId}</code>
                      {searchHit?.excerpt && <span className="search-hit"><b>{searchHit.reason}：</b>{searchHit.excerpt}</span>}
                      {Array.isArray(conversation.tags) && conversation.tags.length > 0 && (
                        <span className="conversation-tag-line">
                          {conversation.tags.map((tag: UnknownRecord) => tag.name).join(" · ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <span className="conversation-project-label">{classification}</span>
                  <div className="conversation-capture-cell">
                    <span>{captureModeLabels[String(revision?.captureMode)] ?? "未记录"}</span>
                    <small>{triggerReasonLabels[String(revision?.triggerReason)] ?? "自动采集"}</small>
                    <small>{sourceDeviceLabel(revision)}</small>
                  </div>
                  <div className="conversation-status-cell">
                    <span className={`pill ${revision?.completeness}`}>
                      {completeness}
                    </span>
                    <span>{revision?.messageCount ?? 0} 条</span>
                  </div>
                  <time>{new Date(conversation.updatedAt).toLocaleString()}</time>
                </Link>
              );
            })}
          </div>
        </section>
      ) : (
        <p className="empty-state">没有匹配的会话</p>
      )}
    </>
  );
}

function speakerLabel(message: UnknownRecord): string {
  switch (message.role) {
    case "user":
      return "你";
    case "assistant":
      return typeof message.model === "string" && message.model.trim()
        ? message.model
        : "AI";
    case "tool":
      return "工具";
    case "system":
      return "系统";
    default:
      return "消息";
  }
}

function segmentLabel(type: unknown): string {
  const labels: Record<string, string> = {
    reasoning: "思考摘要",
    tool_status: "工具过程",
    code: "代码",
    citation: "引用",
  };
  return labels[String(type)] ?? String(type);
}

function messageTime(value: unknown): string {
  if (typeof value !== "string") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

function ExportLinks({ path }: { path: string }) {
  return <div className="export-links" aria-label="导出对话记录">
    <span>导出</span>
    <a className="button-link secondary small" href={`${path}?format=csv`}>CSV</a>
    <a className="button-link secondary small" href={`${path}?format=md`}>Markdown</a>
    <a className="button-link secondary small" href={`${path}?format=xlsx`}>XLSX</a>
  </div>;
}

function cleanSegmentContent(segment: UnknownRecord): string {
  return stripInternalConversationMetadata(String(segment.content ?? ""));
}

function safeExternalHref(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function renderSegment(segment: UnknownRecord, key: string) {
  const content = cleanSegmentContent(segment);
  if (!content) return null;
  const href = safeExternalHref(segment.href);
  return <div key={key} className={`segment ${segment.type}`}>
    {segment.type !== "text" && <small className="segment-label">{segmentLabel(segment.type)}</small>}
    {segment.type === "code" ? <pre><code>{content}</code></pre> : href ? <a href={href} target="_blank" rel="noopener noreferrer">{content}</a> : <p>{content}</p>}
  </div>;
}

function ConversationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const revisionId = searchParams.get("revisionId") ?? "";
  const state = useLoad(() => api<UnknownRecord>(`/api/v1/conversations/${id}${revisionId ? `?revisionId=${revisionId}` : ""}`), [id, revisionId]);
  const projectsState = useLoad(() => api<UnknownRecord[]>("/api/v1/projects/options"), []);
  const [actionError, setActionError] = useState("");
  const [revisionDiff, setRevisionDiff] = useState<UnknownRecord | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    if (!state.loading && window.location.hash) {
      const match = window.location.hash.match(/^#message-(\d+)$/);
      if (match?.[1]) {
        requestAnimationFrame(() =>
          document.getElementById(`message-${match[1]}`)?.scrollIntoView({ block: "center" }),
        );
      }
    }
  }, [state.loading, state.data]);

  async function assignProject(projectId: string): Promise<void> {
    setActionError("");
    try {
      await api(`/api/v1/conversations/${id}/project`, {
        method: "PUT",
        ...jsonBody({ projectId: projectId || null, mode: "lock" }),
      });
      state.reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function releaseProjectLock(): Promise<void> {
    setActionError("");
    try {
      await api(`/api/v1/conversations/${id}/project`, {
        method: "PUT",
        ...jsonBody({
          projectId: data.projectAssignment?.projectId ?? null,
          mode: "auto",
        }),
      });
      state.reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function addConversationTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setActionError("");
    try {
      await api(`/api/v1/conversations/${id}/tags`, {
        method: "POST",
        ...jsonBody({ name: form.get("name"), lockedByUser: true }),
      });
      formElement.reset();
      state.reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function toggleConversationTag(tag: UnknownRecord) {
    setActionError("");
    try {
      await api(`/api/v1/conversations/${id}/tags/${tag.id}`, {
        method: "PATCH",
        ...jsonBody({ lockedByUser: !tag.lockedByUser }),
      });
      state.reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function removeConversationTag(tag: UnknownRecord) {
    setActionError("");
    try {
      await api(`/api/v1/conversations/${id}/tags/${tag.id}`, { method: "DELETE" });
      state.reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function removeConversation(): Promise<void> {
    if (!window.confirm("确认将这个会话移入回收站？30 天内可以恢复。")) return;
    await api(`/api/v1/conversations/${id}`, { method: "DELETE" });
    navigate("/conversations");
  }

  async function compareRevision(): Promise<void> {
    const selectedId = state.data?.selectedRevision?.id;
    if (!selectedId) return;
    setDiffLoading(true);
    setActionError("");
    try {
      setRevisionDiff(await api(`/api/v1/conversations/${id}/revisions/${selectedId}/diff`));
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setDiffLoading(false);
    }
  }

  if (state.loading) return <Loading />;
  if (state.error) return <ErrorBanner message={state.error} />;
  const data = state.data!;
  const selectedRevision = data.selectedRevision as UnknownRecord | null;
  const displayMessages = (data.messages as UnknownRecord[]).flatMap((message) => {
    const segments = Array.isArray(message.segments) ? message.segments as UnknownRecord[] : [];
    const processSegments = segments.filter((segment) => segment.type === "tool_status" || segment.type === "reasoning");
    const contentSegments = segments.filter((segment) => segment.type !== "tool_status" && segment.type !== "reasoning" && cleanSegmentContent(segment));
    const isCodexInternal = data.conversation.provider === "codex" && (message.role === "tool" || message.role === "system");
    if (!contentSegments.length && !processSegments.length) return [];
    return [{ ...message, contentSegments, processSegments, isCodexInternal }];
  });
  const canonicalUrl = safeExternalHref(data.conversation.canonicalUrl);
  return <><PageHeader title={data.conversation.title || "未命名会话"} subtitle={`${providerLabels[data.conversation.provider as Provider]} · ${data.conversation.externalSessionId}`} actions={<div className="button-group"><ExportLinks path={`/api/v1/conversations/${id}/export`} />{canonicalUrl && <a className="button-link" href={canonicalUrl} target="_blank" rel="noopener noreferrer">打开原会话</a>}<button className="danger" onClick={() => void removeConversation()}>移入回收站</button></div>} />
    <ErrorBanner message={actionError} />
    <div className="toolbar"><label>版本 <select value={selectedRevision?.id ?? ""} onChange={(event) => { setRevisionDiff(null); setSearchParams(event.target.value ? { revisionId: event.target.value } : {}); }}>{data.revisions.map((revision: UnknownRecord) => <option key={revision.id} value={revision.id}>{new Date(revision.capturedAt).toLocaleString()} · {captureModeLabels[String(revision.captureMode)] ?? revision.captureMode} · {revision.completeness} · {revision.messageCount} 条</option>)}</select></label><button className="secondary small" disabled={!selectedRevision || diffLoading} onClick={() => void compareRevision()}>{diffLoading ? "比较中" : "与上一版本比较"}</button><label>项目（选择后人工锁定） <select disabled={projectsState.loading} value={data.projectAssignment?.projectId ?? ""} onChange={(event) => void assignProject(event.target.value)}><option value="">待归类</option>{projectsState.data?.filter((project) => !project.archived || project.id === data.projectAssignment?.projectId).map((project) => <option key={project.id} value={project.id}>{project.name}{project.archived ? "（已归档）" : ""}</option>)}</select></label>{data.projectAssignment?.lockedByUser ? <><span className="pill complete">人工锁定</span><button className="secondary small" onClick={() => void releaseProjectLock()}>交还 AI 调整</button></> : <span className="pill">AI 可动态调整</span>}</div>
    {revisionDiff && <section className="panel">
      <div className="section-title-row"><div><h2>Revision Diff</h2><p className="panel-subtitle">与上一版本相比：新增 {revisionDiff.summary?.added ?? 0}，修改 {revisionDiff.summary?.modified ?? 0}，移除 {revisionDiff.summary?.removed ?? 0}</p></div><button className="ghost small" onClick={() => setRevisionDiff(null)}>关闭</button></div>
      {["added", "modified", "removed"].map((kind) => Array.isArray(revisionDiff[kind]) && revisionDiff[kind].length > 0 && <details key={kind} open={kind === "added"}><summary>{({added:"新增消息",modified:"修改消息",removed:"移除消息"} as UnknownRecord)[kind]} · {revisionDiff[kind].length}</summary><div className="stack">{revisionDiff[kind].map((change: UnknownRecord) => <article className="segment" key={change.key}><strong>#{change.ordinal} · {speakerLabel(change)}</strong>{change.before && <pre>{String(change.before).slice(0, 4000)}</pre>}<pre>{String(change.after ?? change.content ?? "").slice(0, 4000)}</pre></article>)}</div></details>)}
      {(revisionDiff.titleChanged || revisionDiff.canonicalUrlChanged) && <div className="stack">
        {revisionDiff.titleChanged && <article className="segment"><strong>标题变化</strong><pre>{String(revisionDiff.titleChanged.before ?? "（空）")} → {String(revisionDiff.titleChanged.after ?? "（空）")}</pre></article>}
        {revisionDiff.canonicalUrlChanged && <article className="segment"><strong>原会话地址变化</strong><pre>{String(revisionDiff.canonicalUrlChanged.before ?? "（空）")} → {String(revisionDiff.canonicalUrlChanged.after ?? "（空）")}</pre></article>}
      </div>}
      {revisionDiff.metadataUnavailable && <p className="muted">至少一个版本来自 V2.3 之前，历史标题或原会话地址当时未按 Revision 保存；消息 Diff 仍可完整比较。</p>}
    </section>}
    <section className="panel conversation-tags-panel">
      <div className="section-title-row">
        <div><h2>标签</h2><p className="panel-subtitle">人工标签默认锁定；自动整理不会覆盖人工或已锁定关联。</p></div>
        <form className="inline-form" onSubmit={addConversationTag}>
          <input name="name" placeholder="新增标签" required />
          <button>添加</button>
        </form>
      </div>
      <div className="conversation-tag-editor">
        {(data.tags ?? []).map((tag: UnknownRecord) => (
          <span className={`tag-editor-chip ${tag.lockedByUser ? "locked" : ""}`} key={tag.id}>
            <Link to={`/conversations?tagIds=${tag.id}`}>{tag.name}</Link>
            <small>{tag.source === "manual" ? "人工" : `AI ${typeof tag.confidence === "number" ? Math.round(tag.confidence * 100) + "%" : ""}`}</small>
            <button className="ghost small" onClick={() => void toggleConversationTag(tag)}>{tag.lockedByUser ? "交还 AI 管理" : "人工固定"}</button>
            <button className="ghost small" onClick={() => void removeConversationTag(tag)}>移除</button>
          </span>
        ))}
        {!data.tags?.length && <span className="muted">暂无标签</span>}
      </div>
    </section>
    {selectedRevision && <section className="revision-meta-grid">
      <div><span>采集模式</span><strong>{captureModeLabels[String(selectedRevision.captureMode)] ?? selectedRevision.captureMode}</strong></div>
      <div><span>触发原因</span><strong>{triggerReasonLabels[String(selectedRevision.triggerReason)] ?? "未记录"}</strong></div>
      <div><span>来源设备</span><strong>{sourceDeviceLabel(selectedRevision)}</strong></div>
      <div><span>适配器</span><strong>{selectedRevision.adapterVersion ?? "未知"}</strong></div>
      <div><span>完整性</span><strong>{statusLabel(selectedRevision.completeness)}</strong></div>
      <div><span>采集时间</span><strong>{formatTaskTime(selectedRevision.capturedAt)}</strong></div>
      {selectedRevision.completenessReason && <div className="wide"><span>原因说明</span><strong>{selectedRevision.completenessReason}</strong></div>}
    </section>}
    <section className="transcript">{displayMessages.map((message: UnknownRecord, index: number) => {
      const previous = index > 0 ? displayMessages[index - 1] as UnknownRecord : undefined;
      const sameSpeaker = Boolean(previous && previous.role === message.role);
      const timestamp = messageTime(message.sourceCreatedAt ?? message.createdAt);
      if (message.isCodexInternal) return <details className="tool-details hidden-process" key={message.id}>
        <summary><span>Codex 工具链信息已隐藏</span><small>消息 #{message.ordinal} · 点击查看</small></summary>
        <div className="message-segments">{[...message.contentSegments, ...message.processSegments].map((segment: UnknownRecord, segmentIndex: number) => renderSegment(segment, segment.id ?? `${message.id}-process-${segmentIndex}`))}</div>
      </details>;
      return <article id={`message-${message.ordinal}`} className={`message ${message.role} ${sameSpeaker ? "same-speaker" : "speaker-start"}`} key={message.id}>
        {!sameSpeaker && <header className="message-header"><span className="speaker-chip">{speakerLabel(message)}</span><span className="message-meta">#{message.ordinal}{timestamp ? ` · ${timestamp}` : ""}</span></header>}
        <div className="message-segments">{message.contentSegments.map((segment: UnknownRecord, segmentIndex: number) => renderSegment(segment, segment.id ?? `${message.id}-${segmentIndex}`))}</div>
        {message.processSegments.length > 0 && <details className="tool-details inline-process">
          <summary><span>过程信息已折叠</span><small>{message.processSegments.length} 段 · 点击查看</small></summary>
          <div className="message-segments">{message.processSegments.map((segment: UnknownRecord, segmentIndex: number) => renderSegment(segment, segment.id ?? `${message.id}-process-${segmentIndex}`))}</div>
        </details>}
      </article>;
    })}</section>
  </>;
}

function ProjectTimeline({ projectId }: { projectId: string }) {
  const [visible, setVisible] = useState(false);
  const [offset, setOffset] = useState(0);
  const state = useLoad(
    () => visible
      ? api<UnknownRecord>(`/api/v1/projects/${projectId}/timeline?limit=50&offset=${offset}`)
      : Promise.resolve(null as UnknownRecord | null),
    [visible, projectId, offset],
  );
  if (!visible) {
    return <button className="secondary small" onClick={() => setVisible(true)}>查看项目时间线</button>;
  }
  if (state.loading) return <Loading label="加载时间线中…" />;
  if (state.error) return <ErrorBanner message={state.error} />;
  const items = Array.isArray(state.data?.items) ? state.data.items : [];
  return (
    <div className="project-timeline">
      <div className="section-title-row">
        <strong>项目演进</strong>
        <button className="ghost small" onClick={() => setVisible(false)}>收起</button>
      </div>
      {items.length ? items.map((item: UnknownRecord) => (
        <Link className="timeline-item" key={item.revisionId} to={item.href}>
          <time>{new Date(item.capturedAt).toLocaleDateString()}</time>
          <div>
            <strong>{providerLabels[item.provider as Provider] ?? item.provider} · {item.title || "未命名会话"}</strong>
            <span>{Array.isArray(item.tags) ? item.tags.map((tag: UnknownRecord) => tag.name).join(" · ") : ""}</span>
          </div>
        </Link>
      )) : <p className="muted">这个项目还没有可展示的完整 Revision。</p>}
      <Pagination
        loading={state.loading}
        pagination={state.data?.pagination}
        onOffsetChange={setOffset}
      />
    </div>
  );
}

function Projects() {
  const overviewState = useLoad(() => api<UnknownRecord>("/api/v1/projects/overview"), []);
  const [projectOffset, setProjectOffset] = useState(0);
  const [unclassifiedOffset, setUnclassifiedOffset] = useState(0);
  const projectState = useLoad(
    () => api<PageEnvelope>(`/api/v1/projects?limit=40&offset=${projectOffset}`),
    [projectOffset],
  );
  const unclassifiedState = useLoad(
    () => api<PageEnvelope>(`/api/v1/unclassified?limit=40&offset=${unclassifiedOffset}`),
    [unclassifiedOffset],
  );
  const projectOptionsState = useLoad(
    () => api<UnknownRecord[]>("/api/v1/projects/options"),
    [],
  );
  const [error, setError] = useState("");
  const [classificationMessage, setClassificationMessage] = useState("");
  const [classificationTask, setClassificationTask] = useState<UnknownRecord | null>(null);
  const [classificationRunMode, setClassificationRunMode] = useState<"economy" | "full">("economy");
  const [mergeSourceId, setMergeSourceId] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeTargetName, setMergeTargetName] = useState("");
  const [mergeMessage, setMergeMessage] = useState("");
  const [projectDialog, setProjectDialog] = useState<"create" | "merge" | null>(null);
  const classificationActive = isActiveStatus(classificationTask?.status);
  const classificationClock = useTaskClock(classificationActive);
  const overview = overviewState.data ?? {};
  const projectGroups = projectState.data?.items ?? [];
  const projectOptions = projectOptionsState.data ?? [];
  const activeProjectGroups = projectGroups.filter((project) => !project.archived);
  const archivedProjectGroups = projectGroups.filter((project) => project.archived);
  const categorizedProjectGroups = activeProjectGroups.filter(
    (project) => Number(project.conversationCount ?? 0) > 0,
  );
  const emptyProjectGroups = activeProjectGroups.filter(
    (project) => Number(project.conversationCount ?? 0) <= 0,
  );
  const unclassified = unclassifiedState.data?.items ?? [];
  const totals = overview.totals ?? {};
  const totalProjectCount = Number(totals.projectCount ?? activeProjectGroups.length);
  const archivedProjectCount = Number(
    totals.archivedProjectCount ?? archivedProjectGroups.length,
  );
  const activeCategoryCount = Number(
    totals.activeProjectCount ?? categorizedProjectGroups.length,
  );
  const categorizedConversationCount = Number(
    totals.categorizedConversationCount ??
      projectGroups.reduce(
        (sum, project) => sum + Number(project.conversationCount ?? 0),
        0,
      ),
  );
  const unclassifiedConversationCount = Number(
    totals.unclassifiedConversationCount ?? unclassified.length,
  );
  const tagCount = Number(totals.tagCount ?? 0);
  const reloadProjectsData = useCallback(() => {
    overviewState.reload();
    projectState.reload();
    unclassifiedState.reload();
    projectOptionsState.reload();
  }, [overviewState.reload, projectState.reload, unclassifiedState.reload, projectOptionsState.reload]);

  useEffect(() => {
    let cancelled = false;
    void api<{ task: UnknownRecord | null }>("/api/v1/classification/tasks/latest")
      .then((payload) => {
        if (!cancelled && payload.task && isActiveStatus(payload.task.status)) {
          setClassificationTask(payload.task);
          setClassificationMessage(payload.task.message ?? "项目与标签整理正在运行");
        }
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!classificationTask?.id || !classificationActive) return;
    const timer = window.setInterval(() => {
      void api<UnknownRecord>(`/api/v1/classification/tasks/${classificationTask.id}`)
        .then((task) => {
          setClassificationTask(task);
          setClassificationMessage(task.message ?? statusLabel(task.status));
          if (!isActiveStatus(task.status)) {
            reloadProjectsData();
          }
        })
        .catch((reason) =>
          setClassificationMessage(
            reason instanceof Error ? reason.message : String(reason),
          ),
        );
    }, 2000);
    return () => window.clearInterval(timer);
  }, [
    classificationTask?.id,
    classificationActive,
    reloadProjectsData,
  ]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api("/api/v1/projects", {
        method: "POST",
        ...jsonBody({
          name: form.get("name"),
          description: form.get("description"),
        }),
      });
      formElement.reset();
      setProjectDialog(null);
      reloadProjectsData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function runClassification() {
    setClassificationMessage("正在加入项目与标签整理队列…");
    setClassificationTask(null);
    try {
      const payload = await api<{
        jobId: string | null;
        task: UnknownRecord;
        reused?: boolean;
      }>("/api/v1/classification/run", {
        method: "POST",
        ...jsonBody({
          mode: classificationRunMode,
          scope: classificationRunMode === "full" ? "all" : "incremental",
        }),
      });
      setClassificationTask(payload.task);
      setClassificationMessage(
        payload.reused
          ? "已有项目与标签整理任务正在运行，已切换到当前任务进度"
          : payload.task.message ?? "已加入队列，等待 Worker 接手",
      );
    } catch (reason) {
      setClassificationMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function mergeProjects(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const source = projectOptions.find((project) => project.id === mergeSourceId);
    const target = projectOptions.find((project) => project.id === mergeTargetId);
    const targetName = mergeTargetName.trim();
    if (!source || !target || source.id === target.id || !targetName) return;
    if (!window.confirm(`确认把项目“${source.name}”合并到“${target.name}”，并将合并后的项目命名为“${targetName}”？源项目将在迁移完成后删除，此操作不可撤销。`)) return;
    setError("");
    setMergeMessage("正在合并项目…");
    try {
      const result = await api<UnknownRecord>(`/api/v1/projects/${source.id}/merge`, {
        method: "POST",
        ...jsonBody({ targetProjectId: target.id, targetName }),
      });
      setMergeMessage(`合并完成：迁移 ${result.movedConversationCount ?? 0} 个会话和 ${result.movedReportCount ?? 0} 份关联报告。`);
      setMergeSourceId("");
      setMergeTargetId("");
      setMergeTargetName("");
      setProjectDialog(null);
      reloadProjectsData();
    } catch (reason) {
      setMergeMessage("");
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function editProject(project: UnknownRecord) {
    const name = window.prompt("项目名称", String(project.name ?? ""));
    if (!name?.trim()) return;
    const description = window.prompt("项目说明", String(project.description ?? ""));
    if (description === null) return;
    try {
      await api(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        ...jsonBody({ name: name.trim(), description: description.trim() }),
      });
      reloadProjectsData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function setProjectArchived(project: UnknownRecord, archived: boolean) {
    const action = archived ? "归档" : "恢复";
    if (!window.confirm(`确认${action}项目“${project.name}”？会话不会被删除。`)) return;
    try {
      await api(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        ...jsonBody({ archived }),
      });
      reloadProjectsData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function downloadProjectContext(project: UnknownRecord, ai = true) {
    setError("");
    async function download(useAi: boolean) {
      const response = await fetch(`/api/v1/projects/${project.id}/context`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ai: useAi }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? response.statusText);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "PROJECT-CONTEXT.md";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    }
    try {
      await download(ai);
    } catch (reason) {
      if (ai && window.confirm("智能总结生成失败，是否改为生成不使用 AI 的基础版本？")) {
        try {
          await download(false);
          return;
        } catch (fallbackReason) {
          setError(fallbackReason instanceof Error ? fallbackReason.message : String(fallbackReason));
          return;
        }
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function confidenceLabel(value: unknown): string {
    return typeof value === "number" ? `${Math.round(value * 100)}%` : "未评分";
  }

  const percent = taskPercent(classificationTask);
  const stats = taskStats(classificationTask);
  const classificationDeferredMessage = deferredAiTaskMessage(
    stats,
    classificationClock,
  );
  const visibleClassificationMessage =
    classificationDeferredMessage || classificationMessage;
  const failureSamples = taskFailureSamples(classificationTask);
  const candidateReasonEntries = taskCandidateReasonEntries(classificationTask);
  const classificationScopeLabel =
    classificationScopeLabels[String(stats.scope ?? "")] ?? "未记录";
  return (
    <>
      <PageHeader
        title="项目"
        subtitle="用一个主项目组织每段归档会话；跨项目主题请前往独立标签页。"
        actions={
          <div className="button-group">
            <select
              disabled={classificationActive}
              value={classificationRunMode}
              onChange={(event) =>
                setClassificationRunMode(
                  event.target.value === "full" ? "full" : "economy",
                )
              }
            >
              <option value="economy">增量整理</option>
              <option value="full">完整整理未锁定会话</option>
            </select>
            <button disabled={classificationActive} onClick={() => void runClassification()}>
              {classificationActive ? "整理中" : "整理项目与标签"}
            </button>
          </div>
        }
      />
      <ErrorBanner message={error || overviewState.error || projectState.error || unclassifiedState.error} />
      {mergeMessage && <div className="alert success">{mergeMessage}</div>}
      <section className={`panel project-status-panel${classificationTask ? " has-task" : ""}`}>
        <div className="project-status-summary">
          <strong>{classificationTask ? `项目与标签整理 · ${statusLabel(classificationTask.status)}` : "项目概况"}</strong>
          <span>
            {visibleClassificationMessage || (
              activeCategoryCount > 0
                ? `当前 ${activeCategoryCount} 个已启用项目，已归类 ${categorizedConversationCount} 个会话，待归类 ${unclassifiedConversationCount} 个。`
                : "当前还没有可展示的组织结果，先创建项目或运行一次整理。"
            )}
          </span>
          {classificationTask && <time>{formatTaskTime(classificationTask.updatedAt)}</time>}
        </div>
        {classificationTask && (
          <>
            <div className="project-status-progress">
              <div className="progress-bar">
                <span style={{ width: `${percent}%` }} />
              </div>
              <strong>{percent}%</strong>
            </div>
            <div className="project-status-details">
              <span>范围 {classificationScopeLabel}</span>
              <span>已处理 {classificationTask.processedCount ?? 0}/{classificationTask.totalCount ?? 0}</span>
              <span>已归类 {stats.classified ?? 0}</span>
              <span>标签关联 {stats.tagAssignments ?? 0}</span>
              <span>失败 {classificationTask.failedCount ?? 0}</span>
              {stats.stage && <span>阶段 {stageLabel(stats.stage)}</span>}
              {candidateReasonEntries.map((item) => (
                <span className="project-status-pill" key={item.key}>
                  {classificationCandidateReasonLabels[item.key] ?? item.key} {formatCount(item.count)}
                </span>
              ))}
            </div>
            {classificationTask.error && !classificationActive && !classificationDeferredMessage && (
              <p className="progress-error">{classificationTask.error}</p>
            )}
            {failureSamples.length > 0 && (
              <details className="failure-list compact-failure-list">
                <summary>查看 {failureSamples.length} 条失败样例</summary>
                {failureSamples.map((sample, index) => (
                  <p key={`${sample.conversationId ?? index}`}>
                    {sample.title || sample.conversationId || `样例 ${index + 1}`}：
                    {sample.error}
                  </p>
                ))}
              </details>
            )}
          </>
        )}
      </section>

      <section className="project-metrics">
        <article className="metric">
          <span>项目</span>
          <strong>{activeCategoryCount}</strong>
          <small>共 {totalProjectCount} 个项目{archivedProjectCount > 0 ? `，另 ${archivedProjectCount} 个已归档` : ""}</small>
        </article>
        <article className="metric">
          <span>已归类会话</span>
          <strong>{categorizedConversationCount}</strong>
          <small>按项目分组展示</small>
        </article>
        <article className="metric">
          <span>待归类会话</span>
          <strong>{unclassifiedConversationCount}</strong>
          <small>含仅有建议的会话</small>
        </article>
        <article className="metric">
          <span>标签</span>
          <strong>{tagCount}</strong>
          <small>可跨项目组合筛选</small>
        </article>
      </section>

      <section className="project-board">
        <div className="section-title-row">
          <div>
            <h2>项目</h2>
            <p className="panel-subtitle">展开项目可查看会话、标签分布、时间线与导出入口。</p>
          </div>
          <div className="project-board-actions">
            <span className="pill">{activeCategoryCount} 个活跃项目</span>
            <button
              className="secondary small"
              onClick={() => {
                setError("");
                setMergeMessage("");
                setMergeSourceId("");
                setMergeTargetId("");
                setMergeTargetName("");
                setProjectDialog("merge");
              }}
            >合并项目</button>
            <button
              className="small"
              onClick={() => {
                setError("");
                setProjectDialog("create");
              }}
            >新建项目</button>
          </div>
        </div>
        {projectState.loading ? (
          <Loading label="加载项目中…" />
        ) : activeProjectGroups.length ? (
          <div className="project-group-list">
            {categorizedProjectGroups.map((project, index) => {
              const conversations = Array.isArray(project.conversations)
                ? project.conversations
                : [];
              const conversationCount = Number(project.conversationCount ?? conversations.length);
              return (
                <details
                  className="project-group"
                  key={project.id}
                >
                  <summary>
                    <div className="project-group-title">
                      <strong>{project.name}</strong>
                      <p>{project.description || "暂无描述"}</p>
                    </div>
                    <div className="project-group-counts">
                      <span>{conversationCount} 会话</span>
                      <span>近 7 日 +{project.growth7d ?? 0}</span>
                      <span>近 30 日 +{project.growth30d ?? 0}</span>
                    </div>
                  </summary>
                  <div className="project-group-actions">
                    <ExportLinks path={`/api/v1/projects/${project.id}/export`} />
                    <button className="secondary small" onClick={() => void downloadProjectContext(project, true)}>智能上下文（推荐）</button>
                    <button className="ghost small" onClick={() => void downloadProjectContext(project, false)}>仅历史索引</button>
                    <button className="secondary small" onClick={() => void editProject(project)}>编辑</button>
                    <button className="danger small" onClick={() => void setProjectArchived(project, true)}>归档</button>
                  </div>
                  {Array.isArray(project.commonTags) && project.commonTags.length > 0 && (
                    <div className="project-common-tags">
                      {project.commonTags.map((tag: UnknownRecord) => (
                        <Link className="pill" key={tag.id} to={`/conversations?projectId=${project.id}&tagIds=${tag.id}`}>
                          {tag.name} · {tag.count}
                        </Link>
                      ))}
                    </div>
                  )}
                  {conversations.length ? (
                    <div className="project-conversation-list">
                      {conversations.map((conversation: UnknownRecord) => (
                        <Link
                          className="project-conversation-row"
                          key={conversation.id}
                          to={`/conversations/${conversation.id}`}
                        >
                          <div className="project-conversation-main">
                            <strong>{conversation.title || conversation.id}</strong>
                            <span>
                              {providerLabels[conversation.provider as Provider] ??
                                conversation.provider} · {formatTaskTime(conversation.updatedAt)}
                            </span>
                          </div>
                          <div className="project-conversation-tags">
                            {conversation.lockedByUser && (
                              <span className="pill complete">人工锁定</span>
                            )}
                            <span>{confidenceLabel(conversation.confidence)}</span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  ) : (
                    <p className="project-empty">{conversationCount > 0 ? "会话已改由下方时间线分页加载。" : "这个项目暂时还没有归入会话。"}</p>
                  )}
                  <ProjectTimeline projectId={String(project.id)} />
                </details>
              );
            })}
            {emptyProjectGroups.length > 0 && (
              <details className="project-group empty-project-group">
                <summary>
                  <div className="project-group-title">
                    <strong>空项目</strong>
                    <p>这些项目目前没有会话，可作为人工整理的候选。</p>
                  </div>
                  <div className="project-group-counts">
                    <span>{emptyProjectGroups.length} 个</span>
                  </div>
                </summary>
                <div className="empty-project-list">
                  {emptyProjectGroups.map((project) => (
                    <div className="empty-project-item" key={project.id}>
                      <span>{project.name}</span>
                      <div className="button-group">
                        <ExportLinks path={`/api/v1/projects/${project.id}/export`} />
                        <button className="secondary small" onClick={() => void editProject(project)}>编辑</button>
                        <button className="danger small" onClick={() => void setProjectArchived(project, true)}>归档</button>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        ) : (
          <Loading label="还没有项目。创建项目或运行整理后会在这里显示。" />
        )}
      </section>

      {archivedProjectGroups.length > 0 && (
        <section className="project-board">
          <div className="section-title-row">
            <div>
              <h2>已归档项目</h2>
              <p className="panel-subtitle">保留原有会话、标签、时间线和导出；恢复后可重新接收归类。</p>
            </div>
            <span className="pill">{archivedProjectCount} 个</span>
          </div>
          <div className="project-group-list">
            {archivedProjectGroups.map((project) => {
              const conversations = Array.isArray(project.conversations)
                ? project.conversations
                : [];
              return (
                <details className="project-group empty-project-group" key={project.id}>
                  <summary>
                    <div className="project-group-title">
                      <strong>{project.name}</strong>
                      <p>{project.description || "暂无描述"}</p>
                    </div>
                    <div className="project-group-counts">
                      <span>{project.conversationCount ?? conversations.length} 会话</span>
                      <span>已归档</span>
                    </div>
                  </summary>
                  <div className="project-group-actions">
                    <ExportLinks path={`/api/v1/projects/${project.id}/export`} />
                    <button className="secondary small" onClick={() => void downloadProjectContext(project, true)}>智能上下文（推荐）</button>
                    <button className="ghost small" onClick={() => void downloadProjectContext(project, false)}>仅历史索引</button>
                    <button className="secondary small" onClick={() => void editProject(project)}>编辑</button>
                    <button className="secondary small" onClick={() => void setProjectArchived(project, false)}>恢复项目</button>
                  </div>
                  {conversations.length > 0 && (
                    <div className="project-conversation-list">
                      {conversations.map((conversation: UnknownRecord) => (
                        <Link className="project-conversation-row" key={conversation.id} to={`/conversations/${conversation.id}`}>
                          <div className="project-conversation-main">
                            <strong>{conversation.title || conversation.id}</strong>
                            <span>{providerLabels[conversation.provider as Provider] ?? conversation.provider} · {formatTaskTime(conversation.updatedAt)}</span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                  <ProjectTimeline projectId={String(project.id)} />
                </details>
              );
            })}
          </div>
        </section>
      )}
      <Pagination loading={projectState.loading} pagination={projectState.data?.pagination} onOffsetChange={setProjectOffset} />

      <section className="project-board">
        <div className="section-title-row">
          <div>
            <h2>待归类</h2>
            <p className="panel-subtitle">这些会话还没有确认项目，可能只有 AI 建议名。</p>
          </div>
          <span className="pill partial">{unclassifiedConversationCount} 条</span>
        </div>
        {unclassifiedState.loading ? (
          <Loading label="加载待归类会话中…" />
        ) : unclassified.length ? (
          <div className="project-conversation-list unclassified-list">
            {unclassified.map((item) => (
              <Link
                className="project-conversation-row"
                key={item.id}
                to={`/conversations/${item.id}`}
              >
                <div className="project-conversation-main">
                  <strong>{item.title || item.id}</strong>
                  <span>
                    {providerLabels[item.provider as Provider] ?? item.provider} ·
                    {item.suggestedName ? ` 建议：${item.suggestedName}` : " 等待分析"}
                  </span>
                </div>
                <div className="project-conversation-tags">
                  <span>{confidenceLabel(item.confidence)}</span>
                </div>
              </Link>
            ))}
          </div>
        ) : (
          <Loading label="当前没有待归类会话。" />
        )}
        <Pagination loading={unclassifiedState.loading} pagination={unclassifiedState.data?.pagination} onOffsetChange={setUnclassifiedOffset} />
      </section>

      {projectDialog === "create" && (
        <Modal
          description="新增后可重新运行整理，或在会话详情中人工锁定项目。"
          onClose={() => setProjectDialog(null)}
          title="新建项目"
        >
          <ErrorBanner message={error} />
          <form className="stack modal-form" onSubmit={createProject}>
            <label>项目名称<input name="name" autoFocus placeholder="例如：知识归档系统" required /></label>
            <label>项目描述（可选）<textarea name="description" placeholder="简要说明项目范围" rows={3} /></label>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setProjectDialog(null)} type="button">取消</button>
              <button type="submit">创建项目</button>
            </div>
          </form>
        </Modal>
      )}

      {projectDialog === "merge" && (
        <Modal
          description="源项目的会话和关联报告将迁移到目标项目，随后删除源项目。"
          onClose={() => setProjectDialog(null)}
          title="合并项目"
        >
          <ErrorBanner message={error} />
          <form className="stack modal-form" onSubmit={mergeProjects}>
            <label>A · 源项目
              <select value={mergeSourceId} onChange={(event) => setMergeSourceId(event.target.value)} required>
                <option value="">请选择要删除的源项目</option>
                {projectOptions.filter((project) => !project.archived).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <div className="modal-merge-arrow">↓ 会话和报告迁移至</div>
            <label>B · 目标项目
              <select
                value={mergeTargetId}
                onChange={(event) => {
                  const targetId = event.target.value;
                  setMergeTargetId(targetId);
                  const selectedProject = projectOptions.find((project) => project.id === targetId);
                  setMergeTargetName(String(selectedProject?.name ?? ""));
                }}
                required
              >
                <option value="">请选择保留的目标项目</option>
                {projectOptions.filter((project) => !project.archived && project.id !== mergeSourceId).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            <label>合并后项目名称
              <input
                disabled={!mergeTargetId}
                maxLength={200}
                onChange={(event) => setMergeTargetName(event.target.value)}
                placeholder="请先选择目标项目"
                required
                value={mergeTargetName}
              />
            </label>
            <p className="modal-warning">合并后无法撤销，请确认源项目与目标项目选择正确。</p>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setProjectDialog(null)} type="button">取消</button>
              <button className="danger" disabled={!mergeSourceId || !mergeTargetId || !mergeTargetName.trim() || mergeSourceId === mergeTargetId}>确认合并</button>
            </div>
          </form>
        </Modal>
      )}

    </>
  );
}

function tagCloudWeight(count: unknown, maximum: number): number {
  const value = Math.max(0, Number(count ?? 0));
  if (maximum <= 0) return 0;
  return Math.sqrt(value) / Math.sqrt(maximum);
}

function normalizedTagLabel(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function Tags() {
  const state = useLoad(() => api<UnknownRecord[]>("/api/v1/tags"), []);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [selectedTagId, setSelectedTagId] = useState("");
  const [mergeTargetTagId, setMergeTargetTagId] = useState("");
  const allTags = state.data ?? [];
  const normalizedQuery = normalizedTagLabel(query);
  const tags = allTags
    .filter((tag) =>
      normalizedTagLabel(tag.name).includes(normalizedQuery),
    )
    .sort(
      (left, right) =>
        Number(right.conversationCount ?? 0) - Number(left.conversationCount ?? 0) ||
        String(left.name ?? "").localeCompare(String(right.name ?? ""), "zh-CN"),
    );
  const selectedTag = tags.find((tag) => String(tag.id) === selectedTagId) ?? null;
  const mergeTargets = allTags.filter((tag) => String(tag.id) !== selectedTagId);
  const maximumConversationCount = Math.max(
    0,
    ...tags.map((tag) => Number(tag.conversationCount ?? 0)),
  );
  const usedTagCount = allTags.filter((tag) => Number(tag.conversationCount ?? 0) > 0).length;
  const totalAssignments = allTags.reduce(
    (sum, tag) => sum + Number(tag.conversationCount ?? 0),
    0,
  );

  useEffect(() => {
    if (!tags.length) {
      setSelectedTagId("");
      return;
    }
    if (!tags.some((tag) => String(tag.id) === selectedTagId)) {
      setSelectedTagId(String(tags[0]?.id ?? ""));
    }
  }, [query, state.data, selectedTagId]);

  useEffect(() => {
    if (!mergeTargets.some((tag) => String(tag.id) === mergeTargetTagId)) {
      setMergeTargetTagId(String(mergeTargets[0]?.id ?? ""));
    }
  }, [mergeTargetTagId, selectedTagId, state.data]);

  async function createTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const created = await api<UnknownRecord>("/api/v1/tags", {
        method: "POST",
        ...jsonBody({ name: form.get("name") }),
      });
      formElement.reset();
      setSelectedTagId(String(created.id ?? ""));
      state.reload();
      setMessage("标签已创建");
      setMessageTone("success");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    }
  }

  async function renameTag(tag: UnknownRecord) {
    const name = window.prompt("新标签名称", String(tag.name ?? ""));
    if (!name?.trim()) return;
    try {
      await api(`/api/v1/tags/${tag.id}`, {
        method: "PATCH",
        ...jsonBody({ name: name.trim() }),
      });
      state.reload();
      setMessage("标签已重命名");
      setMessageTone("success");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    }
  }

  async function mergeTag(tag: UnknownRecord) {
    const target = allTags.find(
      (item) => String(item.id) === mergeTargetTagId,
    );
    if (!target || target.id === tag.id) {
      setMessage("没有找到可用的目标标签");
      setMessageTone("error");
      return;
    }
    try {
      await api(`/api/v1/tags/${tag.id}/merge`, {
        method: "POST",
        ...jsonBody({ targetTagId: target.id }),
      });
      setSelectedTagId(String(target.id));
      state.reload();
      setMessage(`已合并到 ${target.name}`);
      setMessageTone("success");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    }
  }

  async function deleteTag(tag: UnknownRecord) {
    if (!window.confirm(`删除标签“${tag.name}”？只会删除标签关联，不会删除会话。`)) return;
    try {
      await api(`/api/v1/tags/${tag.id}`, { method: "DELETE" });
      setSelectedTagId("");
      state.reload();
      setMessage("标签已删除，会话内容未受影响");
      setMessageTone("success");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    }
  }

  return (
    <>
      <PageHeader
        title="标签"
        subtitle="用词云看见高频主题，点击标签后可查看会话或集中管理。"
        actions={<span className="pill">{allTags.length} 个标签</span>}
      />
      <section className="tag-metrics">
        <article className="metric">
          <span>标签总数</span>
          <strong>{allTags.length}</strong>
          <small>当前标签库</small>
        </article>
        <article className="metric">
          <span>已使用标签</span>
          <strong>{usedTagCount}</strong>
          <small>{allTags.length - usedTagCount} 个尚未关联会话</small>
        </article>
        <article className="metric">
          <span>标签关联</span>
          <strong>{totalAssignments}</strong>
          <small>同一会话可关联多个标签</small>
        </article>
      </section>
      <section className="panel tag-workspace">
        <div className="tag-workspace-header">
          <div>
            <h2>主题词云</h2>
            <p className="panel-subtitle">字号按关联会话数计算；搜索结果会即时收拢。</p>
          </div>
          <form className="tag-create-form" onSubmit={createTag}>
            <input name="name" aria-label="新标签名称" placeholder="新标签" required />
            <button>创建</button>
          </form>
        </div>
        <div className="tag-search-row">
          <input
            aria-label="搜索标签"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标签…"
          />
          <span>{normalizedQuery ? `找到 ${tags.length} 个` : `展示全部 ${tags.length} 个`}</span>
        </div>
        {message && <div className={`alert ${messageTone}`}>{message}</div>}
        {state.loading ? <Loading label="加载标签中…" /> : state.error ? <ErrorBanner message={state.error} /> : tags.length ? (
          <div className="tag-cloud" aria-label="标签词云">
            {tags.map((tag) => {
              const count = Number(tag.conversationCount ?? 0);
              const weight = tagCloudWeight(count, maximumConversationCount);
              return (
                <button
                  className={`tag-cloud-item ${String(tag.id) === selectedTagId ? "selected" : ""}`}
                  key={tag.id}
                  style={{ fontSize: `${(0.86 + weight * 1.25).toFixed(2)}rem` }}
                  aria-pressed={String(tag.id) === selectedTagId}
                  aria-label={`${tag.name}，${count} 个会话`}
                  onClick={() => setSelectedTagId(String(tag.id))}
                >
                  <strong>{tag.name}</strong>
                  <small>{count}</small>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="tag-cloud-empty">
            <strong>{allTags.length ? "没有匹配的标签" : "还没有标签"}</strong>
            <span>{allTags.length ? "换个关键词试试。" : "可以在上方创建第一个标签。"}</span>
          </div>
        )}
      </section>
      {selectedTag && (
        <section className="panel tag-selection-panel">
          <div className="tag-selection-copy">
            <span>当前标签</span>
            <strong>{selectedTag.name}</strong>
            <small>{selectedTag.conversationCount ?? 0} 个关联会话</small>
          </div>
          <div className="button-group">
            <Link className="button-link" to={`/conversations?tagIds=${selectedTag.id}`}>查看相关会话</Link>
            <button className="secondary" onClick={() => void renameTag(selectedTag)}>重命名</button>
            <select
              aria-label="标签合并目标"
              value={mergeTargetTagId}
              onChange={(event) => setMergeTargetTagId(event.target.value)}
            >
              {mergeTargets.map((tag) => (
                <option key={tag.id} value={String(tag.id)}>{String(tag.name)}</option>
              ))}
            </select>
            <button className="secondary" disabled={!mergeTargetTagId} onClick={() => void mergeTag(selectedTag)}>合并到所选标签</button>
            <button className="danger" onClick={() => void deleteTag(selectedTag)}>删除</button>
          </div>
        </section>
      )}
      <p className="tag-safety-note">删除标签只会解除标签关联，不会删除任何会话。</p>
    </>
  );
}

function Reports() {
  const [offset, setOffset] = useState(0);
  const state = useLoad(
    () => api<PageEnvelope>(`/api/v1/reports?limit=50&offset=${offset}`),
    [offset],
  );
  const runsState = useLoad(
    () =>
      Promise.all([
        api<PageEnvelope>("/api/v1/analysis/runs?kind=weekly&limit=1"),
        api<PageEnvelope>("/api/v1/analysis/runs?kind=monthly&limit=1"),
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
    const timer = window.setInterval(() => {
      runsState.reload();
      state.reload();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [activeRunIds, runsState.reload, state.reload]);

  async function run(kind: "weekly"|"monthly") {
    setReportMessage(`${kind === "weekly" ? "周报" : "月报"}正在加入队列…`);
    try {
      const payload = await api<{ jobId: string | null; run: UnknownRecord }>("/api/v1/analysis/run", {method:"POST",...jsonBody({kind})});
      setReportMessage(`${kind === "weekly" ? "周报" : "月报"}${statusLabel(payload.run.status)}，下方会持续刷新运行状态`);
      runsState.reload();
    } catch (reason) {
      setReportMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function retryReportEmail(report: UnknownRecord) {
    setReportMessage(`正在重新发送“${report.title}”…`);
    try {
      await api(`/api/v1/reports/${report.id}/email/retry`, { method: "POST" });
      setReportMessage("邮件任务已进入队列，下方状态将随刷新更新。");
      state.reload();
    } catch (reason) {
      setReportMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  function runProgress(run: UnknownRecord): number {
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
                <span className={`pill ${report.emailStatus === "sent" ? "complete" : report.emailStatus === "failed" ? "failed" : "partial"}`}>邮件：{({sent:"已发送",queued:"等待发送",sending:"发送中",failed:"失败",not_configured:"未配置"} as UnknownRecord)[report.emailStatus] ?? report.emailStatus}</span>
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

function ReportDetail() {
  const { id } = useParams(); const state = useLoad(() => api<UnknownRecord>(`/api/v1/reports/${id}`), [id]); if (state.loading) return <Loading />; if (state.error) return <ErrorBanner message={state.error} />; const report=state.data!; return <><PageHeader title={report.title} subtitle={`${report.kind} · ${reportPeriodLabel(report.periodStart, report.periodEnd)}`} actions={<a className="button-link secondary" href={`/api/v1/reports/${id}/download`}>下载 Markdown</a>} /><article className="report-body"><p className="report-summary">{report.summary}</p><ReactMarkdown skipHtml components={{ a: ({ href, children }) => { const safeHref = safeExternalHref(href); return safeHref ? <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>; }, img: ({ alt }) => <span>{alt ?? "[图片已隐藏]"}</span> }}>{String(report.bodyMarkdown ?? "")}</ReactMarkdown></article></>;
}

function importJobPercent(job: UnknownRecord): number {
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

function importJobStats(job: UnknownRecord) {
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

function importJobText(job: UnknownRecord): string {
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

function importJobMetaText(job: UnknownRecord): string {
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

function Imports() {
  const [offset, setOffset] = useState(0);
  const state = useLoad(
    () => api<PageEnvelope>(`/api/v1/imports?limit=50&offset=${offset}`),
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
    const timer = window.setInterval(() => state.reload(), 2500);
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

  async function retryImport(job: UnknownRecord) {
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
      const result = await api<UnknownRecord>("/api/v1/imports/cleanup", {
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

function ActivityPage() {
  const [offset, setOffset] = useState(0);
  const state = useLoad(
    () => api<UnknownRecord>(`/api/v1/activity?limit=30&offset=${offset}`),
    [offset],
  );
  return <>
    <PageHeader title="活动" subtitle="后台任务、报告、导入和采集异常的统一时间线" actions={<button className="secondary small" onClick={() => state.reload()}>刷新</button>} />
    {state.loading ? <Loading /> : state.error ? <ErrorBanner message={state.error} /> : <section className="panel">
      <div className="metric-grid">
        <article className="metric"><span>运行中</span><strong>{state.data?.summary?.active ?? 0}</strong></article>
        <article className="metric"><span>失败</span><strong>{state.data?.summary?.failed ?? 0}</strong></article>
        <article className="metric"><span>警告</span><strong>{state.data?.summary?.warnings ?? 0}</strong></article>
      </div>
      <div className="run-list">
        {(state.data?.items ?? []).map((item: UnknownRecord) => <Link className="run-row" key={`${item.type}-${item.id}`} to={item.href || "/logs"}>
          <div><strong>{item.title}</strong><span>{item.message || formatTaskTime(item.updatedAt)}</span></div>
          <div className="run-progress"><div className="progress-bar"><span style={{width:`${Number(item.progress ?? 0)}%`}} /></div><small>{item.error || formatTaskTime(item.updatedAt)}</small></div>
          <span className={`pill ${statusClass(item.status)}`}>{statusLabel(item.status)}</span>
        </Link>)}
      </div>
      <Pagination loading={state.loading} pagination={state.data?.pagination} onOffsetChange={setOffset} />
    </section>}
  </>;
}

function Trash() {
  const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState("");
  const state = useLoad(
    () => api<UnknownRecord>(`/api/v1/conversations/trash?limit=50&offset=${offset}`),
    [offset],
  );
  async function restore(id: string) {
    await api(`/api/v1/conversations/${id}/restore`, { method: "POST" });
    setMessage("会话已恢复");
    state.reload();
  }
  async function remove(id: string) {
    const confirmation = window.prompt("永久删除不可恢复。请输入 DELETE 继续：");
    if (confirmation !== "DELETE") return;
    await api(`/api/v1/conversations/${id}/permanent`, { method: "DELETE", ...jsonBody({ confirmation }) });
    setMessage("会话已永久删除");
    state.reload();
  }
  return <>
    <PageHeader title="会话回收站" subtitle="删除后保留 30 天，可恢复；到期由 Worker 自动永久清理" />
    {message && <div className="alert success">{message}</div>}
    {state.loading ? <Loading /> : state.error ? <ErrorBanner message={state.error} /> : <section className="panel">
      <div className="run-list">{(state.data?.items ?? []).map((item: UnknownRecord) => <div className="run-row" key={item.id}>
        <div><strong>{item.title || item.externalSessionId}</strong><span>{providerLabels[item.provider as Provider] ?? item.provider} · 删除于 {new Date(item.deletedAt).toLocaleString()}</span></div>
        <div className="button-group"><button className="secondary small" onClick={() => void restore(item.id).catch((reason) => setMessage(String(reason)))}>恢复</button><button className="danger small" onClick={() => void remove(item.id).catch((reason) => setMessage(String(reason)))}>永久删除</button></div>
      </div>)}</div>
      {!state.data?.items?.length && <p className="muted">回收站为空</p>}
      <Pagination loading={state.loading} pagination={state.data?.pagination} onOffsetChange={setOffset} />
    </section>}
  </>;
}

function Devices() {
  const state = useLoad(() => api<UnknownRecord[]>("/api/v1/devices"), []);
  const componentsState = useLoad(() => api<UnknownRecord[]>("/api/v1/device-components"), []);
  const adaptersState = useLoad(() => api<UnknownRecord[]>("/api/v1/reliability/adapters"), []);
  const [code, setCode] = useState<UnknownRecord | null>(null);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState("");
  const [editingName, setEditingName] = useState("");

  async function createCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      setCode(await api("/api/v1/pairing-codes", { method: "POST", ...jsonBody({ name: form.get("name"), kind: form.get("kind") }) }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function saveDeviceName(id: string) {
    const name = editingName.trim();
    if (!name) return;
    setError("");
    try {
      await api(`/api/v1/devices/${id}`, { method: "PATCH", ...jsonBody({ name }) });
      setEditingId("");
      state.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function removeDevice(device: UnknownRecord) {
    const hardDelete = Boolean(device.revokedAt);
    if (hardDelete && !window.confirm("确认删除这个已撤销设备？历史归档记录会保留，但设备引用会清空。")) return;
    setError("");
    try {
      await api(`/api/v1/devices/${device.id}`, { method: "DELETE" });
      state.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  return <>
    <PageHeader title="设备" subtitle="下载采集组件、生成配对码并管理已配对设备"/>
    <ErrorBanner message={error || componentsState.error}/>
    <section className="panel component-download-panel">
      <div className="section-title-row">
        <div>
          <h2>下载上传组件</h2>
          <p className="panel-subtitle">下载后先解压，再在本页生成对应类型的配对码完成连接。</p>
        </div>
        <button className="secondary small" onClick={() => componentsState.reload()}>刷新</button>
      </div>
      {componentsState.loading ? <Loading label="检查服务器发布包…"/> : <div className="component-download-grid">
        {componentsState.data?.map((component) => <article className={`component-download-card ${component.available ? "" : "unavailable"}`} key={component.id}>
          <header>
            <div className="component-icon">{component.id === "windows" ? "WIN" : component.id === "macos" ? "MAC" : "CHR"}</div>
            <div><strong>{component.name}</strong><span>{component.platform}</span></div>
          </header>
          <p>{component.description}</p>
          <footer>
            <div>
              <span>{component.version || "服务器未提供安装包"}</span>
              {component.sizeBytes ? <small>{(Number(component.sizeBytes) / 1024 / 1024).toFixed(1)} MB · {component.archiveType}</small> : <small>请检查发布包目录配置</small>}
            </div>
            {component.available && component.downloadUrl
              ? <a className="button-link small" href={component.downloadUrl}>下载</a>
              : <button className="secondary small" disabled>暂不可用</button>}
          </footer>
        </article>)}
      </div>}
    </section>
    <section className="two-column">
      <article className="panel"><h2>生成配对码</h2><form className="stack compact" onSubmit={createCode}><label>设备名称<input name="name" required placeholder="公司 Chrome"/></label><label>类型<select name="kind"><option value="chrome_extension">Chrome 扩展</option><option value="openclaw_sync">OpenClaw/Codex 同步代理</option></select></label><button>生成</button></form>{code&&<div className="pair-code"><strong>{code.code}</strong><span>有效至 {new Date(code.expiresAt).toLocaleTimeString()}</span></div>}</article>
      <article className="panel"><h2>已配对设备</h2>{state.loading?<Loading/>:state.data?.map((device)=><div className="device-row" key={device.id}><div>{editingId===device.id?<div className="device-name-edit"><input value={editingName} onChange={(event)=>setEditingName(event.target.value)} onKeyDown={(event)=>{if(event.key==="Enter")void saveDeviceName(device.id); if(event.key==="Escape")setEditingId("");}} autoFocus/><button className="small" onClick={()=>void saveDeviceName(device.id)}>保存</button><button className="secondary small" onClick={()=>setEditingId("")}>取消</button></div>:<strong>{device.name}</strong>}<span>{device.kind} · {device.os || "系统未知"} · {device.clientVersion || "版本未知"}</span><small>跟踪 {device.trackedFiles ?? 0} · 跳过 {device.skippedFiles ?? 0}</small></div><div><span>{device.lastSeenAt?`心跳 ${formatTaskTime(device.lastSeenAt)}`:"尚未上线"}</span>{device.lastSuccessfulSyncAt&&<span>最近同步 {formatTaskTime(device.lastSuccessfulSyncAt)}</span>}{device.lastErrorCode&&<span className="pill failed">{device.lastErrorCode}</span>}{device.revokedAt?<span className="pill failed">已撤销</span>:null}<div className="button-group"><button className="secondary small" onClick={()=>{setEditingId(device.id);setEditingName(String(device.name??""));}}>重命名</button><button className="danger small" onClick={()=>void removeDevice(device)}>{device.revokedAt?"删除":"撤销"}</button></div></div></div>)}</article>
    </section>
    <section className="panel">
      <div className="section-title-row"><div><h2>采集适配器健康度</h2><p className="panel-subtitle">按平台和适配器版本观察最近 24 小时成功、部分和失败比例；连续失败或部分率过高会标记为退化。</p></div><button className="secondary small" onClick={() => adaptersState.reload()}>刷新</button></div>
      {adaptersState.loading ? <Loading label="正在汇总采集健康度…" /> : adaptersState.error ? <ErrorBanner message={adaptersState.error} /> : adaptersState.data?.length ? <div className="run-list">{adaptersState.data.map((adapter) => <div className="run-row" key={`${adapter.provider}-${adapter.adapterVersion}`}><div><strong>{providerLabels[adapter.provider as Provider] ?? adapter.provider} · {adapter.adapterVersion}</strong><span>最后采集 {formatTaskTime(adapter.lastCaptureAt)} · 平均 {Number(adapter.averageMessageCount24h ?? 0).toFixed(1)} 条消息</span></div><div className="run-progress"><div className="progress-bar"><span style={{width:`${Math.round(Number(adapter.rates24h?.success ?? 0)*100)}%`}} /></div><small>24h：成功 {Math.round(Number(adapter.rates24h?.success ?? 0)*100)}% · 部分 {Math.round(Number(adapter.rates24h?.partial ?? 0)*100)}% · 失败 {Math.round(Number(adapter.rates24h?.failed ?? 0)*100)}% · 连续失败 {adapter.consecutiveFailures ?? 0}</small></div><span className={`pill ${adapter.status === "healthy" ? "complete" : adapter.status === "degraded" ? "failed" : "partial"}`}>{adapter.status === "healthy" ? "健康" : adapter.status === "degraded" ? "退化" : "长时间无采集"}</span></div>)}</div> : <p className="muted">最近 30 天还没有采集运行记录。</p>}
    </section>
  </>;
}

const settingsSections = [
  { id: "account", label: "账号与安全", hint: "密码、TOTP 与登录会话", icon: "◎" },
  { id: "ai", label: "模型与额度", hint: "MiniMax、模型连接与 Token Plan", icon: "✦" },
  { id: "classification", label: "项目与标签", hint: "自动整理与稳定结果复用", icon: "◇" },
  { id: "email", label: "邮件与报告", hint: "SMTP、周报与月报", icon: "✉" },
  { id: "backup", label: "备份与恢复", hint: "业务数据导入与导出", icon: "▤" },
  { id: "redaction", label: "脱敏与安全", hint: "安全规则与历史脱敏", icon: "⊘" },
  { id: "system", label: "系统状态", hint: "项目资源与 PostgreSQL", icon: "⌁" },
] as const;

type SettingsSection = (typeof settingsSections)[number]["id"];

function AccountSecurity() {
  const sessionsState = useLoad(
    () => api<{items: UnknownRecord[]}>("/api/v1/auth/sessions"),
    [],
  );
  const [message, setMessage] = useState("");
  const [totpResult, setTotpResult] = useState<UnknownRecord | null>(null);

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    if (form.get("newPassword") !== form.get("confirmPassword")) {
      setMessage("两次输入的新密码不一致");
      return;
    }
    try {
      await api("/api/v1/auth/password", {
        method: "POST",
        ...jsonBody({
          currentPassword: form.get("currentPassword"),
          totpCode: form.get("totpCode"),
          newPassword: form.get("newPassword"),
        }),
      });
      formElement.reset();
      setMessage("密码已修改");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function resetTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm("将生成一份待确认的新密钥；确认新验证码前，旧验证器仍然有效。继续？")) return;
    const form = new FormData(event.currentTarget);
    try {
      const result = await api<UnknownRecord>("/api/v1/auth/totp/reset", {
        method: "POST",
        ...jsonBody({ currentPassword: form.get("currentPassword"), totpCode: form.get("totpCode") }),
      });
      setTotpResult(result);
      setMessage("新密钥已生成。请先加入验证器，再输入新验证码完成切换；在此之前旧验证器继续有效。");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function confirmTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      await api("/api/v1/auth/totp/confirm", {
        method: "POST",
        ...jsonBody({ totpCode: form.get("totpCode") }),
      });
      setTotpResult(null);
      setMessage("新 TOTP 已确认并启用，旧验证器代码现已失效。");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function cancelTotp() {
    try {
      await api("/api/v1/auth/totp/pending", { method: "DELETE" });
      setTotpResult(null);
      setMessage("待确认的新 TOTP 已取消，旧验证器保持有效。");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function revokeSession(id: string) {
    await api(`/api/v1/auth/sessions/${id}`, { method: "DELETE" });
    sessionsState.reload();
  }

  return <div className="stack">
    {message && <div className="alert success">{message}</div>}
    <section className="panel"><h2>修改密码</h2><form className="form-grid" onSubmit={changePassword}><label>当前密码<input name="currentPassword" type="password" required /></label><label>当前六位验证码<input name="totpCode" inputMode="numeric" pattern="[0-9]{6}" required /></label><label>新密码<input name="newPassword" type="password" minLength={12} required /></label><label>确认新密码<input name="confirmPassword" type="password" minLength={12} required /></label><button>修改密码</button></form></section>
    <section className="panel"><h2>重新绑定 TOTP</h2><p className="panel-subtitle">采用二阶段切换：只有新验证器验证码确认成功后，旧密钥才会失效。</p><form className="form-grid" onSubmit={resetTotp}><label>当前密码<input name="currentPassword" type="password" required /></label><label>当前六位验证码<input name="totpCode" inputMode="numeric" pattern="[0-9]{6}" required /></label><button className="secondary">生成待确认密钥</button></form>{totpResult && <div className="stack"><div className="pair-code"><strong>{totpResult.secret}</strong><span>有效至 {formatTaskTime(totpResult.expiresAt)}</span><details><summary>OTP URI</summary><code className="breakable">{totpResult.otpauthUrl}</code></details></div><form className="inline-form" onSubmit={confirmTotp}><input name="totpCode" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="输入新验证器验证码" required /><button>确认并切换</button><button type="button" className="secondary" onClick={() => void cancelTotp()}>取消切换</button></form></div>}</section>
    <section className="panel"><div className="section-title-row"><div><h2>登录会话</h2><p className="panel-subtitle">可远程注销其他浏览器。</p></div><button className="danger small" onClick={() => void api<UnknownRecord>("/api/v1/auth/sessions/revoke-others", {method:"POST"}).then(() => sessionsState.reload())}>注销其他会话</button></div>{sessionsState.loading ? <Loading /> : (sessionsState.data?.items ?? []).map((session) => <div className="device-row" key={session.id}><div><strong>{session.current ? "当前会话" : "其他浏览器会话"}</strong><span>登录于 {new Date(session.createdAt).toLocaleString()} · 到期 {new Date(session.expiresAt).toLocaleString()}</span></div>{!session.current && <button className="danger small" onClick={() => void revokeSession(session.id)}>注销</button>}</div>)}</section>
  </div>;
}

function formatBytes(value: unknown): string {
  const bytes = Math.max(0, Number(value ?? 0));
  if (bytes < 1024) return `${bytes.toFixed(0)} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  let amount = bytes;
  let unit = -1;
  do {
    amount /= 1024;
    unit += 1;
  } while (amount >= 1024 && unit < units.length - 1);
  return `${amount >= 100 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function formatDuration(value: unknown): string {
  let seconds = Math.max(0, Math.floor(Number(value ?? 0)));
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  return [days ? `${days}天` : "", hours ? `${hours}小时` : "", `${minutes}分钟`]
    .filter(Boolean)
    .join(" ");
}

function ResourceGauge({
  label,
  percent,
  detail,
}: {
  label: string;
  percent: number;
  detail: string;
}) {
  const normalized = Math.min(100, Math.max(0, Number(percent || 0)));
  const tone = normalized >= 95 ? "critical" : normalized >= 85 ? "warning" : "normal";
  return (
    <article className={`resource-gauge ${tone}`}>
      <div><strong>{label}</strong><b>{normalized.toFixed(1)}%</b></div>
      <div className="resource-gauge-track"><span style={{ width: `${normalized}%` }} /></div>
      <small>{detail}</small>
    </article>
  );
}

function SystemStatus() {
  const state = useLoad(() => api<UnknownRecord>("/api/v1/system/status"), []);
  const integrityState = useLoad(() => api<UnknownRecord>("/api/v1/reliability/integrity"), []);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const integrityActive = isActiveStatus(integrityState.data?.task?.status);
  useEffect(() => {
    const timer = window.setInterval(() => state.reload(), 10_000);
    return () => window.clearInterval(timer);
  }, [state.reload]);
  useEffect(() => {
    if (!integrityActive) return;
    const timer = window.setInterval(() => integrityState.reload(), 2500);
    return () => window.clearInterval(timer);
  }, [integrityActive, integrityState.reload]);

  async function runIntegrity() {
    setMaintenanceBusy(true);
    setMaintenanceMessage("归档完整性检查正在加入队列…");
    try {
      await api("/api/v1/reliability/integrity/run", { method: "POST" });
      integrityState.reload();
      setMaintenanceMessage("已开始检查 Revision 链、哈希、消息与检索分块。");
    } catch (reason) {
      setMaintenanceMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMaintenanceBusy(false);
    }
  }

  async function rebuildSearch() {
    if (!window.confirm("将根据当前归档重新生成全文检索分块。归档事实数据不会改变，确认继续？")) return;
    setMaintenanceBusy(true);
    setMaintenanceMessage("正在重建全文检索分块…");
    try {
      const result = await api<UnknownRecord>("/api/v1/search/rebuild", { method: "POST" });
      setMaintenanceMessage(`全文检索重建完成，共生成 ${result.chunkCount ?? 0} 个分块。`);
    } catch (reason) {
      setMaintenanceMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMaintenanceBusy(false);
    }
  }

  if (state.loading && !state.data) return <Loading label="正在读取主机运行状态…" />;
  const data = state.data;
  const host = data?.host;
  const database = data?.database;
  const projectStorage = data?.projectStorage;
  const history = Array.isArray(host?.history) ? host.history : [];
  const services = data?.services ?? {};
  const alerts = [
    ...(Array.isArray(host?.alerts) ? host.alerts : []),
    ...(projectStorage?.alert ? [projectStorage.alert] : []),
  ];

  return (
    <>
      <ErrorBanner message={state.error} />
      <section className="panel">
        <div className="section-title-row"><div><h2>归档维护</h2><p className="panel-subtitle">完整性检查验证 Revision 链、快照哈希、消息/分段引用与搜索分块；搜索索引可从事实归档随时重建。</p></div><div className="button-group"><button disabled={maintenanceBusy || integrityActive} onClick={() => void runIntegrity()}>{integrityActive ? "检查中" : "运行完整性检查"}</button><button className="secondary" disabled={maintenanceBusy || integrityActive} onClick={() => void rebuildSearch()}>重建全文检索</button></div></div>
        {maintenanceMessage && <div className="alert warning">{maintenanceMessage}</div>}
        {integrityState.error && <ErrorBanner message={integrityState.error} />}
        {integrityState.data?.task && <div className="run-row"><div><strong>最近完整性检查 · {statusLabel(integrityState.data.task.status)}</strong><span>{integrityState.data.task.message} · {formatTaskTime(integrityState.data.task.updatedAt)}</span></div><div className="run-progress"><div className="progress-bar"><span style={{width:`${taskPercent(integrityState.data.task)}%`}} /></div><small>{integrityState.data.task.error || `${integrityState.data.task.processedCount ?? 0} / ${integrityState.data.task.totalCount ?? 0}`}</small></div><span className={`pill ${statusClass(integrityState.data.task.status)}`}>{statusLabel(integrityState.data.task.status)}</span></div>}
      </section>
      <section className="panel system-service-panel">
        <div className="section-title-row">
          <div>
            <h2>运行环境</h2>
            <p className="panel-subtitle">每 10 秒自动刷新；监测容器仅使用只读主机指标挂载。</p>
          </div>
          <button className="secondary small" type="button" onClick={() => state.reload()}>
            {state.loading ? "刷新中" : "立即刷新"}
          </button>
        </div>
        <div className="service-status-grid">
          {[
            ["应用服务", services.app?.online, services.app?.version || "API"],
            ["容器监测", services.hostMonitor?.online, services.hostMonitor?.online ? "Docker 内部服务" : "连接异常"],
            ["PostgreSQL", services.postgres?.online, services.postgres?.online ? "数据库可用" : "连接异常"],
          ].map(([label, online, detail]) => (
            <div className="service-status" key={String(label)}>
              <span className={online ? "online" : "offline"} />
              <div><strong>{String(label)}</strong><small>{String(detail)}</small></div>
              <b>{online ? "正常" : "异常"}</b>
            </div>
          ))}
        </div>
      </section>

      {alerts.length > 0 && (
        <section className="panel system-alert-panel">
          <h2>资源告警</h2>
          {alerts.map((alert: UnknownRecord) => (
            <div className={`system-alert ${alert.level}`} key={`${alert.metric}-${alert.message}`}>
              <strong>{alert.level === "critical" ? "CRITICAL" : "WARNING"} · {alert.metric}</strong>
              <span>{alert.message}</span>
              <small>检查于 {new Date(data?.collectedAt).toLocaleString()}</small>
            </div>
          ))}
        </section>
      )}

      {!host?.available ? (
        <div className="alert warning">{host?.error || "暂时无法读取项目容器指标，请检查 host-monitor 容器。"}</div>
      ) : (
        <>
          <section className="panel host-resource-panel">
            <div className="section-title-row">
              <div>
                <h2>项目容器资源</h2>
                <p className="panel-subtitle">
                  应用已运行 {formatDuration(services.app?.uptimeSeconds)} · 汇总本项目 app、worker、PostgreSQL 和监测容器
                </p>
              </div>
              <span className="status-sampled-at">采样 {new Date(host.collectedAt).toLocaleTimeString()}</span>
            </div>
            <div className="resource-gauge-grid">
              <ResourceGauge label="CPU" percent={host.cpuPercent} detail="本项目占宿主机总 CPU 算力" />
              <ResourceGauge label="内存" percent={host.memory.percent} detail={`${formatBytes(host.memory.usedBytes)} / ${formatBytes(host.memory.totalBytes)} 项目容器额度`} />
              <ResourceGauge label="Swap" percent={host.swap.percent} detail={host.swap.totalBytes ? `${formatBytes(host.swap.usedBytes)} / ${formatBytes(host.swap.totalBytes)} 项目容器额度` : "项目容器未配置 Swap 额度"} />
            </div>
            <div className="system-trend">
              <div className="system-trend-title"><strong>最近趋势</strong><span>项目 CPU / 项目内存 · 最近 {history.length} 个采样点</span></div>
              <div className="system-trend-chart" aria-label="项目 CPU 与项目内存最近趋势">
                {history.map((sample: UnknownRecord) => (
                  <div className="system-trend-sample" key={String(sample.collectedAt)} title={`${new Date(sample.collectedAt).toLocaleTimeString()} · CPU ${Number(sample.cpuPercent).toFixed(1)}% · 内存 ${Number(sample.memoryPercent).toFixed(1)}%`}>
                    <span className="cpu" style={{ height: `${Math.max(2, Number(sample.cpuPercent))}%` }} />
                    <span className="memory" style={{ height: `${Math.max(2, Number(sample.memoryPercent))}%` }} />
                  </div>
                ))}
              </div>
            </div>
          </section>
        </>
      )}

      {projectStorage && (
        <section className="panel project-storage-panel">
          <div className="section-title-row">
            <div>
              <h2>项目存储</h2>
              <p className="panel-subtitle">统计归档数据库、导入文件和 Restore 暂存文件的实际占用，不使用 NAS 整盘容量。</p>
            </div>
            <span className="pill complete">实际项目数据</span>
          </div>
          {projectStorage.budgetBytes ? (
            <div className="resource-gauge-grid project-storage-gauge">
              <ResourceGauge
                label="存储预算"
                percent={projectStorage.percent}
                detail={`${formatBytes(projectStorage.usedBytes)} / ${formatBytes(projectStorage.budgetBytes)}`}
              />
            </div>
          ) : (
            <article className="project-storage-total">
              <span>项目数据已用</span>
              <strong>{formatBytes(projectStorage.usedBytes)}</strong>
              <small>未配置项目存储预算，因此不显示虚假的容量百分比，也不产生磁盘容量告警。</small>
            </article>
          )}
          <div className="database-metric-grid">
            <div><span>PostgreSQL 数据库</span><strong>{formatBytes(projectStorage.databaseBytes)}</strong></div>
            <div><span>待处理与留存导入文件</span><strong>{formatBytes(projectStorage.importBytes)}</strong></div>
            <div><span>导入文件数</span><strong>{Number(projectStorage.importFiles).toLocaleString()}</strong></div>
            <div><span>Restore Staging</span><strong>{formatBytes(projectStorage.restoreBytes)}</strong><small>{projectStorage.restoreFiles ?? 0} 个文件 · 提交前失败保留 {projectStorage.restoreFailedRetentionDays ?? 30} 天</small></div>
            <div><span>Inbox</span><strong>{formatBytes(projectStorage.importBreakdown?.inbox?.bytes)}</strong><small>{projectStorage.importBreakdown?.inbox?.files ?? 0} 个文件</small></div>
            <div><span>Processed</span><strong>{formatBytes(projectStorage.importBreakdown?.processed?.bytes)}</strong><small>保留 {projectStorage.importRetentionDays?.processed ?? 30} 天</small></div>
            <div><span>Failed</span><strong>{formatBytes(projectStorage.importBreakdown?.failed?.bytes)}</strong><small>保留 {projectStorage.importRetentionDays?.failed ?? 30} 天</small></div>
          </div>
          {projectStorage.incomplete && <div className="alert warning">部分导入目录暂时无法读取，本次项目存储统计可能偏小。</div>}
        </section>
      )}

      {database && (
        <section className="panel database-status-panel">
          <div className="section-title-row">
            <div><h2>PostgreSQL</h2><p className="panel-subtitle">数据库大小 {formatBytes(database.sizeBytes)} · 已运行 {formatDuration(database.uptimeSeconds)}</p></div>
            <span className="pill complete">运行正常</span>
          </div>
          <div className="database-metric-grid">
            <div><span>连接数</span><strong>{database.connections} / {database.maxConnections}</strong></div>
            <div><span>活跃连接</span><strong>{database.activeConnections}</strong></div>
            <div><span>最长查询</span><strong>{Number(database.longestQuerySeconds).toFixed(1)} 秒</strong></div>
            <div><span>最近 Web 备份</span><strong>{database.lastBackupAt ? new Date(database.lastBackupAt).toLocaleString() : "暂无记录"}</strong></div>
            <div><span>最近备份失败</span><strong>{database.lastBackupFailureAt ? new Date(database.lastBackupFailureAt).toLocaleString() : "暂无"}</strong></div>
          </div>
        </section>
      )}
    </>
  );
}

function Settings() {
  const [searchParams] = useSearchParams();
  const requestedSection = searchParams.get("section") as SettingsSection | null;
  const activeSection: SettingsSection = settingsSections.some((item) => item.id === requestedSection)
    ? requestedSection!
    : "account";
  const state = useLoad(() => api<UnknownRecord>("/api/v1/settings"), []);
  const cleanupState = useLoad(
    () => api<UnknownRecord>("/api/v1/redaction/storage-cleanup"),
    [],
  );
  const restoresState = useLoad(
    () => api<{ items: UnknownRecord[]; failedRetentionDays?: number }>("/api/v1/backups/restores"),
    [],
  );
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState("");
  const [llmTestMessage, setLlmTestMessage] = useState("");
  const [testingLlm, setTestingLlm] = useState(false);
  const [emailTestMessage, setEmailTestMessage] = useState("");
  const [testingEmail, setTestingEmail] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupVerification, setBackupVerification] = useState<UnknownRecord | null>(null);
  const [redactionMessage, setRedactionMessage] = useState("");
  const [redactionBusy, setRedactionBusy] = useState(false);
  const [redactionPreview, setRedactionPreview] = useState<UnknownRecord | null>(null);
  const cleanupTask = cleanupState.data?.task;
  const cleanupActive = cleanupTask && isActiveStatus(cleanupTask.status);
  const securityPackEnabled = state.data?.securityPack?.fullyEnabled === true;
  const activeRestores = (restoresState.data?.items ?? []).filter((job) => ["queued", "validating", "validated", "restoring", "rebuilding_search", "verifying", "recovery_required"].includes(String(job.status)));

  useEffect(() => {
    if (!cleanupActive) return;
    const timer = window.setInterval(() => cleanupState.reload(), 2500);
    return () => window.clearInterval(timer);
  }, [cleanupActive, cleanupState.reload]);

  useEffect(() => {
    if (!activeRestores.length) return;
    const timer = window.setInterval(() => restoresState.reload(), 2500);
    return () => window.clearInterval(timer);
  }, [activeRestores.map((job) => `${job.id}:${job.status}:${job.progress}`).join("|"), restoresState.reload]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(
      Array.from(form.entries()).map(([key, value]) => [key, String(value)]),
    );
    try {
      await api("/api/v1/settings", { method: "PUT", ...jsonBody(values) });
      setMessage("设置已保存");
      state.reload();
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function testLlm() {
    if (!formRef.current) return;
    const form = new FormData(formRef.current);
    setTestingLlm(true);
    setLlmTestMessage("正在测试模型连接…");
    try {
      const result = await api<UnknownRecord>("/api/v1/settings/llm/test", {
        method: "POST",
        ...jsonBody({
          baseURL: form.get("llm.baseUrl"),
          apiKey: form.get("llm.apiKey"),
          model: form.get("llm.model"),
        }),
      });
      setLlmTestMessage(`连接正常：${result.model} 返回 ${result.response}`);
    } catch (reason) {
      setLlmTestMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTestingLlm(false);
    }
  }

  async function testEmail() {
    if (!formRef.current) return;
    const form = new FormData(formRef.current);
    setTestingEmail(true);
    setEmailTestMessage("正在连接 SMTP 并发送测试邮件…");
    try {
      const result = await api<UnknownRecord>("/api/v1/settings/email/test", {
        method: "POST",
        ...jsonBody({
          host: form.get("smtp.host"),
          port: form.get("smtp.port"),
          secure: form.get("smtp.secure"),
          username: form.get("smtp.username"),
          password: form.get("smtp.password"),
          from: form.get("smtp.from"),
          to: form.get("smtp.to"),
        }),
      });
      setEmailTestMessage(`测试邮件已发送至 ${result.to}`);
    } catch (reason) {
      setEmailTestMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setTestingEmail(false);
    }
  }

  async function addRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setRedactionMessage("");
    try {
      await api("/api/v1/redaction-rules", {
        method: "POST",
        ...jsonBody({
          pattern: form.get("pattern"),
          replacement: form.get("replacement"),
        }),
      });
      formElement.reset();
      setRedactionMessage("脱敏规则已添加，并将用于云端发送和后续数据库入库。");
      state.reload();
    } catch (reason) {
      setRedactionMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function toggleRule(rule: UnknownRecord) {
    setRedactionMessage("");
    try {
      await api(`/api/v1/redaction-rules/${rule.id}`, {
        method: "PATCH",
        ...jsonBody({ enabled: !rule.enabled }),
      });
      state.reload();
    } catch (reason) {
      setRedactionMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function deleteRule(rule: UnknownRecord) {
    if (!window.confirm(`确认删除脱敏规则“${rule.name || rule.replacement}”？`)) return;
    setRedactionMessage("");
    try {
      await api(`/api/v1/redaction-rules/${rule.id}`, { method: "DELETE" });
      setRedactionMessage("脱敏规则已删除。已经打码的数据库内容不会恢复。");
      state.reload();
    } catch (reason) {
      setRedactionMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function enableSecurityPack() {
    if (securityPackEnabled) return;
    setRedactionBusy(true);
    setRedactionMessage("正在启用安全规则包并安排历史归档脱敏…");
    try {
      const result = await api<UnknownRecord>("/api/v1/redaction-rules/security-pack", {
        method: "POST",
      });
      setRedactionMessage(
        `安全规则包已启用：新增 ${result.added ?? 0} 条、启用 ${result.enabled ?? 0} 条；历史归档脱敏已进入队列。`,
      );
      state.reload();
      cleanupState.reload();
    } catch (reason) {
      setRedactionMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRedactionBusy(false);
    }
  }

  async function runStorageCleanup() {
    if (!window.confirm("该操作只会将历史归档中匹配到的密码、密钥和登录信息替换为脱敏标记，不会删除会话或报告；替换后无法恢复原文。确认继续？")) return;
    setRedactionBusy(true);
    setRedactionMessage("历史归档敏感信息脱敏正在加入队列…");
    try {
      await api("/api/v1/redaction/storage-cleanup", { method: "POST" });
      setRedactionMessage("历史归档敏感信息脱敏已进入队列，不会删除会话或报告。");
      cleanupState.reload();
    } catch (reason) {
      setRedactionMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRedactionBusy(false);
    }
  }

  async function testRedaction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setRedactionBusy(true);
    setRedactionPreview(null);
    try {
      setRedactionPreview(
        await api<UnknownRecord>("/api/v1/redaction-rules/test", {
          method: "POST",
          ...jsonBody({ text: form.get("text"), target: form.get("target") }),
        }),
      );
    } catch (reason) {
      setRedactionMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRedactionBusy(false);
    }
  }

  function downloadBackup() {
    setBackupBusy(true);
    setBackupMessage("备份下载已开始；数据较多时请等待浏览器下载栏出现。");
    const link = document.createElement("a");
    link.href = `/api/v1/backups/export?download=${Date.now()}`;
    link.download = "";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => setBackupBusy(false), 1500);
  }

  async function verifyBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBackupBusy(true);
    setBackupVerification(null);
    setBackupMessage("正在校验备份格式、表清单与引用关系…");
    try {
      const result = await api<UnknownRecord>("/api/v1/backups/verify", { method: "POST", body: form });
      setBackupVerification(result);
      setBackupMessage(result.ok ? "备份校验通过，可以提交恢复。" : "备份校验未通过，请查看错误清单。");
    } catch (reason) {
      setBackupMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBackupBusy(false);
    }
  }

  async function importBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm("导入系统备份会替换当前会话、项目、标签、报告、设备、设置和日志等业务数据；当前管理员账号会保留。确认继续？")) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBackupBusy(true);
    setBackupMessage("正在上传备份文件；上传后将由 Restore Worker 异步校验与恢复…");
    try {
      const result = await api<UnknownRecord>("/api/v1/backups/import", {
        method: "POST",
        body: form,
      });
      setBackupMessage(`恢复任务已创建（${result.restoreJobId}），页面会持续刷新阶段和进度。`);
      formElement.reset();
      restoresState.reload();
    } catch (reason) {
      setBackupMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBackupBusy(false);
    }
  }

  async function retryRestore(id: string) {
    setBackupMessage("正在重新加入恢复队列…");
    try {
      await api(`/api/v1/backups/restores/${id}/retry`, { method: "POST" });
      restoresState.reload();
      setBackupMessage("恢复任务已重新入队。");
    } catch (reason) {
      setBackupMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function cancelRestore(id: string) {
    if (!window.confirm("只允许在数据替换开始前取消。确认取消这次恢复？")) return;
    try {
      await api(`/api/v1/backups/restores/${id}`, { method: "DELETE" });
      restoresState.reload();
      setBackupMessage("恢复任务已取消，当前业务数据未被替换。");
    } catch (reason) {
      setBackupMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function deleteRestoreFile(id: string) {
    if (!window.confirm("确认删除这次失败恢复保留的上传文件？任务记录会保留，但之后不能重试，只能重新上传备份。")) return;
    try {
      await api(`/api/v1/backups/restores/${id}/staged-file`, { method: "DELETE" });
      restoresState.reload();
      setBackupMessage("失败恢复文件已删除，任务记录仍保留。");
    } catch (reason) {
      setBackupMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  if (state.loading && activeSection !== "system" && activeSection !== "account") return <Loading />;
  if (state.error && activeSection !== "backup" && activeSection !== "system") return <ErrorBanner message={state.error} />;
  const settings = state.data?.settings ?? {};
  const activeMeta = settingsSections.find((item) => item.id === activeSection)!;
  const configurable = activeSection === "ai" || activeSection === "classification" || activeSection === "email";

  return (
    <>
      <PageHeader title="设置" subtitle="按功能分区管理系统配置、数据安全与运行环境" />
      <div className="settings-layout">
        <aside className="panel settings-subnav">
          <span className="settings-subnav-label">设置项目</span>
          <nav>
            {settingsSections.map((item) => (
              <Link
                key={item.id}
                className={item.id === activeSection ? "active" : ""}
                to={`/settings?section=${item.id}`}
              >
                <span className="settings-subnav-icon">{item.icon}</span>
                <div><strong>{item.label}</strong><small>{item.hint}</small></div>
              </Link>
            ))}
          </nav>
        </aside>
        <div className="settings-workspace">
          <header className="settings-section-header">
            <div><span>{activeMeta.icon}</span><div><h2>{activeMeta.label}</h2><p>{activeMeta.hint}</p></div></div>
          </header>

          {activeSection === "account" && <AccountSecurity />}

          {configurable && (
            <form ref={formRef} className="settings-form" onSubmit={save}>
              {activeSection === "ai" && (
                <>
                  <section className="panel">
                    <div className="section-title-row">
                      <div><h2>OpenAI 兼容分析接口</h2><p className="panel-subtitle">API Key 使用主密钥加密保存，页面不会返回明文。</p></div>
                      <button type="button" className="secondary small" disabled={testingLlm} onClick={() => void testLlm()}>
                        {testingLlm ? "测试中" : "测试连接"}
                      </button>
                    </div>
                    <div className="form-grid">
                      <label>Base URL<input name="llm.baseUrl" defaultValue={settings["llm.baseUrl"] || ""} placeholder="https://api.example.com/v1" /></label>
                      <label>API Key<input type="password" name="llm.apiKey" defaultValue={settings["llm.apiKey"] || ""} /></label>
                      <label>模型<input name="llm.model" defaultValue={settings["llm.model"] || ""} placeholder="model-name" /></label>
                    </div>
                    {llmTestMessage && <div className={`alert ${llmTestMessage.startsWith("连接正常") ? "success" : "error"}`}>{llmTestMessage}</div>}
                  </section>
                  <section className="panel">
                    <h2>Token Plan 共享调度</h2>
                    <p className="panel-subtitle">默认按实测吞吐将请求匀速分布在约 5.5 小时内，为共用套餐的其他程序保留空间。</p>
                    <div className="form-grid">
                      <label>AI 调用节流<select name="ai.pacingEnabled" defaultValue={settings["ai.pacingEnabled"] || "true"}><option value="true">启用</option><option value="false">停用</option></select></label>
                      <label>调用起始最小间隔（秒）<input type="number" min={0} max={3600} step={1} name="ai.requestIntervalSeconds" defaultValue={settings["ai.requestIntervalSeconds"] || "82"} /></label>
                      <label>每日夜间维护<select name="ai.nightlyMaintenanceEnabled" defaultValue={settings["ai.nightlyMaintenanceEnabled"] || "true"}><option value="true">每天 22:00 启用</option><option value="false">停用</option></select></label>
                    </div>
                    <p className="muted">夜间维护只增量整理发生变化的会话项目与标签；没有候选时直接结束。遇到额度上限会显示恢复时间并自动续跑。</p>
                  </section>
                </>
              )}

              {activeSection === "classification" && (
                <section className="panel">
                  <h2>项目与标签整理策略</h2>
                  <div className="form-grid">
                    <label>新采集后自动整理<select name="classification.autoOnCapture" defaultValue={settings["classification.autoOnCapture"] || "false"}><option value="false">停用</option><option value="true">启用</option></select></label>
                    <label>项目变更后自动重评<select name="classification.autoReclassify" defaultValue={settings["classification.autoReclassify"] || "false"}><option value="false">停用</option><option value="true">启用</option></select></label>
                    <label>默认运行方式<select name="classification.runMode" defaultValue={settings["classification.runMode"] || "economy"}><option value="economy">节能归类</option><option value="full">完整重评</option></select></label>
                    <label>稳定结果复用<select name="classification.reuseStable" defaultValue={settings["classification.reuseStable"] || "true"}><option value="true">启用</option><option value="false">停用</option></select></label>
                    <label>单会话正文上限<input type="number" min={2000} max={40000} step={1000} name="classification.maxConversationChars" defaultValue={settings["classification.maxConversationChars"] || "8000"} /></label>
                  </div>
                </section>
              )}

              {activeSection === "email" && (
                <section className="panel">
                  <div className="section-title-row">
                    <div><h2>报告邮件</h2><p className="panel-subtitle">使用当前表单配置实际发送一封测试邮件，无需先保存。</p></div>
                    <button type="button" className="secondary small" disabled={testingEmail} onClick={() => void testEmail()}>
                      {testingEmail ? "测试中" : "发送测试邮件"}
                    </button>
                  </div>
                  <div className="form-grid">
                    <label>SMTP 主机<input name="smtp.host" defaultValue={settings["smtp.host"] || ""} /></label>
                    <label>端口<input name="smtp.port" defaultValue={settings["smtp.port"] || "587"} /></label>
                    <label>安全连接<select name="smtp.secure" defaultValue={settings["smtp.secure"] || "false"}><option value="false">STARTTLS/普通</option><option value="true">TLS</option></select></label>
                    <label>用户名<input name="smtp.username" defaultValue={settings["smtp.username"] || ""} /></label>
                    <label>密码<input type="password" name="smtp.password" defaultValue={settings["smtp.password"] || ""} /></label>
                    <label>发件人<input name="smtp.from" defaultValue={settings["smtp.from"] || ""} /></label>
                    <label>收件人<input name="smtp.to" defaultValue={settings["smtp.to"] || ""} /></label>
                    <label>周报<select name="reports.weeklyEnabled" defaultValue={settings["reports.weeklyEnabled"] || "true"}><option value="true">启用</option><option value="false">停用</option></select></label>
                    <label>月报<select name="reports.monthlyEnabled" defaultValue={settings["reports.monthlyEnabled"] || "true"}><option value="true">启用</option><option value="false">停用</option></select></label>
                  </div>
                  {emailTestMessage && <div className={`alert ${emailTestMessage.startsWith("测试邮件已发送") ? "success" : emailTestMessage.startsWith("正在") ? "warning" : "error"}`}>{emailTestMessage}</div>}
                </section>
              )}
              <div className="settings-save-row"><button>保存设置</button><span>{message}</span></div>
            </form>
          )}

          {activeSection === "backup" && <section className="panel">
        <div className="section-title-row">
          <div>
            <h2>备份与恢复</h2>
            <p className="panel-subtitle">导出使用一致性快照；恢复由独立 Worker 分阶段执行，数据替换期间系统进入只读维护状态。</p>
          </div>
          <button
            type="button"
            className="secondary small"
            disabled={backupBusy}
            onClick={() => void downloadBackup()}
          >
            {backupBusy ? "准备中" : "下载备份"}
          </button>
        </div>
        {state.error && <div className="alert warning">{state.error}。若正在恢复，这是维护模式的预期行为；可继续查看下方恢复进度。</div>}
        <form className="upload-box" onSubmit={verifyBackup}>
          <input type="file" name="file" accept=".json,.gz,.json.gz,application/gzip,application/json" required />
          <button className="secondary" disabled={backupBusy}>只校验，不恢复</button>
        </form>
        {backupVerification && <div className={`alert ${backupVerification.ok ? "success" : "error"}`}><strong>{backupVerification.ok ? "校验通过" : "校验失败"}</strong> · Schema {backupVerification.schemaVersion ?? "未知"} · {Object.keys(backupVerification.counts ?? {}).length} 张业务表{Array.isArray(backupVerification.errors) && backupVerification.errors.length > 0 && <ul>{backupVerification.errors.map((error: unknown) => <li key={String(error)}>{String(error)}</li>)}</ul>}{Array.isArray(backupVerification.warnings) && backupVerification.warnings.length > 0 && <ul>{backupVerification.warnings.map((warning: unknown) => <li key={String(warning)}>{String(warning)}</li>)}</ul>}</div>}
        <form className="upload-box" onSubmit={importBackup}>
          <input
            type="file"
            name="file"
            accept=".json,.gz,.json.gz,application/gzip,application/json"
            required
          />
          <button className="danger" disabled={backupBusy || activeRestores.length > 0}>创建异步恢复任务</button>
          <span>{backupMessage}</span>
        </form>
        <div className="section-title-row"><div><h3>恢复任务</h3><p className="panel-subtitle">提交前失败保留上传文件 {restoresState.data?.failedRetentionDays ?? 30} 天；事实已提交后的异常会保持维护模式，只重新执行检索重建与完整性验证。</p></div><button className="secondary small" onClick={() => restoresState.reload()}>刷新</button></div>
        {restoresState.loading && !restoresState.data ? <Loading label="正在读取恢复任务…" /> : restoresState.error ? <ErrorBanner message={restoresState.error} /> : (restoresState.data?.items ?? []).length ? (
          <div className="run-list">
            {(restoresState.data?.items ?? []).map((job) => (
              <div className="run-row" key={job.id}>
                <div>
                  <strong>{job.filename}</strong>
                  <span>{job.phaseMessage || statusLabel(job.status)} · {formatTaskTime(job.updatedAt)}</span>
                  {job.error && <small className="failed-text">{job.error}</small>}
                </div>
                <div className="run-progress">
                  <div className="progress-bar"><span style={{width:`${Number(job.progress ?? 0)}%`}} /></div>
                  <small>{job.progress ?? 0}%{Array.isArray(job.warnings) && job.warnings.length ? ` · ${job.warnings.join("；")}` : ""}</small>
                </div>
                <div className="button-group">
                  <span className={`pill ${statusClass(job.status)}`}>{statusLabel(job.status)}</span>
                  {["queued","validating","validated"].includes(String(job.status)) && <button className="secondary small" onClick={() => void cancelRestore(job.id)}>取消</button>}
                  {job.status === "failed" && job.stagedAvailable && <button className="secondary small" onClick={() => void retryRestore(job.id)}>重试</button>}
                  {job.status === "recovery_required" && <button className="secondary small" onClick={() => void retryRestore(job.id)}>继续恢复后处理</button>}
                  {job.status === "failed" && job.stagedAvailable && <button className="danger small" onClick={() => void deleteRestoreFile(job.id)}>删除恢复文件</button>}
                </div>
              </div>
            ))}
          </div>
        ) : <p className="muted">还没有恢复任务。</p>}
        <p className="muted">
          备份不包含后台管理员密码、登录会话和一次性配对码。若重建时更换了 APP_MASTER_KEY，加密的 API Key/SMTP 密码会被跳过，导入后需要重新填写。
        </p>
          </section>}

          {activeSection === "redaction" && <section className="panel">
        <div className="section-title-row">
          <div>
            <h2>自定义脱敏规则</h2>
            <p className="panel-subtitle">
              启用规则同时作用于发往 AI 的文本和后续采集入库。密码、密钥、私钥、数据库连接串和 SSH 登录信息另有内置强制防护。
            </p>
          </div>
          <div className="button-group">
            <button
              type="button"
              disabled={redactionBusy || cleanupActive || securityPackEnabled}
              onClick={() => void enableSecurityPack()}
            >
              {redactionBusy ? "处理中" : securityPackEnabled ? "安全规则包已启用" : "一键启用安全规则包"}
            </button>
            <button
              type="button"
              className="secondary"
              disabled={redactionBusy || cleanupActive}
              onClick={() => void runStorageCleanup()}
            >
              {cleanupActive ? "正在脱敏历史归档" : "脱敏已有归档"}
            </button>
          </div>
        </div>
        <div className="alert warning">
          数据库入库脱敏不可逆。请使用字段特征正则，不要把真实密码或密钥直接写进正则表达式；系统配置中的模型 API Key 和 SMTP 密码仍会单独加密保存。
        </div>
        {redactionMessage && <div className="alert success">{redactionMessage}</div>}
        {cleanupTask && (
          <div className="redaction-cleanup-status">
            <div>
              <strong>历史归档脱敏 · {statusLabel(cleanupTask.status)}</strong>
              <span>{storageRedactionMessage(cleanupTask.message) || "等待处理"}</span>
            </div>
            <span className={`pill ${statusClass(cleanupTask.status)}`}>
              {statusLabel(cleanupTask.status)}
            </span>
            <small>
              已扫描 {Number(cleanupTask.processedCount ?? 0).toLocaleString()} / {Number(cleanupTask.totalCount ?? 0).toLocaleString()} 条
              {typeof cleanupTask.stats?.replacements === "number"
                ? ` · 已打码 ${Number(cleanupTask.stats.replacements).toLocaleString()} 处`
                : ""}
            </small>
          </div>
        )}
        <form className="inline-form" onSubmit={addRule}>
          <input name="pattern" placeholder="正则表达式" required />
          <input name="replacement" defaultValue="[CUSTOM_REDACTED]" required />
          <button>添加</button>
        </form>
        {(state.data?.redactionRules ?? []).map((rule: UnknownRecord) => (
          <div className="list-row redaction-rule-row" key={rule.id}>
            <div>
              <strong>{rule.name || "自定义规则"}</strong>
              <code title={rule.pattern}>{rule.pattern}</code>
              <span>替换为 {rule.replacement}</span>
            </div>
            <span className={`pill ${rule.enabled ? "complete" : "partial"}`}>
              {rule.enabled ? "启用" : "停用"}
            </span>
            <div className="button-group">
              <button
                type="button"
                className="secondary small"
                onClick={() => void toggleRule(rule)}
              >
                {rule.enabled ? "停用" : "启用"}
              </button>
              <button
                type="button"
                className="danger small"
                onClick={() => void deleteRule(rule)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
        <form className="redaction-test" onSubmit={testRedaction}>
          <div className="section-title-row">
            <div>
              <h3>规则测试</h3>
              <p className="panel-subtitle">只在本机服务端预览，不会发送给 AI，也不会保存测试文本。建议只使用虚构样例。</p>
            </div>
            <select name="target" defaultValue="storage">
              <option value="storage">数据库入库效果</option>
              <option value="cloud">发送 AI 前效果</option>
            </select>
          </div>
          <textarea
            name="text"
            rows={6}
            required
            defaultValue={"password=DemoOnly_123\nssh demo@192.0.2.10 -p 22\nAuthorization: Bearer demo-token-value"}
          />
          <button disabled={redactionBusy}>{redactionBusy ? "测试中" : "测试脱敏"}</button>
          {redactionPreview && (
            <pre className="redaction-preview">{String(redactionPreview.text ?? "")}</pre>
          )}
          {redactionPreview && (
            <small>共匹配并替换 {Number(redactionPreview.replacements ?? 0)} 处。</small>
          )}
        </form>
          </section>}

          {activeSection === "system" && <SystemStatus />}
        </div>
      </div>
    </>
  );
}

export default function App() {
  const [authenticated,setAuthenticated]=useState<boolean|null>(null);const [authError,setAuthError]=useState("");const navigate=useNavigate();useEffect(()=>{void api<UnknownRecord>("/api/v1/auth/me").then((result)=>{instanceTimeZone=String(result.instance?.timezone||instanceTimeZone);setAuthenticated(true);setAuthError("");}).catch((reason)=>{if(reason instanceof ApiError&&reason.status===401){setAuthenticated(false);return;}setAuthError(reason instanceof ApiError?`服务器异常（${reason.status}）：${reason.message}`:"无法连接服务器，请检查网络、反向代理和服务状态");});},[]);async function logout(){await api("/api/v1/auth/logout",{method:"POST"});setAuthenticated(false);navigate("/");}
  if(authError)return <main className="auth-page"><section className="auth-card"><ErrorBanner message={authError}/><button onClick={()=>window.location.reload()}>重新连接</button></section></main>;if(authenticated===null)return<Loading/>;if(!authenticated)return<AuthScreen onAuthenticated={()=>setAuthenticated(true)}/>;
  return <Shell onLogout={()=>void logout()}><Routes><Route path="/" element={<Dashboard/>}/><Route path="/conversations" element={<Conversations/>}/><Route path="/conversations/:id" element={<ConversationDetail/>}/><Route path="/activity" element={<ActivityPage/>}/><Route path="/projects" element={<Projects/>}/><Route path="/tags" element={<Tags/>}/><Route path="/classification" element={<Navigate to="/projects" replace/>}/><Route path="/reports" element={<Reports/>}/><Route path="/reports/:id" element={<ReportDetail/>}/><Route path="/imports" element={<Imports/>}/><Route path="/devices" element={<Devices/>}/><Route path="/logs" element={<Logs/>}/><Route path="/trash" element={<Trash/>}/><Route path="/settings" element={<Settings/>}/><Route path="/changelog" element={<ChangelogPage/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Routes></Shell>;
}
