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
  getBackgroundTask,
  getLatestBackgroundTask,
  updateBackgroundTask,
} from "../services/background-tasks.js";
import {
  enqueueConversationClassification,
  enqueueUnlockedReclassification,
} from "../services/queue.js";
import { getBooleanSetting, getSetting } from "../services/settings.js";

const ProjectInputSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(5_000).default(""),
});

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
      const input = ProjectInputSchema.partial().extend({
        archived: z.boolean().optional(),
      }).parse(request.body);
      const [project] = await db
        .update(projects)
        .set({ ...input, updatedAt: new Date() })
        .where(eq(projects.id, request.params.id))
        .returning();
      if (!project) return reply.code(404).send({ error: "Project not found" });
      await enqueueAutoReclassification(request.log);
      return project;
    },
  );

  app.put<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/project",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const input = z
        .object({
          projectId: z.string().uuid().nullable(),
          mode: z.enum(["lock", "auto"]).default("lock"),
        })
        .parse(request.body);
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(eq(conversations.id, request.params.id))
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
      .object({ mode: z.enum(["economy", "full"]).optional() })
      .parse(request.body ?? {});
    const savedMode = await getSetting("classification.runMode");
    const mode = input.mode ?? (savedMode === "full" ? "full" : "economy");
    const activeTask = await getLatestBackgroundTask("classification_rebuild", [
      "queued",
      "running",
    ]);
    if (activeTask) {
      return reply.code(202).send({ jobId: null, task: activeTask, reused: true });
    }
    const task = await createBackgroundTask(
      "classification_rebuild",
      `已加入队列，等待 Worker 以${mode === "full" ? "完整" : "节能"}模式接手`,
    );
    const jobId = await enqueueUnlockedReclassification(task.id, mode);
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
    return {
      task: await getLatestBackgroundTask("classification_rebuild"),
    };
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/classification/tasks/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
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
