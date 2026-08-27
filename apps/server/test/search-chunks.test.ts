import { describe, expect, it } from "vitest";
import { chunkSearchContent } from "../src/services/search-chunks.js";

describe("conversation search chunks", () => {
  it("keeps the complete message text in bounded rebuildable chunks", () => {
    const source = `  ${"甲".repeat(8_100)}  `;
    const chunks = chunkSearchContent(source, 4_000);
    expect(chunks.map((chunk) => chunk.length)).toEqual([4_000, 4_000, 100]);
    expect(chunks.join("")).toBe(source.trim());
  });

  it("does not create empty chunks", () => {
    expect(chunkSearchContent(" \n ")).toEqual([]);
  });
});
