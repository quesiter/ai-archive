import type { ReactNode } from "react";
import type { CaptureMessage } from "@ai-archive/contracts";

const archiveReasonLabels: Record<string, string> = {
  accumulated_content_requires_review: "累计采集内容存在差异或顺序疑点，请结合原会话核对。",
  accumulated_capture_is_partial: "已保留累计内容，尚未确认会话完整性。",
};

type CaptureBody = {
  ordinal?: number;
  storedOrdinal?: number | null;
  externalMessageId?: string | null | undefined;
  role: string;
  segments: ReadonlyArray<{ type: string; content: string; href?: string | null | undefined; language?: string | null | undefined }>;
};

export function conversationMessageAnchor(message: { ordinal: number; storedOrdinal?: number | null }): string {
  return `message-${message.storedOrdinal ?? message.ordinal}`;
}

export interface ConversationArchiveReviewSummary {
  verifiedAt: string;
  fullyApplicable: boolean;
  contentComplete?: boolean;
  captureComplete?: boolean;
  reviewedOrderApplicable?: boolean;
  storedMessageCount: number;
  inactiveMessageCount?: number;
  resolvedObservationCount?: number;
  unresolvedVariantCount?: number;
  unresolvedWarningCount?: number;
}

export interface ConversationArchiveReview extends ConversationArchiveReviewSummary {
  inactiveMessages: CaptureMessage[];
  resolvedObservations: Array<{
    message: CaptureMessage;
    kind: "map_rendering" | "partial_rendering" | "attachment_preview" | "source_text";
  }>;
  unresolvedWarnings: Array<{ type: string; messageIds: string[] }>;
  unresolvedVariants: CaptureMessage[];
}

const reviewedContentLabels: Record<ConversationArchiveReview["resolvedObservations"][number]["kind"], string> = {
  map_rendering: "地图控件显示内容",
  partial_rendering: "页面未完整显示时的采集片段",
  attachment_preview: "附件预览内容",
  source_text: "原会话正文核对前的采集内容",
};

function captureBodyKey(message: CaptureBody): string {
  return JSON.stringify([message.externalMessageId ?? null, message.role, message.segments.map(segment => [
    segment.type, segment.content.replace(/\r+\n/g, "\n"), segment.href ?? null, segment.language ?? null,
  ])]);
}

function distinctOtherCaptureMessages(primary: readonly CaptureBody[], variants: readonly CaptureMessage[]): CaptureMessage[] {
  const byBody = new Map<string, CaptureMessage>();
  for (const variant of variants) {
    const key = captureBodyKey(variant);
    if (!byBody.has(key)) byBody.set(key, variant);
  }
  for (const message of primary) {
    if (!byBody.size) break;
    byBody.delete(captureBodyKey(message));
  }
  return [...byBody.values()];
}

export function conversationArchiveHref(conversationId: string, hit?: {
  messageOrdinal?: number | null;
  reason?: string;
} | null, searchQuery?: string): string {
  const ordinal = hit?.messageOrdinal;
  const anchor = typeof ordinal === "number" && Number.isSafeInteger(ordinal) && ordinal >= 0
    ? `#message-${ordinal}` : hit?.reason === "子代理命中" ? "#subagents" : "";
  const query = anchor.startsWith("#message-") && searchQuery?.trim()
    ? `?${new URLSearchParams({ q: searchQuery.trim() })}` : "";
  return `/conversations/${conversationId}${query}${anchor}`;
}

export function withoutLegacyRevision(location: { pathname: string; search: string; hash: string }) {
  const query = new URLSearchParams(location.search);
  if (!query.has("revisionId")) return null;
  query.delete("revisionId");
  const search = query.toString();
  return {
    pathname: location.pathname,
    search: search ? `?${search}` : "",
    // Ordinals in old links belong to an earlier snapshot, so they cannot
    // identify the corresponding message in the accumulated transcript.
    hash: location.hash.startsWith("#message-") ? "" : location.hash,
  };
}

export function ConversationArchiveSummary({
  messageCount,
  capturedAt,
  status,
  captureMode,
  triggerReason,
  sourceDevice,
  reason,
  archiveReview,
  currentMessageCount,
  reviewedAt,
  manualCompletion,
}: {
  messageCount: number;
  capturedAt: string;
  status: string;
  captureMode: string;
  triggerReason: string;
  sourceDevice: string;
  reason?: string;
  archiveReview?: ConversationArchiveReviewSummary | undefined;
  currentMessageCount?: number;
  reviewedAt?: string | undefined;
  manualCompletion?: {
    version?: number;
    source?: string;
    sourceVerified?: boolean;
    reason?: string;
    confirmedAt?: string;
  } | undefined;
}) {
  const manuallyCompleted = status === "完整" && manualCompletion?.version === 1 &&
    manualCompletion.source === "user_acceptance" && manualCompletion.sourceVerified === false &&
    manualCompletion.reason === "source_unavailable_user_accepted";
  const orderReviewed = archiveReview?.reviewedOrderApplicable === true || archiveReview?.fullyApplicable === true;
  const fullyReviewed = archiveReview?.fullyApplicable === true && archiveReview?.contentComplete !== false;
  const captureComplete = archiveReview?.fullyApplicable === true && archiveReview.captureComplete === true;
  const displayedCount = orderReviewed ? currentMessageCount ?? messageCount : messageCount;
  return <section className="archive-meta-grid" aria-label="会话累计归档">
    <div><span>累计消息</span><strong>{displayedCount} 条</strong></div>
    <div><span>最近采集</span><strong>{capturedAt || "未记录"}</strong></div>
    <div><span>归档状态</span><strong>{manuallyCompleted ? "人工确认完整" : captureComplete ? "已完整归档" : fullyReviewed ? "已核对" : orderReviewed ? "原文待核对" : status}</strong></div>
    <div><span>最近采集模式</span><strong>{captureMode}</strong></div>
    <div><span>触发原因</span><strong>{triggerReason}</strong></div>
    <div><span>来源设备</span><strong>{sourceDevice}</strong></div>
    {manuallyCompleted && <div className="wide"><span>人工确认</span><strong>原会话已删除或无法访问，用户已接受现有归档并停止补采。现有正文及原始缺失记录保留；这不表示重新取得了源站全文。</strong></div>}
    {fullyReviewed && <div className="wide"><span>原会话核对</span><strong>{reviewedAt || archiveReview.verifiedAt} · 当前正文已核对，历史内容另行保留。</strong></div>}
    {orderReviewed && !fullyReviewed && <div className="wide"><span>原会话核对</span><strong>当前分支全部 {displayedCount} 条消息及顺序已确认，历史内容另行保留。</strong></div>}
    {!fullyReviewed && reason && <div className="wide"><span>{captureComplete ? "来源说明" : "原因说明"}</span><strong>{archiveReasonLabels[reason] ?? reason}</strong></div>}
  </section>;
}

