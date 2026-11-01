import { and, asc, count, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import { projectMergeSuggestionRoutes } from "./project-merge-suggestions.js";
import {
  conversationProjects,
  conversationRevisions,
  conversationTags,
  conversations,
  projects,
  tags,
} from "../schema.js";
import {
  createBackgroundTask,
  failStaleBackgroundTasks,
  getBackgroundTask,
  getLatestBackgroundTask,
  updateBackgroundTask,
} from "../services/background-tasks.js";
import {
  enqueueConversationClassification,
  enqueueUnlockedReclassification,
} from "../services/queue.js";
import { getBooleanSetting, getSetting } from "../services/settings.js";
import {
  createConversationTextExport,
  createConversationXlsxExport,
  type ConversationExportFormat,
} from "../services/conversation-export.js";
import { mergeProjectIntoProject, mergeProjectsIntoProject } from "../services/project-merge.js";
import { generateProjectContext } from "../services/project-context.js";
import { conversationChildCount } from "../services/conversation-lineage.js";
import {
  projectConversationFilter,
  projectConversationMembershipQuery,
  unclassifiedConversationFilter,
} from "../services/project-lineage.js";
import { safeStoredError, writeOperationLog } from "../services/operation-log.js";
import {
  isUniqueViolation,
  normalizeProjectName,
  projectConflictError,
} from "../services/projects.js";

const ProjectDescriptionSchema = z.string().max(5_000);
const ProjectInputSchema = z.object({
  name: z.string().transform((value, context) => {
    const normalized = normalizeProjectName(value);
    if (!normalized.name || [...normalized.name].length > 200) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Project name must contain 1 to 200 characters after normalization",
      });
      return z.NEVER;
    }
    return normalized.name;
  }),
  description: ProjectDescriptionSchema.default(""),
});

const ProjectExportQuerySchema = z.object({
  format: z.enum(["csv", "md", "xlsx"]),
});

function safeProjectExportFilename(value: string): string {
  const normalized = value
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return normalized || "project";
}

function projectExportMimeType(format: ConversationExportFormat): string {
  if (format === "csv") return "text/csv; charset=utf-8";
  if (format === "md") return "text/markdown; charset=utf-8";
  return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
}

async function enqueueAutoReclassification(
  log: Pick<FastifyInstance["log"], "warn">,
): Promise<void> {
  if (!(await getBooleanSetting("classification.autoReclassify", false))) return;
  await enqueueUnlockedReclassification().catch((error) =>
    log.warn({ error }, "Failed to queue project and tag organization"),
  );
}

function liveProjectStatistics() {
  return db
    .select({
      projectId: sql<string>`project_memberships.project_id`.as("project_id"),
      conversationCount: sql<number>`count(*)::int`.as("conversation_count"),
      latestActivityAt: sql<Date | null>`max(project_memberships.conversation_updated_at)`.as(
        "latest_activity_at",
      ),
      growth7d: sql<number>`count(*) filter (
        where project_memberships.conversation_updated_at >= now() - interval '7 days'
      )::int`.as("growth_7d"),
      growth30d: sql<number>`count(*) filter (
        where project_memberships.conversation_updated_at >= now() - interval '30 days'
      )::int`.as("growth_30d"),
    })
    .from(sql`(${projectConversationMembershipQuery()}) project_memberships`)
    .groupBy(sql`project_memberships.project_id`)
    .as("project_conversation_stats");
}

