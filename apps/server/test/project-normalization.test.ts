import { describe, expect, it } from "vitest";
import { normalizeProjectName } from "../src/services/projects.js";

describe("project name normalization", () => {
  it("normalizes Unicode width, trims, and collapses whitespace", () => {
    expect(normalizeProjectName("  Ｐｒｏｊｅｃｔ　A  ")).toEqual({
      name: "Project A",
      normalizedName: "project a",
    });
  });

  it("makes whitespace-only names empty for validation", () => {
    expect(normalizeProjectName(" \t　\n ").name).toBe("");
  });
});
