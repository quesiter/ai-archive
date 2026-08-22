import { describe, expect, it } from "vitest";
import {
  normalizeReportResponseInput,
  reportSourcePayload,
  reportSystemPrompt,
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

  it("builds markdown from section arrays when body markdown is absent", () => {
    const result = normalizeReportResponseInput({
      title: "报告",
      summary: "摘要",
      sections: [{ heading: "进展", content: "完成采集修复" }],
    }) as { bodyMarkdown: string };

    expect(result.bodyMarkdown).toContain("## 进展");
    expect(result.bodyMarkdown).toContain("完成采集修复");
  });

  it("builds weekly reports directly from conversation, project, tag, and body data", () => {
    const windowStart = new Date("2026-08-10T16:00:00.000Z");
    const windowEnd = new Date("2026-08-17T16:00:00.000Z");
    const payload = JSON.parse(reportSourcePayload({
      windowStart,
      windowEnd,
      conversations: [{
        conversationId: "conversation-1",
        revisionId: "revision-1",
        projectName: "知言归藏",
        tags: ["NAS", "归档"],
        content: "完成标签体系重构",
      }],
    })) as Record<string, unknown>;

    expect(payload).toEqual({
      period: { start: windowStart.toISOString(), end: windowEnd.toISOString() },
      conversations: [{
        conversationId: "conversation-1",
        revisionId: "revision-1",
        projectName: "知言归藏",
        tags: ["NAS", "归档"],
        content: "完成标签体系重构",
      }],
      weeklyReports: [],
    });
    expect(reportSystemPrompt("weekly", windowStart, windowEnd)).toContain("按项目组织，注明相关标签");
    expect(JSON.stringify(payload)).not.toMatch(/knowledge/i);
  });

  it("lets monthly reports reuse weekly reports alongside raw conversation materials", () => {
    const windowStart = new Date("2026-07-31T16:00:00.000Z");
    const windowEnd = new Date("2026-08-31T16:00:00.000Z");
    const payload = JSON.parse(reportSourcePayload({
      windowStart,
      windowEnd,
      conversations: [{ projectName: "知言归藏", tags: ["搜索"] }],
      weeklyReports: [{ title: "周报", summary: "本周完成检索重构" }],
    })) as { weeklyReports: unknown[] };

    expect(payload.weeklyReports).toHaveLength(1);
    expect(reportSystemPrompt("monthly", windowStart, windowEnd)).toContain("归档会话、项目、标签与周报材料");
  });
});
