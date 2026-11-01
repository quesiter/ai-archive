import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ArchivedMessage, ArchivedSegment, ConversationEvidenceResponse } from "./api-types.js";
import { api } from "./api.js";
import { messageContainsSearchText } from "./conversation-pagination.js";
import { conversationMessageAnchor } from "./conversation-archive.js";
import { ErrorBanner, Loading, Pagination, useLoad } from "./shared-ui.js";

const reviewedLabels: Record<string, string> = {
  map_rendering: "地图控件显示内容", partial_rendering: "页面未完整显示时的采集片段",
  attachment_preview: "附件预览内容", source_text: "原会话正文核对前的采集内容",
};

export function ConversationEvidence({ conversationId, revisionId, targetOrdinal, searchQuery = "", primaryMessageOrdinals = [], renderSegment, speakerLabel }: {
  conversationId: string;
  revisionId?: string | undefined;
  targetOrdinal?: number | undefined;
  searchQuery?: string;
  primaryMessageOrdinals?: readonly number[];
  renderSegment: (segment: ArchivedSegment, key: string) => ReactNode;
  speakerLabel: (message: ArchivedMessage) => string;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(targetOrdinal !== undefined);
  const [offset, setOffset] = useState<number | null>(null);
  useEffect(() => {
    setOffset(null);
    if (targetOrdinal !== undefined) setOpen(true);
  }, [conversationId, revisionId, targetOrdinal, searchQuery]);
  const query = new URLSearchParams({ limit: "50", offset: String(offset ?? 0) });
  if (offset === null && targetOrdinal !== undefined) query.set("messageOrdinal", String(targetOrdinal));
  if (offset === null && searchQuery.trim()) query.set("q", searchQuery.trim().slice(0, 500));
  const state = useLoad(() => open
    ? api<ConversationEvidenceResponse>(`/api/v1/conversations/${conversationId}/evidence?${query}`)
    : Promise.resolve(null), [conversationId, revisionId, open, query.toString()]);
  useEffect(() => {
    if (!open || state.loading || targetOrdinal === undefined) return;
    const frame = requestAnimationFrame(() => {
      const selector = searchQuery.trim() ? '[data-search-match="true"]' : `[data-message-ordinal="${targetOrdinal}"]`;
      const target = detailsRef.current?.querySelector<HTMLElement>(selector) ?? detailsRef.current;
      target?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, state.loading, state.data, targetOrdinal, searchQuery]);
  const anchoredOrdinals = new Set(primaryMessageOrdinals);
  const warningCount = state.data?.warningCount ?? state.data?.warnings.length ?? 0;
  return <details className="panel other-capture-details" ref={detailsRef} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>其他采集与历史内容{state.data ? `（${state.data.pagination.total} 条）` : ""}</summary>
    <p className="panel-subtitle">展开后分批读取保留的差异、历史消息和已核对片段，不计入当前正文。</p>
    {open && <>
      {state.loading ? <Loading label="加载历史内容…" /> : state.error ? <><ErrorBanner message={state.error} /><button type="button" className="secondary small" onClick={state.reload}>重试</button></> : <>
        {warningCount > 0 && <p className="alert warning" role="status">仍有 {warningCount} 项采集疑点，请结合原会话核对。</p>}
        <div className="stack">{state.data?.items.map((item, index) => {
          const ordinal = item.message.storedOrdinal ?? item.message.ordinal;
          const anchor = anchoredOrdinals.has(ordinal) ? undefined : conversationMessageAnchor(item.message);
          anchoredOrdinals.add(ordinal);
          return <article
          className="capture-variant" id={anchor} data-message-ordinal={ordinal} data-search-match={searchQuery.trim() && messageContainsSearchText(item.message, searchQuery) ? "true" : undefined} key={`${item.kind}-${item.message.ordinal}-${index}`}>
          <strong>{speakerLabel(item.message)} · {item.kind === "inactive" ? "历史消息" : item.kind === "variant" ? "差异内容" : `${reviewedLabels[item.reviewKind ?? ""] ?? "采集内容"} · 已核对`} · #{item.message.ordinal}</strong>
          <div className="message-segments">{item.message.segments.map((segment, segmentIndex) => renderSegment(segment, `evidence-${index}-${segmentIndex}`))}</div>
        </article>; })}</div>
        {!state.data?.items.length && <p className="muted">没有额外保留的采集内容。</p>}
      </>}
      <Pagination loading={state.loading} pagination={state.data?.pagination} onOffsetChange={setOffset} />
    </>}
  </details>;
}
