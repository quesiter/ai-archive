import { describe, expect, it } from "vitest";
import { escapeLikePattern, literalContainsPattern } from "../src/services/search-pattern.js";

describe("literal ILIKE search patterns", () => {
  it("escapes SQL wildcard and escape characters", () => {
    expect(escapeLikePattern("100%_done\\ok")).toBe("100\\%\\_done\\\\ok");
    expect(literalContainsPattern("100%")).toBe("%100\\%%");
  });
});
