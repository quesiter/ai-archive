import type { ArchivedSegment, ArchivedMessage, ConversationDetailResponse, ProjectOption, Tag } from "../api-types.js";
import { ConversationEvidence } from "../conversation-evidence.js";
import { conversationMessageQuery, conversationPageSearch, fallbackMessagePagination, messageTargetOrdinal, conversationTargetInEvidence } from "../conversation-pagination.js";
import { FormEvent, useEffect, useState } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router-dom";
import { providerLabels, stripInternalConversationMetadata } from "@ai-archive/contracts/presentation";
import type { Provider } from "@ai-archive/contracts";
import { api, jsonBody } from "../api.js";
import { sourceDeviceLabel } from "../source-device.js";
import { ConversationArchiveSummary, conversationMessageAnchor, withoutLegacyRevision } from "../conversation-archive.js";
import { ConversationParentLink, ConversationSubagents } from "../conversation-lineage.js";
import { useLoad, Loading, ErrorBanner, Pagination, PageHeader, statusLabel, captureModeLabels, triggerReasonLabels, formatTaskTime, ExportLinks, safeExternalHref } from "../shared-ui.js";

export function speakerLabel(message: Pick<ArchivedMessage, "role" | "model">): string {
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

export function segmentLabel(type: unknown): string {
  const labels: Record<string, string> = {
    reasoning: "思考摘要",
    tool_status: "工具过程",
    code: "代码",
    citation: "引用",
  };
  return labels[String(type)] ?? String(type);
}

export function messageTime(value: unknown): string {
  if (typeof value !== "string") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

export function cleanSegmentContent(segment: ArchivedSegment): string {
  return stripInternalConversationMetadata(String(segment.content ?? ""));
}


export function renderSegment(segment: ArchivedSegment, key: string) {
  const content = cleanSegmentContent(segment);
  if (!content) return null;
  const href = safeExternalHref(segment.href);
  return <div key={key} className={`segment ${segment.type}`}>
    {segment.type !== "text" && <small className="segment-label">{segmentLabel(segment.type)}</small>}
    {segment.type === "code" ? <pre><code>{content}</code></pre> : href ? <a href={href} target="_blank" rel="noopener noreferrer">{content}</a> : <p>{content}</p>}
  </div>;
}

export function ConversationDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const legacyLocation = withoutLegacyRevision(location);
  const messageQuery = conversationMessageQuery(location.search, legacyLocation ? "" : location.hash);
  const state = useLoad(() => api<ConversationDetailResponse>(`/api/v1/conversations/${id}?${messageQuery}`), [id, messageQuery]);
  const projectsState = useLoad(() => api<ProjectOption[]>("/api/v1/projects/options"), []);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (!legacyLocation && !state.loading && location.hash) {
      const match = location.hash.match(/^#message-(\d+)$/);
      if (match?.[1]) {
        requestAnimationFrame(() => {
          const target = document.getElementById(`message-${match[1]}`);
          for (let parent = target?.parentElement; parent; parent = parent.parentElement) {
            if (parent instanceof HTMLDetailsElement) parent.open = true;
          }
          target?.scrollIntoView({ block: "center" });
        });
      }
    }
  }, [state.loading, state.data, location.hash, location.search]);

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

  async function toggleConversationTag(tag: Tag) {
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

  async function removeConversationTag(tag: Tag) {
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

  if (legacyLocation) return <Navigate to={legacyLocation} replace />;
  if (state.loading) return <Loading />;
  if (state.error) return <ErrorBanner message={state.error} />;
  const data = state.data!;
  const archive = data.selectedRevision;
  const pagination = data.messagePagination ?? fallbackMessagePagination(data.messages.length);
  const targetOrdinal = messageTargetOrdinal(location.hash);
  const searchQuery = new URLSearchParams(location.search).get("q") ?? "";
  const evidenceTarget = conversationTargetInEvidence(data.messages, targetOrdinal, searchQuery) ? targetOrdinal : undefined;
  function changeMessageOffset(offset: number): void {
    navigate({ pathname: location.pathname, search: conversationPageSearch(location.search, offset), hash: "" });
  }
  const archiveReview = data.archiveReview;
  const displayMessages = data.messages.flatMap((message) => {
    const segments = Array.isArray(message.segments) ? message.segments : [];
    const processSegments = segments.filter((segment) => segment.type === "tool_status" || segment.type === "reasoning");
    const contentSegments = segments.filter((segment) => segment.type !== "tool_status" && segment.type !== "reasoning" && cleanSegmentContent(segment));
    const isCodexInternal = data.conversation.provider === "codex" && (message.role === "tool" || message.role === "system");
    if (!contentSegments.length && !processSegments.length) return [];
    return [{ ...message, contentSegments, processSegments, isCodexInternal }];
  });
  const canonicalUrl = safeExternalHref(data.conversation.canonicalUrl);
  return <><ConversationParentLink parent={data.parentConversation ?? null} /><PageHeader title={data.conversation.title || "未命名会话"} subtitle={`${providerLabels[data.conversation.provider as Provider]} · ${data.conversation.externalSessionId}`} actions={<div className="button-group"><ExportLinks path={`/api/v1/conversations/${id}/export`} />{canonicalUrl && <a className="button-link" href={canonicalUrl} target="_blank" rel="noopener noreferrer">打开原会话</a>}<button className="danger" onClick={() => void removeConversation()}>移入回收站</button></div>} />
    <ErrorBanner message={actionError} />
    <ConversationSubagents key={id} conversations={data.childConversations ?? []} formatTime={formatTaskTime} />
    <div className="toolbar conversation-detail-toolbar"><label>项目（选择后人工锁定） <select disabled={projectsState.loading} value={data.projectAssignment?.projectId ?? ""} onChange={(event) => void assignProject(event.target.value)}><option value="">待归类</option>{projectsState.data?.filter((project) => !project.archived || project.id === data.projectAssignment?.projectId).map((project) => <option key={project.id} value={project.id}>{project.name}{project.archived ? "（已归档）" : ""}</option>)}</select></label>{data.projectAssignment?.lockedByUser ? <><span className="pill complete">人工锁定</span><button className="secondary small" onClick={() => void releaseProjectLock()}>交还 AI 调整</button></> : <span className="pill">AI 可动态调整</span>}</div>
    <section className="panel conversation-tags-panel">
      <div className="section-title-row">
        <div><h2>标签</h2><p className="panel-subtitle">人工标签默认锁定；自动整理不会覆盖人工或已锁定关联。</p></div>
        <form className="inline-form" onSubmit={addConversationTag}>
          <input name="name" placeholder="新增标签" required />
          <button>添加</button>
        </form>
      </div>
      <div className="conversation-tag-editor">
        {(data.tags ?? []).map((tag: Tag) => (
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
    {archive && <ConversationArchiveSummary
      messageCount={archive.messageCount ?? data.messages.length}
      capturedAt={formatTaskTime(archive.capturedAt)}
      status={statusLabel(archive.completeness)}
      captureMode={captureModeLabels[String(archive.captureMode)] ?? archive.captureMode}
      triggerReason={triggerReasonLabels[String(archive.triggerReason)] ?? "未记录"}
      sourceDevice={sourceDeviceLabel(archive)}
      reason={archive.completenessReason ?? ""}
      archiveReview={archiveReview}
      manualCompletion={archive.mergeEvidence?.manualCompletion}
      currentMessageCount={pagination.total}
      reviewedAt={archiveReview ? formatTaskTime(archiveReview.verifiedAt) : undefined}
    />}
    <Pagination pagination={pagination} onOffsetChange={changeMessageOffset} />
    <section className="transcript">{displayMessages.map((message, index) => {
      const previous = index > 0 ? displayMessages[index - 1] : undefined;
      const sameSpeaker = Boolean(previous && previous.role === message.role);
      const sourceTimestamp = messageTime(message.sourceCreatedAt);
      const archivedTimestamp = messageTime(message.createdAt);
      const timestamp = sourceTimestamp || (archivedTimestamp ? `发送时间未知 · 入库 ${archivedTimestamp}` : "发送时间未知");
      if (message.isCodexInternal) return <details id={conversationMessageAnchor(message)} className="tool-details hidden-process" key={message.id}>
        <summary><span>Codex 工具链信息已隐藏</span><small>消息 #{message.ordinal} · 点击查看</small></summary>
        <div className="message-segments">{[...message.contentSegments, ...message.processSegments].map((segment, segmentIndex) => renderSegment(segment, segment.id ?? `${message.id}-process-${segmentIndex}`))}</div>
      </details>;
      return <article id={conversationMessageAnchor(message)} className={`message ${message.role} ${sameSpeaker ? "same-speaker" : "speaker-start"}`} key={message.id}>
        {!sameSpeaker && <header className="message-header"><span className="speaker-chip">{speakerLabel(message)}</span><span className="message-meta">#{message.ordinal}{timestamp ? ` · ${timestamp}` : ""}</span></header>}
        <div className="message-segments">{message.contentSegments.map((segment, segmentIndex) => renderSegment(segment, segment.id ?? `${message.id}-${segmentIndex}`))}</div>
        {message.processSegments.length > 0 && <details className="tool-details inline-process">
          <summary><span>过程信息已折叠</span><small>{message.processSegments.length} 段 · 点击查看</small></summary>
          <div className="message-segments">{message.processSegments.map((segment, segmentIndex) => renderSegment(segment, segment.id ?? `${message.id}-process-${segmentIndex}`))}</div>
        </details>}
      </article>;
    })}</section>
    <Pagination pagination={pagination} onOffsetChange={changeMessageOffset} />
    <ConversationEvidence key={id} conversationId={id!} revisionId={archive?.id} targetOrdinal={evidenceTarget} searchQuery={searchQuery} primaryMessageOrdinals={data.messages.map(message => message.storedOrdinal ?? message.ordinal)} renderSegment={renderSegment} speakerLabel={speakerLabel} />
  </>;
}


