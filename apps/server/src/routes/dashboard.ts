import { and, asc, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import {
  captureRuns,
  conversationProjects,
  conversationRevisions,
  conversationTags,
  conversations,
  devices,
  projects,
  reports,
  tags,
} from "../schema.js";

function textUnitCount(value: string): number {
  return Array.from(value).length;
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/dashboard", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const since7d = new Date(Date.now() - 7 * 24 * 60 * 60_000);
    const [
      [conversationCount],
      [projectCount],
      [tagCount],
      [deviceCount],
      [unclassifiedCount],
      activeProjects,
      assignmentRows,
      projectTagRows,
      latestRevisionRows,
    ] =
      await Promise.all([
        db
          .select({ value: count() })
          .from(conversations)
          .where(isNull(conversations.deletedAt)),
        db.select({ value: count() }).from(projects),
        db.select({ value: count() }).from(tags),
        db.select({ value: count() }).from(devices).where(isNull(devices.revokedAt)),
        db
          .select({ value: count() })
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
          ),
        db
          .select({
            id: projects.id,
            name: projects.name,
            description: projects.description,
            updatedAt: projects.updatedAt,
          })
          .from(projects)
          .where(eq(projects.archived, false))
          .orderBy(asc(projects.name)),
        db
          .select({
            projectId: conversationProjects.projectId,
            conversationId: conversationProjects.conversationId,
            assignmentUpdatedAt: conversationProjects.updatedAt,
            conversationUpdatedAt: conversations.updatedAt,
          })
          .from(conversationProjects)
          .innerJoin(projects, eq(projects.id, conversationProjects.projectId))
          .innerJoin(
            conversations,
            eq(conversations.id, conversationProjects.conversationId),
          )
          .where(and(eq(projects.archived, false), isNull(conversations.deletedAt))),
        db
          .select({
            projectId: conversationProjects.projectId,
            tagId: conversationTags.tagId,
          })
          .from(conversationTags)
          .innerJoin(
            conversationProjects,
            eq(conversationProjects.conversationId, conversationTags.conversationId),
          )
          .innerJoin(projects, eq(projects.id, conversationProjects.projectId))
          .where(eq(projects.archived, false)),
        db
          .select({
            conversationId: conversationRevisions.conversationId,
            searchText: conversationRevisions.searchText,
            messageCount: conversationRevisions.messageCount,
          })
          .from(conversationRevisions)
          .innerJoin(
            conversations,
            eq(conversations.id, conversationRevisions.conversationId),
          )
          .where(isNull(conversations.deletedAt))
          .orderBy(
            asc(conversationRevisions.conversationId),
            desc(sql`${conversationRevisions.completeness} = 'complete'`),
            desc(conversationRevisions.capturedAt),
            desc(conversationRevisions.createdAt),
          ),
      ]);

    const captures24h = await db
      .select({
        provider: captureRuns.provider,
        status: captureRuns.status,
      })
      .from(captureRuns)
      .where(gte(captureRuns.createdAt, since));
    const recentReports = await db
      .select()
      .from(reports)
      .orderBy(desc(reports.createdAt))
      .limit(5);
    const statusCounts = Object.fromEntries(
      ["complete", "partial", "failed"].map((status) => [
        status,
        captures24h.filter((capture) => capture.status === status).length,
      ]),
    );
    const providerStats = new Map<
      string,
      { provider: string; complete: number; partial: number; failed: number; total: number }
    >();
    for (const capture of captures24h) {
      const current =
        providerStats.get(capture.provider) ??
        {
          provider: capture.provider,
          complete: 0,
          partial: 0,
          failed: 0,
          total: 0,
        };
      current.total += 1;
      current[capture.status] += 1;
      providerStats.set(capture.provider, current);
    }
    const tagIdsByProject = new Map<string, Set<string>>();
    for (const row of projectTagRows) {
      if (!row.projectId) continue;
      const values = tagIdsByProject.get(row.projectId) ?? new Set<string>();
      values.add(row.tagId);
      tagIdsByProject.set(row.projectId, values);
    }
    const categoryStats = activeProjects.map((project) => ({
      projectId: project.id,
      projectName: project.name,
      description: project.description,
      conversationCount: 0,
      growth7d: 0,
      tagCount: tagIdsByProject.get(project.id)?.size ?? 0,
      latestActivityAt: project.updatedAt?.toISOString?.() ?? null,
    }));
    const categoryByProject = new Map(
      categoryStats.map((project) => [project.projectId, project]),
    );
    let categorizedConversationCount = 0;
    let categoryGrowth7d = 0;
    for (const assignment of assignmentRows) {
      if (!assignment.projectId) continue;
      const category = categoryByProject.get(assignment.projectId);
      if (!category) continue;
      categorizedConversationCount += 1;
      category.conversationCount += 1;
      const assignmentTime = assignment.assignmentUpdatedAt?.getTime?.() ?? 0;
      const conversationTime = assignment.conversationUpdatedAt?.getTime?.() ?? 0;
      const latestTime = Math.max(assignmentTime, conversationTime);
      if (latestTime >= since7d.getTime()) {
        category.growth7d += 1;
        categoryGrowth7d += 1;
      }
      if (
        latestTime &&
        (!category.latestActivityAt ||
          latestTime > new Date(category.latestActivityAt).getTime())
      ) {
        category.latestActivityAt = new Date(latestTime).toISOString();
      }
    }
    const textRevisionIds = new Set<string>();
    let textUnits = 0;
    let latestRevisionCount = 0;
    let latestMessageCount = 0;
    for (const revision of latestRevisionRows) {
      if (textRevisionIds.has(revision.conversationId)) continue;
      textRevisionIds.add(revision.conversationId);
      latestRevisionCount += 1;
      latestMessageCount += revision.messageCount ?? 0;
      textUnits += textUnitCount(revision.searchText ?? "");
    }
    const estimatedTokens = Math.ceil(textUnits / 1.7);
    const sortedCategoryStats = categoryStats.sort(
      (left, right) =>
        right.conversationCount - left.conversationCount ||
        right.growth7d - left.growth7d ||
        left.projectName.localeCompare(right.projectName),
    );

    return {
      counts: {
        conversations: conversationCount?.value ?? 0,
        projects: projectCount?.value ?? 0,
        tags: tagCount?.value ?? 0,
        devices: deviceCount?.value ?? 0,
      },
      textStats: {
        textUnits,
        estimatedTokens,
        latestRevisionCount,
        latestMessageCount,
        tokenEstimateRule: "按 1 token≈1.7 个字符粗估",
      },
      categoryTotals: {
        activeCategoryCount: sortedCategoryStats.filter(
          (category) => category.conversationCount > 0,
        ).length,
        emptyCategoryCount: sortedCategoryStats.filter(
          (category) => category.conversationCount === 0,
        ).length,
        categorizedConversationCount,
        unclassifiedConversationCount: unclassifiedCount?.value ?? 0,
        growth7d: categoryGrowth7d,
      },
      categoryStats: sortedCategoryStats,
      captureStatus24h: statusCounts,
      captureProviders24h: Array.from(providerStats.values()).sort(
        (left, right) =>
          right.failed - left.failed ||
          right.partial - left.partial ||
          right.total - left.total ||
          left.provider.localeCompare(right.provider),
      ),
      recentReports,
    };
  });
}
