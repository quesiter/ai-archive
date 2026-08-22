import { describe, expect, it } from "vitest";
import { buildConversationListSearch, type ConversationListQuery } from "./conversation-list.js";

const baseQuery: ConversationListQuery = {
  limit: 100,
  offset: 0,
  q: "",
  provider: "chatgpt",
  source: "",
  completeness: "",
  captureMode: "",
  projectId: "",
  tagIds: "",
  from: "",
  to: "",
};

describe("buildConversationListSearch", () => {
  it("creates the shared refresh key for the list and provider counts", () => {
    expect(buildConversationListSearch(baseQuery)).toBe(
      "limit=100&offset=0&provider=chatgpt",
    );
  });

  it("changes whenever pagination or a filter changes", () => {
    const initial = buildConversationListSearch(baseQuery);
    expect(buildConversationListSearch({ ...baseQuery, offset: 300 })).not.toBe(initial);
    expect(buildConversationListSearch({ ...baseQuery, q: "history" })).not.toBe(initial);
    expect(buildConversationListSearch({ ...baseQuery, from: "2026-08-01" })).not.toBe(initial);
  });
});
