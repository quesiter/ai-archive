import type { PageEnvelope, Conversation } from "../api-types.js";
import { useState } from "react";
import { providerLabels } from "@ai-archive/contracts/presentation";
import type { Provider } from "@ai-archive/contracts";
import { api, jsonBody } from "../api.js";
import { useLoad, Loading, ErrorBanner, Pagination, PageHeader } from "../shared-ui.js";

export function Trash() {
  const [offset, setOffset] = useState(0);
  const [message, setMessage] = useState("");
  const state = useLoad(
    () => api<PageEnvelope<Conversation & { deletedAt: string }>>(`/api/v1/conversations/trash?limit=50&offset=${offset}`),
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
      <div className="run-list">{(state.data?.items ?? []).map((item) => <div className="run-row" key={item.id}>
        <div><strong>{item.title || item.externalSessionId}</strong><span>{providerLabels[item.provider as Provider] ?? item.provider} · 删除于 {new Date(item.deletedAt).toLocaleString()}</span></div>
        <div className="button-group"><button className="secondary small" onClick={() => void restore(item.id).catch((reason) => setMessage(String(reason)))}>恢复</button><button className="danger small" onClick={() => void remove(item.id).catch((reason) => setMessage(String(reason)))}>永久删除</button></div>
      </div>)}</div>
      {!state.data?.items?.length && <p className="muted">回收站为空</p>}
      <Pagination loading={state.loading} pagination={state.data?.pagination} onOffsetChange={setOffset} />
    </section>}
  </>;
}
