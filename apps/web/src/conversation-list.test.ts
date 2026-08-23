import { describe, expect, it } from "vitest";
import {
  buildConversationListSearch,
  countActiveConversationListFilters,
  type ConversationListQuery,
} from "./conversation-list.js";

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

  it("treats the end date as inclusive by sending the next local midnight", () => {
    const search = new URLSearchParams(buildConversationListSearch({
      ...baseQuery,
      from: "2026-08-01",
      to: "2026-08-23",
    }));
    const from = new Date(search.get("from")!);
    const to = new Date(search.get("to")!);
    expect(to.getTime() - from.getTime()).toBe(23 * 86_400_000);
  });

  it("counts active filters without treating pagination as a filter", () => {
    expect(countActiveConversationListFilters(baseQuery)).toBe(1);
    expect(countActiveConversationListFilters({
      ...baseQuery,
      offset: 400,
      source: "live",
      tagIds: "tag-a,tag-b",
      from: "2026-08-01",
      to: "2026-08-23",
    })).toBe(5);
  });
});
