import MarkdownIt from "markdown-it";
import { parse } from "node-html-parser";
import { withReportTitlePrefix } from "./report-title.js";

export function escapeEmailHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const markdown = new MarkdownIt({ html: false, breaks: true });
markdown.validateLink = (value) => {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};
// Match the web report: show image descriptions without loading remote content.
markdown.renderer.rules.image = (tokens, index) => escapeEmailHtml(tokens[index]!.content);

const elementStyles: Record<string, string> = {
  h1: "margin: 28px 0 14px; font-size: 24px; line-height: 1.4; color: #162d49; font-weight: 700;",
  h2: "margin: 30px 0 14px; padding: 0 0 10px; border-bottom: 2px solid #dbe7f4; font-size: 21px; line-height: 1.5; color: #163e67; font-weight: 700;",
  h3: "margin: 22px 0 10px; font-size: 17px; line-height: 1.5; color: #203b58; font-weight: 700;",
  h4: "margin: 18px 0 8px; font-size: 16px; line-height: 1.5; color: #203b58; font-weight: 700;",
  h5: "margin: 16px 0 8px; font-size: 15px; line-height: 1.5; font-weight: 700;",
  h6: "margin: 16px 0 8px; font-size: 15px; line-height: 1.5; font-weight: 700;",
  p: "margin: 0 0 14px; line-height: 1.8;",
  ul: "margin: 0 0 16px; padding-left: 26px; list-style-type: disc;",
  ol: "margin: 0 0 16px; padding-left: 26px; list-style-type: decimal;",
  li: "margin: 0 0 8px; line-height: 1.8;",
  blockquote: "margin: 16px 0; padding: 12px 16px; border-left: 4px solid #5c80aa; background-color: #f1f5fa; color: #465b72;",
  strong: "font-weight: 700; color: #162d49;",
  a: "color: #1762ae; text-decoration: underline; word-break: break-all;",
  code: "padding: 2px 4px; border-radius: 3px; background-color: #f1f4f8; font-family: Consolas, Menlo, monospace; font-size: 13px; overflow-wrap: anywhere;",
  pre: "margin: 16px 0; padding: 14px; border: 1px solid #dfe5ec; background-color: #f6f8fa; white-space: pre-wrap; word-wrap: break-word; line-height: 1.6;",
  table: "width: 100%; margin: 16px 0; border-collapse: collapse; font-size: 14px;",
  th: "padding: 10px 12px; border: 1px solid #d8e1eb; background-color: #edf3f9; text-align: left; font-weight: 700; line-height: 1.6;",
  td: "padding: 10px 12px; border: 1px solid #d8e1eb; text-align: left; vertical-align: top; line-height: 1.6;",
  hr: "margin: 24px 0; border: 0; border-top: 1px solid #dfe5ec;",
};

function renderMarkdown(markdownBody: string): string {
  // Only parser-generated elements reach this tree; source HTML is escaped above.
  const root = parse(markdown.render(markdownBody));
  for (const element of root.querySelectorAll("*")) {
    const style = elementStyles[element.tagName.toLowerCase()];
    if (style) {
      // Preserve the parser's table column alignment after applying our defaults.
      const existingStyle = element.getAttribute("style");
      element.setAttribute("style", `${style}${existingStyle ? ` ${existingStyle}` : ""}`);
    }
  }
  return root.toString();
}

export function renderReportEmailHtml(input: {
  title: string;
  bodyMarkdown: string;
  reportUrl: string;
}): string {
  const title = escapeEmailHtml(withReportTitlePrefix(input.title));
  const reportUrl = escapeEmailHtml(input.reportUrl);
  // Use real block elements and inline styles: webmail may strip style blocks/classes.
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body style="margin: 0; padding: 0; background-color: #f3f6fa; color: #273649; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', Arial, sans-serif; font-size: 15px; line-height: 1.8;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse: collapse; background-color: #f3f6fa;">
<tr><td align="center" style="padding: 24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width: 880px; table-layout: fixed; border-collapse: collapse; background-color: #ffffff; border: 1px solid #dfe5ec; color: #273649; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', Arial, sans-serif;">
<tr><td style="padding: 24px 28px; border-top: 4px solid #245a8d; border-bottom: 1px solid #dfe5ec;">
<p style="margin: 0 0 8px; color: #62758b; font-size: 13px;">知言归藏 · 报告</p>
<h1 style="margin: 0; color: #162d49; font-size: 24px; line-height: 1.5; font-weight: 700;">${title}</h1>
</td></tr>
<tr><td style="padding: 4px 28px 20px; font-size: 15px; line-height: 1.8; overflow-wrap: anywhere; word-wrap: break-word;">${renderMarkdown(input.bodyMarkdown)}</td></tr>
<tr><td style="padding: 20px 28px; border-top: 1px solid #dfe5ec; background-color: #f8fafc;">
<a href="${reportUrl}" style="display: inline-block; padding: 10px 18px; border: 1px solid #245a8d; border-radius: 4px; background-color: #245a8d; color: #ffffff; font-size: 14px; text-decoration: none;">在线查看报告</a>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}
