import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ProviderSchema } from "@ai-archive/contracts";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import {
  conversationProjects,
  conversationRevisions,
  conversationSearchChunks,
  conversationTags,
  conversations,
  devices,
  messages,
  projects,
  tags,
} from "../schema.js";
import {
  hardDeleteConversation,
  restoreConversation,
  softDeleteConversation,
} from "../services/capture.js";
import {
  createConversationTextExport,
  createConversationXlsxExport,
  type ConversationExportFormat,
} from "../services/conversation-export.js";
import { loadConversationTags } from "../services/tags.js";
import {
  buildConversationSearchHit,
} from "../services/conversation-search.js";
import { literalContainsPattern } from "../services/search-pattern.js";
import { rebuildConversationSearchChunks } from "../services/search-chunks.js";
import { parseInstanceDateBoundary } from "../services/timezone.js";
import {
  loadConversationLineage,
  mainConversationFilter,
} from "../services/conversation-lineage.js";

import { buildSourceDeviceOptionsQuery } from "../services/source-devices.js";
import { conversationPageSnippetsQuery, conversationSearchPageQuery, conversationSearchFilter, conversationTagsFilter, currentConversationRevisionFilter } from "../services/conversation-list-query.js";
import { projectConversationFilter } from "../services/project-lineage.js";
import { loadConversationEvidencePage, loadCurrentConversationPage } from "../services/conversation-page.js";

const ListQuerySchema = z.object({
  q: z.string().max(500).optional(),
  provider: ProviderSchema.optional(),
  source: z.enum(["web", "openclaw", "codex", "claude_code", "grok_build", "historical_import"]).optional(),
  sourceDevice: z.string().max(512).refine(value => value === "unrecorded" || value === "historical_import" || (value.startsWith("name:") && value.slice(5).trim().length > 0)).optional(),
  completeness: z.enum(["complete", "partial"]).optional(),
  captureMode: z.enum(["full", "append", "import"]).optional(),
  projectId: z.guid().optional(),
  tagIds: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value
          : typeof value === "string" && value
            ? value.split(",")
            : [],
      z.array(z.guid()).max(20),
    )
    .default([]),
  from: z.string().refine(
    (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)),
  ).optional(),
  to: z.string().refine(
    (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value)),
  ).optional(),
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

const ExportQuerySchema = z.object({
  format: z.enum(["csv", "md", "xlsx"]),
});

