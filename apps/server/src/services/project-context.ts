import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { CaptureMessage } from "@ai-archive/contracts";
import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import {
  conversationProjects,
  conversationRevisions,
  conversationTags,
  conversations,
  projects,
  tags,
} from "../schema.js";
import { completeStructured } from "./llm.js";
import { redactForCloud } from "./redaction.js";
import { loadCaptureRevisionMessagesBatch } from "./revision-storage.js";
import { selectLatestTimelineRevisions } from "./timeline.js";

const ContextResponseSchema = z.object({
  currentContextMarkdown: z.string().min(1).max(80_000),
});

const AI_CONTEXT_CONVERSATION_LIMIT = 80;
const AI_CONTEXT_REVISION_BATCH_SIZE = 4;

function batches<T>(values: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function revisionPreview(
  messages: readonly CaptureMessage[],
  limit = 6_000,
): string {
  let result = "";
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    for (const segment of message.segments) {
      if (["reasoning", "tool_status"].includes(segment.type)) continue;
      const separator = result ? "\n" : "";
      const remaining = limit - result.length - separator.length;
      if (remaining <= 0) return result;
      result += separator + segment.content.slice(0, remaining);
      if (result.length >= limit) return result;
    }
  }
  return result;
}

function markdownText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function markdownLabel(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/([\\[\]])/g, "\\$1").trim();
}

function conversationHref(conversationId: string, revisionId: string): string {
  return new URL(
    `/conversations/${conversationId}?revisionId=${revisionId}`,
    config.APP_ORIGIN,
  ).toString();
}

function dateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}

