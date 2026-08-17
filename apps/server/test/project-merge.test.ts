import { describe, expect, it } from "vitest";
import { mergeSourceReferences } from "../src/services/project-merge.js";

describe("mergeSourceReferences", () => {
  it("deduplicates references while preserving both projects' sources", () => {
    const first = {
      conversationId: "c1",
      revisionId: "r1",
      messageOrdinal: 1,
    };
    const second = {
      conversationId: "c2",
      revisionId: "r2",
      messageOrdinal: 4,
    };
    expect(mergeSourceReferences([first], [first, second])).toEqual([
      first,
      second,
    ]);
  });
});
