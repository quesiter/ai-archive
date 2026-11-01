import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CaptureMessage } from "@ai-archive/contracts";
import { ConversationArchiveSummary, ConversationOtherCaptureContent, conversationArchiveHref, conversationMessageAnchor, withoutLegacyRevision, type ConversationArchiveReview } from "./conversation-archive.js";

function reviewedConversation() {
  const primary: CaptureMessage[] = Array.from({ length: 42 }, (_, index) => ({
    externalMessageId: `current-${index}`, ordinal: index === 0 ? 0 : index + 1,
    role: index % 2 ? "assistant" : "user", segments: [{ type: "text", content: `Current message ${index}` }],
  }));
  const inactive: CaptureMessage = { externalMessageId: "old-edit", ordinal: 1, role: "user", segments: [{ type: "text", content: "Earlier edited question" }] };
  const review: ConversationArchiveReview = {
    verifiedAt: "2026-09-14T07:00:00Z", fullyApplicable: true, storedMessageCount: 43,
    inactiveMessages: [inactive],
    resolvedObservations: Array.from({ length: 14 }, (_, index) => ({
      message: { externalMessageId: `current-${index}`, ordinal: primary[index]!.ordinal, role: "assistant", segments: [{ type: "text", content: `Reviewed observation ${index}` }] },
      kind: index === 0 ? "attachment_preview" : "map_rendering",
    })),
    unresolvedWarnings: [], unresolvedVariants: [],
  };
  return { primary, review };
}

