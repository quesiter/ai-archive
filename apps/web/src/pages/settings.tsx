import type { AuthSession, TotpSetup, SettingsResponse, RedactionRule, RedactionPreview, BackupVerification, RestoreJob, BackgroundTask, SystemStatusResponse } from "../api-types.js";
import { FormEvent, useEffect, useRef, useState } from "react";
import { setVisibleInterval } from "../visible-poll";
import { Link, useSearchParams } from "react-router-dom";
import { api, jsonBody } from "../api.js";
import { useLoad, Loading, ErrorBanner, PageHeader, isActiveStatus, statusLabel, statusClass, storageRedactionMessage, taskPercent, formatTaskTime } from "../shared-ui.js";

export const settingsSections = [
  { id: "account", label: "账号与安全", hint: "密码、TOTP 与登录会话", icon: "◎" },
  { id: "ai", label: "模型与额度", hint: "MiniMax、模型连接与 Token Plan", icon: "✦" },
  { id: "classification", label: "项目与标签", hint: "自动整理与稳定结果复用", icon: "◇" },
  { id: "email", label: "邮件与报告", hint: "SMTP、周报与月报", icon: "✉" },
  { id: "backup", label: "备份与恢复", hint: "业务数据导入与导出", icon: "▤" },
  { id: "redaction", label: "脱敏与安全", hint: "安全规则与历史脱敏", icon: "⊘" },
  { id: "system", label: "系统状态", hint: "项目资源与 PostgreSQL", icon: "⌁" },
] as const;

export type SettingsSection = (typeof settingsSections)[number]["id"];

