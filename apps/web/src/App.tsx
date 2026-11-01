import { lazy, Suspense } from "react";
import { FormEvent, type ReactNode, useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes, useNavigate } from "react-router-dom";
import { api, ApiError, jsonBody } from "./api.js";
import { WEB_VERSION, useLoad, Loading, ErrorBanner, setInstanceTimeZone } from "./shared-ui.js";

const Dashboard = lazy(() => import("./pages/dashboard.js").then(module => ({ default: module.Dashboard })));
const Logs = lazy(() => import("./pages/logs.js").then(module => ({ default: module.Logs })));
const Conversations = lazy(() => import("./pages/conversations.js").then(module => ({ default: module.Conversations })));
const ConversationDetail = lazy(() => import("./pages/conversation-detail.js").then(module => ({ default: module.ConversationDetail })));
const Projects = lazy(() => import("./pages/projects.js").then(module => ({ default: module.Projects })));
const Tags = lazy(() => import("./pages/tags.js").then(module => ({ default: module.Tags })));
const Reports = lazy(() => import("./pages/reports.js").then(module => ({ default: module.Reports })));
const ReportDetail = lazy(() => import("./pages/reports.js").then(module => ({ default: module.ReportDetail })));
const Imports = lazy(() => import("./pages/imports.js").then(module => ({ default: module.Imports })));
const ActivityPage = lazy(() => import("./pages/activity.js").then(module => ({ default: module.ActivityPage })));
const Trash = lazy(() => import("./pages/trash.js").then(module => ({ default: module.Trash })));
const Devices = lazy(() => import("./pages/devices.js").then(module => ({ default: module.Devices })));
const Settings = lazy(() => import("./pages/settings.js").then(module => ({ default: module.Settings })));
const ChangelogPage = lazy(() => import("./pages/changelog.js").then(module => ({ default: module.ChangelogPage })));
const RecapturePage = lazy(() => import("./recapture-panel.js").then(module => ({ default: module.RecapturePage })));

function AuthScreen({ onAuthenticated }: { onAuthenticated: () => void }) {
  const status = useLoad(() => api<{ initialized: boolean; instance?: { timezone?: string } }>("/api/v1/auth/status"), []);
  const [bootstrapResult, setBootstrapResult] = useState<{
    secret: string;
    otpauthUrl: string;
  } | null>(null);
  const [error, setError] = useState("");

  if (status.loading) return <Loading />;
  if (status.error) return <ErrorBanner message={status.error} />;
  setInstanceTimeZone(status.data?.instance?.timezone);
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
                <label><span>密码</span><input name="password" type="password" autoComplete="new-password" minLength={11} placeholder="至少 11 个字符" required /></label>
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
  ["/recapture", "批量补采", "⇄"],
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

export default function App() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState("");
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    void api<{ instance?: { timezone?: string } }>("/api/v1/auth/me")
      .then(result => {
        if (cancelled) return;
        setInstanceTimeZone(result.instance?.timezone);
        setAuthenticated(true);
        setAuthError("");
      })
      .catch(reason => {
        if (cancelled) return;
        if (reason instanceof ApiError && reason.status === 401) {
          setAuthenticated(false);
          return;
        }
        setAuthError(reason instanceof ApiError
          ? `服务器异常（${reason.status}）：${reason.message}`
          : "无法连接服务器，请检查网络、反向代理和服务状态");
      });
    return () => { cancelled = true; };
  }, []);

  async function logout() {
    await api("/api/v1/auth/logout", { method: "POST" });
    setAuthenticated(false);
    navigate("/");
  }

  if (authError) return <main className="auth-page"><section className="auth-card">
    <ErrorBanner message={authError} />
    <button onClick={() => window.location.reload()}>重新连接</button>
  </section></main>;
  if (authenticated === null) return <Loading />;
  if (!authenticated) return <AuthScreen onAuthenticated={() => setAuthenticated(true)} />;

  return <Shell onLogout={() => void logout()}>
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/conversations" element={<Conversations />} />
        <Route path="/recapture" element={<RecapturePage />} />
        <Route path="/conversations/:id" element={<ConversationDetail />} />
        <Route path="/activity" element={<ActivityPage />} />
        <Route path="/projects" element={<Projects />} />
        <Route path="/tags" element={<Tags />} />
        <Route path="/classification" element={<Navigate to="/projects" replace />} />
        <Route path="/reports" element={<Reports />} />
        <Route path="/reports/:id" element={<ReportDetail />} />
        <Route path="/imports" element={<Imports />} />
        <Route path="/devices" element={<Devices />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/trash" element={<Trash />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/changelog" element={<ChangelogPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  </Shell>;
}