describe("one accumulated conversation archive", () => {
  it("shows complete archive independently of unfinished source generation", () => {
    const { review } = reviewedConversation();
    review.contentComplete = false;
    review.captureComplete = true;
    const html = renderToStaticMarkup(<ConversationArchiveSummary messageCount={53} currentMessageCount={40} archiveReview={review}
      capturedAt="2026/10/8 08:44" status="完整" captureMode="完整采集" triggerReason="手动重采" sourceDevice="浏览器"
      reason="1 条原回答在源站未标记完成；已归档当前分支全部 40 条消息及源站返回的正文。" />);
    expect(html).toContain("归档状态</span><strong>已完整归档");
    expect(html).toContain("来源说明");
    expect(html).toContain("已归档当前分支全部 40 条消息");
    expect(html).not.toContain("原文待核对");
  });
  it("distinguishes verified native order from unfinished source content", () => {
    const { review } = reviewedConversation();
    review.contentComplete = false;
    const html = renderToStaticMarkup(<ConversationArchiveSummary messageCount={51} currentMessageCount={42} archiveReview={review}
      capturedAt="2026/10/7 22:53" status="部分完成" captureMode="完整采集" triggerReason="手动重采" sourceDevice="浏览器"
      reason="1 条在原会话中未标记完成" />);
    expect(html).toContain("累计消息</span><strong>42 条");
    expect(html).toContain("归档状态</span><strong>原文待核对");
    expect(html).toContain("当前分支全部 42 条消息及顺序已确认");
    expect(html).toContain("1 条在原会话中未标记完成");
    expect(html).not.toContain("归档状态</span><strong>已核对");
  });
  it("uses stored ordinals for search anchors after the reviewed transcript is reordered", () => {
    expect(conversationMessageAnchor({ ordinal: 0, storedOrdinal: 2 })).toBe("message-2");
    expect(conversationMessageAnchor({ ordinal: 4 })).toBe("message-4");
    const { review } = reviewedConversation();
    review.inactiveMessages[0]!.ordinal = 0;
    const html = renderToStaticMarkup(<ConversationOtherCaptureContent primaryMessages={[{ ordinal: 0, storedOrdinal: 2, role: "user", segments: [] }]}
      archiveReview={review} speakerLabel={() => "用户"} renderSegment={(segment, key) => <p key={key}>{segment.content}</p>} />);
    expect(html).toContain('id="message-0"');
    expect(html).not.toContain('id="message-2"');
  });

  it("links current search hits to their accumulated ordinals, including the first message", () => {
    expect(conversationArchiveHref("conversation", { messageOrdinal: 0 })).toBe("/conversations/conversation#message-0");
    expect(conversationArchiveHref("conversation", { messageOrdinal: 39 })).toBe("/conversations/conversation#message-39");
    expect(conversationArchiveHref("conversation", { messageOrdinal: null, reason: "子代理命中" })).toBe("/conversations/conversation#subagents");
    expect(conversationArchiveHref("conversation", { messageOrdinal: -1 })).toBe("/conversations/conversation");
  });

  it("opens a legacy snapshot link at the unified transcript without reusing its old ordinal", () => {
    expect(withoutLegacyRevision({ pathname: "/conversations/one", search: "?revisionId=old&q=travel", hash: "#message-3" })).toEqual({
      pathname: "/conversations/one", search: "?q=travel", hash: "",
    });
    expect(withoutLegacyRevision({ pathname: "/conversations/one", search: "?revisionId=old", hash: "#subagents" })).toEqual({
      pathname: "/conversations/one", search: "", hash: "#subagents",
    });
    expect(withoutLegacyRevision({ pathname: "/conversations/one", search: "", hash: "#message-3" })).toBeNull();
  });

  it("shows the accumulated count and the latest collection state without offering version selection", () => {
    const html = renderToStaticMarkup(<ConversationArchiveSummary messageCount={40} capturedAt="2026/9/14 12:30" status="部分完成" captureMode="增量" triggerReason="新增消息" sourceDevice="工作电脑" reason="部分内容尚未采集" />);
    expect(html).toContain("累计消息</span><strong>40 条");
    expect(html).toContain("最近采集</span><strong>2026/9/14 12:30");
    expect(html).toContain("归档状态</span><strong>部分完成");
    expect(html).toContain("部分内容尚未采集");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("比较");
  });

  it("shows 42 verified current messages while retaining the old edit and 14 reviewed observations", () => {
    const { primary, review } = reviewedConversation();
    const html = renderToStaticMarkup(<>
      <ConversationArchiveSummary messageCount={43} currentMessageCount={primary.length} archiveReview={review}
        capturedAt="2026/9/14 14:30" reviewedAt="2026/9/14 15:00" status="部分完成" captureMode="完整采集" triggerReason="手动重采" sourceDevice="浏览器"
        reason="accumulated_content_requires_review" />
      <ConversationOtherCaptureContent primaryMessages={primary} archiveReview={review}
        evidence={{ variants: review.resolvedObservations.map(item => item.message), warnings: [{ type: "order", messageIds: ["old-edit", "current-0"] }] }}
        speakerLabel={message => message.role === "user" ? "用户" : "AI"} renderSegment={(segment, key) => <p key={key}>{segment.content}</p>} />
    </>);
    expect(html).toContain("累计消息</span><strong>42 条");
    expect(html).toContain("归档状态</span><strong>已核对");
    expect(html).toContain("2026/9/14 15:00");
    expect(html).not.toContain("累计消息</span><strong>43 条");
    expect(html).not.toContain("部分片段顺序待核对");
    expect(html).not.toContain("其他采集内容");
    expect(html).not.toContain("累计采集内容存在差异或顺序疑点");
    expect(html).toContain("已保留的历史内容");
    expect(html).toContain("1 条历史消息 · 14 条已核对采集内容");
    expect(html).toContain("Earlier edited question");
    expect(html.match(/Reviewed observation \d+/g)).toHaveLength(14);
    expect(html).toContain('id="message-1"');
    expect(html).not.toContain('id="message-0"');
    expect(html).not.toContain('open=""');
    expect(html).toContain("不作为接续问答，无需逐条核对");
  });

  it("keeps new unresolved differences visible without presenting a partially applicable review as verified", () => {
    const { primary, review } = reviewedConversation();
    review.fullyApplicable = false;
    review.unresolvedWarnings = [{ type: "order", messageIds: ["new-answer"] }, { type: "content", messageIds: ["new-answer"] }];
    review.unresolvedVariants = [{ externalMessageId: "new-answer", ordinal: 43, role: "assistant", segments: [{ type: "text", content: "New difference still unresolved" }] }];
    const html = renderToStaticMarkup(<>
      <ConversationArchiveSummary messageCount={44} currentMessageCount={primary.length} archiveReview={review}
        capturedAt="2026/9/14 15:30" status="部分完成" captureMode="完整采集" triggerReason="手动重采" sourceDevice="浏览器"
        reason="accumulated_content_requires_review" />
      <ConversationOtherCaptureContent primaryMessages={primary} archiveReview={review} evidence={{ variants: [], warnings: [] }}
        speakerLabel={() => "AI"} renderSegment={(segment, key) => <p key={key}>{segment.content}</p>} />
    </>);
    expect(html).toContain("累计消息</span><strong>44 条");
    expect(html).toContain("归档状态</span><strong>部分完成");
    expect(html).not.toContain("归档状态</span><strong>已核对");
    expect(html).toContain("部分片段顺序待核对");
    expect(html).toContain("部分采集内容待核对");
    expect(html).toContain("其他采集内容");
    expect(html).toContain("New difference still unresolved");
    expect(html).toContain("1 条差异内容");
    expect(html).toContain("已保留的历史内容");
    expect(html.match(/Reviewed observation \d+/g)).toHaveLength(14);
  });

  it("does not hide an unresolved warning when there is no alternate body to display", () => {
    const { review } = reviewedConversation();
    review.inactiveMessages = [];
    review.resolvedObservations = [];
    review.fullyApplicable = false;
    review.unresolvedWarnings = [{ type: "source_mismatch", messageIds: ["unknown-id"] }];
    const html = renderToStaticMarkup(<ConversationOtherCaptureContent primaryMessages={[]} archiveReview={review}
      speakerLabel={() => "AI"} renderSegment={(segment, key) => <p key={key}>{segment.content}</p>} />);
    expect(html).toContain("部分采集内容待核对");
    expect(html).toContain("1 项采集疑点");
  });

  it.each([
    ["accumulated_content_requires_review", "累计采集内容存在差异或顺序疑点，请结合原会话核对。"],
    ["accumulated_capture_is_partial", "已保留累计内容，尚未确认会话完整性。"],
  ])("explains server archive reason %s in Chinese", (reason, explanation) => {
    const html = renderToStaticMarkup(<ConversationArchiveSummary messageCount={40} capturedAt="2026/9/14 12:30" status="部分完成" captureMode="增量" triggerReason="新增消息" sourceDevice="工作电脑" reason={reason} />);
    expect(html).toContain(explanation);
    expect(html).not.toContain(reason);
  });

  it.each(["order", "disconnected"])("keeps conflicting capture text collapsed and shows an ordering warning for %s", (type) => {
    const html = renderToStaticMarkup(<ConversationOtherCaptureContent primaryMessages={[]} evidence={{
      variants: [{ externalMessageId: "answer", ordinal: 1, role: "assistant", segments: [{ type: "text", content: "Earlier answer retained for review" }] }],
      warnings: [{ type, messageIds: ["question", "answer"] }],
    }} speakerLabel={() => "AI"} renderSegment={(segment, key) => <p key={key}>{segment.content}</p>} />);
    expect(html).toContain("部分片段顺序待核对");
    expect(html).toContain("其他采集内容");
    expect(html).toContain("Earlier answer retained for review");
    expect(html).toContain("不计入累计消息数，也不表示连续问答");
    expect(html).not.toContain('open=""');
    expect(html).not.toContain('id="message-');
  });

  it("retains alternate content without claiming its message order is uncertain", () => {
    const html = renderToStaticMarkup(<ConversationOtherCaptureContent primaryMessages={[]} evidence={{
      variants: [{ externalMessageId: "answer", ordinal: 1, role: "assistant", segments: [{ type: "text", content: "Earlier answer retained for review" }] }],
      warnings: [{ type: "content", messageIds: ["answer"] }],
    }} speakerLabel={() => "AI"} renderSegment={(segment, key) => <p key={key}>{segment.content}</p>} />);
    expect(html).toContain("其他采集内容");
    expect(html).toContain("Earlier answer retained for review");
    expect(html).toContain("正文存在差异");
    expect(html).not.toContain("部分片段顺序待核对");
  });

  it("hides metadata-only evidence and repeated variants while retaining distinct bodies", () => {
    const primary = [{ ordinal: 0, role: "assistant" as const, segments: [{ type: "text" as const, content: "Stored reply\nsecond line" }] }];
    const variant = { ordinal: 1, role: "assistant" as const, segments: [{ type: "text" as const, content: "Different earlier reply" }] };
    const evidence = { variants: [
      { ...primary[0]!, model: "other-model", createdAt: "2026-09-14T01:00:00Z", segments: [{ type: "text" as const, content: "Stored reply\r\nsecond line" }] },
      variant,
      { ...variant, model: "another-model", createdAt: "2026-09-14T02:00:00Z" },
    ] };
    const before = JSON.stringify({ primary, evidence });
    const html = renderToStaticMarkup(<ConversationOtherCaptureContent primaryMessages={primary} evidence={evidence}
      speakerLabel={() => "AI"} renderSegment={(segment, key) => <p key={key}>{segment.content}</p>} />);
    expect(html).not.toContain("Stored reply");
    expect(html.match(/Different earlier reply/g)).toHaveLength(1);
    expect(html).toContain("1 条差异内容");
    expect(JSON.stringify({ primary, evidence })).toBe(before);
  });

  it.each(["externalMessageId", "role", "type", "href", "language"])("retains evidence when %s changes", (field) => {
    const primary = { externalMessageId: "answer", ordinal: 0, role: "assistant" as const,
      segments: [{ type: "code" as const, content: "Same visible characters", href: "https://example.com/one", language: "ts" }] };
    const variant = { ...primary,
      ...(field === "externalMessageId" ? { externalMessageId: "another-answer" } : {}),
      ...(field === "role" ? { role: "user" as const } : {}),
      segments: [{ ...primary.segments[0]!,
        ...(field === "type" ? { type: "text" as const } : {}),
        ...(field === "href" ? { href: "https://example.com/two" } : {}),
        ...(field === "language" ? { language: "js" } : {}),
      }],
    };
    const html = renderToStaticMarkup(<ConversationOtherCaptureContent primaryMessages={[primary]} evidence={{ variants: [variant] }}
      speakerLabel={() => "AI"} renderSegment={(segment, key) => <p key={key}>{segment.content}</p>} />);
    expect(html).toContain("Same visible characters");
    expect(html).toContain("1 条差异内容");
  });
});
