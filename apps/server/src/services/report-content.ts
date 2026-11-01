import { z } from "zod";

export type ReportKind = "weekly" | "monthly";

export type ReportResponse = {
  title: string;
  summary: string;
  bodyMarkdown: string;
};

export const REPORT_SECTION_HEADINGS = {
  weekly: ["本周主要讨论", "关键变化", "重要决定", "尚未解决", "下阶段关注点"],
  monthly: ["本月概览", "项目演进", "关键变化与决定", "未解决问题", "下月关注点"],
} as const;

const BODY_KEYS = [
  "bodyMarkdown", "body_markdown", "reportMarkdown", "report_markdown",
  "markdown", "content", "body", "text",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function textValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || /^(null|none|n\/a|undefined)$/i.test(trimmed)) return null;
  return trimmed;
}

function firstText(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = textValue(record[key]);
    if (value) return value;
  }
  return null;
}

function excerptText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const headLength = Math.ceil(limit * 0.7);
  const tailLength = limit - headLength;
  return `${value.slice(0, headLength)}\n\n[...省略 ${value.length - limit} 个字符...]\n\n${value.slice(-tailLength)}`;
}

function sectionMarkdown(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const sections = value.map((item) => {
    if (typeof item === "string") return item.trim();
    if (!isRecord(item)) return "";
    const heading = firstText(item, ["title", "heading", "name"]);
    const body = firstText(item, BODY_KEYS);
    return [heading ? `## ${heading.replace(/^#{1,6}\s+/, "")}` : "", body ?? ""]
      .filter(Boolean).join("\n\n");
  }).filter(Boolean);
  return sections.length ? sections.join("\n\n") : null;
}