export function buildProjectListFilter(input: { archived?: boolean; q?: string }) {
  const query = normalizeProjectName(input.q ?? "").normalizedName;
  return and(
    input.archived === undefined ? undefined : eq(projects.archived, input.archived),
    query ? like(projects.normalizedName, `%${query.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
  );
}

export function buildProjectListQuery(input: {
  limit: number;
  offset: number;
  archived?: boolean;
  q?: string;
}) {
  const statistics = liveProjectStatistics();
  const conversationCount = sql<number>`coalesce(${statistics.conversationCount}, 0)::int`;
  const where = buildProjectListFilter(input);

  return db
    .select({
      id: projects.id,
      name: projects.name,
      normalizedName: projects.normalizedName,
      description: projects.description,
      archived: projects.archived,
      updatedAt: projects.updatedAt,
      createdAt: projects.createdAt,
      conversationCount,
      latestActivityAt: statistics.latestActivityAt,
      growth7d: sql<number>`coalesce(${statistics.growth7d}, 0)::int`,
      growth30d: sql<number>`coalesce(${statistics.growth30d}, 0)::int`,
    })
    .from(projects)
    .leftJoin(statistics, sql`"project_conversation_stats"."project_id" = ${projects.id}`)
    .where(where)
    .orderBy(desc(conversationCount), asc(projects.name))
    .limit(input.limit)
    .offset(input.offset);
}

export function buildProjectTotalsQuery() {
  const statistics = liveProjectStatistics();
  return db
    .select({
      projectCount: sql<number>`count(*) filter (where not ${projects.archived})::int`,
      archivedProjectCount: sql<number>`count(*) filter (where ${projects.archived})::int`,
      activeProjectCount: sql<number>`count(*) filter (
        where not ${projects.archived} and "project_conversation_stats"."project_id" is not null
      )::int`,
    })
    .from(projects)
    .leftJoin(statistics, sql`"project_conversation_stats"."project_id" = ${projects.id}`);
}

export function buildProjectTimelineConversationQuery(
  projectId: string,
  input: { limit: number; offset: number } = { limit: 100, offset: 0 },
  executor: Pick<typeof db, "select"> = db,
) {
  const revision = executor.select({
    id: conversationRevisions.id,
    capturedAt: conversationRevisions.capturedAt,
  }).from(conversationRevisions)
    .where(eq(conversationRevisions.conversationId, conversations.id))
    .orderBy(desc(conversationRevisions.isAccumulated),
      desc(sql`(${conversationRevisions.completeness} = 'complete')`),
      desc(conversationRevisions.capturedAt), desc(conversationRevisions.createdAt), desc(conversationRevisions.id))
    .limit(1).as("current_revision");
  return executor.select({
    id: conversations.id,
    provider: conversations.provider,
    title: conversations.title,
    revisionId: revision.id,
    capturedAt: revision.capturedAt,
  }).from(conversations).innerJoinLateral(revision, sql`true`).where(and(
    projectConversationFilter(projectId), isNull(conversations.deletedAt),
  )).orderBy(desc(revision.capturedAt), desc(revision.id), desc(conversations.id))
    .limit(input.limit).offset(input.offset);
}

async function loadProjectsOverview() {
  const since7d = Date.now() - 7 * 86_400_000;
  const since30d = Date.now() - 30 * 86_400_000;
  const [projectRows, assignmentRows, unclassifiedRows, tagRows, allTags] =
    await Promise.all([
      db
        .select()
        .from(projects)
        .orderBy(asc(projects.name)),
      db
        .select({
          id: conversations.id,
          provider: conversations.provider,
          title: conversations.title,
          updatedAt: conversations.updatedAt,
          projectId: conversationProjects.projectId,
          confidence: conversationProjects.confidence,
          lockedByUser: conversationProjects.lockedByUser,
          suggestedName: conversationProjects.suggestedName,
        })
        .from(conversationProjects)
        .innerJoin(conversations, eq(conversations.id, conversationProjects.conversationId))
        .where(isNull(conversations.deletedAt))
        .orderBy(desc(conversations.updatedAt)),
      db
        .select({
          id: conversations.id,
          provider: conversations.provider,
          title: conversations.title,
          updatedAt: conversations.updatedAt,
          suggestedName: conversationProjects.suggestedName,
          confidence: conversationProjects.confidence,
        })
        .from(conversations)
        .leftJoin(conversationProjects, eq(conversationProjects.conversationId, conversations.id))
        .where(
          and(
            isNull(conversationProjects.projectId),
            isNull(conversations.deletedAt),
          ),
        )
        .orderBy(desc(conversations.updatedAt)),
      db
        .select({
          projectId: conversationProjects.projectId,
          conversationId: conversationTags.conversationId,
          tagId: tags.id,
          tagName: tags.name,
        })
        .from(conversationTags)
        .innerJoin(tags, eq(tags.id, conversationTags.tagId))
        .innerJoin(
          conversationProjects,
          eq(conversationProjects.conversationId, conversationTags.conversationId),
        ),
      db.select({ id: tags.id }).from(tags),
    ]);
  const visibleIds = new Set(projectRows.map((project) => project.id));
  const conversationsByProject = new Map<string, typeof assignmentRows>();
  for (const assignment of assignmentRows) {
    if (!assignment.projectId || !visibleIds.has(assignment.projectId)) continue;
    const rows = conversationsByProject.get(assignment.projectId) ?? [];
    rows.push(assignment);
    conversationsByProject.set(assignment.projectId, rows);
  }
  const tagsByProject = new Map<string, Map<string, { id: string; name: string; count: number }>>();
  for (const row of tagRows) {
    if (!row.projectId || !visibleIds.has(row.projectId)) continue;
    const values = tagsByProject.get(row.projectId) ?? new Map();
    const value = values.get(row.tagId) ?? { id: row.tagId, name: row.tagName, count: 0 };
    value.count += 1;
    values.set(row.tagId, value);
    tagsByProject.set(row.projectId, values);
  }
  const groupedProjects = projectRows
    .map((project) => {
      const assigned = conversationsByProject.get(project.id) ?? [];
      const latestActivityAt = assigned[0]?.updatedAt ?? project.updatedAt;
      return {
        ...project,
        conversationCount: assigned.length,
        latestActivityAt,
        growth7d: assigned.filter((row) => row.updatedAt.getTime() >= since7d).length,
        growth30d: assigned.filter((row) => row.updatedAt.getTime() >= since30d).length,
        commonTags: [...(tagsByProject.get(project.id)?.values() ?? [])]
          .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
          .slice(0, 8),
        conversations: assigned.map(({ projectId: _projectId, ...row }) => row),
      };
    })
    .sort(
      (left, right) =>
        right.conversationCount - left.conversationCount ||
        left.name.localeCompare(right.name),
    );
  return {
    totals: {
      projectCount: groupedProjects.filter((project) => !project.archived).length,
      archivedProjectCount: groupedProjects.filter((project) => project.archived).length,
      activeProjectCount: groupedProjects.filter(
        (project) => !project.archived && project.conversationCount > 0,
      ).length,
      categorizedConversationCount: groupedProjects.reduce(
        (total, project) => total + project.conversationCount,
        0,
      ),
      unclassifiedConversationCount: unclassifiedRows.length,
      tagCount: allTags.length,
    },
    projects: groupedProjects,
    unclassified: unclassifiedRows,
  };
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  await projectMergeSuggestionRoutes(app);
  app.get("/api/v1/projects", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
      archived: z.enum(["true", "false"]).optional(),
      q: z.string().trim().max(200).default(""),
    }).parse(request.query);
    const archived = query.archived === undefined
      ? undefined
      : query.archived === "true";
    const filter = { q: query.q, ...(archived !== undefined ? { archived } : {}) };
    const where = buildProjectListFilter(filter);
    const [[totalRow], items] = await Promise.all([
      db.select({ total: count() }).from(projects).where(where),
      buildProjectListQuery({
        limit: query.limit,
        offset: query.offset,
        q: query.q,
        ...(archived === undefined ? {} : { archived }),
      }),
    ]);
    const total = Number(totalRow?.total ?? 0);
    return { items, pagination: { total, limit: query.limit, offset: query.offset, hasMore: query.offset + items.length < total } };
  });

  app.get("/api/v1/projects/options", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return db.select({ id: projects.id, name: projects.name, archived: projects.archived })
      .from(projects).orderBy(asc(projects.name));
  });

  app.get("/api/v1/projects/overview", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const [[projectTotals], [categorized], [unclassified], [tagTotal]] = await Promise.all([
      buildProjectTotalsQuery(),
      db.select({ value: sql<number>`count(distinct project_memberships.conversation_id)::int` })
        .from(sql`(${projectConversationMembershipQuery()}) project_memberships`),
      db.select({ value: count() }).from(conversations)
        .leftJoin(conversationProjects, eq(conversationProjects.conversationId, conversations.id))
        .where(unclassifiedConversationFilter()),
      db.select({ value: count() }).from(tags),
    ]);
    return {
      totals: {
        projectCount: Number(projectTotals?.projectCount ?? 0),
        archivedProjectCount: Number(projectTotals?.archivedProjectCount ?? 0),
        activeProjectCount: Number(projectTotals?.activeProjectCount ?? 0),
        categorizedConversationCount: Number(categorized?.value ?? 0),
        unclassifiedConversationCount: Number(unclassified?.value ?? 0),
        tagCount: Number(tagTotal?.value ?? 0),
      },
    };
  });

  app.post("/api/v1/projects", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = ProjectInputSchema.parse(request.body);
    const normalized = normalizeProjectName(input.name);
    let project: typeof projects.$inferSelect | undefined;
    try {
      [project] = await db
        .insert(projects)
        .values({ ...input, normalizedName: normalized.normalizedName })
        .returning();
    } catch (error) {
      if (isUniqueViolation(error)) throw projectConflictError();
      throw error;
    }
    await enqueueAutoReclassification(request.log);
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/projects/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      const input = ProjectInputSchema.partial()
        .extend({
          // PATCH omissions must not apply the create-time default in Zod 4.
          description: ProjectDescriptionSchema.optional(),
          archived: z.boolean().optional(),
        })
        .parse(request.body);
      const values = input.name
        ? {
            ...input,
            normalizedName: normalizeProjectName(input.name).normalizedName,
            updatedAt: new Date(),
          }
        : { ...input, updatedAt: new Date() };
      let project: typeof projects.$inferSelect | undefined;
      try {
        [project] = await db
          .update(projects)
          .set(values)
          .where(eq(projects.id, params.id))
          .returning();
      } catch (error) {
        if (isUniqueViolation(error)) throw projectConflictError();
        throw error;
      }
      if (!project) return reply.code(404).send({ error: "Project not found" });
      await enqueueAutoReclassification(request.log);
      return project;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/v1/projects/:id/export",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      const { format } = ProjectExportQuerySchema.parse(request.query);
      if (format === "xlsx") {
        const xlsx = await createConversationXlsxExport({ projectId: params.id });
        if (!xlsx) return reply.code(404).send({ error: "Project not found" });
        const filename = `${safeProjectExportFilename(xlsx.scopeName)}.${format}`;
        reply
          .header("Content-Type", projectExportMimeType(format))
          .header(
            "Content-Disposition",
            `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          )
          .header("Cache-Control", "no-store");
        return reply.send(xlsx.stream);
      }
      const textExport = await createConversationTextExport(
        { projectId: params.id },
        format,
      );
      if (!textExport) return reply.code(404).send({ error: "Project not found" });
      const filename = `${safeProjectExportFilename(textExport.scopeName)}.${format}`;
      reply
        .header("Content-Type", projectExportMimeType(format))
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .header("Cache-Control", "no-store");
      return reply.send(textExport.stream);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/projects/:id/context",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      const input = z.object({ ai: z.boolean().default(true) }).parse(request.body ?? {});
      const context = await generateProjectContext(params.id, input);
      if (!context) return reply.code(404).send({ error: "Project not found" });
      reply
        .header("Content-Type", "text/markdown; charset=utf-8")
        .header("Content-Disposition", "attachment; filename=PROJECT-CONTEXT.md")
        .header("Cache-Control", "no-store");
      return reply.send(context.markdown);
    },
  );

  app.get<{ Params: { id: string }; Querystring: { limit?: number; offset?: number } }>(
    "/api/v1/projects/:id/timeline",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      const query = z.object({
        limit: z.coerce.number().int().min(1).max(200).default(100),
        offset: z.coerce.number().int().min(0).default(0),
      }).parse(request.query);
      const [project] = await db
        .select()
        .from(projects)
        .where(eq(projects.id, params.id))
        .limit(1);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      const { conversationRows, total, tagLinks, childCounts } = await db.transaction(async tx => {
        const [totalRow] = await tx.select({ total: count() }).from(conversations)
          .where(and(projectConversationFilter(params.id), isNull(conversations.deletedAt), sql`exists (
            select 1 from conversation_revisions revision where revision.conversation_id = ${conversations.id}
          )`));
        const conversationRows = await buildProjectTimelineConversationQuery(params.id, query, tx);
        const ids = conversationRows.map(row => row.id);
        const tagLinks = ids.length ? await tx.select({
          conversationId: conversationTags.conversationId, id: tags.id, name: tags.name,
        }).from(conversationTags).innerJoin(tags, eq(tags.id, conversationTags.tagId))
          .where(inArray(conversationTags.conversationId, ids)).orderBy(tags.name) : [];
        const childCounts = ids.length ? await tx.execute<{ id: string; childCount: number }>(sql`
          select parent.id, count(child.id)::int as "childCount" from conversations parent
          join conversations child on child.provider = parent.provider
            and child.parent_external_session_id = parent.external_session_id
            and child.id <> parent.id and child.deleted_at is null
          where ${inArray(sql`parent.id`, ids)} group by parent.id
        `) : [];
        return { conversationRows, total: Number(totalRow?.total ?? 0), tagLinks, childCounts };
      }, { isolationLevel: "repeatable read", accessMode: "read only" });
      const tagsByConversation = new Map<string, Array<{ id: string; name: string }>>();
      for (const link of tagLinks) {
        const values = tagsByConversation.get(link.conversationId) ?? [];
        values.push({ id: link.id, name: link.name });
        tagsByConversation.set(link.conversationId, values);
      }
      const childCountById = new Map(childCounts.map(row => [row.id, Number(row.childCount)]));
      const items = conversationRows.map(conversation => ({
        conversationId: conversation.id, revisionId: conversation.revisionId,
        capturedAt: conversation.capturedAt, provider: conversation.provider, title: conversation.title,
        childCount: childCountById.get(conversation.id) ?? 0,
        tags: tagsByConversation.get(conversation.id) ?? [], href: `/conversations/${conversation.id}`,
      }));
      return {
        project, items,
        pagination: { total, limit: query.limit, offset: query.offset,
          hasMore: query.offset + items.length < total },
      };
    },
  );

  app.post("/api/v1/projects/merge", async (request, reply) => {
    const user = await requireWebUser(request, reply);
    if (!user) return;
    const input = z.object({
      sourceProjectIds: z.array(z.guid()).min(1),
      targetProjectId: z.guid(),
      targetName: ProjectInputSchema.shape.name.optional(),
    }).parse(request.body);
    const result = await mergeProjectsIntoProject({
      sourceProjectIds: input.sourceProjectIds,
      targetProjectId: input.targetProjectId,
      ...(input.targetName !== undefined ? { targetProjectName: input.targetName } : {}),
    });
    if (!result) return reply.code(404).send({ error: "Source or target project not found, or target is archived" });
    await writeOperationLog({
      scope: "classification",
      message: `${result.sourceProjectIds.length} 个项目（${result.sourceProjectNames.join("、")}）已合并到“${result.targetProjectName}”`,
      status: "completed",
      entityType: "project",
      entityId: result.targetProjectId,
      metadata: { ...result, userId: user.id },
    });
    return result;
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/projects/:id/merge",
    async (request, reply) => {
      const user = await requireWebUser(request, reply);
      if (!user) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      const input = z.object({
        targetProjectId: z.guid(),
        targetName: ProjectInputSchema.shape.name.optional(),
      }).parse(request.body);
      if (input.targetProjectId === params.id) {
        return reply.code(400).send({ error: "Source and target projects must be different" });
      }
      const result = await mergeProjectIntoProject({
        sourceProjectId: params.id,
        targetProjectId: input.targetProjectId,
        ...(input.targetName !== undefined
          ? { targetProjectName: input.targetName }
          : {}),
      });
      if (!result) return reply.code(404).send({ error: "Source or target project not found" });
      await writeOperationLog({
        scope: "classification",
        message: `项目“${result.sourceProjectName}”已合并到“${result.targetProjectName}”`,
        status: "completed",
        entityType: "project",
        entityId: result.targetProjectId,
        metadata: { ...result, userId: user.id },
      });
      return result;
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/project",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      const input = z.object({
        projectId: z.guid().nullable(),
        mode: z.enum(["lock", "auto"]).default("lock"),
      }).parse(request.body);
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, params.id), isNull(conversations.deletedAt)))
        .limit(1);
      if (!conversation) return reply.code(404).send({ error: "Conversation not found" });
      if (input.projectId) {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(and(eq(projects.id, input.projectId), eq(projects.archived, false)))
          .limit(1);
        if (!project) return reply.code(400).send({ error: "Project not found" });
      }
      const lockedByUser = input.mode === "lock";
      await db
        .insert(conversationProjects)
        .values({
          conversationId: conversation.id,
          projectId: input.projectId,
          confidence: lockedByUser ? 1 : null,
          lockedByUser,
          suggestedName: null,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: conversationProjects.conversationId,
          set: {
            projectId: input.projectId,
            confidence: lockedByUser ? 1 : null,
            lockedByUser,
            suggestedName: null,
            updatedAt: new Date(),
          },
        });
      if (!lockedByUser) {
        await enqueueConversationClassification(conversation.id).catch((error) =>
          request.log.warn(
            { error: safeStoredError(error) },
            "Failed to queue AI organization",
          ),
        );
      }
      return { ok: true, lockedByUser };
    },
  );

  app.post("/api/v1/classification/run", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z.object({
      mode: z.enum(["economy", "full"]).optional(),
      scope: z.enum(["incremental", "all"]).optional(),
    }).parse(request.body ?? {});
    const savedMode = await getSetting("classification.runMode");
    const mode = input.mode ?? (savedMode === "full" ? "full" : "economy");
    const scope = input.scope ?? (mode === "full" ? "all" : "incremental");
    await failStaleBackgroundTasks("classification_rebuild");
    const activeTask = await getLatestBackgroundTask("classification_rebuild", [
      "queued",
      "running",
    ]);
    if (activeTask) {
      return reply.code(202).send({ jobId: null, task: activeTask, reused: true });
    }
    const task = await createBackgroundTask(
      "classification_rebuild",
      `已加入队列，等待 Worker ${scope === "incremental" ? "增量" : "完整"}整理项目与标签`,
    );
    const jobId = await enqueueUnlockedReclassification({ taskId: task.id, mode, scope });
    if (!jobId) {
      await updateBackgroundTask(task.id, {
        status: "failed",
        error: "项目与标签整理任务没有成功进入队列",
        message: "任务入队失败",
        completedAt: new Date(),
      });
      return reply.code(409).send({ error: "Failed to queue organization task" });
    }
    return reply.code(202).send({ jobId, task });
  });

  app.get("/api/v1/classification/tasks/latest", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    await failStaleBackgroundTasks("classification_rebuild");
    return { task: await getLatestBackgroundTask("classification_rebuild") };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/classification/tasks/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.guid() }).parse(request.params);
      await failStaleBackgroundTasks("classification_rebuild");
      const task = await getBackgroundTask(params.id);
      if (!task) return reply.code(404).send({ error: "Task not found" });
      return task;
    },
  );

  app.get("/api/v1/unclassified", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const where = unclassifiedConversationFilter();
    const [[totalRow], items] = await Promise.all([
      db.select({ total: count() }).from(conversations)
        .leftJoin(conversationProjects, eq(conversationProjects.conversationId, conversations.id))
        .where(where),
      db
      .select({
        id: conversations.id,
        provider: conversations.provider,
        title: conversations.title,
        updatedAt: conversations.updatedAt,
        childCount: conversationChildCount(),
        suggestedName: conversationProjects.suggestedName,
        confidence: conversationProjects.confidence,
      })
      .from(conversations)
      .leftJoin(conversationProjects, eq(conversationProjects.conversationId, conversations.id))
      .where(
        where,
      )
      .orderBy(desc(conversations.updatedAt))
      .limit(query.limit).offset(query.offset),
    ]);
    const total = Number(totalRow?.total ?? 0);
    return { items, pagination: { total, limit: query.limit, offset: query.offset, hasMore: query.offset + items.length < total } };
  });
}
