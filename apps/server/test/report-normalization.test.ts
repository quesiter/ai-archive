import { describe, expect, it } from "vitest";
import {
  knowledgeTextNeedsChineseRewrite,
  normalizeConsolidationResponseInput,
  normalizeKnowledgeResponseInput,
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

describe("knowledge response normalization", () => {
  it("wraps top-level arrays and accepts common field aliases", () => {
    const result = normalizeKnowledgeResponseInput([
      {
        category: "requirement",
        name: "Backup export",
        content: "The web admin needs a downloadable backup file.",
        score: "80%",
        sources: ["message 2", { messageOrdinal: 5 }],
      },
    ]) as {
      items: Array<{
        type: string;
        title: string;
        body: string;
        confidence: number;
        sourceMessageOrdinals: number[];
      }>;
    };

    expect(result.items[0]).toMatchObject({
      type: "requirement",
      title: "Backup export",
      body: "The web admin needs a downloadable backup file.",
      confidence: 0.8,
      sourceMessageOrdinals: [2, 5],
    });
  });

  it("treats missing items as an empty extraction instead of a schema failure", () => {
    const result = normalizeKnowledgeResponseInput({
      kind: "weekly",
      note: "No durable knowledge found.",
    }) as { items: unknown[] };

    expect(result.items).toEqual([]);
  });

  it("uses a conservative ordinal fallback for otherwise valid items", () => {
    const result = normalizeKnowledgeResponseInput({
      knowledge: [
        {
          type: "risk",
          title: "Long queue",
          description: "Large archives may exceed the worker timeout.",
        },
      ],
    }) as { items: Array<{ sourceMessageOrdinals: number[]; type: string }> };

    expect(result.items[0]?.type).toBe("risk");
    expect(result.items[0]?.sourceMessageOrdinals).toEqual([0]);
  });

  it("accepts Chinese knowledge type names", () => {
    const result = normalizeKnowledgeResponseInput({
      items: [
        {
          category: "决策",
          title: "采用增量采集",
          body: "已有完整基线后优先上传新增回答。",
          sourceMessageOrdinals: [3],
        },
      ],
    }) as { items: Array<{ type: string }> };

    expect(result.items[0]?.type).toBe("decision");
  });

  it("detects untranslated English while allowing technical identifiers", () => {
    expect(
      knowledgeTextNeedsChineseRewrite(
        "Warehouse Shelf Management for Laptop Assets",
        "title",
      ),
    ).toBe(true);
    expect(
      knowledgeTextNeedsChineseRewrite(
        "Laptop assets require warehouse shelf location tracking and ordered slots.",
      ),
    ).toBe(true);
    expect(
      knowledgeTextNeedsChineseRewrite(
        "出库完成后自动清空 shelfLocation 字段，并保留 deliveryStatus 回调状态。",
      ),
    ).toBe(false);
  });
});
