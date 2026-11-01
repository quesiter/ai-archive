import type { Device, DeviceComponent, AdapterHealth } from "../api-types.js";
import { FormEvent, useState } from "react";
import { latestAdaptersByProvider } from "../adapter-health";
import { providerLabels } from "@ai-archive/contracts/presentation";
import type { Provider } from "@ai-archive/contracts";
import { api, jsonBody } from "../api.js";
import { useLoad, Loading, ErrorBanner, PageHeader, formatTaskTime, adapterVersionLabel } from "../shared-ui.js";

export function Devices() {
  const state = useLoad(() => api<Device[]>("/api/v1/devices"), []);
  const componentsState = useLoad(() => api<DeviceComponent[]>("/api/v1/device-components"), []);
  const adaptersState = useLoad(() => api<AdapterHealth[]>("/api/v1/reliability/adapters"), []);
  const [code, setCode] = useState<{ code: string; expiresAt: string } | null>(null);
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

  async function removeDevice(device: Device) {
    if (device.revokedAt) return;
    setError("");
    try {
      await api(`/api/v1/devices/${device.id}`, { method: "DELETE" });
      state.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  const activeDevices = (state.data ?? []).filter(device => !device.revokedAt);
  const revokedDevices = (state.data ?? []).filter(device => Boolean(device.revokedAt));
  const renderDevice = (device: Device) => <div className="device-row" key={device.id}><div>{editingId===device.id?<div className="device-name-edit"><input value={editingName} onChange={(event)=>setEditingName(event.target.value)} onKeyDown={(event)=>{if(event.key==="Enter")void saveDeviceName(device.id); if(event.key==="Escape")setEditingId("");}} autoFocus/><button className="small" onClick={()=>void saveDeviceName(device.id)}>保存</button><button className="secondary small" onClick={()=>setEditingId("")}>取消</button></div>:<strong>{device.name}</strong>}<span>{device.kind} · {device.os || "系统未知"} · {device.clientVersion || "版本未知"}</span><small>跟踪 {device.trackedFiles ?? 0} · 跳过 {device.skippedFiles ?? 0}</small></div><div><span>{device.lastSeenAt?`心跳 ${formatTaskTime(device.lastSeenAt)}`:"尚未上线"}</span>{device.lastSuccessfulSyncAt&&<span>最近同步 {formatTaskTime(device.lastSuccessfulSyncAt)}</span>}{device.lastErrorCode&&<span className="pill failed">{device.lastErrorCode}</span>}{device.revokedAt?<span className="pill failed">已撤销</span>:null}<div className="button-group"><button className="secondary small" onClick={()=>{setEditingId(device.id);setEditingName(String(device.name??""));}}>重命名</button><button className="danger small" disabled={Boolean(device.revokedAt)} onClick={()=>void removeDevice(device)}>{device.revokedAt?"已解除配对":"解除配对"}</button></div></div></div>;

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
      <article className="panel"><h2>生成配对码</h2><form className="stack compact" onSubmit={createCode}><label>设备名称<input name="name" required placeholder="公司 Chrome"/></label><label>类型<select name="kind"><option value="chrome_extension">Chrome 扩展</option><option value="openclaw_sync">本地同步代理（OpenClaw / Codex / Claude Code / Grok Build）</option></select></label><button>生成</button></form>{code&&<div className="pair-code"><strong>{code.code}</strong><span>有效至 {new Date(code.expiresAt).toLocaleTimeString()}</span></div>}</article>
      <article className="panel"><h2>已配对设备</h2>{state.loading ? <Loading /> : <>
        {activeDevices.map(renderDevice)}
        {!activeDevices.length && <p className="muted">暂无有效的已配对设备</p>}
        {revokedDevices.length > 0 && <details className="revoked-devices">
          <summary>已失效设备（{revokedDevices.length}）</summary>
          {revokedDevices.map(renderDevice)}
        </details>}
      </>}</article>
    </section>
    <section className="panel">
      <div className="section-title-row"><div><h2>采集适配器健康度</h2><p className="panel-subtitle">每个平台仅展示最新适配器版本的最近 24 小时成功、部分和失败比例；连续失败或部分率过高会标记为退化。</p></div><button className="secondary small" onClick={() => adaptersState.reload()}>刷新</button></div>
      {adaptersState.loading ? <Loading label="正在汇总采集健康度…" /> : adaptersState.error ? <ErrorBanner message={adaptersState.error} /> : adaptersState.data?.length ? <div className="run-list">{latestAdaptersByProvider(adaptersState.data).map((adapter) => <div className="run-row" key={`${adapter.provider}-${adapter.adapterVersion}`}><div><strong>{providerLabels[adapter.provider as Provider] ?? adapter.provider} · {adapterVersionLabel(adapter.adapterVersion)}</strong><span>最后采集 {formatTaskTime(adapter.lastCaptureAt)} · 平均 {Number(adapter.averageMessageCount24h ?? 0).toFixed(1)} 条消息</span></div><div className="run-progress"><div className="progress-bar"><span style={{width:`${Math.round(Number(adapter.rates24h?.success ?? 0)*100)}%`}} /></div><small>24h：成功 {Math.round(Number(adapter.rates24h?.success ?? 0)*100)}% · 部分 {Math.round(Number(adapter.rates24h?.partial ?? 0)*100)}% · 失败 {Math.round(Number(adapter.rates24h?.failed ?? 0)*100)}% · 连续失败 {adapter.consecutiveFailures ?? 0}</small></div><span className={`pill ${adapter.status === "healthy" ? "complete" : adapter.status === "degraded" ? "failed" : "partial"}`}>{adapter.status === "healthy" ? "健康" : adapter.status === "degraded" ? "退化" : "长时间无采集"}</span></div>)}</div> : <p className="muted">最近 30 天还没有采集运行记录。</p>}
    </section>
  </>;
}
