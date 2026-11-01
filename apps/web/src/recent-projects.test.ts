import { describe, expect, it } from "vitest";
import { recentActiveProjects } from "./recent-projects";

describe("recent active projects", () => {
  it("excludes inactive large projects and ranks by activity rather than archive size", () => {
    const projects = [
      { projectName: "large inactive", conversationCount: 105, growth7d: 0, latestActivityAt: "2026-10-07" },
      { projectName: "older active", conversationCount: 99, growth7d: 10, latestActivityAt: "2026-10-05" },
      { projectName: "latest active", conversationCount: 2, growth7d: 1, latestActivityAt: "2026-10-07" },
    ];
    expect(recentActiveProjects(projects).map(project => project.projectName))
      .toEqual(["latest active", "older active"]);
    expect(projects[0]?.projectName).toBe("large inactive");
  });

  it("handles invalid dates, numeric strings and an empty active period", () => {
    expect(recentActiveProjects([
      { projectName: "unknown", growth7d: "1", latestActivityAt: "invalid" },
      { projectName: "known", growth7d: 1, latestActivityAt: "2026-10-07" },
      { projectName: "missing" },
    ]).map(project => project.projectName)).toEqual(["known", "unknown"]);
    expect(recentActiveProjects([{ growth7d: 0 }])).toEqual([]);
  });
});
