import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";
import { renderReportEmailHtml } from "../src/services/report-email.js";

const reportUrl = "https://archive.example.test/reports/report-1";

function render(bodyMarkdown: string, title = "周报（2026年10月5日—2026年10月11日）") {
  return renderReportEmailHtml({ title, bodyMarkdown, reportUrl });
}

describe("report email HTML", () => {
  it("renders report sections and lists as separate HTML blocks even without styles", () => {
    const html = render([
      "> 报告周期：2026年10月5日—2026年10月11日",
      "",
      "## 本周主要讨论",
      "",
      "### 家庭数字相框",
      "",
      "完成 **照片同步** 和 `NAS` 连接。",
      "",
      "- 修复登录状态",
      "- 恢复照片预览",
      "",
      "## 下阶段关注点",
      "",
      "1. 验证远程恢复",
      "2. 检查日志轮转",
    ].join("\n"));
    // Mail clients may remove CSS; actual block structure must carry the layout.
    const document = parse(html.replace(/\sstyle="[^"]*"/gi, ""));

    expect(document.querySelectorAll("h2").map((node) => node.text)).toEqual(["本周主要讨论", "下阶段关注点"]);
    expect(document.querySelector("h3")?.text).toBe("家庭数字相框");
    expect(document.querySelector("blockquote")?.text).toContain("报告周期：");
    expect(document.querySelector("p strong")?.text).toBe("照片同步");
    expect(document.querySelector("p code")?.text).toBe("NAS");
    expect(document.querySelectorAll("ul > li").map((node) => node.text.trim())).toEqual(["修复登录状态", "恢复照片预览"]);
    expect(document.querySelectorAll("ol > li").map((node) => node.text.trim())).toEqual(["验证远程恢复", "检查日志轮转"]);
    expect(document.querySelector("a")?.getAttribute("href")).toBe(reportUrl);
  });

  it("renders fenced code and tables with their content intact", () => {
    const document = parse(render([
      "```ts",
      "const ready = count < 3 && enabled;",
      "console.log(ready);",
      "```",
      "",
      "| 项目 | 状态 |",
      "| --- | --- |",
      "| NAS | 已完成 |",
      "| 相框 | 待验证 |",
    ].join("\n")), { blockTextElements: { script: true, style: true } });

    expect(document.querySelector("pre > code")?.text).toBe("const ready = count < 3 && enabled;\nconsole.log(ready);\n");
    expect(document.querySelectorAll("table:not([role]) th").map((node) => node.text)).toEqual(["项目", "状态"]);
    expect(document.querySelectorAll("table:not([role]) td").map((node) => node.text)).toEqual(["NAS", "已完成", "相框", "待验证"]);
    expect(document.querySelector("table:not([role])")?.getAttribute("style")).toBeTruthy();
  });

  it("keeps CRLF soft line breaks visible and distinct paragraphs separate", () => {
    const document = parse(render("## 关键变化\r\n\r\n第一行进展\r\n第二行进展\r\n\r\n独立说明段落"));
    const firstParagraph = document.querySelectorAll("p").find((node) => node.text.includes("第一行进展"));
    const secondParagraph = document.querySelectorAll("p").find((node) => node.text.includes("独立说明段落"));

    expect(document.querySelector("h2")?.text).toBe("关键变化");
    expect(firstParagraph?.querySelectorAll("br")).toHaveLength(1);
    expect(firstParagraph?.text).toContain("第二行进展");
    expect(secondParagraph).toBeDefined();
    expect(secondParagraph).not.toBe(firstParagraph);
  });

  it("escapes raw HTML and accepts only absolute HTTP and HTTPS links", () => {
    const document = parse(render([
      '<script>alert("unsafe")</script>',
      "",
      '<img src="https://tracker.example.test/pixel" onerror="alert(1)">',
      "",
      "[安全链接](https://example.test/details?a=1&b=2)",
      "",
      "[HTTP 链接](http://example.test/details)",
      "",
      "[脚本](javascript:alert%281%29) [数据](data:text/html,unsafe)",
      "",
      "[相对路径](/settings) [协议相对](//tracker.example.test/pixel) [邮件](mailto:someone@example.test)",
    ].join("\n")));

    expect(document.querySelectorAll("script, img, iframe, object, embed")).toHaveLength(0);
    expect(document.text).toContain('<script>alert("unsafe")</script>');
    expect(document.querySelectorAll("a").map((node) => node.getAttribute("href"))).toEqual([
      "https://example.test/details?a=1&b=2",
      "http://example.test/details",
      reportUrl,
    ]);
    expect(document.text).toContain("相对路径");
    expect(document.text).toContain("协议相对");
  });

  it("shows image descriptions without loading remote or embedded images", () => {
    const document = parse(render("![照片预览](https://tracker.example.test/image.png)\n\n![内嵌图](data:image/png;base64,AAAA)"));

    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.text).toContain("照片预览");
    expect(document.text).toContain("内嵌图");
  });

  it("preserves long report bodies and treats the report title as text", () => {
    const title = '<img src="x" onerror="alert(1)"> 周报 & "验证"';
    const content = "完整报告内容".repeat(5_000);
    const document = parse(render(`## 完整正文\n\n${content}\n\n报告末尾标记`, title));

    expect(document.querySelector("h1")?.text).toBe(`【知言归藏】${title}`);
    expect(document.querySelectorAll("img, script")).toHaveLength(0);
    expect(document.text).toContain(content);
    expect(document.text).toContain("报告末尾标记");
  });
});
