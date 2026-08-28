import { describe, expect, it } from "vitest";
import {
  isReusableTagName,
  isProtectedConversationTag,
  mergeConversationTagState,
  normalizeTagName,
  normalizeTagSuggestions,
} from "../src/services/tags.js";

describe("tag normalization", () => {
  it("uses NFKC, whitespace folding, and case-insensitive identity", () => {
    expect(normalizeTagName("  ＴｙｐｅＳｃｒｉｐｔ  ")).toEqual({
      name: "TypeScript",
      normalizedName: "typescript",
    });
    expect(normalizeTagName("TypeScript").normalizedName).toBe(
      normalizeTagName("typescript").normalizedName,
    );
    expect(normalizeTagName("AI 工具开发与自动化")).toEqual({
      name: "AI工具开发与自动化",
      normalizedName: "ai工具开发与自动化",
    });
    expect(normalizeTagName("工具 AI").normalizedName).toBe(
      normalizeTagName("工具AI").normalizedName,
    );
  });

  it("rejects sentences and keeps only the strongest reusable suggestion", () => {
    expect(isReusableTagName("这是一个不应成为标签的完整句子。 ")).toBe(false);
    expect(isReusableTagName("b7aff412-0230-43e2-b893-2ad7d567fe36")).toBe(false);
    expect(
      normalizeTagSuggestions([
        { name: "React", confidence: 0.6 },
        { name: "ｒｅａｃｔ", confidence: 0.88 },
        { name: "AI 工具开发与自动化", confidence: 0.75 },
        { name: "AI工具开发与自动化", confidence: 0.82 },
        { name: "18d0da13-1278-47fc-842d-2587d7ed88cf", confidence: 0.99 },
        { name: "弱标签", confidence: 0.1 },
      ]),
    ).toEqual([
      { name: "react", confidence: 0.88 },
      { name: "AI工具开发与自动化", confidence: 0.82 },
    ]);
  });

  it("caps the number of automatic tags", () => {
    const suggestions = Array.from({ length: 20 }, (_, index) => ({
      name: `标签${index}`,
      confidence: 0.9 - index / 100,
    }));
    expect(normalizeTagSuggestions(suggestions)).toHaveLength(10);
  });

  it("protects manual and locked links from automatic replacement", () => {
    expect(isProtectedConversationTag({ source: "manual", lockedByUser: false })).toBe(true);
    expect(isProtectedConversationTag({ source: "auto", lockedByUser: true })).toBe(true);
    expect(isProtectedConversationTag({ source: "auto", lockedByUser: false })).toBe(false);
  });

  it("merges duplicate tag links without losing manual or lock state", () => {
    expect(
      mergeConversationTagState(
        { confidence: 0.7, source: "auto", lockedByUser: true },
        { confidence: 1, source: "manual", lockedByUser: false },
      ),
    ).toEqual({ confidence: 1, source: "manual", lockedByUser: true });
  });
});
