import { describe, expect, it } from "vitest";
import {
  buildConversationSearchHit,
  conversationIdsMatchingAllTags,
  searchExcerpt,
} from "../src/services/conversation-search.js";

describe("conversation search helpers", () => {
  it("returns a bounded excerpt around a body match", () => {
    const excerpt = searchExcerpt(`${"前".repeat(90)}目标词${"后".repeat(120)}`, "目标词");
    expect(excerpt).toContain("目标词");
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("applies AND semantics for multiple tag filters", () => {
    const links = [
      { conversationId: "both", tagId: "a" },
      { conversationId: "both", tagId: "b" },
      { conversationId: "one", tagId: "a" },
      { conversationId: "other", tagId: "c" },
    ];
    expect(conversationIdsMatchingAllTags(links, ["a", "b"])).toEqual(["both"]);
  });

  it("distinguishes title hits from body hits and keeps exact message coordinates", () => {
    expect(buildConversationSearchHit({
      query: "归档",
      title: "AI 归档设计",
      titleMatched: true,
      latestRevisionId: "latest",
    })).toMatchObject({ reason: "标题命中", revisionId: "latest", messageOrdinal: null });
    expect(buildConversationSearchHit({
      query: "归档",
      title: "其他标题",
      titleMatched: false,
      latestRevisionId: "latest",
      bodyHit: { revisionId: "matched", ordinal: 7, content: "这里讨论归档策略" },
    })).toMatchObject({ reason: "正文命中", revisionId: "matched", messageOrdinal: 7 });
  });
});
