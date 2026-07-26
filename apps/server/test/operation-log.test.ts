import { describe, expect, it } from "vitest";
import { normalizeLogMetadata } from "../src/services/operation-log.js";

describe("normalizeLogMetadata", () => {
  it("truncates large strings and limits nested arrays", () => {
    const result = normalizeLogMetadata({
      message: "x".repeat(2_000),
      items: Array.from({ length: 20 }, (_, index) => ({ index })),
    }) as { message: string; items: unknown[] };

    expect(result.message.length).toBeLessThan(1_600);
    expect(result.message).toContain("truncated");
    expect(result.items).toHaveLength(12);
  });

  it("serializes dates and bigints into json-safe values", () => {
    const result = normalizeLogMetadata({
      at: new Date("2026-07-25T00:00:00.000Z"),
      count: 12n,
    }) as { at: string; count: string };

    expect(result.at).toBe("2026-07-25T00:00:00.000Z");
    expect(result.count).toBe("12");
  });
});
