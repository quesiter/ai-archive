import ExcelJS from "exceljs";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { stripInternalConversationMetadata } from "@ai-archive/contracts";
import { db } from "../db.js";
import {
  conversationProjects,
  conversationRevisions,
  conversations,
  projects,
} from "../schema.js";
import { loadHydratedRevisionMessagesBatch } from "./revision-storage.js";

export type ConversationExportFormat = "csv" | "md" | "xlsx";

export interface ConversationExportRow {
  projectName: string;
  conversationId: string;
  conversationTitle: string;
  provider: string;
  externalSessionId: string;
  canonicalUrl: string;
  revisionId: string;
  capturedAt: string;
  messageOrdinal: number;
  role: "user" | "assistant";
  model: string;
  messageAt: string;
  content: string;
}

export interface ConversationExportData {
  scope: "conversation" | "project";
  scopeId: string;
  scopeName: string;
  generatedAt: string;
  rows: ConversationExportRow[];
}

export function safeExportUrl(value: string | null | undefined): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

export function exportableMessageContent(input: {
  role: string;
  segments: Array<{
    type: string;
    content: string;
    href?: string | null;
    language?: string | null;
  }>;
}): string {
  if (input.role !== "user" && input.role !== "assistant") return "";
  return input.segments
    .filter((segment) => segment.type !== "tool_status" && segment.type !== "reasoning")
    .map((segment) => {
      const content = stripInternalConversationMetadata(segment.content);
      if (!content) return "";
      if (segment.type === "code") {
        return `\`\`\`${segment.language ?? ""}\n${content}\n\`\`\``;
      }
      const href = safeExportUrl(segment.href);
      return href ? `${content} (${href})` : content;
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

async function loadScopeConversations(input: {
  conversationId?: string;
  projectId?: string;
}): Promise<{
  scope: ConversationExportData["scope"];
  scopeId: string;
  scopeName: string;
  conversations: Array<{
    id: string;
    title: string | null;
    provider: string;
    externalSessionId: string;
    canonicalUrl: string | null;
    projectName: string | null;
  }>;
} | null> {
  if (input.conversationId) {
    const [row] = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        provider: conversations.provider,
        externalSessionId: conversations.externalSessionId,
        canonicalUrl: conversations.canonicalUrl,
        projectName: projects.name,
      })
      .from(conversations)
      .leftJoin(
        conversationProjects,
        eq(conversationProjects.conversationId, conversations.id),
      )
      .leftJoin(projects, eq(projects.id, conversationProjects.projectId))
      .where(
        and(
          eq(conversations.id, input.conversationId),
          isNull(conversations.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    return {
      scope: "conversation",
      scopeId: row.id,
      scopeName: row.title || row.externalSessionId,
      conversations: [row],
    };
  }

  if (!input.projectId) return null;
  const [project] = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(eq(projects.id, input.projectId))
    .limit(1);
  if (!project) return null;
  const rows = await db
    .select({
      id: conversations.id,
      title: conversations.title,
      provider: conversations.provider,
      externalSessionId: conversations.externalSessionId,
      canonicalUrl: conversations.canonicalUrl,
      projectName: projects.name,
    })
    .from(conversationProjects)
    .innerJoin(conversations, eq(conversations.id, conversationProjects.conversationId))
    .innerJoin(projects, eq(projects.id, conversationProjects.projectId))
    .where(
      and(
        eq(conversationProjects.projectId, project.id),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(asc(conversations.updatedAt));
  return {
    scope: "project",
    scopeId: project.id,
    scopeName: project.name,
    conversations: rows,
  };
}

export async function loadConversationExportData(input: {
  conversationId?: string;
  projectId?: string;
}): Promise<ConversationExportData | null> {
  const scope = await loadScopeConversations(input);
  if (!scope) return null;
  if (!scope.conversations.length) {
    return { ...scope, generatedAt: new Date().toISOString(), rows: [] };
  }

  const conversationIds = scope.conversations.map((conversation) => conversation.id);
  const revisionRows = await db
    .select({
      id: conversationRevisions.id,
      conversationId: conversationRevisions.conversationId,
      capturedAt: conversationRevisions.capturedAt,
    })
    .from(conversationRevisions)
    .where(inArray(conversationRevisions.conversationId, conversationIds))
    .orderBy(
      asc(conversationRevisions.conversationId),
      desc(sql`(${conversationRevisions.completeness} = 'complete')`),
      desc(conversationRevisions.capturedAt),
      desc(conversationRevisions.createdAt),
    );
  const selectedRevisionByConversation = new Map<
    string,
    (typeof revisionRows)[number]
  >();
  for (const revision of revisionRows) {
    if (!selectedRevisionByConversation.has(revision.conversationId)) {
      selectedRevisionByConversation.set(revision.conversationId, revision);
    }
  }
  const revisionIds = [...selectedRevisionByConversation.values()].map(
    (revision) => revision.id,
  );
  if (!revisionIds.length) {
    return { ...scope, generatedAt: new Date().toISOString(), rows: [] };
  }

  const messagesByRevision = await loadHydratedRevisionMessagesBatch(revisionIds);

  const conversationByRevision = new Map(
    scope.conversations.flatMap((conversation) => {
      const revision = selectedRevisionByConversation.get(conversation.id);
      return revision ? [[revision.id, { conversation, revision }] as const] : [];
    }),
  );
  const rows: ConversationExportRow[] = [];
  for (const [revisionId, revisionMessages] of messagesByRevision) {
    const relation = conversationByRevision.get(revisionId);
    if (!relation) continue;
    for (const message of revisionMessages) {
      const content = exportableMessageContent(message);
      if (!content || (message.role !== "user" && message.role !== "assistant")) continue;
      rows.push({
        projectName: relation.conversation.projectName ?? "",
        conversationId: relation.conversation.id,
        conversationTitle:
          relation.conversation.title || relation.conversation.externalSessionId,
        provider: relation.conversation.provider,
        externalSessionId: relation.conversation.externalSessionId,
        canonicalUrl: safeExportUrl(relation.conversation.canonicalUrl),
        revisionId: relation.revision.id,
        capturedAt: relation.revision.capturedAt.toISOString(),
        messageOrdinal: message.ordinal,
        role: message.role,
        model: message.model ?? "",
        messageAt: message.sourceCreatedAt?.toISOString() ?? "",
        content,
      });
    }
  }
  rows.sort(
    (left, right) =>
      left.conversationTitle.localeCompare(right.conversationTitle) ||
      left.messageOrdinal - right.messageOrdinal,
  );
  return { ...scope, generatedAt: new Date().toISOString(), rows };
}

function spreadsheetSafe(value: string): string {
  return /^\s*[=+\-@]/.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number): string {
  const safe = spreadsheetSafe(String(value));
  return `"${safe.replace(/"/g, '""')}"`;
}

export function renderConversationCsv(data: ConversationExportData): Buffer {
  const headers = [
    "项目",
    "会话标题",
    "来源",
    "会话ID",
    "消息序号",
    "角色",
    "模型",
    "消息时间",
    "采集时间",
    "内容",
    "原会话链接",
  ];
  const lines = [
    headers.map(csvCell).join(","),
    ...data.rows.map((row) =>
      [
        row.projectName,
        row.conversationTitle,
        row.provider,
        row.externalSessionId,
        row.messageOrdinal,
        row.role === "user" ? "用户" : "AI",
        row.model,
        row.messageAt,
        row.capturedAt,
        row.content,
        row.canonicalUrl,
      ]
        .map(csvCell)
        .join(","),
    ),
  ];
  return Buffer.from(`\uFEFF${lines.join("\r\n")}`, "utf8");
}

export function renderConversationMarkdown(data: ConversationExportData): Buffer {
  const lines = [
    `# ${data.scope === "project" ? "项目" : "会话"}：${data.scopeName}`,
    "",
    `> 导出时间：${data.generatedAt}`,
    "> 已自动排除工具链调用、推理过程、系统消息和 Codex 运行环境元信息。",
    "",
  ];
  let activeConversationId = "";
  for (const row of data.rows) {
    if (row.conversationId !== activeConversationId) {
      activeConversationId = row.conversationId;
      lines.push(`## ${row.conversationTitle}`, "");
      lines.push(
        `- 来源：${row.provider}`,
        `- 会话 ID：${row.externalSessionId}`,
        `- 采集时间：${row.capturedAt}`,
        ...(row.canonicalUrl ? [`- 原会话：${row.canonicalUrl}`] : []),
        "",
      );
    }
    lines.push(
      `### ${row.role === "user" ? "用户" : row.model || "AI"} · #${row.messageOrdinal}`,
      "",
      row.content,
      "",
    );
  }
  if (!data.rows.length) lines.push("当前范围内没有可导出的正文消息。", "");
  return Buffer.from(lines.join("\n"), "utf8");
}

function chunkCell(value: string, size = 32_000): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

export async function renderConversationXlsx(
  data: ConversationExportData,
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "知言归藏";
  workbook.created = new Date(data.generatedAt);
  const worksheet = workbook.addWorksheet("对话记录", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  worksheet.columns = [
    { header: "项目", key: "project", width: 24 },
    { header: "会话标题", key: "title", width: 36 },
    { header: "来源", key: "provider", width: 14 },
    { header: "会话ID", key: "sessionId", width: 30 },
    { header: "消息序号", key: "ordinal", width: 12 },
    { header: "角色", key: "role", width: 10 },
    { header: "模型", key: "model", width: 18 },
    { header: "消息时间", key: "messageAt", width: 24 },
    { header: "采集时间", key: "capturedAt", width: 24 },
    { header: "内容分段", key: "part", width: 12 },
    { header: "内容", key: "content", width: 80 },
    { header: "原会话链接", key: "url", width: 42 },
  ];
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0F766E" },
  };
  worksheet.autoFilter = { from: "A1", to: "L1" };
  for (const row of data.rows) {
    const contentParts = chunkCell(row.content);
    contentParts.forEach((content, index) => {
      worksheet.addRow({
        project: spreadsheetSafe(row.projectName),
        title: spreadsheetSafe(row.conversationTitle),
        provider: row.provider,
        sessionId: spreadsheetSafe(row.externalSessionId),
        ordinal: row.messageOrdinal,
        role: row.role === "user" ? "用户" : "AI",
        model: spreadsheetSafe(row.model),
        messageAt: row.messageAt,
        capturedAt: row.capturedAt,
        part: `${index + 1}/${contentParts.length}`,
        content: spreadsheetSafe(content),
        url: row.canonicalUrl,
      });
    });
  }
  worksheet.getColumn("content").alignment = { wrapText: true, vertical: "top" };
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: "top" };
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function renderConversationExport(
  format: ConversationExportFormat,
  data: ConversationExportData,
): Promise<Buffer> {
  if (format === "csv") return renderConversationCsv(data);
  if (format === "md") return renderConversationMarkdown(data);
  return renderConversationXlsx(data);
}
