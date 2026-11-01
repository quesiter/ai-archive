import { describe, expect, it, vi } from "vitest";
import { chunkSearchContent } from "../src/services/search-chunks.js";
import { extractCjkTerms, cjkQueryTerms, isShortCjkQuery, usesFullTextSearch } from "../src/services/search-documents.js";
vi.mock("../src/db.js", () => ({db:{}}));
describe("conversation search documents", () => {
  it("retains exact CJK characters and pairs without crossing punctuation or chunk boundaries", () => {
    const terms = extractCjkTerms("项目\u0001测试 项，目 𠀀项目");
    expect(terms).toContain("项目"); expect(terms).toContain("测试"); expect(terms).toContain("𠀀项");
    expect(terms).not.toContain("目测"); expect(terms).not.toContain("试项");
    expect(isShortCjkQuery("𠀀项")).toBe(true); expect(isShortCjkQuery("项目组")).toBe(false);
  });
  it("uses all unique overlapping query pairs, including supplementary characters", () => {
    expect(cjkQueryTerms("归档项目")).toEqual(["归档", "档项", "项目"]);
    expect(cjkQueryTerms("项目项目")).toEqual(["项目", "目项"]);
    expect(cjkQueryTerms("𠀀项目")).toEqual(["𠀀项", "项目"]);
    expect(cjkQueryTerms("项")).toEqual(["项"]);
  });
  it("keeps English AND/OR and phrase fallback while excluding CJK-only queries", () => {
    expect(usesFullTextSearch("AI ML")).toBe(true); expect(usesFullTextSearch('"foo bar"')).toBe(true);
    expect(usesFullTextSearch("项目 OR 报告")).toBe(true); expect(usesFullTextSearch("项目")).toBe(false);
  });
  it("does not synthesize pairs across actual chunk boundaries", () => {
    const terms = new Set(chunkSearchContent("x".repeat(3999)+"项目").flatMap(extractCjkTerms));
    expect(terms.has("项目")).toBe(false);
    expect(terms.has("项")).toBe(true); expect(terms.has("目")).toBe(true);
  });
});