export function ConversationOtherCaptureContent({ primaryMessages, evidence, archiveReview, renderSegment, speakerLabel }: {
  primaryMessages: readonly CaptureBody[];
  evidence?: {
    variants?: CaptureMessage[];
    warnings?: Array<{ type: string; messageIds: string[] }>;
  } | null;
  archiveReview?: ConversationArchiveReview | undefined;
  renderSegment: (segment: CaptureMessage["segments"][number], key: string) => ReactNode;
  speakerLabel: (message: CaptureMessage) => string;
}) {
  // Stored model/source-time observations remain in evidence. Only distinct
  // bodies belong in this display; the primary transcript is never deduplicated.
  const variants = archiveReview?.unresolvedVariants ?? distinctOtherCaptureMessages(primaryMessages, evidence?.variants ?? []);
  const warnings = archiveReview?.unresolvedWarnings ?? evidence?.warnings ?? [];
  const hasOrderWarning = warnings.some(warning => warning.type === "order" || warning.type === "disconnected");
  const otherWarningCount = archiveReview ? warnings.filter(warning => warning.type !== "order" && warning.type !== "disconnected").length : 0;
  const inactive = archiveReview?.inactiveMessages ?? [];
  const resolved = archiveReview?.resolvedObservations ?? [];
  const historyCount = inactive.length + resolved.length;
  const primaryOrdinals = new Set(primaryMessages.map(message => message.storedOrdinal ?? message.ordinal));
  if (!variants.length && !hasOrderWarning && !otherWarningCount && !historyCount) return null;
  return <section className="other-capture-content">
    {hasOrderWarning && <p className="alert warning" role="status"><strong>部分片段顺序待核对</strong>：采集片段之间存在无法确认的先后关系，请结合原会话核对。</p>}
    {otherWarningCount > 0 && <p className="alert warning" role="status"><strong>部分采集内容待核对</strong>：仍有 {otherWarningCount} 项采集疑点尚未得到原会话证据确认。</p>}
    {variants.length > 0 && <details className="panel other-capture-details">
      <summary>其他采集内容 <span className="pill">{variants.length} 条差异内容</span></summary>
      <p className="panel-subtitle">这些片段与已归档消息的正文存在差异，单独保留供核对，不计入累计消息数，也不表示连续问答。</p>
      <div className="stack">{variants.map((message, index) => <article className="capture-variant" key={`${message.externalMessageId ?? "variant"}-${index}`}>
        <strong>{speakerLabel(message)} · 差异内容 {index + 1}</strong>
        <div className="message-segments">{message.segments.map((segment, segmentIndex) => renderSegment(segment, `variant-${index}-${segmentIndex}`))}</div>
      </article>)}</div>
    </details>}
    {historyCount > 0 && <details className="panel other-capture-details">
      <summary>已保留的历史内容 <span className="pill">{inactive.length} 条历史消息 · {resolved.length} 条已核对采集内容</span></summary>
      <p className="panel-subtitle">这些内容包括当前分支以外的历史消息和先前采集片段。内容仍完整保留，不计入当前正文，也不作为接续问答，无需逐条核对。</p>
      <div className="stack">
        {inactive.map((message, index) => <article
          id={!primaryOrdinals.has(message.ordinal) ? conversationMessageAnchor(message) : undefined}
          className="capture-variant" key={`inactive-${message.externalMessageId ?? message.ordinal}-${index}`}>
          <strong>{speakerLabel(message)} · 历史消息 · #{message.ordinal}</strong>
          <div className="message-segments">{message.segments.map((segment, segmentIndex) => renderSegment(segment, `inactive-${index}-${segmentIndex}`))}</div>
        </article>)}
        {resolved.map(({ message, kind }, index) => <article className="capture-variant" key={`resolved-${message.externalMessageId ?? "observation"}-${index}`}>
          <strong>{speakerLabel(message)} · {reviewedContentLabels[kind]} · 已核对</strong>
          <div className="message-segments">{message.segments.map((segment, segmentIndex) => renderSegment(segment, `resolved-${index}-${segmentIndex}`))}</div>
        </article>)}
      </div>
    </details>}
  </section>;
}
