import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNull,
  lte,
  or,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ProviderSchema } from "@ai-archive/contracts";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import {
  conversationProjects,
  conversationRevisions,
  conversations,
  devices,
  messageSegments,
  messages,
  projects,
} from "../schema.js";
import {
  latestRevisionId,
  hardDeleteConversation,
} from "../services/capture.js";
import {
  loadHydratedRevisionMessages,
  loadRevisionStorageChain,
} from "../services/revision-storage.js";
import {
  loadConversationExportData,
  renderConversationExport,
  type ConversationExportFormat,
} from "../services/conversation-export.js";

const ListQuerySchema = z.object({
  q: z.string().max(500).optional(),
  provider: ProviderSchema.optional(),
  source: z.enum(["web", "openclaw", "codex", "claude_code", "historical_import"]).optional(),
  completeness: z.enum(["complete", "partial"]).optional(),
  captureMode: z.enum(["full", "append", "import"]).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const webProviders = [
  "chatgpt",
  "gemini",
  "grok",
  "yuanbao",
  "doubao",
  "minimax_agent",
  "deepseek",
  "qianwen",
  "kimi",
] as const;

function searchExcerpt(content: string, q: string): string {
  const index = content.toLowerCase().indexOf(q.toLowerCase());
  if (index < 0) return content.slice(0, 160);
  const start = Math.max(0, index - 54);
  const end = Math.min(content.length, index + q.length + 90);
  return `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}`;
}

const ExportQuerySchema = z.object({
  format: z.enum(["csv", "md", "xlsx"]),
});

function safeExportFilename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return normalized || "conversation";
}

function exportMimeType(format: ConversationExportFormat): string {
  if (format === "csv") return "text/csv; charset=utf-8";
  if (format === "md") return "text/markdown; charset=utf-8";
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

export async function conversationRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/conversations/provider-counts", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const rows = await db
      .select({
        provider: conversations.provider,
        count: count(),
      })
      .from(conversations)
      .where(isNull(conversations.deletedAt))
      .groupBy(conversations.provider);
    return rows.map((row) => ({
      provider: row.provider,
      count: Number(row.count ?? 0),
    }));
  });

  app.get("/api/v1/conversations", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    let query: z.infer<typeof ListQuerySchema>;
    try {
      query = ListQuerySchema.parse(request.query);
    } catch (error) {
      const issues = (error as { issues?: unknown }).issues;
      return reply.code(400).send({
        error: "Request validation failed",
        ...(Array.isArray(issues) ? { issues } : {}),
      });
    }
    let matchingIds: string[] | undefined;
    if (query.q) {
      const revisionMatches = await db
        .selectDistinct({ id: conversationRevisions.conversationId })
        .from(conversationRevisions)
        .where(ilike(conversationRevisions.searchText, `%${query.q}%`));
      matchingIds = revisionMatches.map((row) => row.id);
    }
    let revisionScopedIds: string[] | undefined;
    const revisionFilters = [];
    if (query.completeness) {
      revisionFilters.push(eq(conversationRevisions.completeness, query.completeness));
    }
    if (query.captureMode) {
      revisionFilters.push(eq(conversationRevisions.captureMode, query.captureMode));
    }
    if (query.source === "historical_import") {
      revisionFilters.push(eq(conversationRevisions.captureMode, "import"));
    }
    if (query.from) {
      revisionFilters.push(gte(conversationRevisions.capturedAt, new Date(query.from)));
    }
    if (query.to) {
      revisionFilters.push(lte(conversationRevisions.capturedAt, new Date(query.to)));
    }
    if (revisionFilters.length) {
      const rows = await db
        .selectDistinct({ id: conversationRevisions.conversationId })
        .from(conversationRevisions)
        .where(and(...revisionFilters));
      revisionScopedIds = rows.map((row) => row.id);
      if (!revisionScopedIds.length) return [];
    }
    const filters = [isNull(conversations.deletedAt)];
    if (query.provider) filters.push(eq(conversations.provider, query.provider));
    if (query.source === "web") filters.push(inArray(conversations.provider, webProviders));
    if (query.source === "openclaw") filters.push(eq(conversations.provider, "openclaw"));
    if (query.source === "codex") filters.push(eq(conversations.provider, "codex"));
    if (query.source === "claude_code") filters.push(eq(conversations.provider, "claude_code"));
    if (revisionScopedIds) filters.push(inArray(conversations.id, revisionScopedIds));
    if (query.q) {
      filters.push(
        matchingIds?.length
          ? or(
              ilike(conversations.title, `%${query.q}%`),
              inArray(conversations.id, matchingIds),
            )!
          : ilike(conversations.title, `%${query.q}%`),
      );
    }
    const rows = await db
      .select({
        id: conversations.id,
        provider: conversations.provider,
        externalSessionId: conversations.externalSessionId,
        title: conversations.title,
        canonicalUrl: conversations.canonicalUrl,
        updatedAt: conversations.updatedAt,
        projectId: conversationProjects.projectId,
        projectName: projects.name,
        projectLocked: conversationProjects.lockedByUser,
        projectConfidence: conversationProjects.confidence,
        suggestedProjectName: conversationProjects.suggestedName,
      })
      .from(conversations)
      .leftJoin(
        conversationProjects,
        eq(conversationProjects.conversationId, conversations.id),
      )
      .leftJoin(projects, eq(projects.id, conversationProjects.projectId))
      .where(and(...filters))
      .orderBy(desc(conversations.updatedAt))
      .limit(query.limit)
      .offset(query.offset);

    return Promise.all(
      rows.map(async (row) => {
        const revisionId = await latestRevisionId(row.id);
        const [revision] = revisionId
          ? await db
              .select({
                id: conversationRevisions.id,
                completeness: conversationRevisions.completeness,
                messageCount: conversationRevisions.messageCount,
                capturedAt: conversationRevisions.capturedAt,
                captureMode: conversationRevisions.captureMode,
                triggerReason: conversationRevisions.triggerReason,
                adapterVersion: conversationRevisions.adapterVersion,
                sourceDeviceId: conversationRevisions.sourceDeviceId,
                sourceDeviceName: devices.name,
                sourceDeviceKind: devices.kind,
              })
              .from(conversationRevisions)
              .leftJoin(devices, eq(devices.id, conversationRevisions.sourceDeviceId))
              .where(eq(conversationRevisions.id, revisionId))
              .limit(1)
          : [];
        const storageRevisionIds = query.q && revision
          ? (await loadRevisionStorageChain(revision.id)).map((item) => item.id)
          : [];
        const [hit] = query.q && storageRevisionIds.length
          ? await db
              .select({
                ordinal: messages.ordinal,
                content: messageSegments.content,
              })
              .from(messages)
              .innerJoin(messageSegments, eq(messageSegments.messageId, messages.id))
              .where(
                and(
                  inArray(messages.revisionId, storageRevisionIds),
                  ilike(messageSegments.content, `%${query.q}%`),
                ),
              )
              .orderBy(asc(messages.ordinal))
              .limit(1)
          : [];
        return {
          ...row,
          latestRevision: revision ?? null,
          searchHit: hit && query.q
            ? {
                messageOrdinal: hit.ordinal,
                excerpt: searchExcerpt(hit.content, query.q),
              }
            : null,
        };
      }),
    );
  });

  app.get<{ Params: { id: string }; Querystring: { revisionId?: string } }>(
    "/api/v1/conversations/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const query = z
        .object({ revisionId: z.string().uuid().optional() })
        .parse(request.query);
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.id, params.id),
            isNull(conversations.deletedAt),
          ),
        )
        .limit(1);
      if (!conversation) {
        return reply.code(404).send({ error: "Conversation not found" });
      }
      const revisions = await db
        .select()
        .from(conversationRevisions)
        .where(eq(conversationRevisions.conversationId, conversation.id))
        .orderBy(
          desc(conversationRevisions.capturedAt),
          desc(conversationRevisions.createdAt),
        );
      const sourceDeviceIds = Array.from(
        new Set(revisions.flatMap((revision) => revision.sourceDeviceId ? [revision.sourceDeviceId] : [])),
      );
      const sourceDevices = sourceDeviceIds.length
        ? await db.select().from(devices).where(inArray(devices.id, sourceDeviceIds))
        : [];
      const sourceDeviceById = new Map(sourceDevices.map((device) => [device.id, device]));
      const revisionPayload = revisions.map((revision) => ({
        ...revision,
        sourceDevice: revision.sourceDeviceId
          ? sourceDeviceById.get(revision.sourceDeviceId) ?? null
          : null,
      }));
      const [projectAssignment] = await db
        .select({
          projectId: conversationProjects.projectId,
          projectName: projects.name,
          confidence: conversationProjects.confidence,
          lockedByUser: conversationProjects.lockedByUser,
          suggestedName: conversationProjects.suggestedName,
        })
        .from(conversationProjects)
        .leftJoin(projects, eq(projects.id, conversationProjects.projectId))
        .where(eq(conversationProjects.conversationId, conversation.id))
        .limit(1);
      const selectedRevisionId =
        query.revisionId ?? (await latestRevisionId(conversation.id));
      const selectedRevision = revisions.find(
        (revision) => revision.id === selectedRevisionId,
      );
      const selectedRevisionPayload = revisionPayload.find(
        (revision) => revision.id === selectedRevisionId,
      );
      if (!selectedRevision) {
        return {
          conversation,
          projectAssignment: projectAssignment ?? null,
          revisions: revisionPayload,
          selectedRevision: null,
          messages: [],
        };
      }
      const hydratedMessages = await loadHydratedRevisionMessages(selectedRevision.id);
      return {
        conversation,
        projectAssignment: projectAssignment ?? null,
        revisions: revisionPayload,
        selectedRevision: selectedRevisionPayload ?? selectedRevision,
        messages: hydratedMessages,
      };
    },
  );

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/v1/conversations/:id/export",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const { format } = ExportQuerySchema.parse(request.query);
      const data = await loadConversationExportData({
        conversationId: params.id,
      });
      if (!data) return reply.code(404).send({ error: "Conversation not found" });
      const content = await renderConversationExport(format, data);
      const filename = `${safeExportFilename(data.scopeName)}.${format}`;
      reply
        .header("Content-Type", exportMimeType(format))
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        )
        .header("Cache-Control", "no-store");
      return reply.send(content);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/conversations/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      if (!(await hardDeleteConversation(params.id))) {
        return reply.code(404).send({ error: "Conversation not found" });
      }
      return reply.code(204).send();
    },
  );
}
