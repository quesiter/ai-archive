import ExcelJS from "exceljs";
import { PassThrough, Readable, type Writable } from "node:stream";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { stripInternalConversationMetadata, type CaptureMessage } from "@ai-archive/contracts";
import { db } from "../db.js";
import {
  conversationProjects,
  conversationRevisions,
  conversations,
  projects,
} from "../schema.js";
import { loadCurrentConversationArchive, type HydratedRevisionMessage } from "./revision-storage.js";
import { projectSourceReview, sourceReviewBodyHash } from "./source-review.js";

type CaptureBody = {
  externalMessageId?: string | null | undefined;
  role: string;
  segments: ReadonlyArray<{ type: string; content: string; href?: string | null | undefined; language?: string | null | undefined }>;
};

function captureBodyKey(message: CaptureBody): string {
  return JSON.stringify([message.externalMessageId ?? null, message.role, message.segments.map(segment => [
    segment.type, segment.content.replace(/\r+\n/g, "\n"), segment.href ?? null, segment.language ?? null,
  ])]);
}

/** Select distinct alternate bodies without modifying primary rows or evidence. */
export function distinctCaptureBodyVariants(primary: readonly CaptureBody[], variants: readonly CaptureMessage[]): CaptureMessage[] {
  const alternativesByBody = new Map<string, CaptureMessage>();
  for (const alternative of variants) {
    const key = captureBodyKey(alternative);
    if (!alternativesByBody.has(key)) alternativesByBody.set(key, alternative);
  }
  for (const message of primary) {
    if (!alternativesByBody.size) break;
    alternativesByBody.delete(captureBodyKey(message));
  }
  return [...alternativesByBody.values()];
}

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
  recordType?: "reviewed_edit" | "reviewed_observation" | "unreviewed_observation";
}

const exportRecordLabels = {
  reviewed_edit: "编辑前消息（已核对）",
  reviewed_observation: "已核对的展示/预览记录",
  unreviewed_observation: "未核对差异",
} as const;

function captureMessageForReview(message: HydratedRevisionMessage): CaptureMessage {
  return {
    ordinal: message.ordinal, role: message.role,
    ...(message.externalMessageId != null ? { externalMessageId: message.externalMessageId } : {}),
    ...(message.model != null ? { model: message.model } : {}),
    ...(message.sourceCreatedAt ? { createdAt: message.sourceCreatedAt.toISOString() } : {}),
    segments: message.segments.map((segment) => ({ type: segment.type, content: segment.content,
      ...(segment.href != null ? { href: segment.href } : {}),
      ...(segment.language != null ? { language: segment.language } : {}) })),
  };
}

export interface ConversationExportData {
  scope: "conversation" | "project" | "selection";
  scopeId: string;
  scopeName: string;
  generatedAt: string;
  rows: ConversationExportRow[];
}

interface ConversationExportSource extends Omit<ConversationExportData, "rows"> {
  relations: Array<{
    conversation: {
      id: string;
      title: string | null;
      provider: string;
      externalSessionId: string;
      canonicalUrl: string | null;
      projectName: string | null;
    };
    revision: {
      id: string;
      conversationId: string;
      capturedAt: Date;
    };
  }>;
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
    href?: string | null | undefined;
    language?: string | null | undefined;
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
  conversationIds?: string[];
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

