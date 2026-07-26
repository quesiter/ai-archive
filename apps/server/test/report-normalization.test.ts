import { describe, expect, it } from "vitest";
import {
  normalizeConsolidationResponseInput,
  normalizeReportResponseInput,
} from "../src/services/analysis.js";

describe("report response normalization", () => {
  it("unwraps report objects and accepts body aliases", () => {
    const result = normalizeReportResponseInput({
      report: {
        headline: "周报",
        overview: "摘要",
        markdown: "## 内容",
      },
    }) as { title: string; summary: string; bodyMarkdown: string };

    expect(result.title).toBe("周报");
    expect(result.summary).toBe("摘要");
    expect(result.bodyMarkdown).toBe("## 内容");
  });

  it("treats missing monthly status updates as an empty array", () => {
    const result = normalizeConsolidationResponseInput({
      title: "月报",
      summary: "摘要",
      body: "## 月度内容",
    }) as {
      statusUpdates: unknown[];
      report: { title: string; bodyMarkdown: string };
    };

    expect(result.statusUpdates).toEqual([]);
    expect(result.report.title).toBe("月报");
    expect(result.report.bodyMarkdown).toBe("## 月度内容");
  });

  it("builds markdown from section arrays when body markdown is absent", () => {
    const result = normalizeReportResponseInput({
      title: "报告",
      summary: "摘要",
      sections: [{ heading: "进展", content: "完成采集修复" }],
    }) as { bodyMarkdown: string };

    expect(result.bodyMarkdown).toContain("## 进展");
    expect(result.bodyMarkdown).toContain("完成采集修复");
  });
});
