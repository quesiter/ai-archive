import { describe, expect, it } from "vitest";
import {
  normalizeReportResponseInput,
  REPORT_SECTION_HEADINGS,
  reportResponseSchema,
  type ReportKind,
} from "../src/services/report-content.js";

function sections(kind: ReportKind = "weekly", content = "暂无相关记录。") {
  return REPORT_SECTION_HEADINGS[kind].map((heading) => ({ heading, content }));
}

function body(kind: ReportKind = "weekly", content = "暂无相关记录。") {
  return sections(kind, content).map((section) => `## ${section.heading}\n\n${section.content}`).join("\n\n");
}

function report(bodyMarkdown = body()) {
  return { title: "报告", summary: "本期材料有限。", bodyMarkdown };
}

describe("report content completeness", () => {
  it("accepts a short complete report without a minimum word count", () => {
    const input = report(body("weekly", "已发布。"));
    expect(input.bodyMarkdown.length).toBeLessThan(120);
    expect(reportResponseSchema("weekly").parse(input)).toEqual(input);
  });

  it.each(["暂无相关记录。", "未发现新增问题。", "暂无记录", "未发现", "没有相关记录。"])(
    "accepts an explicit absence of source material: %s", (content) => {
      expect(reportResponseSchema("weekly").safeParse(report(body("weekly", content))).success).toBe(true);
    },
  );

  it("allows the same explicit no-record finding in the summary and sections", () => {
    expect(reportResponseSchema("weekly").safeParse({
      ...report(body("weekly", "暂无记录。")), summary: "暂无记录。",
    }).success).toBe(true);
  });

  it("rejects a missing required section", () => {
    const result = reportResponseSchema("weekly").safeParse(report(body().replace("## 重要决定", "## 其他内容")));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.message)).toContain("报告正文缺少必需章节：重要决定");
  });

  it.each(["", "   ", "### 项目进展\n\n---", "** **", "![](https://example.com/image.png)"])(
    "rejects a section with no prose: %s", (content) => {
      expect(reportResponseSchema("weekly").safeParse(report(body().replace("暂无相关记录。", content))).success).toBe(false);
    },
  );

  it.each(["...", "……", "TODO", "- TODO: 补写此节", "**待补充**", "同上。", "TBD", "[ ] 待完善", "正文待补充"])(
    "rejects placeholder bodies and sections: %s", (placeholder) => {
      const schema = reportResponseSchema("weekly");
      expect(schema.safeParse(report(placeholder)).success).toBe(false);
      expect(schema.safeParse(report(body("weekly", placeholder))).success).toBe(false);
      expect(schema.safeParse(report(body().replace("暂无相关记录。", placeholder))).success).toBe(false);
    },
  );

  it("rejects a placeholder line mixed into otherwise substantive content", () => {
    expect(reportResponseSchema("weekly").safeParse(report(body().replace("暂无相关记录。", "已发布采集修复。\n\n- ..."))).success).toBe(false);
  });

  it("does not confuse ordinary mentions of TODO or an ellipsis with a placeholder", () => {
    expect(reportResponseSchema("weekly").safeParse(report(body("weekly", "讨论了 TODO 清单，暂未决定...需要复核。"))).success).toBe(true);
  });

  it("accepts a TODO with a substantive source task while rejecting unfinished report instructions", () => {
    expect(reportResponseSchema("weekly").safeParse(report(body("weekly", "- TODO: 排查采集故障。"))).success).toBe(true);
    expect(reportResponseSchema("weekly").safeParse(report(body("weekly", "- TODO: 待补充"))).success).toBe(false);
    expect(reportResponseSchema("weekly").safeParse(report(body("weekly", "- TODO: ..."))).success).toBe(false);
  });

  it("rejects a long summary with no body instead of fabricating one from the title", () => {
    const input = { title: "已完成多个项目。".repeat(20), summary: "本周完成多个项目并发布。".repeat(100) };
    expect(normalizeReportResponseInput(input)).toMatchObject({ bodyMarkdown: "" });
    expect(reportResponseSchema("weekly").safeParse(input).success).toBe(false);
  });

  it("rejects body paragraphs that only repeat the summary or title", () => {
    expect(reportResponseSchema("weekly").safeParse(report(body("weekly", "本期材料有限。"))).success).toBe(false);
    expect(reportResponseSchema("weekly").safeParse(report(body("weekly", "报告"))).success).toBe(false);
  });

  it("rejects repeated summaries split across lines even with a report period preamble", () => {
    expect(reportResponseSchema("weekly").safeParse({
      title: "报告",
      summary: "完成发布。修复采集。",
      bodyMarkdown: `> 报告周期：2026年9月7日—2026年9月13日\n\n${body("weekly", "完成发布。\n修复采集。")}`,
    }).success).toBe(false);
  });

  it("rejects oversized content without silently truncating it", () => {
    const input = report(body("weekly", "完成发布。".repeat(21_000)));
    expect((normalizeReportResponseInput(input) as { bodyMarkdown: string }).bodyMarkdown).toBe(input.bodyMarkdown);
    expect(reportResponseSchema("weekly").safeParse(input).success).toBe(false);
  });

  it("accepts whitespace, full-width punctuation and optional closing hashes in headings", () => {
    const text = REPORT_SECTION_HEADINGS.weekly.map((heading) => `  ## **${heading.split("").join(" ")}：** ##\n\n已发布。`).join("\n\n");
    expect(reportResponseSchema("weekly").safeParse(report(text)).success).toBe(true);
  });

  it.each(["```markdown\n", "~~~~\n"])("ignores fake headings inside a code fence: %s", (opening) => {
    const closing = opening.startsWith("`") ? "```" : "~~~~";
    expect(reportResponseSchema("weekly").safeParse(report(`${opening}${body()}\n${closing}`)).success).toBe(false);
  });

  it("does not allow a shorter fence to expose enclosed fake headings", () => {
    expect(reportResponseSchema("weekly").safeParse(report(`\`\`\`\`\`\n\`\`\`\n${body()}\n\`\`\`\`\``)).success).toBe(false);
  });

  it("ignores fake headings in comments and indented code", () => {
    expect(reportResponseSchema("weekly").safeParse(report(`<!-- ${body()} -->`)).success).toBe(false);
    expect(reportResponseSchema("weekly").safeParse(report(body().split("\n").map((line) => `    ${line}`).join("\n"))).success).toBe(false);
  });

  it("validates weekly and monthly requirements separately", () => {
    expect(reportResponseSchema("monthly").safeParse(report(body("monthly"))).success).toBe(true);
    expect(reportResponseSchema("weekly").safeParse(report(body("monthly"))).success).toBe(false);
    expect(reportResponseSchema("monthly").safeParse(report(body("weekly"))).success).toBe(false);
  });

  it("reports only fixed validation messages without echoing provider data", () => {
    const secret = "sk-secret-token-that-must-not-appear";
    const result = reportResponseSchema("weekly").safeParse({ title: secret, summary: secret, bodyMarkdown: `## ${secret}\n...` });
    expect(result.success).toBe(false);
    if (!result.success) expect(JSON.stringify(result.error)).not.toContain(secret);
  });
});

