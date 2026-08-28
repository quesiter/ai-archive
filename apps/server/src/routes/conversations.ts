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
  latestRevisionId,
  restoreConversation,
  softDeleteConversation,
} from "../services/capture.js";
import {
  loadHydratedRevisionMessages,
} from "../services/revision-storage.js";
import {
  createConversationTextExport,
  createConversationXlsxExport,
  type ConversationExportFormat,
} from "../services/conversation-export.js";
import { loadConversationTags } from "../services/tags.js";
import {
  buildConversationSearchHit,
  conversationIdsMatchingAllTags,
} from "../services/conversation-search.js";
import { literalContainsPattern } from "../services/search-pattern.js";
import { loadRevisionDiff } from "../services/revision-diff.js";
import { rebuildConversationSearchChunks } from "../services/search-chunks.js";
import { parseInstanceDateBoundary } from "../services/timezone.js";

const ListQuerySchema = z.object({
  q: z.string().max(500).optional(),
  provider: ProviderSchema.optional(),
  source: z.enum(["web", "openclaw", "codex", "claude_code", "historical_import"]).optional(),
  completeness: z.enum(["complete", "partial"]).optional(),
  captureMode: z.enum(["full", "append", "import"]).optional(),
  projectId: z.string().uuid().optional(),
  tagIds: z
    .preprocess(
      (value) =>
        Array.isArray(value)
          ? value
          : typeof value === "string" && value
            ? value.split(",")
            : [],
      z.array(z.string().uuid()).max(20),
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

const BatchConversationIdsSchema = z.array(z.string().uuid()).min(1).max(500);

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
    const searchPattern = query.q ? literalContainsPattern(query.q) : null;
    if (query.q) {
      const revisionMatches = await db
        .selectDistinct({ id: conversationRevisions.conversationId })
        .from(conversationSearchChunks)
        .innerJoin(
          conversationRevisions,
          eq(conversationRevisions.id, conversationSearchChunks.revisionId),
        )
        .where(
          or(
            ilike(conversationSearchChunks.content, searchPattern!),
            sql`conversation_search_chunks.search_vector @@ websearch_to_tsquery('simple', ${query.q})`,
          ),
        );
      matchingIds = revisionMatches.map((row) => row.id);
    }
    let revisionScopedIds: string[] | undefined;
    const currentRevisionFilters = [sql`ranked.revision_rank = 1`];
    if (query.completeness) {
      currentRevisionFilters.push(sql`ranked.completeness = ${query.completeness}`);
    }
    if (query.captureMode) {
      currentRevisionFilters.push(sql`ranked.capture_mode = ${query.captureMode}`);
    }
    if (query.source === "historical_import") {
      currentRevisionFilters.push(sql`ranked.capture_mode = 'import'`);
    }
    if (currentRevisionFilters.length > 1) {
      const rows = await db.execute<{ id: string }>(sql`
        select ranked.id
        from (
          select
            ${conversationRevisions.conversationId} as id,
            ${conversationRevisions.completeness} as completeness,
            ${conversationRevisions.captureMode} as capture_mode,
            row_number() over (
              partition by ${conversationRevisions.conversationId}
              order by
                (${conversationRevisions.completeness} = 'complete') desc,
                ${conversationRevisions.capturedAt} desc,
                ${conversationRevisions.createdAt} desc
            ) as revision_rank
          from ${conversationRevisions}
        ) ranked
        where ${sql.join(currentRevisionFilters, sql` and `)}
      `);
      revisionScopedIds = rows.map((row) => row.id);
      if (!revisionScopedIds.length) return {
        items: [],
        pagination: { total: 0, limit: query.limit, offset: query.offset, hasMore: false },
      };
    }
    let tagScopedIds: string[] | undefined;
    if (query.tagIds.length) {
      const tagLinks = await db
        .select({
          conversationId: conversationTags.conversationId,
          tagId: conversationTags.tagId,
        })
        .from(conversationTags)
        .where(inArray(conversationTags.tagId, query.tagIds));
      tagScopedIds = conversationIdsMatchingAllTags(tagLinks, query.tagIds);
      if (!tagScopedIds.length) return {
        items: [],
        pagination: { total: 0, limit: query.limit, offset: query.offset, hasMore: false },
      };
    }
    const filters = [isNull(conversations.deletedAt)];
    if (query.provider) filters.push(eq(conversations.provider, query.provider));
    if (query.source === "web") filters.push(inArray(conversations.provider, webProviders));
    if (query.source === "openclaw") filters.push(eq(conversations.provider, "openclaw"));
    if (query.source === "codex") filters.push(eq(conversations.provider, "codex"));
    if (query.source === "claude_code") filters.push(eq(conversations.provider, "claude_code"));
    if (query.projectId) filters.push(eq(conversationProjects.projectId, query.projectId));
    if (query.from) filters.push(gte(conversations.updatedAt, parseInstanceDateBoundary(query.from)));
    if (query.to) filters.push(lt(conversations.updatedAt, parseInstanceDateBoundary(query.to, true)));
    if (revisionScopedIds) filters.push(inArray(conversations.id, revisionScopedIds));
    if (tagScopedIds) filters.push(inArray(conversations.id, tagScopedIds));
    if (query.q) {
      filters.push(
        matchingIds?.length
          ? or(
              ilike(conversations.title, searchPattern!),
              inArray(conversations.id, matchingIds),
            )!
          : ilike(conversations.title, searchPattern!),
      );
    }
    const [totalRow] = await db
      .select({ total: count() })
      .from(conversations)
      .leftJoin(
        conversationProjects,
        eq(conversationProjects.conversationId, conversations.id),
      )
      .leftJoin(projects, eq(projects.id, conversationProjects.projectId))
      .where(and(...filters));
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

    const items = await Promise.all(
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
        const titleMatched = Boolean(
          query.q && row.title?.toLocaleLowerCase().includes(query.q.toLocaleLowerCase()),
        );
        const [hit] = query.q && !titleMatched
          ? await db
              .select({
                revisionId: conversationRevisions.id,
                ordinal: messages.ordinal,
                content: conversationSearchChunks.content,
              })
              .from(conversationSearchChunks)
              .innerJoin(messages, eq(messages.id, conversationSearchChunks.messageId))
              .innerJoin(conversationRevisions, eq(conversationRevisions.id, conversationSearchChunks.revisionId))
              .where(
                and(
                  eq(conversationRevisions.conversationId, row.id),
                  ilike(conversationSearchChunks.content, searchPattern!),
                ),
              )
              .orderBy(
                desc(conversationRevisions.capturedAt),
                desc(conversationRevisions.createdAt),
                asc(messages.ordinal),
              )
              .limit(1)
          : [];
        const tagRows = await loadConversationTags(row.id);
        return {
          ...row,
          tags: tagRows,
          latestRevision: revision ?? null,
          searchHit: query.q
            ? buildConversationSearchHit({
                query: query.q,
                title: row.title,
                titleMatched,
                latestRevisionId: revision?.id ?? null,
                bodyHit: hit ?? null,
              })
            : null,
        };
      }),
    );
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
      projectId: z.string().uuid().nullable(),
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
      tagIds: z.array(z.string().uuid()).min(1).max(50),
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
          tags: await loadConversationTags(conversation.id),
          revisions: revisionPayload,
          selectedRevision: null,
          messages: [],
        };
      }
      const hydratedMessages = await loadHydratedRevisionMessages(selectedRevision.id);
      return {
        conversation,
        projectAssignment: projectAssignment ?? null,
        tags: await loadConversationTags(conversation.id),
        revisions: revisionPayload,
        selectedRevision: selectedRevisionPayload ?? selectedRevision,
        messages: hydratedMessages,
      };
    },
  );

  app.get<{ Params: { id: string; revisionId: string } }>(
    "/api/v1/conversations/:id/revisions/:revisionId/diff",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({
        id: z.string().uuid(),
        revisionId: z.string().uuid(),
      }).parse(request.params);
      const query = z.object({ baseRevisionId: z.string().uuid().optional() }).parse(request.query);
      const diff = await loadRevisionDiff({
        conversationId: params.id,
        revisionId: params.revisionId,
        ...(query.baseRevisionId ? { baseRevisionId: query.baseRevisionId } : {}),
      });
      if (!diff) return reply.code(404).send({ error: "Revision not found" });
      return diff;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/v1/conversations/:id/export",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
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
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
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
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
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
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
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