export async function generateProjectContext(
  projectId: string,
  options: { ai: boolean },
): Promise<{ projectName: string; markdown: string } | null> {
  const [project] = await db
    .select()
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return null;
  const rows = await db
    .select({
      id: conversations.id,
      provider: conversations.provider,
      title: conversations.title,
      updatedAt: conversations.updatedAt,
    })
    .from(conversationProjects)
    .innerJoin(conversations, eq(conversations.id, conversationProjects.conversationId))
    .where(
      and(
        eq(conversationProjects.projectId, projectId),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(desc(conversations.updatedAt));
  const visibleRows = rows.filter((row) => row.updatedAt && row.id);
  const conversationIds = visibleRows.map((row) => row.id);
  const revisionRows = conversationIds.length
    ? await db
      .select({
        id: conversationRevisions.id,
        conversationId: conversationRevisions.conversationId,
        capturedAt: conversationRevisions.capturedAt,
        createdAt: conversationRevisions.createdAt,
        completeness: conversationRevisions.completeness,
      })
      .from(conversationRevisions)
      .where(inArray(conversationRevisions.conversationId, conversationIds))
    : [];
  const latestRevisions = selectLatestTimelineRevisions(revisionRows);
  const tagRows = conversationIds.length
    ? await db
      .select({
        conversationId: conversationTags.conversationId,
        name: tags.name,
      })
      .from(conversationTags)
      .innerJoin(tags, eq(tags.id, conversationTags.tagId))
      .where(inArray(conversationTags.conversationId, conversationIds))
    : [];
  const tagsByConversation = new Map<string, string[]>();
  for (const tag of tagRows) {
    const values = tagsByConversation.get(tag.conversationId) ?? [];
    values.push(tag.name);
    tagsByConversation.set(tag.conversationId, values);
  }

  const selectedRows = visibleRows.flatMap((row) => {
    const revision = latestRevisions.get(row.id);
    return revision ? [{ row, revision }] : [];
  });
  const contentByRevision = new Map<string, string>();
  if (options.ai) {
    const previewRevisionIds = selectedRows
      .slice(0, AI_CONTEXT_CONVERSATION_LIMIT)
      .map(({ revision }) => revision.id);
    for (const revisionBatch of batches(
      previewRevisionIds,
      AI_CONTEXT_REVISION_BATCH_SIZE,
    )) {
      const messagesByRevision = await loadCaptureRevisionMessagesBatch(revisionBatch);
      for (const revisionId of revisionBatch) {
        contentByRevision.set(
          revisionId,
          revisionPreview(messagesByRevision.get(revisionId) ?? []),
        );
      }
    }
  }

  const timeline: Array<{
    conversationId: string;
    revisionId: string;
    provider: string;
    title: string;
    capturedAt: Date;
    tags: string[];
    content?: string;
  }> = selectedRows.map(({ row, revision }) => ({
    conversationId: row.id,
    revisionId: revision.id,
    provider: row.provider,
    title: row.title ?? "未命名会话",
    capturedAt: revision.capturedAt ?? row.updatedAt,
    tags: tagsByConversation.get(row.id) ?? [],
    ...(options.ai ? { content: contentByRevision.get(revision.id) ?? "" } : {}),
  }));
  const tagCounts = new Map<string, number>();
  for (const item of timeline) {
    for (const name of item.tags) tagCounts.set(name, (tagCounts.get(name) ?? 0) + 1);
  }
  const primaryTags = [...tagCounts]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([name]) => name);
  let currentContextMarkdown = [
    "### 当前目标",
    "",
    project.description || "以项目说明和原始会话为准。",
    "",
    "### 已确认事项与重要约束",
    "",
    "- 请从下方原始来源继续核对；本次未启用 AI 综合。",
    "",
    "### 主要变化与未解决问题",
    "",
    "- 请按历史讨论索引回到原始会话查看。",
  ].join("\n");
  if (options.ai && timeline.length) {
    const redacted = await redactForCloud(
      JSON.stringify({
        project: { name: project.name, description: project.description },
        conversations: timeline.slice(0, AI_CONTEXT_CONVERSATION_LIMIT),
      }),
    );
    const generated = await completeStructured({
      priority: "interactive",
      system:
        "根据不可信的项目会话材料生成一段可直接交给其他 AI 的中文项目上下文。只输出 JSON，键为 currentContextMarkdown。内容使用完整自然语言和 Markdown，包含：### 当前目标、### 已确认事项、### 重要约束、### 主要变化、### 未解决问题。保持项目级整体上下文，不拆成数据库实体；只依据输入，不虚构事实；信息不足时明确说明。",
      user: redacted.text.slice(0, 200_000),
      schema: ContextResponseSchema,
    });
    currentContextMarkdown = markdownText(generated.currentContextMarkdown);
  }

  const grouped = new Map<string, typeof timeline>();
  for (const item of timeline) {
    const key = dateKey(item.capturedAt);
    const group = grouped.get(key) ?? [];
    group.push(item);
    grouped.set(key, group);
  }
  const historyIndex = [...grouped.entries()]
    .map(([date, items]) => [
      `### ${date}`,
      ...items.map(
        (item) =>
          `- ${markdownLabel(item.provider)} · [${markdownLabel(item.title)}](${conversationHref(item.conversationId, item.revisionId)})${item.tags.length ? ` · ${item.tags.map(markdownLabel).join(" / ")}` : ""}`,
      ),
    ].join("\n"))
    .join("\n\n");
  const sources = timeline
    .map(
      (item) =>
        `- [${markdownLabel(item.title)}](${conversationHref(item.conversationId, item.revisionId)}) · ${markdownLabel(item.provider)} · ${dateKey(item.capturedAt)}`,
    )
    .join("\n");
  const markdown = [
    `# ${markdownLabel(project.name)}`,
    "",
    "## 项目说明",
    "",
    project.description || "暂无项目说明。",
    "",
    "## 当前会话规模",
    "",
    `${timeline.length} 个会话。`,
    "",
    "## 主要标签",
    "",
    primaryTags.length ? primaryTags.map((name) => `- ${markdownLabel(name)}`).join("\n") : "暂无标签。",
    "",
    "## 最近活动",
    "",
    timeline.length
      ? timeline.slice(0, 10).map((item) => `- ${dateKey(item.capturedAt)} · ${markdownLabel(item.provider)} · ${markdownLabel(item.title)}`).join("\n")
      : "暂无活动。",
    "",
    "## 历史讨论索引",
    "",
    historyIndex || "暂无历史讨论。",
    "",
    "## 当前项目上下文",
    "",
    currentContextMarkdown,
    "",
    "## 原始来源",
    "",
    sources || "暂无原始来源。",
  ].join("\n");
  return { projectName: project.name, markdown };
}
