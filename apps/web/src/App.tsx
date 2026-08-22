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

type UnknownRecord = Record<string, any>;
const WEB_VERSION = "V260822-2";

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

function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const status = useLoad(() => api<{ initialized: boolean }>("/api/v1/auth/status"), []);
  const [bootstrapResult, setBootstrapResult] = useState<{
    secret: string;
    otpauthUrl: string;
  } | null>(null);
  const [error, setError] = useState("");

  if (status.loading) return <Loading />;
  if (status.error) return <ErrorBanner message={status.error} />;

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
      <section className="auth-card">
        <div className="brand-mark">A</div>
        <h1>AI 会话档案</h1>
        <p className="muted">九个平台，一份属于你的项目知识。</p>
        <ErrorBanner message={error} />
        {!status.data?.initialized ? (
          <>
            <h2>创建管理员</h2>
            <form onSubmit={bootstrap} className="stack">
              <label>用户名<input name="username" minLength={3} required /></label>
              <label>密码<input name="password" type="password" minLength={12} required /></label>
              <button type="submit">初始化</button>
            </form>
          </>
        ) : (
          <>
            {bootstrapResult && (
              <div className="alert success">
                <strong>请立即加入验证器：</strong>
                <code className="breakable">{bootstrapResult.secret}</code>
                <details><summary>OTP URI</summary><code className="breakable">{bootstrapResult.otpauthUrl}</code></details>
              </div>
            )}
            <h2>登录</h2>
            <form onSubmit={login} className="stack">
              <label>用户名<input name="username" required /></label>
              <label>密码<input name="password" type="password" required /></label>
              <label>六位验证码<input name="totpCode" inputMode="numeric" pattern="[0-9]{6}" required /></label>
              <button type="submit">登录</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}

const navigation = [
  ["/", "总览", "⌂"],
  ["/conversations", "会话", "◫"],
  ["/classification", "分类结果", "◇"],
  ["/knowledge", "项目知识", "▣"],
  ["/reports", "报告", "▤"],
  ["/imports", "导入", "⇧"],
  ["/devices", "设备", "⌘"],
  ["/logs", "日志", "☰"],
  ["/settings", "设置", "⚙"],
] as const;

function Shell({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand"><span>A</span><strong>AI Archive</strong></div>
        <nav>
          {navigation.map(([to, label, icon]) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <span>{icon}</span>{label}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-version" aria-label={`系统版本 ${WEB_VERSION}`}>
          <span>系统版本</span>
          <strong>{WEB_VERSION}</strong>
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

function isActiveStatus(status: unknown): boolean {
  return status === "queued" || status === "running" || status === "processing";
}

function statusLabel(status: unknown): string {
  return ({
    queued: "已入队",
    running: "运行中",
    processing: "处理中",
    completed: "已完成",
    complete: "完整",
    partial: "不完整",
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
      queued: "partial",
      partial: "partial",
      revoked: "failed",
      deleted: "failed",
      failed: "failed",
    } as Record<string, string>
  )[String(status)] ?? "partial";
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

function dateParamToIso(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function stageLabel(stage: unknown): string {
  return (
    {
      queued: "等待执行",
      parsing: "解析文件",
      importing: "写入归档",
      preparing: "准备数据",
      extracting: "抽取知识",
      rebuilding: "重建知识",
      consolidating: "整理知识",
      deferred: "等待 AI 额度恢复",
      reporting: "生成报告",
      completed: "完成",
    } as Record<string, string>
  )[String(stage)] ?? String(stage ?? "");
}

const knowledgeTypeLabels: Record<string, string> = {
  decision: "决策",
  requirement: "需求",
  fact: "事实与结论",
  idea: "已采纳想法",
  task: "待办任务",
  risk: "风险",
  resource: "资源",
  open_question: "待解问题",
};

const knowledgeTypeOrder = [
  "decision",
  "requirement",
  "fact",
  "risk",
  "open_question",
  "task",
  "resource",
  "idea",
];

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
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
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
  low_confidence: "低置信度",
  changed: "内容已更新",
};

function taskCandidateReasonEntries(task: UnknownRecord | null) {
  const reasons = taskStats(task).candidateReasons;
  if (!reasons || typeof reasons !== "object" || Array.isArray(reasons)) return [];
  const order = ["unassigned", "changed", "low_confidence", "full"];
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
  const knowledgeCount = toFiniteNumber(counts.knowledge);
  const topCategories = categoryStats.slice(0, 12);
  const maxCategoryCount = Math.max(
    1,
    ...topCategories.map((category: UnknownRecord) =>
      toFiniteNumber(category.conversationCount),
    ),
  );
  return (
    <>
      <PageHeader title="总览" subtitle="归档规模、分类增长和知识沉淀状态" />
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
          <span>文本量</span>
          <strong>{formatCompactCount(textStats.textUnits)}</strong>
          <small>按一个汉字为一个单位</small>
        </article>
        <article className="metric">
          <span>估算 token</span>
          <strong>{formatCompactCount(textStats.estimatedTokens)}</strong>
          <small>{textStats.tokenEstimateRule ?? "粗略估算"}</small>
        </article>
        <article className="metric">
          <span>知识</span>
          <strong>{formatCount(knowledgeCount)}</strong>
          <small>由报告/抽取任务产生</small>
        </article>
      </section>
      <section className="dashboard-main-grid">
        <article className="panel category-overview-panel">
          <div className="section-title-row">
            <div>
              <h2>分类分布</h2>
              <p className="panel-subtitle">
                {formatCount(categoryStats.length)} 个分类，近 7 日新增或更新 {formatCount(categoryTotals.growth7d)} 条会话
              </p>
            </div>
            <Link className="button-link secondary small" to="/classification">查看分类</Link>
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
                    <span className="pill">{formatCount(category.knowledgeCount)} 知识</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted">还没有分类结果，先在项目知识页运行智能归类。</p>
          )}
        </article>
        <article className="panel knowledge-explain-panel">
          <h2>知识如何产生</h2>
          <div className="knowledge-count-line">
            <strong>{formatCount(knowledgeCount)}</strong>
            <span>当前知识条目</span>
          </div>
          <p>
            知识不是原始会话数量。系统会先把会话归入项目，再在周报、月报或知识抽取流程里从已归类会话中提炼长期有效的信息。
          </p>
          <p className="muted">
            如果这里是 0，通常表示还没有生成报告、智能归类未完成，或分析接口返回异常导致知识抽取没有写入。
          </p>
          <div className="button-group">
            <Link className="button-link secondary small" to="/reports">生成报告</Link>
            <Link className="button-link secondary small" to="/settings">分析配置</Link>
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
  const status = searchParams.get("status") ?? "";
  const q = searchParams.get("q") ?? "";
  const [draftQ, setDraftQ] = useState(q);
  const params = new URLSearchParams({
    limit: "120",
    ...(scope ? { scope } : {}),
    ...(level ? { level } : {}),
    ...(provider ? { provider } : {}),
    ...(status ? { status } : {}),
    ...(q ? { q } : {}),
  });
  const state = useLoad(
    () => api<{ items: UnknownRecord[] }>(`/api/v1/logs?${params}`),
    [scope, level, provider, status, q],
  );
  const providerCountsState = useLoad(
    () => api<UnknownRecord[]>("/api/v1/conversations/provider-counts"),
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

  function updateQuery(next: Record<string, string>) {
    const merged = { scope, level, provider, status, q, ...next };
    const updated = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) updated.set(key, value);
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
      </section>
    </>
  );
}

function Conversations() {
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get("q") ?? "";
  const provider = searchParams.get("provider") ?? "";
  const source = searchParams.get("source") ?? "";
  const completeness = searchParams.get("completeness") ?? "";
  const captureMode = searchParams.get("captureMode") ?? "";
  const from = searchParams.get("from") ?? "";
  const to = searchParams.get("to") ?? "";
  const limit = 100;
  const rawOffset = Number(searchParams.get("offset") ?? 0);
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.floor(rawOffset)) : 0;
  const state = useLoad(
    () =>
      api<UnknownRecord[]>(
        `/api/v1/conversations?${new URLSearchParams({
          limit: String(limit),
          offset: String(Math.max(0, offset)),
          ...(q ? { q } : {}),
          ...(provider ? { provider } : {}),
          ...(source ? { source } : {}),
          ...(completeness ? { completeness } : {}),
          ...(captureMode ? { captureMode } : {}),
          ...(dateParamToIso(from) ? { from: dateParamToIso(from) } : {}),
          ...(dateParamToIso(to) ? { to: dateParamToIso(to) } : {}),
        })}`,
      ),
    [q, provider, source, completeness, captureMode, from, to, offset],
  );
  const providerCountsState = useLoad(
    () => api<UnknownRecord[]>("/api/v1/conversations/provider-counts"),
    [],
  );

  function updateQuery(next: Record<string, string | number>) {
    const merged = {
      q,
      provider,
      source,
      completeness,
      captureMode,
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
    if (merged.from) params.set("from", String(merged.from));
    if (merged.to) params.set("to", String(merged.to));
    if (Number(merged.offset) > 0) params.set("offset", String(merged.offset));
    setSearchParams(params);
  }

  const conversations = state.data ?? [];
  const hasNextPage = conversations.length === limit;
  const pageStart = conversations.length ? offset + 1 : 0;
  const pageEnd = offset + conversations.length;
  const providerCounts = providerCountsFromRows(providerCountsState.data);
  const providerTotal = Object.values(providerCounts).reduce(
    (sum, value) => sum + value,
    0,
  );

  return (
    <>
      <PageHeader title="会话" subtitle="按 Session 自动去重的完整可见分支" />
      <div className="toolbar compact-toolbar">
        <input
          key={q}
          placeholder="搜索全部会话…"
          defaultValue={q}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              updateQuery({ q: event.currentTarget.value.trim(), offset: 0 });
            }
          }}
        />
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
        <select
          value={source}
          onChange={(event) => updateQuery({ source: event.target.value, offset: 0 })}
        >
          <option value="">全部来源</option>
          {Object.entries(sourceLabels).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
        <select
          value={completeness}
          onChange={(event) => updateQuery({ completeness: event.target.value, offset: 0 })}
        >
          <option value="">完整性</option>
          <option value="complete">完整</option>
          <option value="partial">不完整</option>
        </select>
        <select
          value={captureMode}
          onChange={(event) => updateQuery({ captureMode: event.target.value, offset: 0 })}
        >
          <option value="">采集模式</option>
          <option value="full">完整</option>
          <option value="append">增量</option>
          <option value="import">导入</option>
        </select>
        <input
          type="date"
          value={from}
          onChange={(event) => updateQuery({ from: event.target.value, offset: 0 })}
        />
        <input
          type="date"
          value={to}
          onChange={(event) => updateQuery({ to: event.target.value, offset: 0 })}
        />
        <span className="toolbar-count">
          {state.loading ? "加载中" : `第 ${pageStart}-${pageEnd} 条`}
        </span>
        <button
          className="secondary small"
          disabled={offset <= 0}
          onClick={() => updateQuery({ offset: Math.max(0, offset - limit) })}
        >
          上一页
        </button>
        <button
          className="secondary small"
          disabled={!hasNextPage}
          onClick={() => updateQuery({ offset: offset + limit })}
        >
          下一页
        </button>
      </div>
      {state.loading ? (
        <Loading />
      ) : state.error ? (
        <ErrorBanner message={state.error} />
      ) : conversations.length ? (
        <section className="panel conversation-list-panel">
          <div className="conversation-list-header">
            <span>会话</span>
            <span>归类</span>
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
                    searchHit?.messageOrdinal !== undefined
                      ? `#message-${searchHit.messageOrdinal}`
                      : ""
                  }`}
                  className="conversation-compact-row"
                  key={conversation.id}
                >
                  <div className="conversation-compact-main">
                    <span className="provider-badge">
                      {providerLabels[conversation.provider as Provider]}
                    </span>
                    <div>
                      <strong>{conversation.title || conversation.externalSessionId}</strong>
                      <code>{conversation.externalSessionId}</code>
                      {searchHit?.excerpt && <span className="search-hit">{searchHit.excerpt}</span>}
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
  const projectsState = useLoad(() => api<UnknownRecord[]>("/api/v1/projects"), []);
  const [actionError, setActionError] = useState("");

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

  async function removeConversation(): Promise<void> {
    if (!window.confirm("确认永久删除这个会话及全部版本？删除后无法恢复，再次采集会创建全新的版本。")) return;
    await api(`/api/v1/conversations/${id}`, { method: "DELETE" });
    navigate("/conversations");
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
  return <><PageHeader title={data.conversation.title || "未命名会话"} subtitle={`${providerLabels[data.conversation.provider as Provider]} · ${data.conversation.externalSessionId}`} actions={<div className="button-group"><ExportLinks path={`/api/v1/conversations/${id}/export`} />{canonicalUrl && <a className="button-link" href={canonicalUrl} target="_blank" rel="noopener noreferrer">打开原会话</a>}<button className="danger" onClick={() => void removeConversation()}>永久删除归档</button></div>} />
    <ErrorBanner message={actionError} />
    <div className="toolbar"><label>版本 <select value={selectedRevision?.id ?? ""} onChange={(event) => setSearchParams(event.target.value ? { revisionId: event.target.value } : {})}>{data.revisions.map((revision: UnknownRecord) => <option key={revision.id} value={revision.id}>{new Date(revision.capturedAt).toLocaleString()} · {captureModeLabels[String(revision.captureMode)] ?? revision.captureMode} · {revision.completeness} · {revision.messageCount} 条</option>)}</select></label><label>项目（选择后人工锁定） <select disabled={projectsState.loading} value={data.projectAssignment?.projectId ?? ""} onChange={(event) => void assignProject(event.target.value)}><option value="">待归类</option>{projectsState.data?.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>{data.projectAssignment?.lockedByUser ? <><span className="pill complete">人工锁定</span><button className="secondary small" onClick={() => void releaseProjectLock()}>交还 AI 调整</button></> : <span className="pill">AI 可动态调整</span>}</div>
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

function Projects() {
  const overviewState = useLoad(() => api<UnknownRecord>("/api/v1/projects/overview"), []);
  const [error, setError] = useState("");
  const [classificationMessage, setClassificationMessage] = useState("");
  const [classificationTask, setClassificationTask] = useState<UnknownRecord | null>(null);
  const [classificationRunMode, setClassificationRunMode] = useState<"economy" | "full">("economy");
  const [mergeSourceId, setMergeSourceId] = useState("");
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeMessage, setMergeMessage] = useState("");
  const classificationActive = isActiveStatus(classificationTask?.status);
  const classificationClock = useTaskClock(classificationActive);
  const overview = overviewState.data ?? {};
  const projectGroups = Array.isArray(overview.projects) ? overview.projects : [];
  const categorizedProjectGroups = projectGroups.filter(
    (project) => Number(project.conversationCount ?? 0) > 0,
  );
  const emptyProjectGroups = projectGroups.filter(
    (project) => Number(project.conversationCount ?? 0) <= 0,
  );
  const unclassified = Array.isArray(overview.unclassified) ? overview.unclassified : [];
  const totals = overview.totals ?? {};
  const totalProjectCount = Number(totals.projectCount ?? projectGroups.length);
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

  useEffect(() => {
    let cancelled = false;
    void api<{ task: UnknownRecord | null }>("/api/v1/classification/tasks/latest")
      .then((payload) => {
        if (!cancelled && payload.task && isActiveStatus(payload.task.status)) {
          setClassificationTask(payload.task);
          setClassificationMessage(payload.task.message ?? "智能归类正在运行");
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
            overviewState.reload();
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
    overviewState.reload,
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
      overviewState.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function runClassification() {
    setClassificationMessage("正在加入智能归类队列…");
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
          ? "已有智能归类任务正在运行，已切换到当前任务进度"
          : payload.task.message ?? "已加入队列，等待 Worker 接手",
      );
    } catch (reason) {
      setClassificationMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function mergeProjects(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const source = projectGroups.find((project) => project.id === mergeSourceId);
    const target = projectGroups.find((project) => project.id === mergeTargetId);
    if (!source || !target || source.id === target.id) return;
    if (!window.confirm(`确认把项目“${source.name}”合并到“${target.name}”？源项目将在迁移完成后删除，此操作不可撤销。`)) return;
    setError("");
    setMergeMessage("正在合并项目…");
    try {
      const result = await api<UnknownRecord>(`/api/v1/projects/${source.id}/merge`, {
        method: "POST",
        ...jsonBody({ targetProjectId: target.id }),
      });
      setMergeMessage(`合并完成：迁移 ${result.movedConversationCount ?? 0} 个会话、${result.movedKnowledgeCount ?? 0} 条知识，合并 ${result.mergedKnowledgeCount ?? 0} 条重复知识。`);
      setMergeSourceId("");
      setMergeTargetId("");
      overviewState.reload();
    } catch (reason) {
      setMergeMessage("");
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
        title="分类结果"
        subtitle="按项目浏览已归类会话和待归类会话。"
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
              <option value="economy">增量智能归类</option>
              <option value="full">完整重评未锁定会话</option>
            </select>
            <button disabled={classificationActive} onClick={() => void runClassification()}>
              {classificationActive ? "智能归类中" : "立即智能归类"}
            </button>
          </div>
        }
      />
      <ErrorBanner message={error || overviewState.error} />
      {visibleClassificationMessage && (
        <div className={`alert ${classificationTask?.status === "failed" ? "error" : classificationDeferredMessage ? "warning" : "success"}`}>
          {visibleClassificationMessage}
        </div>
      )}
      <section className="panel summary-panel">
        <h2>结论</h2>
        <p>
          {classificationActive
            ? "正在重新归类会话，完成后这里会自动刷新。"
            : activeCategoryCount > 0
              ? `当前共有 ${activeCategoryCount} 个已启用项目，已归类 ${categorizedConversationCount} 个会话，仍有 ${unclassifiedConversationCount} 个待归类会话。`
              : "当前还没有可展示的分类结果，先创建项目或运行智能归类。"}
        </p>
      </section>
      {classificationTask && (
        <section className="panel progress-panel">
          <div className="progress-header">
            <div>
              <strong>
                智能归类 · {statusLabel(classificationTask.status)}
                {stats.stage ? ` · ${stageLabel(stats.stage)}` : ""}
              </strong>
              <span>{formatTaskTime(classificationTask.updatedAt)}</span>
            </div>
            <span>{percent}%</span>
          </div>
          <div className="progress-bar">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="progress-stats">
            <span>范围 {classificationScopeLabel}</span>
            <span>已处理 {classificationTask.processedCount ?? 0}/{classificationTask.totalCount ?? 0}</span>
            <span>AI 调用 {stats.aiCalls ?? 0}</span>
            <span>AI 兜底 {stats.aiFallbacks ?? 0}</span>
            <span>本地命中 {stats.localMatches ?? 0}</span>
            <span>复用 {stats.cached ?? 0}</span>
            <span>已归类 {stats.classified ?? 0}</span>
            <span>仅建议 {stats.suggested ?? 0}</span>
            <span>跳过 {stats.skipped ?? 0}</span>
            <span>失败 {classificationTask.failedCount ?? 0}</span>
          </div>
          {classificationDeferredMessage && (
            <p className="ai-deferred-notice">{classificationDeferredMessage}</p>
          )}
          {candidateReasonEntries.length > 0 && (
            <div className="progress-breakdown">
              {candidateReasonEntries.map((item) => (
                <span key={item.key}>
                  {classificationCandidateReasonLabels[item.key] ?? item.key} {formatCount(item.count)}
                </span>
              ))}
            </div>
          )}
          {classificationTask.error && !classificationDeferredMessage && (
            <p className="progress-error">{classificationTask.error}</p>
          )}
          {failureSamples.length > 0 && (
            <div className="failure-list">
              {failureSamples.map((sample, index) => (
                <p key={`${sample.conversationId ?? index}`}>
                  {sample.title || sample.conversationId || `样例 ${index + 1}`}：
                  {sample.error}
                </p>
              ))}
            </div>
          )}
        </section>
      )}

      <section className="project-metrics">
        <article className="metric">
          <span>类别</span>
          <strong>{activeCategoryCount}</strong>
          <small>共 {totalProjectCount} 个项目</small>
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
      </section>

      <section className="panel project-create-panel">
        <div className="project-action-copy">
          <h2>新建项目</h2>
          <p className="panel-subtitle">新增项目后，可重新运行智能归类或在会话详情中人工锁定。</p>
        </div>
        <form className="project-create-form" onSubmit={createProject}>
          <input name="name" aria-label="项目名称" placeholder="新项目名称" required />
          <input name="description" aria-label="项目描述" placeholder="描述（可选）" />
          <button>创建</button>
        </form>
      </section>

      <section className="panel project-admin-panel">
        <div className="project-action-copy">
          <h2>合并项目</h2>
          <p className="panel-subtitle">把 A 项目的会话、知识和关联报告迁移到 B 项目；完成后删除 A 项目。</p>
        </div>
        <form className="project-merge-form" onSubmit={mergeProjects}>
          <label>A · 源项目
            <select value={mergeSourceId} onChange={(event) => setMergeSourceId(event.target.value)} required>
              <option value="">请选择</option>
              {projectGroups.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <span className="merge-arrow">→</span>
          <label>B · 目标项目
            <select value={mergeTargetId} onChange={(event) => setMergeTargetId(event.target.value)} required>
              <option value="">请选择</option>
              {projectGroups.filter((project) => project.id !== mergeSourceId).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
          </label>
          <button className="danger" disabled={!mergeSourceId || !mergeTargetId || mergeSourceId === mergeTargetId}>确认合并</button>
        </form>
        {mergeMessage && <p className="merge-result">{mergeMessage}</p>}
      </section>

      <section className="project-board">
        <div className="section-title-row">
          <div>
            <h2>分类结果</h2>
            <p className="panel-subtitle">展开项目即可查看归到该类别下的会话。</p>
          </div>
          <span className="pill">{activeCategoryCount} 个类别</span>
        </div>
        {overviewState.loading ? (
          <Loading label="加载分类结果中…" />
        ) : projectGroups.length ? (
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
                      <span>{project.knowledgeCount ?? 0} 知识</span>
                    </div>
                  </summary>
                  <div className="project-group-actions">
                    <ExportLinks path={`/api/v1/projects/${project.id}/export`} />
                  </div>
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
                    <p className="project-empty">这个项目暂时还没有归入会话。</p>
                  )}
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
                      <ExportLinks path={`/api/v1/projects/${project.id}/export`} />
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        ) : (
          <Loading label="还没有项目。创建项目或运行智能归类后会在这里显示。" />
        )}
      </section>

      <section className="project-board">
        <div className="section-title-row">
          <div>
            <h2>待归类</h2>
            <p className="panel-subtitle">这些会话还没有确认项目，可能只有 AI 建议名。</p>
          </div>
          <span className="pill partial">{unclassifiedConversationCount} 条</span>
        </div>
        {overviewState.loading ? (
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
      </section>

    </>
  );
}

function KnowledgePage() {
  const knowledgeState = useLoad(
    () => api<UnknownRecord[]>("/api/v1/knowledge?status=active"),
    [],
  );
  const overviewState = useLoad(() => api<UnknownRecord>("/api/v1/projects/overview"), []);
  const [message, setMessage] = useState("");
  const [task, setTask] = useState<UnknownRecord | null>(null);
  const [projectFilter, setProjectFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [query, setQuery] = useState("");
  const active = isActiveStatus(task?.status);
  const knowledgeClock = useTaskClock(active);
  const knowledgeTaskStats = taskStats(task);
  const knowledgeDeferredMessage = deferredAiTaskMessage(
    knowledgeTaskStats,
    knowledgeClock,
  );
  const visibleKnowledgeMessage = knowledgeDeferredMessage || message;
  const knowledge = knowledgeState.data ?? [];
  const overview = overviewState.data ?? {};
  const projectGroups = Array.isArray(overview.projects) ? overview.projects : [];
  const projectCount = Number(overview.totals?.projectCount ?? projectGroups.length);
  const knowledgeCount = knowledge.length;
  const activeProjects = Number(overview.totals?.activeProjectCount ?? 0);
  const sourceProjectCount = new Set(knowledge.map((item) => item.projectId)).size;
  const projectsWithKnowledge = Array.from(
    new Map(
      knowledge.map((item) => [String(item.projectId), String(item.projectName)]),
    ).entries(),
  ).sort((left, right) => left[1].localeCompare(right[1], "zh-CN"));
  const availableTypes = [...new Set(knowledge.map((item) => String(item.type)))]
    .sort((left, right) => {
      const leftIndex = knowledgeTypeOrder.indexOf(left);
      const rightIndex = knowledgeTypeOrder.indexOf(right);
      return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
    });
  const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
  const filteredKnowledge = knowledge.filter((item) => {
    if (projectFilter && item.projectId !== projectFilter) return false;
    if (typeFilter && item.type !== typeFilter) return false;
    if (!normalizedQuery) return true;
    return `${item.title ?? ""}\n${item.body ?? ""}\n${item.projectName ?? ""}`
      .toLocaleLowerCase("zh-CN")
      .includes(normalizedQuery);
  });
  const knowledgeGroups = new Map<
    string,
    { id: string; name: string; items: UnknownRecord[] }
  >();
  for (const item of filteredKnowledge) {
    const key = String(item.projectId);
    const group = knowledgeGroups.get(key) ?? {
      id: key,
      name: String(item.projectName ?? "未命名项目"),
      items: [],
    };
    group.items.push(item);
    knowledgeGroups.set(key, group);
  }
  const groupedKnowledge = [...knowledgeGroups.values()]
    .map((group) => ({
      ...group,
      items: group.items.sort((left, right) => {
        const leftIndex = knowledgeTypeOrder.indexOf(String(left.type));
        const rightIndex = knowledgeTypeOrder.indexOf(String(right.type));
        if (leftIndex !== rightIndex) {
          return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex);
        }
        return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
      }),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

  useEffect(() => {
    let cancelled = false;
    void api<{ task: UnknownRecord | null }>("/api/v1/knowledge/rebuild/latest")
      .then((payload) => {
        if (!cancelled && payload.task && isActiveStatus(payload.task.status)) {
          setTask(payload.task);
          setMessage(payload.task.message ?? "项目知识重建正在运行");
        }
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!task?.id || !active) return;
    const timer = window.setInterval(() => {
      void api<UnknownRecord>(`/api/v1/knowledge/rebuild/${task.id}`)
        .then((nextTask) => {
          setTask(nextTask);
          setMessage(nextTask.message ?? statusLabel(nextTask.status));
          if (!isActiveStatus(nextTask.status)) {
            knowledgeState.reload();
            overviewState.reload();
          }
        })
        .catch((reason) => setMessage(reason instanceof Error ? reason.message : String(reason)));
    }, 2000);
    return () => window.clearInterval(timer);
  }, [task?.id, active, knowledgeState.reload, overviewState.reload]);

  async function runRebuild() {
    setMessage("正在加入项目知识重建队列…");
    setTask(null);
    try {
      const payload = await api<{ jobId: string | null; task: UnknownRecord; reused?: boolean }>(
        "/api/v1/knowledge/rebuild",
        { method: "POST" },
      );
      setTask(payload.task);
      setMessage(
        payload.reused
          ? "已有重建任务正在运行，已切换到当前进度"
          : payload.task.message ?? "已加入队列，等待 Worker 接手",
      );
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const conclusion =
    knowledgeCount > 0
      ? `已沉淀 ${knowledgeCount} 条有效知识，覆盖 ${sourceProjectCount} 个项目。`
      : "当前还没有项目知识，先完成归类或重建一次知识库。";

  return (
    <>
      <PageHeader
        title="项目知识"
        subtitle="把会话整理成可追溯、可复用、可继续维护的中文项目知识。"
        actions={
          <div className="button-group">
            <button disabled={active} onClick={() => void runRebuild()}>
              {active ? "重建中" : "按新标准重建"}
            </button>
          </div>
        }
      />
      <ErrorBanner message={knowledgeState.error || overviewState.error} />
      {visibleKnowledgeMessage && (
        <div
          className={`alert ${
            task?.status === "failed"
              ? "error"
              : knowledgeDeferredMessage
                ? "warning"
                : "success"
          }`}
        >
          {visibleKnowledgeMessage}
        </div>
      )}
      <section className="panel summary-panel">
        <h2>结论</h2>
        <p>{conclusion}</p>
      </section>
      <section className="panel knowledge-definition-panel">
        <div>
          <h2>这里保存什么</h2>
          <p>已确认的决策、稳定需求、事实结论、风险、资源，以及仍需跟进的重要问题。</p>
        </div>
        <div>
          <h2>这里不会保存什么</h2>
          <p>助手的实施计划、代码生成步骤、过程播报、重复摘要、临时状态和无证据猜测。</p>
        </div>
      </section>
      {task && (
        <section className="panel progress-panel">
          <div className="progress-header">
            <div>
              <strong>
                项目知识 · {statusLabel(task.status)}
                {knowledgeTaskStats.stage
                  ? ` · ${stageLabel(knowledgeTaskStats.stage)}`
                  : ""}
              </strong>
              <span>{formatTaskTime(task.updatedAt)}</span>
            </div>
            <span>{taskPercent(task)}%</span>
          </div>
          <div className="progress-bar">
            <span style={{ width: `${taskPercent(task)}%` }} />
          </div>
          <div className="progress-stats">
            <span>已处理 {task.processedCount ?? 0}/{task.totalCount ?? 0}</span>
            <span>成功 {task.succeededCount ?? 0}</span>
            <span>失败 {task.failedCount ?? 0}</span>
          </div>
          {knowledgeDeferredMessage && (
            <p className="ai-deferred-notice">{knowledgeDeferredMessage}</p>
          )}
          {task.error && !knowledgeDeferredMessage && (
            <p className="progress-error">{task.error}</p>
          )}
        </section>
      )}
      <section className="project-metrics">
        <article className="metric">
          <span>项目</span>
          <strong>{projectCount}</strong>
          <small>已启用项目 {activeProjects} 个</small>
        </article>
        <article className="metric">
          <span>知识条目</span>
          <strong>{knowledgeCount}</strong>
          <small>仅显示当前有效知识</small>
        </article>
        <article className="metric">
          <span>来源项目</span>
          <strong>{sourceProjectCount}</strong>
          <small>按项目聚合展示</small>
        </article>
      </section>
      <section className="panel">
        <div className="section-title-row">
          <div>
            <h2>知识库</h2>
            <p className="panel-subtitle">按项目整理；每条知识都能回到原始消息核对。</p>
          </div>
          <span className="pill">{filteredKnowledge.length} / {knowledge.length} 条</span>
        </div>
        <div className="toolbar knowledge-toolbar">
          <input
            aria-label="搜索项目知识"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、正文或项目"
          />
          <select
            aria-label="按项目筛选知识"
            value={projectFilter}
            onChange={(event) => setProjectFilter(event.target.value)}
          >
            <option value="">全部项目</option>
            {projectsWithKnowledge.map(([id, name]) => (
              <option key={id} value={id}>{name}</option>
            ))}
          </select>
          <select
            aria-label="按类型筛选知识"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value)}
          >
            <option value="">全部类型</option>
            {availableTypes.map((type) => (
              <option key={type} value={type}>{knowledgeTypeLabels[type] ?? type}</option>
            ))}
          </select>
        </div>
        {knowledgeState.loading ? (
          <Loading />
        ) : groupedKnowledge.length === 0 ? (
          <p className="empty-state">没有符合当前条件的知识</p>
        ) : (
          <div className="knowledge-project-list">
            {groupedKnowledge.map((group) => (
              <section className="knowledge-project-section" key={group.id}>
                <header className="knowledge-project-header">
                  <div>
                    <span>项目</span>
                    <h3>{group.name}</h3>
                  </div>
                  <span className="pill">{group.items.length} 条知识</span>
                </header>
                <div className="knowledge-grid">
                  {group.items.map((item) => {
                    const references = Array.isArray(item.sourceReferences)
                      ? item.sourceReferences
                      : [];
                    return (
                      <article className="knowledge-card" key={item.id}>
                        <header>
                          <span className={`pill knowledge-type ${String(item.type)}`}>
                            {knowledgeTypeLabels[String(item.type)] ?? String(item.type)}
                          </span>
                          <time>{new Date(item.updatedAt).toLocaleDateString("zh-CN")}</time>
                        </header>
                        <h3>{item.title}</h3>
                        <p>{item.body}</p>
                        <footer>
                          <span>置信度 {Math.round(Number(item.confidence) * 100)}%</span>
                          <div className="knowledge-evidence-links">
                            <span>原始依据 {references.length} 条</span>
                            {references.map((reference: UnknownRecord, index: number) => (
                              <Link
                                key={`${reference.revisionId}-${reference.messageOrdinal}-${index}`}
                                to={`/conversations/${reference.conversationId}?revisionId=${reference.revisionId}#message-${reference.messageOrdinal}`}
                              >
                                查看依据 {index + 1}（消息 #{reference.messageOrdinal}）
                              </Link>
                            ))}
                          </div>
                        </footer>
                      </article>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function Reports() {
  const state = useLoad(() => api<UnknownRecord[]>("/api/v1/reports"), []);
  const runsState = useLoad(() => api<UnknownRecord[]>("/api/v1/analysis/runs"), []);
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
        subtitle="每周知识增量与每月项目演进"
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
                      {new Date(run.windowStart).toLocaleDateString()} —{" "}
                      {new Date(run.windowEnd).toLocaleDateString()}
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
                          typeof stats.knowledgeCount === "number"
                            ? ` · 知识 ${stats.knowledgeCount}`
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
          {state.data!.map((report) => (
            <Link className="report-card" to={`/reports/${report.id}`} key={report.id}>
              <span className="pill">{report.kind}</span>
              <h3>{report.title}</h3>
              <p>{report.summary}</p>
              <time>{new Date(report.createdAt).toLocaleString()}</time>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

function ReportDetail() {
  const { id } = useParams(); const state = useLoad(() => api<UnknownRecord>(`/api/v1/reports/${id}`), [id]); if (state.loading) return <Loading />; if (state.error) return <ErrorBanner message={state.error} />; const report=state.data!; return <><PageHeader title={report.title} subtitle={`${report.kind} · ${new Date(report.periodStart).toLocaleDateString()} — ${new Date(report.periodEnd).toLocaleDateString()}`} /><article className="report-body"><p className="report-summary">{report.summary}</p><ReactMarkdown skipHtml components={{ a: ({ href, children }) => { const safeHref = safeExternalHref(href); return safeHref ? <a href={safeHref} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>; }, img: ({ alt }) => <span>{alt ?? "[图片已隐藏]"}</span> }}>{String(report.bodyMarkdown ?? "")}</ReactMarkdown></article></>;
}

function importJobPercent(job: UnknownRecord): number {
  if (job.status === "completed" || job.status === "failed") return 100;
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
  return {
    stats,
    imported: Number.isFinite(imported) ? imported : 0,
    unchanged: Number.isFinite(unchanged) ? unchanged : 0,
    total: Number.isFinite(total) ? total : 0,
    processed: Number.isFinite(processed) ? processed : 0,
  };
}

function importJobText(job: UnknownRecord): string {
  const { stats, imported, unchanged, total, processed } = importJobStats(job);
  if (job.status === "queued") return "等待 Worker 接手";
  if (job.status === "failed") {
    return `导入失败${job.error ? `：${compactErrorMessage(job.error)}` : ""}`;
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
  const state = useLoad(() => api<UnknownRecord[]>("/api/v1/imports"), []);
  const [message, setMessage] = useState("");
  const activeJobs = (state.data ?? []).filter((job) => isActiveStatus(job.status));
  const activeKey = (state.data ?? [])
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

  return (
    <>
      <PageHeader title="历史导入" subtitle="支持 ChatGPT 官方 ZIP 与 Gemini Takeout ZIP" />
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
          </div>
        </div>
        {state.loading ? (
          <Loading />
        ) : state.data?.length ? (
          <div className="run-list">
            {state.data.map((job) => {
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
                  <span className={`pill ${statusClass(job.status)}`}>
                    {active && <span className="live-dot inline" />}
                    {statusLabel(job.status)}
                  </span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="muted">还没有导入记录</p>
        )}
      </section>
    </>
  );
}

function Devices() {
  const state = useLoad(() => api<UnknownRecord[]>("/api/v1/devices"), []);
  const componentsState = useLoad(() => api<UnknownRecord[]>("/api/v1/device-components"), []);
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
      <article className="panel"><h2>已配对设备</h2>{state.loading?<Loading/>:state.data?.map((device)=><div className="device-row" key={device.id}><div>{editingId===device.id?<div className="device-name-edit"><input value={editingName} onChange={(event)=>setEditingName(event.target.value)} onKeyDown={(event)=>{if(event.key==="Enter")void saveDeviceName(device.id); if(event.key==="Escape")setEditingId("");}} autoFocus/><button className="small" onClick={()=>void saveDeviceName(device.id)}>保存</button><button className="secondary small" onClick={()=>setEditingId("")}>取消</button></div>:<strong>{device.name}</strong>}<span>{device.kind}</span></div><div><span>{device.lastSeenAt?`最后在线 ${new Date(device.lastSeenAt).toLocaleString()}`:"尚未上传"}</span>{device.revokedAt?<span className="pill failed">已撤销</span>:null}<div className="button-group"><button className="secondary small" onClick={()=>{setEditingId(device.id);setEditingName(String(device.name??""));}}>重命名</button><button className="danger small" onClick={()=>void removeDevice(device)}>{device.revokedAt?"删除":"撤销"}</button></div></div></div>)}</article>
    </section>
  </>;
}

function Settings() {
  const state = useLoad(() => api<UnknownRecord>("/api/v1/settings"), []);
  const formRef = useRef<HTMLFormElement>(null);
  const [message, setMessage] = useState("");
  const [llmTestMessage, setLlmTestMessage] = useState("");
  const [testingLlm, setTestingLlm] = useState(false);
  const [backupMessage, setBackupMessage] = useState("");
  const [backupBusy, setBackupBusy] = useState(false);

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

  async function addRule(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    await api("/api/v1/redaction-rules", {
      method: "POST",
      ...jsonBody({
        pattern: form.get("pattern"),
        replacement: form.get("replacement"),
      }),
    });
    formElement.reset();
    state.reload();
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

  async function importBackup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!window.confirm("导入系统备份会替换当前会话、项目、分类、报告、设备、设置和日志等业务数据；当前管理员账号会保留。确认继续？")) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBackupBusy(true);
    setBackupMessage("正在导入备份文件...");
    try {
      const result = await api<UnknownRecord>("/api/v1/backups/import", {
        method: "POST",
        body: form,
      });
      const counts = result.counts && typeof result.counts === "object" ? result.counts : {};
      const total = Object.values(counts).reduce<number>(
        (sum, value) => sum + Number(value ?? 0),
        0,
      );
      const warnings = Array.isArray(result.warnings) && result.warnings.length
        ? `；${result.warnings.join("；")}`
        : "";
      setBackupMessage(`导入完成，共恢复 ${total} 条记录${warnings}`);
      formElement.reset();
      state.reload();
    } catch (reason) {
      setBackupMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBackupBusy(false);
    }
  }

  if (state.loading) return <Loading />;
  if (state.error) return <ErrorBanner message={state.error} />;
  const settings = state.data!.settings;

  return (
    <>
      <PageHeader title="设置" subtitle="模型密钥与 SMTP 密码加密存储" />
      <form ref={formRef} className="settings-form" onSubmit={save}>
        <section className="panel">
          <div className="section-title-row">
            <h2>OpenAI 兼容分析接口</h2>
            <button
              type="button"
              className="secondary small"
              disabled={testingLlm}
              onClick={() => void testLlm()}
            >
              {testingLlm ? "测试中" : "测试连接"}
            </button>
          </div>
          <label>
            Base URL
            <input
              name="llm.baseUrl"
              defaultValue={settings["llm.baseUrl"] || ""}
              placeholder="https://api.example.com/v1"
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              name="llm.apiKey"
              defaultValue={settings["llm.apiKey"] || ""}
            />
          </label>
          <label>
            模型
            <input
              name="llm.model"
              defaultValue={settings["llm.model"] || ""}
              placeholder="model-name"
            />
          </label>
          {llmTestMessage && (
            <div
              className={`alert ${
                llmTestMessage.startsWith("连接正常") ? "success" : "error"
              }`}
            >
              {llmTestMessage}
            </div>
          )}
        </section>

        <section className="panel">
          <h2>智能归类</h2>
          <div className="form-grid">
            <label>
              新采集后自动归类
              <select
                name="classification.autoOnCapture"
                defaultValue={settings["classification.autoOnCapture"] || "false"}
              >
                <option value="false">停用</option>
                <option value="true">启用</option>
              </select>
            </label>
            <label>
              项目/周报后自动重评
              <select
                name="classification.autoReclassify"
                defaultValue={settings["classification.autoReclassify"] || "false"}
              >
                <option value="false">停用</option>
                <option value="true">启用</option>
              </select>
            </label>
            <label>
              默认运行方式
              <select
                name="classification.runMode"
                defaultValue={settings["classification.runMode"] || "economy"}
              >
                <option value="economy">节能归类</option>
                <option value="full">完整重评</option>
              </select>
            </label>
            <label>
              稳定结果复用
              <select
                name="classification.reuseStable"
                defaultValue={settings["classification.reuseStable"] || "true"}
              >
                <option value="true">启用</option>
                <option value="false">停用</option>
              </select>
            </label>
            <label>
              单会话正文上限
              <input
                type="number"
                min={2000}
                max={40000}
                step={1000}
                name="classification.maxConversationChars"
                defaultValue={settings["classification.maxConversationChars"] || "8000"}
              />
            </label>
          </div>
        </section>

        <section className="panel">
          <h2>Token Plan 共享调度</h2>
          <p className="panel-subtitle">
            根据最近 244 次调用耗尽五小时额度的实测结果，默认将 AI 调用起始间隔设为 82 秒，约用 5.5 小时完成同等调用量，为其他程序保留使用空间。
          </p>
          <div className="form-grid">
            <label>
              AI 调用节流
              <select
                name="ai.pacingEnabled"
                defaultValue={settings["ai.pacingEnabled"] || "true"}
              >
                <option value="true">启用</option>
                <option value="false">停用</option>
              </select>
            </label>
            <label>
              调用起始最小间隔（秒）
              <input
                type="number"
                min={0}
                max={3600}
                step={1}
                name="ai.requestIntervalSeconds"
                defaultValue={settings["ai.requestIntervalSeconds"] || "82"}
              />
            </label>
            <label>
              每日夜间维护
              <select
                name="ai.nightlyMaintenanceEnabled"
                defaultValue={settings["ai.nightlyMaintenanceEnabled"] || "true"}
              >
                <option value="true">每天 22:00 启用</option>
                <option value="false">停用</option>
              </select>
            </label>
          </div>
          <p className="muted">
            夜间维护按照“增量智能归类 → 项目知识分析”串行执行；遇到额度上限时会显示恢复时间并自动续跑。
          </p>
        </section>

        <section className="panel">
          <h2>报告邮件</h2>
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
        </section>

        <button>保存设置</button>
        <span>{message}</span>
      </form>
      <section className="panel">
        <div className="section-title-row">
          <div>
            <h2>备份与恢复</h2>
            <p className="panel-subtitle">下载当前业务数据备份，或在重建网站后导入备份恢复归档内容。</p>
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
        <form className="upload-box" onSubmit={importBackup}>
          <input
            type="file"
            name="file"
            accept=".json,.gz,.json.gz,application/gzip,application/json"
            required
          />
          <button className="danger" disabled={backupBusy}>导入备份并替换数据</button>
          <span>{backupMessage}</span>
        </form>
        <p className="muted">
          备份不包含后台管理员密码、登录会话和一次性配对码。若重建时更换了 APP_MASTER_KEY，加密的 API Key/SMTP 密码会被跳过，导入后需要重新填写。
        </p>
      </section>
      <section className="panel">
        <h2>自定义脱敏规则</h2>
        <form className="inline-form" onSubmit={addRule}>
          <input name="pattern" placeholder="正则表达式" required />
          <input name="replacement" defaultValue="[CUSTOM_REDACTED]" required />
          <button>添加</button>
        </form>
        {state.data!.redactionRules.map((rule: UnknownRecord) => (
          <div className="list-row" key={rule.id}>
            <code>{rule.pattern}</code>
            <span>→ {rule.replacement}</span>
            <span className={`pill ${rule.enabled ? "complete" : "partial"}`}>
              {rule.enabled ? "启用" : "停用"}
            </span>
          </div>
        ))}
      </section>
    </>
  );
}

export default function App() {
  const [authenticated,setAuthenticated]=useState<boolean|null>(null);const navigate=useNavigate();useEffect(()=>{void api("/api/v1/auth/me").then(()=>setAuthenticated(true)).catch((reason)=>setAuthenticated(reason instanceof ApiError&&reason.status===401?false:false));},[]);async function logout(){await api("/api/v1/auth/logout",{method:"POST"});setAuthenticated(false);navigate("/");}
  if(authenticated===null)return<Loading/>;if(!authenticated)return<AuthScreen onAuthenticated={()=>setAuthenticated(true)}/>;
  return <Shell onLogout={()=>void logout()}><Routes><Route path="/" element={<Dashboard/>}/><Route path="/conversations" element={<Conversations/>}/><Route path="/conversations/:id" element={<ConversationDetail/>}/><Route path="/classification" element={<Projects/>}/><Route path="/knowledge" element={<KnowledgePage/>}/><Route path="/projects" element={<Navigate to="/classification" replace/>}/><Route path="/reports" element={<Reports/>}/><Route path="/reports/:id" element={<ReportDetail/>}/><Route path="/imports" element={<Imports/>}/><Route path="/devices" element={<Devices/>}/><Route path="/logs" element={<Logs/>}/><Route path="/settings" element={<Settings/>}/><Route path="*" element={<Navigate to="/" replace/>}/></Routes></Shell>;
}
