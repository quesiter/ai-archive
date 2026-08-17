import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import {
  conversationProjects,
  conversations,
  knowledgeItems,
  projects,
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
  enqueueKnowledgeRebuild,
  enqueueUnlockedReclassification,
} from "../services/queue.js";
import { getBooleanSetting, getSetting } from "../services/settings.js";
import {
  loadConversationExportData,
  renderConversationExport,
  type ConversationExportFormat,
} from "../services/conversation-export.js";
import { mergeProjectIntoProject } from "../services/project-merge.js";
import { writeOperationLog } from "../services/operation-log.js";

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
    log.warn({ error }, "Failed to queue project reclassification"),
  );
}

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/projects", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const rows = await db.select().from(projects).orderBy(asc(projects.name));
    return Promise.all(
      rows.map(async (project) => {
        const assignments = await db
          .select({ conversationId: conversationProjects.conversationId })
          .from(conversationProjects)
          .where(eq(conversationProjects.projectId, project.id));
        const knowledge = await db
          .select({ id: knowledgeItems.id })
          .from(knowledgeItems)
          .where(eq(knowledgeItems.projectId, project.id));
        return {
          ...project,
          conversationCount: assignments.length,
          knowledgeCount: knowledge.length,
        };
      }),
    );
  });

  app.get("/api/v1/projects/overview", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const [projectRows, assignmentRows, knowledgeRows, unclassifiedRows] =
      await Promise.all([
        db
          .select()
          .from(projects)
          .where(eq(projects.archived, false))
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
          .innerJoin(
            conversations,
            eq(conversations.id, conversationProjects.conversationId),
          )
          .where(isNull(conversations.deletedAt))
          .orderBy(desc(conversations.updatedAt)),
        db
          .select({
            id: knowledgeItems.id,
            projectId: knowledgeItems.projectId,
          })
          .from(knowledgeItems),
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
          .leftJoin(
            conversationProjects,
            eq(conversationProjects.conversationId, conversations.id),
          )
          .where(
            and(
              isNull(conversationProjects.projectId),
              isNull(conversations.deletedAt),
            ),
          )
          .orderBy(desc(conversations.updatedAt)),
      ]);

    const visibleProjectIds = new Set(projectRows.map((project) => project.id));
    const conversationsByProject = new Map<string, typeof assignmentRows>();
    let categorizedConversationCount = 0;
    for (const assignment of assignmentRows) {
      if (!assignment.projectId || !visibleProjectIds.has(assignment.projectId)) continue;
      categorizedConversationCount += 1;
      const rows = conversationsByProject.get(assignment.projectId) ?? [];
      rows.push(assignment);
      conversationsByProject.set(assignment.projectId, rows);
    }

    const knowledgeCountByProject = new Map<string, number>();
    let visibleKnowledgeCount = 0;
    for (const item of knowledgeRows) {
      if (!visibleProjectIds.has(item.projectId)) continue;
      visibleKnowledgeCount += 1;
      knowledgeCountByProject.set(
        item.projectId,
        (knowledgeCountByProject.get(item.projectId) ?? 0) + 1,
      );
    }

    const groupedProjects = projectRows
      .map((project) => {
        const assignedConversations = conversationsByProject.get(project.id) ?? [];
        return {
          ...project,
          conversationCount: assignedConversations.length,
          knowledgeCount: knowledgeCountByProject.get(project.id) ?? 0,
          conversations: assignedConversations.map(
            ({ projectId: _projectId, ...row }) => row,
          ),
        };
      })
      .sort(
        (left, right) =>
          right.conversationCount - left.conversationCount ||
          left.name.localeCompare(right.name),
      );

    return {
      totals: {
        projectCount: groupedProjects.length,
        activeProjectCount: groupedProjects.filter(
          (project) => project.conversationCount > 0,
        ).length,
        categorizedConversationCount,
        unclassifiedConversationCount: unclassifiedRows.length,
        knowledgeCount: visibleKnowledgeCount,
      },
      projects: groupedProjects,
      unclassified: unclassifiedRows,
    };
  });

  app.post("/api/v1/projects", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = ProjectInputSchema.parse(request.body);
    const [project] = await db
      .insert(projects)
      .values(input)
      .returning();
    await enqueueAutoReclassification(request.log);
    return reply.code(201).send(project);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/projects/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = ProjectInputSchema.partial().extend({
        archived: z.boolean().optional(),
      }).parse(request.body);
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
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        )
        .header("Cache-Control", "no-store");
      return reply.send(content);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/projects/:id/merge",
    async (request, reply) => {
      const user = await requireWebUser(request, reply);
      if (!user) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z.object({ targetProjectId: z.string().uuid() }).parse(request.body);
      if (input.targetProjectId === params.id) {
        return reply.code(400).send({
          error: "Source and target projects must be different",
        });
      }
      const result = await mergeProjectIntoProject({
        sourceProjectId: params.id,
        targetProjectId: input.targetProjectId,
      });
      if (!result) {
        return reply.code(404).send({ error: "Source or target project not found" });
      }
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
      const input = z
        .object({
          projectId: z.string().uuid().nullable(),
          mode: z.enum(["lock", "auto"]).default("lock"),
        })
        .parse(request.body);
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, params.id))
        .limit(1);
      if (!conversation) {
        return reply.code(404).send({ error: "Conversation not found" });
      }
      if (input.projectId) {
        const [project] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.id, input.projectId))
          .limit(1);
        if (!project) return reply.code(400).send({ error: "Project not found" });
      }
      if (input.mode === "auto") {
        await db
          .insert(conversationProjects)
          .values({
            conversationId: conversation.id,
            projectId: input.projectId,
            confidence: null,
            lockedByUser: false,
            updatedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: conversationProjects.conversationId,
            set: {
              projectId: input.projectId,
              lockedByUser: false,
              updatedAt: new Date(),
            },
          });
        await enqueueConversationClassification(conversation.id).catch((error) =>
          request.log.warn({ error }, "Failed to queue AI classification"),
        );
        return { ok: true, lockedByUser: false };
      }
      await db
        .insert(conversationProjects)
        .values({
          conversationId: conversation.id,
          projectId: input.projectId,
          confidence: 1,
          lockedByUser: true,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: conversationProjects.conversationId,
          set: {
            projectId: input.projectId,
            confidence: 1,
            lockedByUser: true,
            updatedAt: new Date(),
          },
        });
      return { ok: true };
    },
  );

  app.post("/api/v1/classification/run", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z
      .object({
        mode: z.enum(["economy", "full"]).optional(),
        scope: z.enum(["incremental", "all"]).optional(),
      })
      .parse(request.body ?? {});
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
      `已加入队列，等待 Worker 以${mode === "full" ? "完整" : "节能"}模式${scope === "incremental" ? "增量处理候选会话" : "重评未锁定会话"}`,
    );
    const jobId = await enqueueUnlockedReclassification({ taskId: task.id, mode, scope });
    if (!jobId) {
      await updateBackgroundTask(task.id, {
        status: "failed",
        error: "智能归类任务没有成功进入队列",
        message: "任务入队失败",
        completedAt: new Date(),
      });
      return reply.code(409).send({ error: "Failed to queue classification task" });
    }
    return reply.code(202).send({ jobId, task });
  });

  app.get("/api/v1/classification/tasks/latest", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    await failStaleBackgroundTasks("classification_rebuild");
    return {
      task: await getLatestBackgroundTask("classification_rebuild"),
    };
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

  app.get("/api/v1/knowledge", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z
      .object({
        projectId: z.string().uuid().optional(),
        status: z.string().optional(),
      })
      .parse(request.query);
    const rows = await db
      .select({
        id: knowledgeItems.id,
        projectId: knowledgeItems.projectId,
        projectName: projects.name,
        type: knowledgeItems.type,
        title: knowledgeItems.title,
        body: knowledgeItems.body,
        status: knowledgeItems.status,
        confidence: knowledgeItems.confidence,
        sourceReferences: knowledgeItems.sourceReferences,
        updatedAt: knowledgeItems.updatedAt,
      })
      .from(knowledgeItems)
      .innerJoin(projects, eq(projects.id, knowledgeItems.projectId))
      .orderBy(desc(knowledgeItems.updatedAt));
    return rows.filter(
      (row) =>
        (!query.projectId || row.projectId === query.projectId) &&
      (!query.status || row.status === query.status),
    );
  });

  app.post("/api/v1/knowledge/rebuild", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    await failStaleBackgroundTasks("knowledge_rebuild");
    const activeTask = await getLatestBackgroundTask("knowledge_rebuild", ["queued", "running"]);
    if (activeTask) {
      return reply.code(202).send({ jobId: null, task: activeTask, reused: true });
    }
    const task = await createBackgroundTask(
      "knowledge_rebuild",
      "正在加入队列，等待 Worker 重建项目知识",
    );
    const jobId = await enqueueKnowledgeRebuild({ taskId: task.id });
    if (!jobId) {
      await updateBackgroundTask(task.id, {
        status: "failed",
        error: "项目知识重建任务没有成功进入队列",
        message: "任务入队失败",
        completedAt: new Date(),
      });
      return reply.code(409).send({ error: "Failed to queue knowledge rebuild task" });
    }
    return reply.code(202).send({ jobId, task });
  });

  app.get("/api/v1/knowledge/rebuild/latest", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    await failStaleBackgroundTasks("knowledge_rebuild");
    return {
      task: await getLatestBackgroundTask("knowledge_rebuild"),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/knowledge/rebuild/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      await failStaleBackgroundTasks("knowledge_rebuild");
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
      .leftJoin(
        conversationProjects,
        eq(conversationProjects.conversationId, conversations.id),
      )
      .where(
        and(
          isNull(conversationProjects.projectId),
          isNull(conversations.deletedAt),
        ),
      )
      .orderBy(desc(conversations.updatedAt));
  });
}