  if (input.conversationIds?.length) {
    const rows = await db
      .select({
        id: conversations.id,
        title: conversations.title,
        provider: conversations.provider,
        externalSessionId: conversations.externalSessionId,
        canonicalUrl: conversations.canonicalUrl,
        projectName: projects.name,
      })
      .from(conversations)
      .leftJoin(conversationProjects, eq(conversationProjects.conversationId, conversations.id))
      .leftJoin(projects, eq(projects.id, conversationProjects.projectId))
      .where(and(inArray(conversations.id, input.conversationIds), isNull(conversations.deletedAt)))
      .orderBy(asc(conversations.updatedAt));
    return {
      scope: "selection",
      scopeId: "selection",
      scopeName: `已选会话-${rows.length}`,
      conversations: rows,
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

async function loadConversationExportSource(input: {
  conversationId?: string;
  projectId?: string;
  conversationIds?: string[];
}): Promise<ConversationExportSource | null> {
  const scope = await loadScopeConversations(input);
  if (!scope) return null;
  if (!scope.conversations.length) {
    return {
      scope: scope.scope,
      scopeId: scope.scopeId,
      scopeName: scope.scopeName,
      generatedAt: new Date().toISOString(),
      relations: [],
    };
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
      desc(conversationRevisions.isAccumulated),
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
    return {
      scope: scope.scope,
      scopeId: scope.scopeId,
      scopeName: scope.scopeName,
      generatedAt: new Date().toISOString(),
      relations: [],
    };
  }

  const relations = scope.conversations
    .flatMap((conversation) => {
      const revision = selectedRevisionByConversation.get(conversation.id);
      return revision ? [{ conversation, revision }] : [];
    })
    .sort((left, right) => {
      const leftTitle = left.conversation.title || left.conversation.externalSessionId;
      const rightTitle = right.conversation.title || right.conversation.externalSessionId;
      return (
        leftTitle.localeCompare(rightTitle) ||
        left.conversation.id.localeCompare(right.conversation.id)
      );
    });
  return {
    scope: scope.scope,
    scopeId: scope.scopeId,
    scopeName: scope.scopeName,
    generatedAt: new Date().toISOString(),
    relations,
  };
}

async function* iterateConversationExportRows(
  source: ConversationExportSource,
): AsyncGenerator<ConversationExportRow> {
  for (const relation of source.relations) {
    // Loading one logical revision at a time bounds peak memory for large projects.
    const archive = await loadCurrentConversationArchive(relation.conversation.id);
    if (!archive) continue;
    const revisionMessages = archive.messages;
    const evidence = archive.revision.mergeEvidence;
    const projection = evidence?.sourceReview ? projectSourceReview({
      provider: relation.conversation.provider, sessionId: relation.conversation.externalSessionId,
      sourceReview: evidence.sourceReview, primaryMessages: revisionMessages.map(captureMessageForReview),
      variants: evidence.variants, warnings: evidence.warnings,
    }) : undefined;
    if (projection?.validation.valid) {
      const rowFor = (message: CaptureMessage, content: string): ConversationExportRow => ({
        projectName: relation.conversation.projectName ?? "", conversationId: relation.conversation.id,
        conversationTitle: relation.conversation.title || relation.conversation.externalSessionId,
        provider: relation.conversation.provider, externalSessionId: relation.conversation.externalSessionId,
        canonicalUrl: safeExportUrl(relation.conversation.canonicalUrl), revisionId: archive.revision.id,
        capturedAt: archive.revision.capturedAt.toISOString(), messageOrdinal: message.ordinal,
        role: message.role as "user" | "assistant", model: message.model ?? "", messageAt: message.createdAt ?? "", content,
      });
      const represented = new Map<string, number>();
      for (const message of projection.projectedMessages) {
        const content = exportableMessageContent(message);
        if (!content || (message.role !== "user" && message.role !== "assistant")) continue;
        const hash = sourceReviewBodyHash(message);
        represented.set(hash, (represented.get(hash) ?? 0) + 1);
        yield rowFor(message, content);
      }
      const review = projection.validation.review;
      const referenceKey = (messageId: string | undefined, hash: string) => JSON.stringify([messageId, hash]);
      const reviewed = new Map(review.reviewedBodies.map((body) => [referenceKey(body.messageId, body.bodyHash), body.kind]));
      const known = new Set([...review.selectedBodies, ...review.reviewedBodies].map((body) => referenceKey(body.messageId, body.bodyHash)));
      const invalidated = new Set(projection.invalidatedMessageIds);
      const inactive = new Set(projection.inactiveMessages.map((message) => message.externalMessageId));
      const remainders = new Map(projection.remainderObservations.map((observation) => [`${observation.origin}:${observation.index}`, observation]));
      const original = [
        ...revisionMessages.map((message, index) => ({ message: captureMessageForReview(message), index, origin: "primary" as const })),
        ...evidence!.variants.map((message, index) => ({ message, index, origin: "variant" as const })),
      ];
      const kindLabels = { map_rendering: "地图显示内容", partial_rendering: "部分渲染片段",
        attachment_preview: "附件/表格预览", source_text: "源正文观察" } as const;
      for (const observation of original) {
        const { message, origin, index } = observation;
        if (message.role !== "user" && message.role !== "assistant") continue;
        const hash = sourceReviewBodyHash(message);
        const shown = represented.get(hash) ?? 0;
        if (shown > 0) { represented.set(hash, shown - 1); continue; }
        // The projection omits exact visible bodies. Retain every additional
        // model/source-time observation as a separate record too; unlike the
        // legacy display deduplication, this is a provenance-preserving export.
        const remainder = remainders.get(`${origin}:${index}`);
        const key = referenceKey(message.externalMessageId, hash);
        const resolved = remainder?.resolved ?? Boolean(message.externalMessageId &&
          !invalidated.has(message.externalMessageId) && known.has(key));
        const wasEdited = remainder?.inactive ?? inactive.has(message.externalMessageId);
        const kind = remainder?.kind ?? reviewed.get(key);
        const recordType = resolved ? wasEdited ? "reviewed_edit" : "reviewed_observation" : "unreviewed_observation";
        const recordOrigin = origin === "primary" ? `原主正文 #${message.ordinal}` : `原差异观察 #${index + 1}`;
        const originalId = origin === "primary" ? revisionMessages[index]?.id : undefined;
        const firstObservedAt = origin === "primary" ? revisionMessages[index]?.createdAt?.toISOString() : undefined;
        const details = [exportRecordLabels[recordType], "非连续问答记录", kind ? kindLabels[kind] : "",
          recordOrigin, message.externalMessageId ? `消息 ${message.externalMessageId}` : "匿名消息",
          originalId ? `原记录 ${originalId}` : "", firstObservedAt ? `首次归档 ${firstObservedAt}` : "", `正文哈希 ${hash}`,
          archive.revision.contentIntegrityHash ? `原归档哈希 ${archive.revision.contentIntegrityHash}` : "",
        ].filter(Boolean).join("；");
        const rawContent = message.segments.map((segment) => {
          const href = safeExportUrl(segment.href);
          return href ? `${segment.content} (${href})` : segment.content;
        }).join("\n");
        yield { ...rowFor(message, `[${details}]\n${rawContent}`), recordType };
      }
      continue;
    }
    for (const message of revisionMessages) {
      const content = exportableMessageContent(message);
      if (!content || (message.role !== "user" && message.role !== "assistant")) continue;
      yield {
        projectName: relation.conversation.projectName ?? "",
        conversationId: relation.conversation.id,
        conversationTitle:
          relation.conversation.title || relation.conversation.externalSessionId,
        provider: relation.conversation.provider,
        externalSessionId: relation.conversation.externalSessionId,
        canonicalUrl: safeExportUrl(relation.conversation.canonicalUrl),
        revisionId: archive.revision.id,
        capturedAt: archive.revision.capturedAt.toISOString(),
        messageOrdinal: message.ordinal,
        role: message.role,
        model: message.model ?? "",
        messageAt: message.sourceCreatedAt?.toISOString() ?? "",
        content,
      };
    }
    // Keep source-time/model observations in storage, but export each distinct
    // alternate body once. Primary rows (including real repeated turns) above
    // are emitted unchanged; this map applies only to evidence.
    for (const alternative of distinctCaptureBodyVariants(revisionMessages, archive.revision.mergeEvidence?.variants ?? [])) {
      if (alternative.role !== "user" && alternative.role !== "assistant") continue;
      const content = alternative.segments.map(segment => segment.href ? `${segment.content} (${segment.href})` : segment.content).join("\n");
      if (!content.trim()) continue;
      yield {
        projectName: relation.conversation.projectName ?? "",
        conversationId: relation.conversation.id,
        conversationTitle: relation.conversation.title || relation.conversation.externalSessionId,
        provider: relation.conversation.provider,
        externalSessionId: relation.conversation.externalSessionId,
        canonicalUrl: safeExportUrl(relation.conversation.canonicalUrl),
        revisionId: archive.revision.id,
        capturedAt: archive.revision.capturedAt.toISOString(),
        messageOrdinal: alternative.ordinal,
        role: alternative.role,
        model: alternative.model ?? "",
        messageAt: alternative.createdAt ?? "",
        content: `[其他采集内容，非新增问答${alternative.externalMessageId ? `；消息 ${alternative.externalMessageId}` : ""}]\n${content}`,
      };
    }
  }
}

export async function loadConversationExportData(input: {
  conversationId?: string;
  projectId?: string;
  conversationIds?: string[];
}): Promise<ConversationExportData | null> {
  const source = await loadConversationExportSource(input);
  if (!source) return null;
  const rows: ConversationExportRow[] = [];
  for await (const row of iterateConversationExportRows(source)) rows.push(row);
  const { relations: _relations, ...data } = source;
  return { ...data, rows };
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
  let originalRecordsStarted = false;
  for (const row of data.rows) {
    if (row.conversationId !== activeConversationId) {
      activeConversationId = row.conversationId;
      originalRecordsStarted = false;
      lines.push(`## ${row.conversationTitle}`, "");
      lines.push(
        `- 来源：${row.provider}`,
        `- 会话 ID：${row.externalSessionId}`,
        `- 采集时间：${row.capturedAt}`,
        ...(row.canonicalUrl ? [`- 原会话：${row.canonicalUrl}`] : []),
        "",
      );
    }
    if (row.recordType && !originalRecordsStarted) {
      lines.push("### 原始采集观察（非连续问答）", "");
      originalRecordsStarted = true;
    }
    lines.push(
      row.recordType ? `#### ${exportRecordLabels[row.recordType]} · #${row.messageOrdinal}`
        : `### ${row.role === "user" ? "用户" : row.model || "AI"} · #${row.messageOrdinal}`,
      "",
      row.content,
      "",
    );
  }
  if (!data.rows.length) lines.push("当前范围内没有可导出的正文消息。", "");
  return Buffer.from(lines.join("\n"), "utf8");
}

async function* iterateConversationCsvChunks(
  source: ConversationExportSource,
): AsyncGenerator<Buffer> {
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
  yield Buffer.from(`\uFEFF${headers.map(csvCell).join(",")}\r\n`, "utf8");
  for await (const row of iterateConversationExportRows(source)) {
    yield Buffer.from(`${[
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
    ].map(csvCell).join(",")}\r\n`, "utf8");
  }
}

async function* iterateConversationMarkdownChunks(
  source: ConversationExportSource,
): AsyncGenerator<Buffer> {
  yield Buffer.from([
    `# ${source.scope === "project" ? "项目" : "会话"}：${source.scopeName}`,
    "",
    `> 导出时间：${source.generatedAt}`,
    "> 已自动排除工具链调用、推理过程、系统消息和 Codex 运行环境元信息。",
    "",
  ].join("\n"), "utf8");
  let activeConversationId = "";
  let originalRecordsStarted = false;
  let rowCount = 0;
  for await (const row of iterateConversationExportRows(source)) {
    const lines: string[] = [""];
    rowCount += 1;
    if (row.conversationId !== activeConversationId) {
      activeConversationId = row.conversationId;
      originalRecordsStarted = false;
      lines.push(
        `## ${row.conversationTitle}`,
        "",
        `- 来源：${row.provider}`,
        `- 会话 ID：${row.externalSessionId}`,
        `- 采集时间：${row.capturedAt}`,
        ...(row.canonicalUrl ? [`- 原会话：${row.canonicalUrl}`] : []),
        "",
      );
    }
    if (row.recordType && !originalRecordsStarted) {
      lines.push("### 原始采集观察（非连续问答）", "");
      originalRecordsStarted = true;
    }
    lines.push(
      row.recordType ? `#### ${exportRecordLabels[row.recordType]} · #${row.messageOrdinal}`
        : `### ${row.role === "user" ? "用户" : row.model || "AI"} · #${row.messageOrdinal}`,
      "",
      row.content,
      "",
    );
    yield Buffer.from(lines.join("\n"), "utf8");
  }
  if (!rowCount) yield Buffer.from("\n当前范围内没有可导出的正文消息。\n", "utf8");
}

export async function createConversationTextExport(
  input: {
    conversationId?: string;
    projectId?: string;
    conversationIds?: string[];
  },
  format: "csv" | "md",
): Promise<{ scopeName: string; stream: Readable } | null> {
  const source = await loadConversationExportSource(input);
  if (!source) return null;
  return {
    scopeName: source.scopeName,
    stream: Readable.from(
      format === "csv"
        ? iterateConversationCsvChunks(source)
        : iterateConversationMarkdownChunks(source),
    ),
  };
}

function chunkCell(value: string, size = 32_000): string[] {
  if (!value) return [""];
  const chunks: string[] = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

async function writeConversationXlsx(
  output: Writable,
  generatedAt: string,
  rows: Iterable<ConversationExportRow> | AsyncIterable<ConversationExportRow>,
): Promise<void> {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useSharedStrings: false,
    useStyles: true,
  });
  workbook.creator = "知言归藏";
  workbook.created = new Date(generatedAt);
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
  const header = worksheet.getRow(1);
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF0F766E" },
  };
  worksheet.autoFilter = { from: "A1", to: "L1" };
  worksheet.getColumn("content").alignment = { wrapText: true, vertical: "top" };
  header.commit();

  for await (const row of rows) {
    const contentParts = chunkCell(row.content);
    contentParts.forEach((content, index) => {
      const worksheetRow = worksheet.addRow({
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
      worksheetRow.alignment = { vertical: "top" };
      worksheetRow.commit();
    });
  }
  worksheet.commit();
  await workbook.commit();
}

export function renderConversationXlsxStream(input: {
  generatedAt: string;
  rows: Iterable<ConversationExportRow> | AsyncIterable<ConversationExportRow>;
}): Readable {
  const output = new PassThrough();
  void writeConversationXlsx(output, input.generatedAt, input.rows).catch((error) => {
    output.destroy(error instanceof Error ? error : new Error(String(error)));
  });
  return output;
}

export async function renderConversationXlsx(
  data: ConversationExportData,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of renderConversationXlsxStream(data)) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function createConversationXlsxExport(input: {
  conversationId?: string;
  projectId?: string;
  conversationIds?: string[];
}): Promise<{ scopeName: string; stream: Readable } | null> {
  const source = await loadConversationExportSource(input);
  if (!source) return null;
  return {
    scopeName: source.scopeName,
    stream: renderConversationXlsxStream({
      generatedAt: source.generatedAt,
      rows: iterateConversationExportRows(source),
    }),
  };
}

export async function renderConversationExport(
  format: ConversationExportFormat,
  data: ConversationExportData,
): Promise<Buffer> {
  if (format === "csv") return renderConversationCsv(data);
  if (format === "md") return renderConversationMarkdown(data);
  return renderConversationXlsx(data);
}