describe("report response normalization", () => {
  it("preserves legacy alias normalization without validating the content", () => {
    expect(normalizeReportResponseInput({ report: { headline: "周报", overview: "摘要", markdown: "## 内容" } }))
      .toMatchObject({ title: "周报", summary: "摘要", bodyMarkdown: "## 内容" });
    expect(normalizeReportResponseInput({ title: "报告", summary: "摘要", sections: [{ heading: "进展", content: "完成采集修复" }] }))
      .toMatchObject({ bodyMarkdown: "## 进展\n\n完成采集修复" });
  });

  it("uses complete sections when bodyMarkdown is only an ellipsis", () => {
    const parsed = reportResponseSchema("weekly").parse({ ...report("..."), sections: sections() });
    expect(parsed.bodyMarkdown).toBe(body());
  });

  it("uses complete sections when the initial body is missing one section", () => {
    expect(reportResponseSchema("weekly").parse({ ...report("## 本周主要讨论\n已发布"), sections: sections() }).bodyMarkdown).toBe(body());
  });

  it("chooses a valid body alias over an incomplete primary field", () => {
    expect(reportResponseSchema("weekly").parse({ ...report("..."), report_markdown: body() }).bodyMarkdown).toBe(body());
  });

  it("uses top-level sections or body aliases with wrapped metadata", () => {
    const wrapped = { report: { title: "周报", summary: "摘要", bodyMarkdown: "..." } };
    expect(reportResponseSchema("weekly").parse({ ...wrapped, sections: sections() }).bodyMarkdown).toBe(body());
    expect(reportResponseSchema("weekly").parse({ ...wrapped, content: body() }).bodyMarkdown).toBe(body());
  });

  it("selects candidates using the requested report kind", () => {
    const input = { ...report(body("monthly")), sections: sections("weekly") };
    expect(reportResponseSchema("weekly").parse(input).bodyMarkdown).toBe(body("weekly"));
    expect(reportResponseSchema("monthly").parse(input).bodyMarkdown).toBe(body("monthly"));
  });

  it("retains the primary field when multiple complete candidates exist", () => {
    const primary = body("weekly", "完成发布。");
    expect(reportResponseSchema("weekly").parse({ ...report(primary), sections: sections() }).bodyMarkdown).toBe(primary);
  });
});
