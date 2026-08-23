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

type DashboardTokenStatsRow = {
  text_units?: number | string | null;
  reasoning_text_units?: number | string | null;
  tool_text_units?: number | string | null;
  reported_tokens?: number | string | null;
  reported_reasoning_tokens?: number | string | null;
  fallback_estimated_tokens?: number | string | null;
  model_tokens?: number | string | null;
  usage_backed_conversations?: number | string | null;
  fallback_conversations?: number | string | null;
};

function nonnegativeNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function dashboardTokenStatsFromRow(
  row: DashboardTokenStatsRow | undefined,
) {
  return {
    textUnits: nonnegativeNumber(row?.text_units),
    reasoningTextUnits: nonnegativeNumber(row?.reasoning_text_units),
    toolTextUnits: nonnegativeNumber(row?.tool_text_units),
    reportedTokens: nonnegativeNumber(row?.reported_tokens),
    reportedReasoningTokens: nonnegativeNumber(
      row?.reported_reasoning_tokens,
    ),
    fallbackEstimatedTokens: nonnegativeNumber(
      row?.fallback_estimated_tokens,
    ),
    estimatedTokens: nonnegativeNumber(row?.model_tokens),
    usageBackedConversationCount: nonnegativeNumber(
      row?.usage_backed_conversations,
    ),
    fallbackConversationCount: nonnegativeNumber(row?.fallback_conversations),
  };
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
      tokenStatRows,
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
        db.execute(sql`
          WITH RECURSIVE ranked_revisions AS (
            SELECT
              revision.id,
              revision.conversation_id,
              revision.base_revision_id,
              revision.archived_text_units,
              revision.reasoning_text_units,
              revision.tool_text_units,
              revision.reported_reasoning_output_tokens,
              revision.reported_total_tokens,
              row_number() OVER (
                PARTITION BY revision.conversation_id
                ORDER BY
                  (revision.completeness = 'complete') DESC,
                  revision.captured_at DESC,
                  revision.created_at DESC
              ) AS rank
            FROM conversation_revisions revision
            INNER JOIN conversations conversation
              ON conversation.id = revision.conversation_id
            WHERE conversation.deleted_at IS NULL
          ),
          canonical_revisions AS (
            SELECT * FROM ranked_revisions WHERE rank = 1
          ),
          revision_chain AS (
            SELECT
              canonical.conversation_id,
              canonical.id AS canonical_revision_id,
              canonical.id AS revision_id,
              canonical.base_revision_id,
              canonical.archived_text_units,
              canonical.reasoning_text_units,
              canonical.tool_text_units,
              ARRAY[canonical.id]::uuid[] AS visited
            FROM canonical_revisions canonical
            UNION ALL
            SELECT
              chain.conversation_id,
              chain.canonical_revision_id,
              base.id,
              base.base_revision_id,
              base.archived_text_units,
              base.reasoning_text_units,
              base.tool_text_units,
              chain.visited || base.id
            FROM revision_chain chain
            INNER JOIN conversation_revisions base
              ON base.id = chain.base_revision_id
            WHERE
              NOT base.id = ANY(chain.visited)
              AND cardinality(chain.visited) < 10000
          ),
          chain_totals AS (
            SELECT
              chain.conversation_id,
              COALESCE(sum(chain.archived_text_units), 0) AS text_units,
              COALESCE(sum(chain.reasoning_text_units), 0) AS reasoning_text_units,
              COALESCE(sum(chain.tool_text_units), 0) AS tool_text_units
            FROM revision_chain chain
            GROUP BY chain.conversation_id
          ),
          conversation_stats AS (
            SELECT
              canonical.conversation_id,
              COALESCE(chain.text_units, 0) AS text_units,
              COALESCE(chain.reasoning_text_units, 0) AS reasoning_text_units,
              COALESCE(chain.tool_text_units, 0) AS tool_text_units,
              canonical.reported_reasoning_output_tokens,
              canonical.reported_total_tokens,
              CASE
                WHEN canonical.reported_total_tokens IS NOT NULL
                  THEN canonical.reported_total_tokens
                ELSE ceil(COALESCE(chain.text_units, 0) / 1.7)
              END AS model_tokens
            FROM canonical_revisions canonical
            LEFT JOIN chain_totals chain
              ON chain.conversation_id = canonical.conversation_id
          )
          SELECT
            COALESCE(sum(text_units), 0) AS text_units,
            COALESCE(sum(reasoning_text_units), 0) AS reasoning_text_units,
            COALESCE(sum(tool_text_units), 0) AS tool_text_units,
            COALESCE(sum(reported_total_tokens), 0) AS reported_tokens,
            COALESCE(sum(reported_reasoning_output_tokens), 0)
              AS reported_reasoning_tokens,
            COALESCE(sum(
              CASE WHEN reported_total_tokens IS NULL THEN model_tokens ELSE 0 END
            ), 0) AS fallback_estimated_tokens,
            COALESCE(sum(model_tokens), 0) AS model_tokens,
            count(*) FILTER (WHERE reported_total_tokens IS NOT NULL)
              AS usage_backed_conversations,
            count(*) FILTER (WHERE reported_total_tokens IS NULL)
              AS fallback_conversations
          FROM conversation_stats
        `),
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
    const latestConversationIds = new Set<string>();
    let latestRevisionCount = 0;
    let latestMessageCount = 0;
    for (const revision of latestRevisionRows) {
      if (latestConversationIds.has(revision.conversationId)) continue;
      latestConversationIds.add(revision.conversationId);
      latestRevisionCount += 1;
      latestMessageCount += revision.messageCount ?? 0;
    }
    const textStats = dashboardTokenStatsFromRow(
      (tokenStatRows as unknown as DashboardTokenStatsRow[])[0],
    );
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
        ...textStats,
        latestRevisionCount,
        latestMessageCount,
        tokenEstimateRule: "源端 usage 优先；其余含思考与工具过程估算",
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
