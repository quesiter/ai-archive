import { describe, expect, it } from "vitest";
import { analysisWindow } from "../src/services/analysis.js";

describe("analysisWindow", () => {
  it("uses the previous Shanghai calendar week", () => {
    const result = analysisWindow("weekly", new Date("2026-07-13T02:30:00.000Z"));
    expect(result.windowStart.toISOString()).toBe("2026-07-05T16:00:00.000Z");
    expect(result.windowEnd.toISOString()).toBe("2026-07-12T16:00:00.000Z");
  });

  it("uses the previous Shanghai calendar month", () => {
    const result = analysisWindow("monthly", new Date("2026-07-01T00:00:00.000Z"));
    expect(result.windowStart.toISOString()).toBe("2026-05-31T16:00:00.000Z");
    expect(result.windowEnd.toISOString()).toBe("2026-06-30T16:00:00.000Z");
  });
});
