import type { Conversation, ProjectOption, Tag, SavedSearch, ProviderCount } from "../api-types.js";
import { useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { providerLabels } from "@ai-archive/contracts/presentation";
import type { Provider } from "@ai-archive/contracts";
import { api, jsonBody } from "../api.js";
import { buildConversationListSearch, countActiveConversationListFilters, filterConversationTags } from "../conversation-list.js";
import { sourceDeviceFilterLabel, sourceDeviceLabel } from "../source-device.js";
import { conversationArchiveHref } from "../conversation-archive.js";
import { ConversationSubagentLink } from "../conversation-lineage.js";
import { PageEnvelope, useLoad, Loading, ErrorBanner, Pagination, PageHeader, sourceLabels, captureModeLabels, triggerReasonLabels, formatCount, providerCountsFromRows, providerLabelWithCount, downloadResponse } from "../shared-ui.js";

export function Conversations() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tagQuery, setTagQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchProjectId, setBatchProjectId] = useState("");
  const [batchTagId, setBatchTagId] = useState("");
  const [batchMessage, setBatchMessage] = useState("");
  const [batchError, setBatchError] = useState("");
  const [batchExportFormat, setBatchExportFormat] = useState<"csv" | "md" | "xlsx" | null>(null);
  const [selectedSavedSearchId, setSelectedSavedSearchId] = useState("");
  const tagSearchRef = useRef<HTMLInputElement>(null);
  const q = searchParams.get("q") ?? "";
  const provider = searchParams.get("provider") ?? "";
  const source = searchParams.get("source") ?? "";
  const sourceDevice = searchParams.get("sourceDevice") ?? "";
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
    sourceDevice,
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
      api<PageEnvelope<Conversation>>(
        `/api/v1/conversations?${conversationSearch}`,
      ),
    [conversationSearch],
  );
  const providerCountsState = useLoad(
    () => api<ProviderCount[]>("/api/v1/conversations/provider-counts"),
    [],
  );
  const sourceDevicesState = useLoad(() => api<Array<{ key: string; name: string; count: number }>>("/api/v1/conversations/source-devices"), []);
  const projectsState = useLoad(() => api<ProjectOption[]>("/api/v1/projects/options"), []);
  const tagsState = useLoad(() => api<Tag[]>("/api/v1/tags"), []);
  const savedSearchesState = useLoad(() => api<SavedSearch[]>("/api/v1/saved-searches"), []);


  function updateQuery(next: Record<string, string | number>) {
    const merged = {
      q,
      provider,
      source,
      sourceDevice,
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
    if (merged.sourceDevice) params.set("sourceDevice", String(merged.sourceDevice));
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
    setBatchError(""); setBatchMessage("");
    await api("/api/v1/conversations/batch/project", {
      method: "POST",
      ...jsonBody({ conversationIds: [...selectedIds], projectId: batchProjectId || null }),
    });
    setBatchMessage(`已更新 ${selectedIds.size} 个会话的项目`);
    state.reload();
  }

  async function batchTags(operation: "add" | "remove") {
    if (!selectedIds.size || !batchTagId) return;
    setBatchError(""); setBatchMessage("");
    await api("/api/v1/conversations/batch/tags", {
      method: "POST",
      ...jsonBody({ conversationIds: [...selectedIds], tagIds: [batchTagId], operation }),
    });
    setBatchMessage(`已${operation === "add" ? "添加" : "移除"}标签`);
    state.reload();
  }

  async function batchExport(format: "csv" | "md" | "xlsx") {
    if (!selectedIds.size || batchExportFormat) return;
    const conversationIds = [...selectedIds];
    setBatchExportFormat(format);
    setBatchError("");
    setBatchMessage(`正在生成 ${conversationIds.length} 个会话的 ${format.toUpperCase()} 文件，内容较多时请稍候…`);
    try {
      await downloadResponse(
        `/api/v1/conversations/batch/export?format=${format}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationIds }),
        },
        `已选会话-${conversationIds.length}.${format}`,
      );
      setBatchMessage(`${format.toUpperCase()} 文件已生成并发起下载，请查看浏览器下载列表。`);
    } catch (reason) {
      setBatchMessage("");
      setBatchError(`导出失败：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setBatchExportFormat(null);
    }
  }

  return (
    <>
      <PageHeader title="会话" subtitle="主列表展示主会话，子代理收纳在所属会话中" actions={<div className="button-group"><Link className="button-link secondary small" to="/recapture">批量补采</Link><button className="secondary small" disabled={state.loading} onClick={() => { state.reload(); providerCountsState.reload(); sourceDevicesState.reload(); }}>刷新</button></div>} />
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
            <span>来源设备</span>
            <select value={sourceDevice} onChange={(event) => updateQuery({ sourceDevice: event.target.value, offset: 0 })}>
              <option value="">全部设备</option>
              {(sourceDevicesState.data ?? []).map((device) => <option key={device.key} value={device.key}>{device.name}（{formatCount(device.count)}）</option>)}
              {sourceDevice && sourceDevicesState.data && !sourceDevicesState.data.some(device => device.key === sourceDevice) && <option value={sourceDevice}>{sourceDeviceFilterLabel(sourceDevice)}</option>}
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
                if (saved?.query) setSearchParams(new URLSearchParams(Object.entries(saved.query).map(([key, value]) => [key, String(value)])));
              }}
            >
              <option value="">常用视图</option>
              {(savedSearchesState.data ?? []).map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}
            </select>
            <button className="secondary small" type="button" onClick={() => void saveCurrentSearch()}>保存当前搜索</button>
            <button className="ghost small" disabled={!selectedSavedSearchId} type="button" onClick={() => void deleteSavedSearch()}>删除视图</button>
            <span className="conversation-filter-summary">
              {activeFilterCount ? `已启用 ${activeFilterCount} 项筛选` : "当前显示主会话"}
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
          <div className="toolbar conversation-batch-toolbar" aria-label="会话批量操作">
            <div className="conversation-batch-group">
            <strong>{selectedIds.size} 个会话已选中</strong>
            <button className="secondary small" onClick={() => setSelectedIds(new Set(conversations.map((item) => String(item.id))))}>选择本页</button>
            <button className="secondary small" disabled={!selectedIds.size} onClick={() => setSelectedIds(new Set())}>清空</button>
            <button className="secondary small" disabled={!selectedIds.size} onClick={() => navigate("/recapture", { state: { conversationIds: [...selectedIds] } })}>补采已选会话</button>
            </div>
            <div className="conversation-batch-group">
            <select aria-label="批量设置项目" value={batchProjectId} onChange={(event) => setBatchProjectId(event.target.value)}>
              <option value="">待归类</option>
              {(projectsState.data ?? []).filter((project) => !project.archived).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
            </select>
            <button className="secondary small" disabled={!selectedIds.size} onClick={() => void batchProject().catch((reason) => setBatchError(String(reason)))}>设置项目</button>
            </div>
            <div className="conversation-batch-group">
            <select aria-label="批量操作标签" aria-describedby="batch-tag-help" value={batchTagId} onChange={(event) => setBatchTagId(event.target.value)}>
              <option value="">选择标签</option>
              {tags.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
            </select>
            <button className="secondary small" title={!selectedIds.size ? "请先勾选会话" : !batchTagId ? "请先选择要添加的标签" : "为已选会话添加此标签"} disabled={!selectedIds.size || !batchTagId} onClick={() => void batchTags("add").catch((reason) => setBatchError(String(reason)))}>添加标签</button>
            <button className="secondary small" title={!selectedIds.size ? "请先勾选会话" : !batchTagId ? "请先选择要移除的标签" : "从已选会话移除此标签"} disabled={!selectedIds.size || !batchTagId} onClick={() => void batchTags("remove").catch((reason) => setBatchError(String(reason)))}>移除标签</button>
            </div>
            <div className="conversation-batch-group" role="group" aria-label="导出已选会话" aria-busy={batchExportFormat !== null}>
            {(["csv", "md", "xlsx"] as const).map((format) => <button className="secondary small" key={format} title={!selectedIds.size ? "请先勾选会话" : `导出已选会话为 ${format.toUpperCase()}`} disabled={!selectedIds.size || batchExportFormat !== null} onClick={() => void batchExport(format)}>{batchExportFormat === format ? `正在生成 ${format.toUpperCase()}…` : `导出 ${format.toUpperCase()}`}</button>)}
            </div>
            <p id="batch-tag-help" className="conversation-batch-help">{!selectedIds.size ? "先勾选会话，再设置项目、操作标签或导出。" : !batchTagId ? "添加或移除标签前，请先在下拉框选择标签。导出无需选择标签。" : "添加或移除只针对已选标签；导出包含已勾选的会话。"}</p>
          </div>
          {batchMessage && <p className="conversation-batch-status" role="status">{batchMessage}</p>}
          <ErrorBanner message={batchError} />
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
                revision?.sourceContentPending ? "原文待核对" : ({ complete: "完整", partial: "不完整", failed: "失败" } as Record<
                  string,
                  string
                >)[String(revision?.completeness)] ?? "未归档";
              return (
                <div
                  className="conversation-compact-row"
                  key={conversation.id}
                >
                  <div className="conversation-compact-main">
                    <input
                      aria-label={`选择 ${conversation.title || conversation.externalSessionId}`}
                      checked={selectedIds.has(String(conversation.id))}
                      onChange={() => toggleSelected(String(conversation.id))}
                      type="checkbox"
                    />
                    <span className="provider-badge">
                      {providerLabels[conversation.provider as Provider]}
                    </span>
                    <div>
                      <div className="conversation-title-row">
                        <Link
                          className="conversation-main-link"
                          to={conversationArchiveHref(conversation.id, searchHit, q)}
                        >
                          <strong>{conversation.title || conversation.externalSessionId}</strong>
                        </Link>
                        <ConversationSubagentLink conversationId={conversation.id} childCount={conversation.childCount ?? 0} />
                      </div>
                      <code>{conversation.externalSessionId}</code>
                      {searchHit?.excerpt && <span className="search-hit"><b>{searchHit.reason}：</b>{searchHit.excerpt}</span>}
                      {Array.isArray(conversation.tags) && conversation.tags.length > 0 && (
                        <span className="conversation-tag-line">
                          {conversation.tags.map((tag) => tag.name).join(" · ")}
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
                    <span>累计 {revision?.messageCount ?? 0} 条</span>
                  </div>
                  <time>{new Date(conversation.updatedAt).toLocaleString()}</time>
                </div>
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
