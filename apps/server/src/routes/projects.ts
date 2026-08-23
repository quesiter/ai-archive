import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
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
  loadConversationExportData,
  renderConversationExport,
  type ConversationExportFormat,
} from "../services/conversation-export.js";
import { mergeProjectIntoProject } from "../services/project-merge.js";
import { generateProjectContext } from "../services/project-context.js";
import { selectLatestTimelineRevisions } from "../services/timeline.js";
import { safeStoredError, writeOperationLog } from "../services/operation-log.js";

const ProjectInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5_000).default(""),
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
  app.get("/api/v1/projects", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const overview = await loadProjectsOverview();
    return overview.projects;
  });

  app.get("/api/v1/projects/overview", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return loadProjectsOverview();
  });

  app.post("/api/v1/projects", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = ProjectInputSchema.parse(request.body);
    const [project] = await db.insert(projects).values(input).returning();
    await enqueueAutoReclassification(request.log);
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/projects/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = ProjectInputSchema.partial()
        .extend({ archived: z.boolean().optional() })
        .parse(request.body);
      const [project] = await db
        .update(projects)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(projects.id, params.id))
        .returning();
      if (!project) return reply.code(404).send({ error: "Project not found" });
      await enqueueAutoReclassification(request.log);
      return project;
    },
  );

  app.get<{ Params: { id: string }; Querystring: { format?: string } }>(
    "/api/v1/projects/:id/export",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const { format } = ProjectExportQuerySchema.parse(request.query);
      const data = await loadConversationExportData({ projectId: params.id });
      if (!data) return reply.code(404).send({ error: "Project not found" });
      const content = await renderConversationExport(format, data);
      const filename = `${safeProjectExportFilename(data.scopeName)}.${format}`;
      reply
        .header("Content-Type", projectExportMimeType(format))
        .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
        .header("Cache-Control", "no-store");
      return reply.send(content);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/projects/:id/context",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
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
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
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
      const conversationRows = await db
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
            eq(conversationProjects.projectId, params.id),
            isNull(conversations.deletedAt),
          ),
        );
      if (!conversationRows.length) return { project, total: 0, items: [] };
      const ids = conversationRows.map((row) => row.id);
      const revisions = await db
        .select({
          id: conversationRevisions.id,
          conversationId: conversationRevisions.conversationId,
          capturedAt: conversationRevisions.capturedAt,
          createdAt: conversationRevisions.createdAt,
          completeness: conversationRevisions.completeness,
        })
        .from(conversationRevisions)
        .where(inArray(conversationRevisions.conversationId, ids))
        .orderBy(
          asc(conversationRevisions.conversationId),
          desc(sql`${conversationRevisions.completeness} = 'complete'`),
          desc(conversationRevisions.capturedAt),
          desc(conversationRevisions.createdAt),
        );
      const newestRevision = selectLatestTimelineRevisions(revisions);
      const tagLinks = await db
        .select({
          conversationId: conversationTags.conversationId,
          id: tags.id,
          name: tags.name,
        })
        .from(conversationTags)
        .innerJoin(tags, eq(tags.id, conversationTags.tagId))
        .where(inArray(conversationTags.conversationId, ids));
      const tagsByConversation = new Map<string, Array<{ id: string; name: string }>>();
      for (const link of tagLinks) {
        const values = tagsByConversation.get(link.conversationId) ?? [];
        values.push({ id: link.id, name: link.name });
        tagsByConversation.set(link.conversationId, values);
      }
      const items = conversationRows
        .flatMap((conversation) => {
          const revision = newestRevision.get(conversation.id);
          if (!revision) return [];
          return [{
            conversationId: conversation.id,
            revisionId: revision.id,
            capturedAt: revision.capturedAt,
            provider: conversation.provider,
            title: conversation.title,
            tags: tagsByConversation.get(conversation.id) ?? [],
            href: `/conversations/${conversation.id}?revisionId=${revision.id}`,
          }];
        })
        .sort(
          (left, right) =>
            right.capturedAt.getTime() - left.capturedAt.getTime() ||
            right.revisionId.localeCompare(left.revisionId),
        );
      return {
        project,
        total: items.length,
        items: items.slice(query.offset, query.offset + query.limit),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/projects/:id/merge",
    async (request, reply) => {
      const user = await requireWebUser(request, reply);
      if (!user) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z.object({
        targetProjectId: z.string().uuid(),
        targetName: z.string().trim().min(1).max(200).optional(),
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
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z.object({
        projectId: z.string().uuid().nullable(),
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
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: conversationProjects.conversationId,
          set: {
            projectId: input.projectId,
            confidence: lockedByUser ? 1 : null,
            lockedByUser,
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
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      await failStaleBackgroundTasks("classification_rebuild");
      const task = await getBackgroundTask(params.id);
      if (!task) return reply.code(404).send({ error: "Task not found" });
      return task;
    },
  );

  app.get("/api/v1/unclassified", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return db
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
      .orderBy(desc(conversations.updatedAt));
  });
}
