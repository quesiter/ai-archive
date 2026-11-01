import { conversationArchiveHref } from "./conversation-archive.js";
import { describe, expect, it } from "vitest";
import { conversationMessageQuery, conversationPageSearch, messageTargetOrdinal, conversationTargetInEvidence } from "./conversation-pagination.js";

describe("bounded conversation windows", () => {
  it("requests only the matched message window for a search link", () => {
    expect(Object.fromEntries(new URLSearchParams(conversationMessageQuery("", "#message-1537"))))
      .toEqual({ messageLimit: "50", messageOffset: "0", messageOrdinal: "1537" });
  });

  it("keeps a browsed window in the URL and leaves unrelated parameters intact", () => {
    const search = conversationPageSearch("?revisionId=old&q=needle", 100);
    expect(new URLSearchParams(search).get("revisionId")).toBeNull();
    expect(new URLSearchParams(search).get("q")).toBe("needle");
    expect(Object.fromEntries(new URLSearchParams(conversationMessageQuery(search, ""))))
      .toEqual({ messageLimit: "50", messageOffset: "100" });
  });

  it.each(["-1", "1.5", "NaN", "Infinity", "9007199254740992"])("rejects an invalid window offset %s", offset => {
    expect(new URLSearchParams(conversationMessageQuery(`?messageOffset=${offset}`, "")).get("messageOffset")).toBe("0");
  });

  it("accepts ordinal zero and ignores non-message or unsafe anchors", () => {
    expect(messageTargetOrdinal("#message-0")).toBe(0);
    expect(messageTargetOrdinal("#subagents")).toBeUndefined();
    expect(messageTargetOrdinal("#message-9007199254740992")).toBeUndefined();
    expect(new URLSearchParams(conversationMessageQuery("", "#subagents")).has("messageOrdinal")).toBe(false);
  });
});


describe("search targets in historical observations", () => {
  const messages = [{ ordinal: 0, storedOrdinal: 1537, segments: [{ content: "Current answer" }] }];

  it("preserves the literal search text alongside the stored ordinal link", () => {
    expect(conversationArchiveHref("conversation", { messageOrdinal: 1537, reason: "正文命中" }, "a%b + 中文"))
      .toBe("/conversations/conversation?q=a%25b+%2B+%E4%B8%AD%E6%96%87#message-1537");
    expect(conversationArchiveHref("conversation", { reason: "标题命中" }, "title"))
      .toBe("/conversations/conversation");
  });

  it("loads evidence when the matching chunk belongs to a variant of the current message", () => {
    expect(conversationTargetInEvidence(messages, 1537, "historical answer")).toBe(true);
    expect(conversationTargetInEvidence(messages, 1537, "CURRENT answer")).toBe(false);
    expect(conversationTargetInEvidence(messages, 1537, "")).toBe(false);
    expect(conversationTargetInEvidence(messages, 1500, "")).toBe(true);
    expect(conversationTargetInEvidence(messages, undefined, "query")).toBe(false);
  });
});
