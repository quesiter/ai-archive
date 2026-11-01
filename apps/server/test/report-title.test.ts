import { describe, expect, it } from "vitest";
import {
  REPORT_TITLE_PREFIX,
  withReportTitlePrefix,
} from "../src/services/report-title.js";

describe("report title prefix", () => {
  it("uses the requested brand prefix", () => {
    expect(REPORT_TITLE_PREFIX).toBe("【知言归藏】");
  });

  it.each([
    "周报（2026年10月12日—2026年10月18日）",
    "月报（2026年9月）",
  ])("prefixes %s without changing its period", (title) => {
    expect(withReportTitlePrefix(title)).toBe(`【知言归藏】${title}`);
  });

  it("trims surrounding whitespace", () => {
    expect(withReportTitlePrefix(" \n\t月报（2026年9月） \n"))
      .toBe("【知言归藏】月报（2026年9月）");
  });

  it("is idempotent for titles already carrying the prefix", () => {
    const title = "【知言归藏】周报（2026年10月12日—2026年10月18日）";
    expect(withReportTitlePrefix(title)).toBe(title);
    expect(withReportTitlePrefix(withReportTitlePrefix(title))).toBe(title);
  });

  it("collapses repeated leading prefixes and separating whitespace", () => {
    expect(withReportTitlePrefix(" \t【知言归藏】 \n【知言归藏】【知言归藏】\t 月报（2026年9月） \n"))
      .toBe("【知言归藏】月报（2026年9月）");
  });

  it("preserves internal occurrences of the brand", () => {
    const title = "周报：【知言归藏】项目发布与后续计划";
    expect(withReportTitlePrefix(title)).toBe(`【知言归藏】${title}`);
  });
});
