import { FormEvent, useEffect, useState } from "react";
import type {
  CaptureUiState,
  ExtensionMessage,
  ExtensionSettings,
} from "../../lib/messages";
import type { OutboxRecord } from "../../lib/outbox";
import { activeTabState, PAGE_RECONNECT_MESSAGE, type CurrentTabState } from "../../lib/current-tab";
import {
  packagedServerOrigin,
  serverPermissionPattern,
} from "../../lib/packaged-origin";

// Keep this list in sync with the content-script matches and the manifest's
// optional host permissions.  Requesting these permissions during pairing is
// necessary for Chrome to inject the collector on platforms that are declared
// as optional host permissions.
const captureOrigins = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://grok.com/*",
  "https://www.doubao.com/*",
  "https://doubao.com/*",
  "https://yuanbao.tencent.com/*",
  "https://agent.minimax.io/*",
  "https://agent.minimaxi.com/*",
  "https://chat.deepseek.com/*",
  "https://qianwen.com/*",
  "https://www.qianwen.com/*",
  "https://www.kimi.com/*",
  "https://kimi.com/*",
];

export default function App() {
  const [settings, setSettings] = useState<ExtensionSettings>({});
  const [tab, setTab] = useState<CurrentTabState>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [outbox, setOutbox] = useState<OutboxRecord[]>([]);

  async function reload(): Promise<void> {
    const [stored, current, queued] = await Promise.all([
      browser.storage.local.get() as Promise<ExtensionSettings>,
      activeTabState(),
      browser.runtime.sendMessage({ type: "getOutbox" } satisfies ExtensionMessage) as Promise<OutboxRecord[]>,
    ]);
    setSettings(stored);
    setTab(current);
    setOutbox(Array.isArray(queued) ? queued : []);
  }

  useEffect(() => {
    void reload();
    const listener = () => void reload();
    browser.storage.onChanged.addListener(listener);
    return () => browser.storage.onChanged.removeListener(listener);
  }, []);

  async function pair(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const serverUrl = packagedServerOrigin();
    const code = String(form.get("code") ?? "");
    setBusy(true);
    setMessage("");
    try {
      if (!serverUrl) throw new Error("此扩展包没有配置归档服务器地址，请重新构建扩展");
      const originPattern = serverPermissionPattern(serverUrl);
      const granted = await browser.permissions.request({
        origins: Array.from(new Set([originPattern, ...captureOrigins])),
      });
      if (!granted) throw new Error("需要授权访问归档服务器");
      await browser.runtime.sendMessage({
        type: "pairDevice",
        code,
        kind: "chrome_extension",
      } satisfies ExtensionMessage);
      setMessage("配对成功");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function manualCapture(): Promise<void> {
    if (!tab.tabId) return;
    setBusy(true);
    setMessage("正在请求采集…");
    try {
      const response = await browser.tabs.sendMessage(tab.tabId, {
        type: "manualCapture",
      } satisfies ExtensionMessage) as { ok?: boolean } | undefined;
      if (!response?.ok) throw new Error(PAGE_RECONNECT_MESSAGE);
      setMessage("采集请求已接收；操作页面会停止自动滚动，已加载消息仍会保存。");
    } catch (error) {
      setMessage(`${PAGE_RECONNECT_MESSAGE}（${error instanceof Error ? error.message : String(error)}）`);
    } finally {
      setBusy(false);
    }
  }

  async function refreshPage(): Promise<void> {
    if (tab.tabId === undefined) return;
    try {
      await browser.tabs.reload(tab.tabId);
      window.close();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function authorizeCurrentSite(): Promise<void> {
    const origin = `https://${tab.hostname}/*`;
    if (!captureOrigins.includes(origin)) return;
    setBusy(true);
    try {
      if (await browser.permissions.request({ origins: [origin] })) await refreshPage();
      else setMessage("尚未授予本站权限，可再次点击授权后采集。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally { setBusy(false); }
  }

  async function togglePause(): Promise<void> {
    if (!tab.hostname) return;
    const pausedHosts = { ...(settings.pausedHosts ?? {}) };
    pausedHosts[tab.hostname] = !pausedHosts[tab.hostname];
    await browser.storage.local.set({ pausedHosts });
    await reload();
  }

  async function toggleFloatingIndicator(): Promise<void> {
    await browser.storage.local.set({
      showFloatingIndicator: settings.showFloatingIndicator === false,
    });
    await reload();
  }

  async function outboxAction(action: ExtensionMessage): Promise<void> {
    setBusy(true);
    try {
      await browser.runtime.sendMessage(action);
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const status: CaptureUiState = settings.lastStatus ?? {
    status: "idle",
    message: "尚无采集记录",
    updatedAt: new Date().toISOString(),
  };
  const paused = Boolean(tab.hostname && settings.pausedHosts?.[tab.hostname]);
  const floatingVisible = settings.showFloatingIndicator !== false;
  const serverOrigin = packagedServerOrigin();

  return (
    <main>
      <header><img className="logo" src="/icon/128.png" alt="" /><div><strong>知言归藏</strong><small>汇智能之言，成项目之知。</small><small>V{browser.runtime.getManifest().version}</small></div></header>
      {!settings.deviceToken ? (
        <form onSubmit={(event) => void pair(event)}>
          <h2>连接归档服务</h2>
          {settings.authRevoked && <p className="auth-revoked">设备授权已失效，请重新配对。待上传数据不会被删除。</p>}
          <div className="server-field"><span>归档服务</span><code>{serverOrigin || "未配置服务器地址"}</code><small>地址已随扩展包固定，无需手动输入</small></div>
          <label>配对码<input name="code" minLength={6} maxLength={32} required /></label>
          <button disabled={busy || !serverOrigin}>配对</button>
        </form>
      ) : (
        <>
          <section className={`status ${status.status}`}>
            <div className="status-dot" />
            <div><strong>{({idle:"待机",checking:"检查变化",waiting:"等待生成",skipped:"内容未变化",scanning:"正在采集",queued:"等待上传",syncing:"正在同步",complete:"完整归档",partial:"部分归档",failed:"同步失败"} as Record<string,string>)[status.status]}</strong><p>{status.message}</p><small>{status.provider && `${status.provider} · `}{status.captureMode === "append" ? "增量 · " : status.captureMode === "full" ? "快照 · " : ""}{new Date(status.updatedAt).toLocaleString()}</small></div>
          </section>
          {status.status === "partial" && <p className="message">未完整原因：{status.incompleteReason || "此次采集未记录具体原因，请重新完整采集以获取诊断。"}</p>}
          <section className="current"><h2>当前页面</h2>{tab.connectionError ? <><p>{tab.connectionError}</p><div className="actions"><button onClick={() => void refreshPage()}>刷新当前页面</button><button className="secondary" disabled={busy} onClick={() => void authorizeCurrentSite()}>授权本站并刷新</button></div></> : tab.supported ? <><p><strong>{tab.provider}</strong><span className="conversation-title">{tab.title || "标题将在采集时从首个问题生成"}</span>{tab.sessionId ? <code>{tab.sessionId}</code> : <span>请先打开一条已有的对话，等待会话加载完成。</span>}</p><div className="actions"><button disabled={busy || !tab.sessionId || paused} onClick={() => void manualCapture()}>完整采集（会滚动）</button><button className="secondary" onClick={() => void togglePause()}>{paused ? "恢复本站" : "暂停本站"}</button><button className="secondary" onClick={() => void toggleFloatingIndicator()}>{floatingVisible ? "隐藏浮窗" : "显示浮窗"}</button></div></> : <p className="muted">当前页面不在支持列表中</p>}</section>
          <footer><span>{settings.deviceName}</span><button className="link" onClick={() => void browser.runtime.sendMessage({type:"flushOutbox"} satisfies ExtensionMessage)}>重试上传</button></footer>
        </>
      )}
      <section className="outbox-section">
        <div className="message"><strong>批量补采</strong><p>{settings.batchStatus?.message ?? "在归档网页创建队列，扩展会逐条重新采集 ChatGPT 不完整会话。"}</p><a href={`${serverOrigin}/recapture`} target="_blank" rel="noreferrer">管理补采队列</a></div>
        {tab.adapterVersion && <small>当前页面采集适配器：{tab.adapterVersion}</small>}
        {settings.lastManualCapture && settings.lastManualCapture.sessionId === tab.sessionId && <div className="message"><strong>最近一次手动采集</strong><p>{settings.lastManualCapture.message}</p><small>{new Date(settings.lastManualCapture.updatedAt).toLocaleString()}</small></div>}
        {tab.provider === "chatgpt" && settings.nativeReadDiagnostic && <div className="message"><strong>完整历史读取诊断</strong><p>{settings.nativeReadDiagnostic.stage} · {settings.nativeReadDiagnostic.code}{settings.nativeReadDiagnostic.parseReason ? ` · ${settings.nativeReadDiagnostic.parseReason}` : ""}{settings.nativeReadDiagnostic.httpStatus ? ` · HTTP ${settings.nativeReadDiagnostic.httpStatus}` : ""}</p><small>{new Date(settings.nativeReadDiagnostic.updatedAt).toLocaleString()}</small></div>}
        <div className="outbox-heading">
          <h2>待上传 <span>{outbox.length}</span></h2>
          {outbox.length > 0 && settings.deviceToken && (
            <button className="link" disabled={busy} onClick={() => void outboxAction({ type: "retryAllOutbox" })}>全部重试</button>
          )}
        </div>
        {outbox.length ? outbox.map((record) => (
          <article className="outbox-item" key={record.id}>
            <div>
              <strong>{record.payload.provider} · {record.payload.title || record.payload.sessionId}</strong>
              <small>{new Date(record.createdAt).toLocaleString()} · 已尝试 {record.attempts} 次</small>
              <small>{record.authRevoked ? "设备授权已失效" : record.lastStatusCode ? `HTTP ${record.lastStatusCode}` : "等待网络"}{record.lastError ? ` · ${record.lastError}` : ""}</small>
              {!record.authRevoked && record.nextAttemptAt > Date.now() && <small>下次重试：{new Date(record.nextAttemptAt).toLocaleString()}</small>}
            </div>
            <div className="outbox-actions">
              <button className="secondary" disabled={busy || !settings.deviceToken} onClick={() => void outboxAction({ type: "retryOutboxItem", id: record.id })}>立即重试</button>
              <button className="link danger-link" disabled={busy} onClick={() => {
                if (window.confirm("删除这条待上传记录？尚未归档的数据将无法从 Outbox 恢复。")) {
                  void outboxAction({ type: "removeOutboxItem", id: record.id });
                }
              }}>删除</button>
            </div>
          </article>
        )) : <p className="muted">当前没有等待上传的归档。</p>}
      </section>
      {message && <div className="message">{message}</div>}
    </main>
  );
}