function normalizedHeading(value: string): string {
  return value.normalize("NFKC").trim()
    .replace(/\s+#+\s*$/, "")
    .replace(/^[*_]+|[*_]+$/g, "")
    .replace(/[：:]\s*$/, "")
    .replace(/\s+/g, "");
}

// Fenced examples and HTML comments must not manufacture the required sections.
function visibleMarkdownLines(markdown: string): string[] {
  let fence: { marker: string; length: number } | null = null;
  return markdown.replace(/<!--[\s\S]*?(?:-->|$)/g, "").split(/\r?\n/).flatMap((line) => {
    if (fence) {
      const closing = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) {
        fence = null;
      }
      return [];
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (opening) {
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      return [];
    }
    return [line];
  });
}

function proseLine(value: string): string {
  return value.trim()
    .replace(/^(?:>\s*)+/, "")
    .replace(/^(?:[-+*]|\d+[.)、])\s+/, "")
    .replace(/^\[[ xX]\]\s*/, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .trim();
}

function compactProse(value: string): string {
  return proseLine(value).normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isPlaceholderLine(value: string): boolean {
  const line = proseLine(value).normalize("NFKC");
  if (!line) return false;
  if (/^[.。…·\s]+$/.test(line)) return true;
  const taskLabel = /^(?:todo|tbd|fixme)\s*[:：]\s*(.*)$/i.exec(line);
  const taskText = taskLabel?.[1];
  if (taskText !== undefined && (
    !/[\p{L}\p{N}]/u.test(taskText)
    || /^(?:补写|补充|完善|填写)(?:本节|此节|内容|正文)[。.!！]*$/.test(taskText)
  )) return true;
  // A real unresolved task such as "TODO: 修复采集失败" is source content,
  // while bare TODO and "TODO: 待补充" are unfinished report placeholders.
  const compact = compactProse(taskText ?? line);
  return /^(?:(?:正文|内容|本节|本章))?(?:todo|tbd|fixme|待补充|待完善|待填写|待生成|同上|略|省略|省略号|未完待续|占位|placeholder|null|none|na|undefined)+$/i.test(compact);
}

function isExplicitAbsence(value: string): boolean {
  return /^(?:(?:本周|本月|本期|当前|目前|材料中|会话中|归档中|现有材料中))?(?:暂无|未发现|未记录|未涉及|没有|无)(?:(?:相关|新增|明确|可确认|可核实))?(?:记录|材料|问题|事项|变化|决定|决策|计划|进展|内容|数据|信息|待办|关注点|证据)?$/u.test(compactProse(value));
}

function bodyIssues(body: string, kind: ReportKind, title: string, summary: string): string[] {
  const required = REPORT_SECTION_HEADINGS[kind];
  const sections = new Map<string, string[][]>();
  const lines = visibleMarkdownLines(body);
  let currentLines: string[] | null = null;
  for (const line of lines) {
    const heading = /^ {0,3}(#{1,2})\s+(.+)$/.exec(line);
    if (heading) {
      currentLines = null;
      if (heading[1] === "##") {
        const normalized = normalizedHeading(heading[2]!);
        const occurrences = sections.get(normalized) ?? [];
        currentLines = [];
        occurrences.push(currentLines);
        sections.set(normalized, occurrences);
      }
    } else if (currentLines) {
      currentLines.push(line);
    }
  }

  const issues: string[] = [];
  for (const heading of required) {
    const occurrences = sections.get(normalizedHeading(heading));
    if (!occurrences) {
      issues.push(`报告正文缺少必需章节：${heading}`);
      continue;
    }
    // Validate every occurrence so a second, empty copy cannot hide an unfinished section.
    if (occurrences.some((content) => !content.some((line) =>
      !/^\s*#{1,6}\s/.test(line) && !isPlaceholderLine(line) && /[\p{L}\p{N}]/u.test(proseLine(line)),
    ))) {
      issues.push(`报告章节缺少实际内容：${heading}`);
    }
  }

  if (lines.some(isPlaceholderLine)) {
    issues.push("报告正文包含未完成的占位内容");
  }

  const prose = lines.filter((line) => !/^\s*#{1,6}\s/.test(line))
    .map(proseLine).filter((line) => /[\p{L}\p{N}]/u.test(line) && !/^报告周期\s*[:：]/.test(line));
  const titleText = compactProse(title);
  const summaryText = compactProse(summary);
  const remainingContent = [summaryText, titleText].sort((a, b) => b.length - a.length)
    .reduce((text, metadata) => metadata ? text.split(metadata).join("") : text, prose.map(compactProse).join(""));
  if (prose.length && !remainingContent && !prose.every(isExplicitAbsence)) {
    issues.push("报告正文仅重复标题或摘要");
  }
  return issues;
}

/** Normalize provider aliases without accepting incomplete content as a valid report. */
export function normalizeReportResponseInput(value: unknown, kind?: ReportKind): unknown {
  if (typeof value === "string") {
    const body = value.trim();
    return body ? { title: "AI 报告", summary: excerptText(body, 800), bodyMarkdown: body } : value;
  }
  if (!isRecord(value)) return value;
  const wrapperKeys = [
    "report", "weeklyReport", "weekly_report", "monthlyReport", "monthly_report",
    "analysisReport", "analysis_report", "result", "data",
  ];
  const wrapped = wrapperKeys.map((key) => value[key]).find(isRecord) ?? value;
  const title = firstText(wrapped, ["title", "headline", "name", "subject"])
    ?? firstText(value, ["title", "headline", "name", "subject"]) ?? "AI 报告";
  const suppliedSummary = firstText(wrapped, ["summary", "abstract", "overview", "digest", "summary_text"])
    ?? firstText(value, ["summary", "abstract", "overview", "digest", "summary_text"]);
  const candidates: string[] = [];
  for (const record of wrapped === value ? [wrapped] : [wrapped, value]) {
    for (const key of BODY_KEYS) {
      const candidate = textValue(record[key]);
      if (candidate) candidates.push(candidate);
    }
    const sections = sectionMarkdown(record.sections);
    if (sections) candidates.push(sections);
  }
  const kinds: ReportKind[] = kind ? [kind] : ["weekly", "monthly"];
  const body = candidates.find((candidate) => candidate.length <= 100_000 && kinds.some((candidateKind) =>
    bodyIssues(candidate, candidateKind, title, suppliedSummary ?? "").length === 0,
  )) ?? candidates[0] ?? "";
  const summary = suppliedSummary ?? excerptText(body, 800);
  return { ...wrapped, title, summary, bodyMarkdown: body };
}

export function reportResponseSchema(kind: ReportKind): z.ZodType<ReportResponse, unknown> {
  return z.preprocess(
    (value) => normalizeReportResponseInput(value, kind),
    z.object({
      title: z.string().trim().min(1, "报告标题不能为空").max(300, "报告标题过长"),
      summary: z.string().trim().min(1, "报告摘要不能为空").max(5_000, "报告摘要过长"),
      bodyMarkdown: z.string().trim().min(1, "报告正文不能为空").max(100_000, "报告正文过长"),
    }).superRefine((report, context) => {
      for (const message of bodyIssues(report.bodyMarkdown, kind, report.title, report.summary)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["bodyMarkdown"], message });
      }
    }),
  );
}
