import { describe, expect, it } from "vitest";
import {
  analysisWindow,
  enforceWeeklyReportPeriod,
  weeklyReportPeriodLabel,
} from "../src/services/analysis.js";

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

  it("formats the weekly period as an inclusive Shanghai date range", () => {
    const { windowStart, windowEnd } = analysisWindow(
      "weekly",
      new Date("2026-08-22T02:30:00.000Z"),
    );
    expect(weeklyReportPeriodLabel(windowStart, windowEnd)).toBe(
      "2026年8月10日—2026年8月16日",
    );
  });

  it("enforces an exact weekly period in generated report content", () => {
    const { windowStart, windowEnd } = analysisWindow(
      "weekly",
      new Date("2026-08-22T02:30:00.000Z"),
    );
    const report = enforceWeeklyReportPeriod(
      {
        title: "8月中旬周报",
        summary: "8月中旬完成了采集修复。",
        bodyMarkdown: "## 本周概览\n\n8月中旬完成了采集修复。",
      },
      windowStart,
      windowEnd,
    );

    expect(report.title).toBe("周报（2026年8月10日—2026年8月16日）");
    expect(report.summary).toBe("2026年8月10日—2026年8月16日完成了采集修复。");
    expect(report.bodyMarkdown).toContain(
      "> 报告周期：2026年8月10日—2026年8月16日",
    );
    expect(report.bodyMarkdown).not.toContain("8月中旬");
  });
});
