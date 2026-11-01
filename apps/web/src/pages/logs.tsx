import type { LogEntry, Device, ProviderCount } from "../api-types.js";
import { FormEvent, useEffect, useState } from "react";
import { setVisibleInterval } from "../visible-poll";
import { useSearchParams } from "react-router-dom";
import { providerLabels } from "@ai-archive/contracts/presentation";
import type { Provider } from "@ai-archive/contracts";
import { api } from "../api.js";
import { PageEnvelope, useLoad, Loading, ErrorBanner, Pagination, PageHeader, statusLabel, statusClass, formatTaskTime, formatCount, providerCountsFromRows, providerLabelWithCount, shortValue } from "../shared-ui.js";

export const logScopeLabels: Record<string, string> = {
  analysis: "分析",
  capture: "采集",
  classification: "归类",
  device: "设备",
  import: "导入",
  system: "系统",
};

export const logLevelLabels: Record<string, string> = {
  info: "信息",
  warning: "警告",
  error: "错误",
};

export function Logs() {
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
    () => api<PageEnvelope<LogEntry>>(`/api/v1/logs?${params}`),
    [scope, level, provider, deviceId, status, q, from, to, range, offset],
  );
  const providerCountsState = useLoad(
    () => api<ProviderCount[]>("/api/v1/conversations/provider-counts"),
    [],
  );
  const devicesState = useLoad(
    () => api<Device[]>("/api/v1/devices"),
    [],
  );

  useEffect(() => {
    const timer = setVisibleInterval(() => state.reload(), 5000);
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