export function AccountSecurity() {
  const sessionsState = useLoad(
    () => api<{ items: AuthSession[] }>("/api/v1/auth/sessions"),
    [],
  );
  const [message, setMessage] = useState("");
  const [totpResult, setTotpResult] = useState<TotpSetup | null>(null);

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
      const result = await api<TotpSetup>("/api/v1/auth/totp/reset", {
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
    <section className="panel"><h2>修改密码</h2><form className="form-grid" onSubmit={changePassword}><label>当前密码<input name="currentPassword" type="password" required /></label><label>当前六位验证码<input name="totpCode" inputMode="numeric" pattern="[0-9]{6}" required /></label><label>新密码<input name="newPassword" type="password" minLength={11} required /></label><label>确认新密码<input name="confirmPassword" type="password" minLength={11} required /></label><button>修改密码</button></form></section>
    <section className="panel"><h2>重新绑定 TOTP</h2><p className="panel-subtitle">采用二阶段切换：只有新验证器验证码确认成功后，旧密钥才会失效。</p><form className="form-grid" onSubmit={resetTotp}><label>当前密码<input name="currentPassword" type="password" required /></label><label>当前六位验证码<input name="totpCode" inputMode="numeric" pattern="[0-9]{6}" required /></label><button className="secondary">生成待确认密钥</button></form>{totpResult && <div className="stack"><div className="pair-code"><strong>{totpResult.secret}</strong><span>有效至 {formatTaskTime(totpResult.expiresAt)}</span><details><summary>OTP URI</summary><code className="breakable">{totpResult.otpauthUrl}</code></details></div><form className="inline-form" onSubmit={confirmTotp}><input name="totpCode" inputMode="numeric" pattern="[0-9]{6}" minLength={6} maxLength={6} placeholder="输入新验证器验证码" required /><button>确认并切换</button><button type="button" className="secondary" onClick={() => void cancelTotp()}>取消切换</button></form></div>}</section>
    <section className="panel"><div className="section-title-row"><div><h2>登录会话</h2><p className="panel-subtitle">可远程注销其他浏览器。</p></div><button className="danger small" onClick={() => void api("/api/v1/auth/sessions/revoke-others", {method:"POST"}).then(() => sessionsState.reload())}>注销其他会话</button></div>{sessionsState.loading ? <Loading /> : (sessionsState.data?.items ?? []).map((session) => <div className="device-row" key={session.id}><div><strong>{session.current ? "当前会话" : "其他浏览器会话"}</strong><span>登录于 {new Date(session.createdAt).toLocaleString()} · 到期 {new Date(session.expiresAt).toLocaleString()}</span></div>{!session.current && <button className="danger small" onClick={() => void revokeSession(session.id)}>注销</button>}</div>)}</section>
  </div>;
}

export function formatBytes(value: unknown): string {
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

export function formatDuration(value: unknown): string {
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

export function ResourceGauge({
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

export function SystemStatus() {
  const state = useLoad(() => api<SystemStatusResponse>("/api/v1/system/status"), []);
  const integrityState = useLoad(() => api<{ task: BackgroundTask | null }>("/api/v1/reliability/integrity"), []);
  const [maintenanceMessage, setMaintenanceMessage] = useState("");
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const integrityActive = isActiveStatus(integrityState.data?.task?.status);
  useEffect(() => {
    const timer = setVisibleInterval(() => state.reload(), 10_000);
    return () => window.clearInterval(timer);
  }, [state.reload]);
  useEffect(() => {
    if (!integrityActive) return;
    const timer = setVisibleInterval(() => integrityState.reload(), 2500);
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
      const result = await api<{ chunkCount: number }>("/api/v1/search/rebuild", { method: "POST" });
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
  const services: Partial<SystemStatusResponse["services"]> = data?.services ?? {};
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
          {alerts.map((alert) => (
            <div className={`system-alert ${alert.level}`} key={`${alert.metric}-${alert.message}`}>
              <strong>{alert.level === "critical" ? "CRITICAL" : "WARNING"} · {alert.metric}</strong>
              <span>{alert.message}</span>
              <small>检查于 {new Date(data?.collectedAt ?? "").toLocaleString()}</small>
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
              <div className="system-trend-legend"><span><i className="cpu" />项目 CPU</span><span><i className="memory" />项目内存</span><small>占用率 · 0–100%</small></div>
              <div className="system-trend-plot">
              <div className="system-trend-axis" aria-hidden="true"><span>100%</span><span>50%</span><span>0%</span></div>
              <div className="system-trend-chart" aria-label="项目 CPU 与项目内存最近趋势">
                {history.map((sample) => (
                  <div className="system-trend-sample" key={String(sample.collectedAt)} title={`${new Date(sample.collectedAt).toLocaleTimeString()} · CPU ${Number(sample.cpuPercent).toFixed(1)}% · 内存 ${Number(sample.memoryPercent).toFixed(1)}%`}>
                    <span className="cpu" style={{ height: `${Math.min(100, Math.max(0, Number(sample.cpuPercent) || 0))}%` }} />
                    <span className="memory" style={{ height: `${Math.min(100, Math.max(0, Number(sample.memoryPercent) || 0))}%` }} />
                  </div>
                ))}
              </div>
              </div>
              {history.length ? <div className="system-trend-times"><span>{new Date(history[0]!.collectedAt).toLocaleTimeString()}</span><span>{new Date(history[history.length - 1]!.collectedAt).toLocaleTimeString()}</span></div> : <p className="panel-subtitle">正在等待趋势采样数据</p>}
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
                percent={projectStorage.percent ?? 0}
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

export function Settings() {
  const [searchParams] = useSearchParams();
  const requestedSection = searchParams.get("section") as SettingsSection | null;
  const activeSection: SettingsSection = settingsSections.some((item) => item.id === requestedSection)
    ? requestedSection!
    : "account";
  const state = useLoad(() => api<SettingsResponse>("/api/v1/settings"), []);
  const cleanupState = useLoad(
    () => api<{ task: BackgroundTask | null }>("/api/v1/redaction/storage-cleanup"),
    [],
  );
  const restoresState = useLoad(
    () => api<{ items: RestoreJob[]; failedRetentionDays?: number }>("/api/v1/backups/restores"),
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
  const [backupVerification, setBackupVerification] = useState<BackupVerification | null>(null);
  const [redactionMessage, setRedactionMessage] = useState("");
  const [redactionBusy, setRedactionBusy] = useState(false);
  const [redactionPreview, setRedactionPreview] = useState<RedactionPreview | null>(null);
  const cleanupTask = cleanupState.data?.task;
  const cleanupActive = Boolean(cleanupTask && isActiveStatus(cleanupTask.status));
  const securityPackEnabled = state.data?.securityPack?.fullyEnabled === true;
  const activeRestores = (restoresState.data?.items ?? []).filter((job) => ["queued", "validating", "validated", "restoring", "rebuilding_search", "verifying", "recovery_required"].includes(String(job.status)));

  useEffect(() => {
    if (!cleanupActive) return;
    const timer = setVisibleInterval(() => cleanupState.reload(), 2500);
    return () => window.clearInterval(timer);
  }, [cleanupActive, cleanupState.reload]);

  useEffect(() => {
    if (!activeRestores.length) return;
    const timer = setVisibleInterval(() => restoresState.reload(), 2500);
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
      const result = await api<{ model: string; response: string }>("/api/v1/settings/llm/test", {
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
      const result = await api<{ to: string }>("/api/v1/settings/email/test", {
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

  async function toggleRule(rule: RedactionRule) {
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

  async function deleteRule(rule: RedactionRule) {
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
      const result = await api<{ added: number; enabled: number }>("/api/v1/redaction-rules/security-pack", {
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
        await api<RedactionPreview>("/api/v1/redaction-rules/test", {
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
      const result = await api<BackupVerification>("/api/v1/backups/verify", { method: "POST", body: form });
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
      const result = await api<{ restoreJobId: string }>("/api/v1/backups/import", {
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
        {(state.data?.redactionRules ?? []).map((rule: RedactionRule) => (
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