const BatchConversationIdsSchema = z.array(z.guid()).min(1).max(500);

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
    return db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL jit = off`);
    const rows = await tx
      .select({
        provider: conversations.provider,
        count: count(),
      })
      .from(conversations)
      .where(and(isNull(conversations.deletedAt), mainConversationFilter()))
      .groupBy(conversations.provider);
    return rows.map((row) => ({
      provider: row.provider,
      count: Number(row.count ?? 0),
    }));
    }, { accessMode: "read only" });
  });

  app.get("/api/v1/conversations/source-devices", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return db.execute<{ key: string; name: string; count: number }>(buildSourceDeviceOptionsQuery());
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
    const searchPattern = query.q ? literalContainsPattern(query.q) : null;
    const filters = [isNull(conversations.deletedAt), mainConversationFilter()];
    if (query.provider) filters.push(eq(conversations.provider, query.provider));
    if (query.source === "web") filters.push(inArray(conversations.provider, webProviders));
    if (query.source === "openclaw") filters.push(eq(conversations.provider, "openclaw"));
    if (query.source === "codex") filters.push(eq(conversations.provider, "codex"));
    if (query.source === "claude_code") filters.push(eq(conversations.provider, "claude_code"));
    if (query.source === "grok_build") filters.push(eq(conversations.provider, "grok_build"));
    if (query.projectId) filters.push(projectConversationFilter(query.projectId));
    if (query.from) filters.push(gte(conversations.updatedAt, parseInstanceDateBoundary(query.from)));
    if (query.to) filters.push(lt(conversations.updatedAt, parseInstanceDateBoundary(query.to, true)));
    const revisionFilter = currentConversationRevisionFilter(query);
    if (revisionFilter) filters.push(revisionFilter);
    if (query.tagIds.length) filters.push(conversationTagsFilter(query.tagIds));
    if (query.q) filters.push(conversationSearchFilter(query.q));
    const { totalRow, rows, revisionRows, pageTags, pageHits, childCounts } = await db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL jit = off`);
      const totalQuery = tx
        .select({ total: count() })
        .from(conversations)
        .where(and(...filters));
      const pageQuery = tx
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
        .orderBy(desc(conversations.updatedAt), desc(conversations.id))
        .limit(query.limit)
        .offset(query.offset);
      let totalRow: { total: number } | undefined;
      let rows: Awaited<typeof pageQuery>;
      if (query.q) {
        const [result] = await tx.execute<{total:number;rows:Awaited<typeof pageQuery>}>(
          conversationSearchPageQuery(filters, query.limit, query.offset));
        totalRow = {total: Number(result?.total ?? 0)}; rows = result?.rows ?? [];
      } else {
        [totalRow] = await totalQuery; rows = await pageQuery;
      }

      const pageIds = rows.map(row => row.id);
      const revisionRows = pageIds.length ? await tx.selectDistinctOn([conversationRevisions.conversationId], {
        conversationId: conversationRevisions.conversationId,
                  id: conversationRevisions.id,
                  completeness: conversationRevisions.completeness,
                  messageCount: sql<number>`coalesce(${conversationRevisions.presentationMessageCount}, ${conversationRevisions.messageCount})`,
                  storedMessageCount: sql<number>`coalesce(${conversationRevisions.storedMessageCount}, ${conversationRevisions.messageCount})`,
                  sourceContentPending: sql<boolean>`coalesce(${conversationRevisions.sourceContentPending}, false)`,
                  capturedAt: conversationRevisions.capturedAt,
                  captureMode: conversationRevisions.captureMode,
                  triggerReason: conversationRevisions.triggerReason,
                  adapterVersion: conversationRevisions.adapterVersion,
                  sourceDeviceId: conversationRevisions.sourceDeviceId,
                  sourceDeviceName: devices.name,
                  sourceDeviceKind: devices.kind,
      }).from(conversationRevisions)
        .leftJoin(devices, eq(devices.id, conversationRevisions.sourceDeviceId))
        .where(inArray(conversationRevisions.conversationId, pageIds))
        .orderBy(conversationRevisions.conversationId,
          desc(conversationRevisions.isAccumulated), desc(sql`(${conversationRevisions.completeness} = 'complete')`),
          desc(conversationRevisions.capturedAt), desc(conversationRevisions.createdAt), desc(conversationRevisions.id)) : [];
      const pageTags = pageIds.length ? await tx.select({
        conversationId: conversationTags.conversationId,
        id: tags.id, name: tags.name, normalizedName: tags.normalizedName,
        confidence: conversationTags.confidence, source: conversationTags.source,
        lockedByUser: conversationTags.lockedByUser,
        createdAt: conversationTags.createdAt, updatedAt: conversationTags.updatedAt,
      }).from(conversationTags).innerJoin(tags, eq(tags.id, conversationTags.tagId))
        .where(inArray(conversationTags.conversationId, pageIds))
        .orderBy(desc(conversationTags.lockedByUser), desc(conversationTags.confidence), tags.name) : [];
      const bodySearchIds = query.q ? rows.filter(row =>
        !row.title?.toLocaleLowerCase().includes(query.q!.toLocaleLowerCase())).map(row => row.id) : [];
      const hitRevisions = revisionRows.filter(revision => bodySearchIds.includes(revision.conversationId));
      const pageHits = hitRevisions.length ? await tx.execute<{
        conversationId: string; revisionId: string; ordinal: number; content: string;
      }>(conversationPageSnippetsQuery(hitRevisions.map(revision => revision.id), query.q!)) : [];
      const childCounts = pageIds.length ? await tx.execute<{ id: string; childCount: number }>(sql`
        select parent.id, count(child.id)::int as "childCount"
        from conversations parent join conversations child on child.provider = parent.provider
          and child.parent_external_session_id = parent.external_session_id
          and child.id <> parent.id and child.deleted_at is null
        where ${inArray(sql`parent.id`, pageIds)} group by parent.id
      `) : [];
      return { totalRow, rows, revisionRows, pageTags, pageHits, childCounts };
    }, { accessMode: "read only" });
    const revisionsByConversation = new Map(revisionRows.map(({ conversationId, ...revision }) => [conversationId, revision]));
    const hitsByConversation = new Map(pageHits.map(({ conversationId, ...hit }) => [conversationId, hit]));
    const tagsByConversation = new Map<string, Array<Omit<typeof pageTags[number], "conversationId">>>();
    for (const { conversationId, ...tag } of pageTags) {
      const associated = tagsByConversation.get(conversationId) ?? [];
      associated.push(tag);
      tagsByConversation.set(conversationId, associated);
    }
    const childCountById = new Map(childCounts.map(row => [row.id, Number(row.childCount)]));
    const items = rows.map((row) => {
        const revision = revisionsByConversation.get(row.id);
        const titleMatched = Boolean(
          query.q && row.title?.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()),
        );
        const hit = hitsByConversation.get(row.id);
        const tagRows = tagsByConversation.get(row.id) ?? [];
        return {
          ...row,
          childCount: childCountById.get(row.id) ?? 0,
          tags: tagRows,
          latestRevision: revision ?? null,
          searchHit: query.q
            ? buildConversationSearchHit({
                query: query.q,
                title: row.title,
                titleMatched,
                latestRevisionId: revision?.id ?? null,
                bodyHit: hit ?? null,
              }) ?? {
                reason: "子代理命中",
                revisionId: null,
                messageOrdinal: null,
                excerpt: "匹配内容位于此会话的子代理中，可在详情中查看。",
              }
            : null,
        };
      });
    const total = Number(totalRow?.total ?? 0);
    return {
      items,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + items.length < total,
      },
    };
  });

  app.get("/api/v1/conversations/trash", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const where = isNotNull(conversations.deletedAt);
    const [[totalRow], items] = await Promise.all([
      db.select({ total: count() }).from(conversations).where(where),
      db.select().from(conversations).where(where).orderBy(desc(conversations.deletedAt)).limit(query.limit).offset(query.offset),
    ]);
    const total = Number(totalRow?.total ?? 0);
    return {
      items,
      retentionDays: 30,
      pagination: { total, limit: query.limit, offset: query.offset, hasMore: query.offset + items.length < total },
    };
  });

  app.post("/api/v1/search/rebuild", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const chunkCount = await rebuildConversationSearchChunks();
    return { ok: true, chunkCount };
  });

  app.post("/api/v1/conversations/batch/project", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z.object({
      conversationIds: BatchConversationIdsSchema,
      projectId: z.guid().nullable(),
    }).parse(request.body);
    if (input.projectId) {
      const [project] = await db.select({ id: projects.id }).from(projects).where(
        and(eq(projects.id, input.projectId), eq(projects.archived, false)),
      ).limit(1);
      if (!project) return reply.code(400).send({ error: "Project not found or archived" });
    }
    const activeRows = await db.select({ id: conversations.id }).from(conversations).where(
      and(inArray(conversations.id, input.conversationIds), isNull(conversations.deletedAt)),
    );
    await db.transaction(async (tx) => {
      for (const conversation of activeRows) {
        await tx.insert(conversationProjects).values({
          conversationId: conversation.id,
          projectId: input.projectId,
          confidence: 1,
          lockedByUser: true,
          suggestedName: null,
          updatedAt: new Date(),
        }).onConflictDoUpdate({
          target: conversationProjects.conversationId,
          set: {
            projectId: input.projectId,
            confidence: 1,
            lockedByUser: true,
            suggestedName: null,
            updatedAt: new Date(),
          },
        });
      }
    });
    return { updated: activeRows.length };
  });

  app.post("/api/v1/conversations/batch/tags", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z.object({
      conversationIds: BatchConversationIdsSchema,
      tagIds: z.array(z.guid()).min(1).max(50),
      operation: z.enum(["add", "remove"]),
    }).parse(request.body);
    const [activeRows, tagRows] = await Promise.all([
      db.select({ id: conversations.id }).from(conversations).where(
        and(inArray(conversations.id, input.conversationIds), isNull(conversations.deletedAt)),
      ),
      db.select({ id: tags.id }).from(tags).where(inArray(tags.id, input.tagIds)),
    ]);
    if (tagRows.length !== new Set(input.tagIds).size) {
      return reply.code(400).send({ error: "One or more tags do not exist" });
    }
    await db.transaction(async (tx) => {
      if (input.operation === "remove") {
        if (activeRows.length) {
          await tx.delete(conversationTags).where(
            and(
              inArray(conversationTags.conversationId, activeRows.map((row) => row.id)),
              inArray(conversationTags.tagId, input.tagIds),
            ),
          );
        }
        return;
      }
      for (const conversation of activeRows) {
        for (const tag of tagRows) {
          await tx.insert(conversationTags).values({
            conversationId: conversation.id,
            tagId: tag.id,
            confidence: 1,
            source: "manual",
            lockedByUser: true,
            updatedAt: new Date(),
          }).onConflictDoUpdate({
            target: [conversationTags.conversationId, conversationTags.tagId],
            set: {
              confidence: 1,
              source: "manual",
              lockedByUser: true,
              updatedAt: new Date(),
            },
          });
        }
      }
    });
    return { updatedConversations: activeRows.length, tagCount: tagRows.length };
  });

  app.post("/api/v1/conversations/batch/export", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const { format } = ExportQuerySchema.parse(request.query);
    const input = z.object({ conversationIds: BatchConversationIdsSchema }).parse(request.body);
    if (format === "xlsx") {
      const xlsx = await createConversationXlsxExport({ conversationIds: input.conversationIds });
      if (!xlsx) return reply.code(404).send({ error: "No conversations found" });
      reply.header("Content-Type", exportMimeType(format)).header(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(`${safeExportFilename(xlsx.scopeName)}.${format}`)}`,
      );
      return reply.send(xlsx.stream);
    }
    const textExport = await createConversationTextExport(
      { conversationIds: input.conversationIds },
      format,
    );
    if (!textExport) return reply.code(404).send({ error: "No conversations found" });
    reply.header("Content-Type", exportMimeType(format)).header(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(`${safeExportFilename(textExport.scopeName)}.${format}`)}`,
    );
    return reply.send(textExport.stream);
  });

  app.get<{ Params: { id: string } }>("/api/v1/conversations/:id/evidence", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const params = z.object({ id: z.guid() }).parse(request.params);
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      messageOrdinal: z.coerce.number().int().min(0).optional(),
      q: z.string().max(500).optional(),
    }).parse(request.query);
    const [conversation] = await db.select({ id: conversations.id }).from(conversations)
      .where(and(eq(conversations.id, params.id), isNull(conversations.deletedAt))).limit(1);
    if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
    return loadConversationEvidencePage(conversation.id, query);
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/conversations/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      const query = z.object({
        revisionId: z.guid().optional(),
        messageLimit: z.coerce.number().int().min(1).max(200).default(50),
        messageOffset: z.coerce.number().int().min(0).default(0),
        messageOrdinal: z.coerce.number().int().min(0).optional(),
      }).parse(request.query);
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
      const lineage = await loadConversationLineage(conversation);
      const archive = await loadCurrentConversationPage(conversation.id, query);
      const revisions = archive ? [archive.revision] : [];
      const sourceDeviceIds = Array.from(
        new Set(revisions.flatMap((revision) => revision.sourceDeviceId ? [revision.sourceDeviceId] : [])),
      );
      const sourceDevices = sourceDeviceIds.length
        ? await db.select({ id: devices.id, name: devices.name, kind: devices.kind })
          .from(devices).where(inArray(devices.id, sourceDeviceIds))
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
      const selectedRevisionId = archive?.revision.id;
      const selectedRevision = revisions.find(
        (revision) => revision.id === selectedRevisionId,
      );
      const selectedRevisionPayload = revisionPayload.find(
        (revision) => revision.id === selectedRevisionId,
      );
      if (!selectedRevision) {
        return {
          conversation,
          ...lineage,
          projectAssignment: projectAssignment ?? null,
          tags: await loadConversationTags(conversation.id),
          revisions: revisionPayload,
          selectedRevision: null,
          messages: [],
          messagePagination: { total: 0, limit: query.messageLimit, offset: query.messageOffset, hasMore: false },
        };
      }

      return {
        conversation,
        ...lineage,
        projectAssignment: projectAssignment ?? null,
        tags: await loadConversationTags(conversation.id),
        revisions: revisionPayload,
        selectedRevision: selectedRevisionPayload ?? selectedRevision,
        messages: archive!.messages,
        messagePagination: archive!.messagePagination,
        ...(archive!.archiveReview ? { archiveReview: archive!.archiveReview } : {}),
      };
    },
  );

  app.get<{ Params: { id: string; revisionId: string } }>(
    "/api/v1/conversations/:id/revisions/:revisionId/diff",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({
        id: z.guid(),
        revisionId: z.guid(),
      }).parse(request.params);
      return reply.code(410).send({
        error: "会话现维护一份持续更新的正文，不再提供历史版本比较",
        conversationUrl: `/conversations/${params.id}`,
      });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/v1/conversations/:id/export",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      const { format } = ExportQuerySchema.parse(request.query);
      if (format === "xlsx") {
        const xlsx = await createConversationXlsxExport({
          conversationId: params.id,
        });
        if (!xlsx) return reply.code(404).send({ error: "Conversation not found" });
        const filename = `${safeExportFilename(xlsx.scopeName)}.${format}`;
        reply
          .header("Content-Type", exportMimeType(format))
          .header(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          )
          .header("Cache-Control", "no-store");
        return reply.send(xlsx.stream);
      }
      const textExport = await createConversationTextExport(
        { conversationId: params.id },
        format,
      );
      if (!textExport) return reply.code(404).send({ error: "Conversation not found" });
      const filename = `${safeExportFilename(textExport.scopeName)}.${format}`;
      reply
        .header("Content-Type", exportMimeType(format))
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        )
        .header("Cache-Control", "no-store");
      return reply.send(textExport.stream);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/conversations/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      if (!(await softDeleteConversation(params.id))) {
        return reply.code(404).send({ error: "Conversation not found" });
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/restore",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      if (!(await restoreConversation(params.id))) {
        return reply.code(404).send({ error: "Deleted conversation not found" });
      }
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/permanent",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      const input = z.object({ confirmation: z.literal("DELETE") }).parse(request.body);
      const [deleted] = await db.select({ id: conversations.id }).from(conversations).where(
        and(eq(conversations.id, params.id), isNotNull(conversations.deletedAt)),
      ).limit(1);
      if (!deleted || input.confirmation !== "DELETE" || !(await hardDeleteConversation(params.id))) {
        return reply.code(404).send({ error: "Conversation not found" });
      }
      return reply.code(204).send();
    },
  );
}
