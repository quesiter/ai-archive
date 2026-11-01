import { and, asc, count, desc, eq, gte, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import {
  captureRuns,
  conversationProjects,
  conversationTags,
  conversations,
  devices,
  projects,
  reports,
  tags,
} from "../schema.js";
import { mainConversationFilter } from "../services/conversation-lineage.js";
import {
  projectConversationMembershipQuery,
  unclassifiedConversationFilter,
} from "../services/project-lineage.js";

// Column-mapped selects return Date, while postgres-js raw SQL timestamps are
// strings: Drizzle installs transparent date parsers on the underlying client.
type DashboardDate = Date | string | null;

type DashboardProject = {
  id: string;
  name: string;
  description: string | null;
  updatedAt: DashboardDate;
};

type DashboardProjectAssignment = {
  projectId: string | null;
  conversationId: string;
  assignmentUpdatedAt: DashboardDate;
  conversationUpdatedAt: DashboardDate;
};

function dashboardTimestamp(value: DashboardDate): number | null {
  const timestamp = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

type DashboardReader = Pick<typeof db, "select" | "execute">;

export function buildDashboardConversationCountQuery(reader: DashboardReader = db) {
  return reader.select({ value: count() }).from(conversations)
    .where(and(isNull(conversations.deletedAt), mainConversationFilter()));
}

export function buildDashboardUnclassifiedCountQuery(reader: DashboardReader = db) {
  return reader.select({ value: count() }).from(conversations)
    .where(and(isNull(conversations.deletedAt), mainConversationFilter(), sql`not exists (select 1 from project_conversation_rollups r where r.conversation_id = ${conversations.id})`));
}

export function dashboardProjectAssignmentsQuery() {
  return sql`
    select membership.project_id as "projectId",
      membership.conversation_id as "conversationId",
      membership.assignment_updated_at as "assignmentUpdatedAt",
      membership.conversation_updated_at as "conversationUpdatedAt"
    from (${projectConversationMembershipQuery()}) membership
    join projects project on project.id = membership.project_id
    where not project.archived
  `;
}

export function dashboardCategoryStats(input: {
  projects: readonly DashboardProject[];
  assignments: readonly DashboardProjectAssignment[];
  tags: ReadonlyArray<{ projectId: string | null; tagId: string }>;
  since7d: Date;
}) {
  const tagIdsByProject = new Map<string, Set<string>>();
  for (const row of input.tags) {
    if (!row.projectId) continue;
    const values = tagIdsByProject.get(row.projectId) ?? new Set<string>();
    values.add(row.tagId);
    tagIdsByProject.set(row.projectId, values);
  }
  const categories = input.projects.map((project) => {
    const latestTime = dashboardTimestamp(project.updatedAt);
    return {
      projectId: project.id,
      projectName: project.name,
      description: project.description,
      conversationCount: 0,
      growth7d: 0,
      tagCount: tagIdsByProject.get(project.id)?.size ?? 0,
      latestActivityAt: latestTime === null ? null : new Date(latestTime).toISOString(),
    };
  });
  const categoryByProject = new Map(categories.map((category) => [category.projectId, category]));
  const conversationActivityByProject = new Map<string, Map<string, number>>();
  for (const assignment of input.assignments) {
    if (!assignment.projectId || !categoryByProject.has(assignment.projectId)) continue;
    const activity = conversationActivityByProject.get(assignment.projectId) ?? new Map<string, number>();
    activity.set(assignment.conversationId, Math.max(
      activity.get(assignment.conversationId) ?? 0,
      dashboardTimestamp(assignment.assignmentUpdatedAt) ?? 0,
      dashboardTimestamp(assignment.conversationUpdatedAt) ?? 0,
    ));
    conversationActivityByProject.set(assignment.projectId, activity);
  }
  // One main conversation may be discoverable in several projects through
  // its children. Count it once in each project and once in the overall total.
  const categorizedConversationIds = new Set<string>();
  const growingConversationIds = new Set<string>();
  for (const category of categories) {
    const activity = conversationActivityByProject.get(category.projectId) ?? new Map<string, number>();
    category.conversationCount = activity.size;
    for (const [conversationId, latestTime] of activity) {
      categorizedConversationIds.add(conversationId);
      if (latestTime >= input.since7d.getTime()) {
        category.growth7d += 1;
        growingConversationIds.add(conversationId);
      }
      if (latestTime && (!category.latestActivityAt || latestTime > Date.parse(category.latestActivityAt))) {
        category.latestActivityAt = new Date(latestTime).toISOString();
      }
    }
  }
  return {
    categoryStats: categories.sort((left, right) =>
      right.conversationCount - left.conversationCount ||
      right.growth7d - left.growth7d ||
      left.projectName.localeCompare(right.projectName)),
    categoryTotals: {
      activeCategoryCount: categories.filter((category) => category.conversationCount > 0).length,
      emptyCategoryCount: categories.filter((category) => category.conversationCount === 0).length,
      categorizedConversationCount: categorizedConversationIds.size,
      growth7d: growingConversationIds.size,
    },
  };
}

type DashboardTokenStatsRow = {
  text_units?: number | string | null;
  reasoning_text_units?: number | string | null;
  tool_text_units?: number | string | null;
  reported_tokens?: number | string | null;
  reported_reasoning_tokens?: number | string | null;
  fallback_estimated_tokens?: number | string | null;
  model_tokens?: number | string | null;
  calibration_factor?: number | string | null;
  calibration_factor_low?: number | string | null;
  calibration_factor_high?: number | string | null;
  calibration_sample_count?: number | string | null;
  usage_backed_conversations?: number | string | null;
  fallback_conversations?: number | string | null;
  latest_revision_count?: number | string | null;
  latest_message_count?: number | string | null;
};

export function dashboardTextStatsQuery() {
  return sql`
    WITH conversation_stats AS (
      SELECT
        summary.conversation_id,
        summary.message_count,
        summary.archived_text_units AS text_units,
        summary.reasoning_text_units,
        summary.tool_text_units,
        summary.reported_reasoning_output_tokens,
        summary.reported_total_tokens,
        ceil(summary.archived_text_units / 1.7) AS fallback_model_tokens,
        COALESCE(summary.reported_total_tokens, ceil(summary.archived_text_units / 1.7)) AS model_tokens
      FROM conversation_summaries summary
      INNER JOIN conversations conversation ON conversation.id = summary.conversation_id
      WHERE conversation.deleted_at IS NULL
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
      percentile_cont(0.5) WITHIN GROUP (
        ORDER BY reported_total_tokens::double precision
          / NULLIF(fallback_model_tokens, 0)
      ) FILTER (
        WHERE reported_total_tokens > 0 AND fallback_model_tokens > 0
      ) AS calibration_factor,
      percentile_cont(0.25) WITHIN GROUP (
        ORDER BY reported_total_tokens::double precision
          / NULLIF(fallback_model_tokens, 0)
      ) FILTER (
        WHERE reported_total_tokens > 0 AND fallback_model_tokens > 0
      ) AS calibration_factor_low,
      percentile_cont(0.75) WITHIN GROUP (
        ORDER BY reported_total_tokens::double precision
          / NULLIF(fallback_model_tokens, 0)
      ) FILTER (
        WHERE reported_total_tokens > 0 AND fallback_model_tokens > 0
      ) AS calibration_factor_high,
      count(*) FILTER (
        WHERE reported_total_tokens > 0 AND fallback_model_tokens > 0
      ) AS calibration_sample_count,
      count(*) FILTER (WHERE reported_total_tokens IS NOT NULL)
        AS usage_backed_conversations,
      count(*) FILTER (WHERE reported_total_tokens IS NULL)
        AS fallback_conversations,
      count(*) AS latest_revision_count,
      COALESCE(sum(message_count), 0) AS latest_message_count
    FROM conversation_stats
  `;
}

function nonnegativeNumber(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

export function dashboardTokenStatsFromRow(
  row: DashboardTokenStatsRow | undefined,
) {
  const reportedTokens = nonnegativeNumber(row?.reported_tokens);
  const fallbackEstimatedTokens = nonnegativeNumber(
    row?.fallback_estimated_tokens,
  );
  const calibrationSampleCount = nonnegativeNumber(
    row?.calibration_sample_count,
  );
  const reportedCalibrationFactor = nonnegativeNumber(
    row?.calibration_factor,
  );
  const calibrationFactor =
    calibrationSampleCount > 0 && reportedCalibrationFactor > 0
      ? reportedCalibrationFactor
      : 1;
  const reportedLowFactor = nonnegativeNumber(row?.calibration_factor_low);
  const reportedHighFactor = nonnegativeNumber(row?.calibration_factor_high);
  const calibrationFactorLow =
    calibrationSampleCount > 0 && reportedLowFactor > 0
      ? reportedLowFactor
      : calibrationFactor;
  const calibrationFactorHigh =
    calibrationSampleCount > 0 && reportedHighFactor > 0
      ? reportedHighFactor
      : calibrationFactor;
  const calibratedFallbackTokens = Math.round(
    fallbackEstimatedTokens * calibrationFactor,
  );
  return {
    textUnits: nonnegativeNumber(row?.text_units),
    reasoningTextUnits: nonnegativeNumber(row?.reasoning_text_units),
    toolTextUnits: nonnegativeNumber(row?.tool_text_units),
    reportedTokens,
    reportedReasoningTokens: nonnegativeNumber(
      row?.reported_reasoning_tokens,
    ),
    fallbackEstimatedTokens,
    estimatedTokens: nonnegativeNumber(row?.model_tokens),
    calibrationFactor,
    calibrationFactorLow,
    calibrationFactorHigh,
    calibrationSampleCount,
    calibratedFallbackTokens,
    calibratedEstimatedTokens: reportedTokens + calibratedFallbackTokens,
    calibratedEstimatedTokensLow:
      reportedTokens + Math.round(fallbackEstimatedTokens * calibrationFactorLow),
    calibratedEstimatedTokensHigh:
      reportedTokens + Math.round(fallbackEstimatedTokens * calibrationFactorHigh),
    usageBackedConversationCount: nonnegativeNumber(
      row?.usage_backed_conversations,
    ),
    fallbackConversationCount: nonnegativeNumber(row?.fallback_conversations),
  };
}

async function loadDashboardTextStats() {
  const rows = await db.execute<DashboardTokenStatsRow>(dashboardTextStatsQuery());
  const row = rows[0];
  return {
    ...dashboardTokenStatsFromRow(row),
    latestRevisionCount: nonnegativeNumber(row?.latest_revision_count),
    latestMessageCount: nonnegativeNumber(row?.latest_message_count),
    tokenEstimateRule:
      "源端 usage 优先；其余按真实会话的 usage/归档估算中位倍率校准",
  };
}

async function loadDashboardOrganization(since7d = new Date(Date.now() - 7 * 24 * 60 * 60_000)) {
  return db.transaction(async tx => {
    await tx.execute(sql`SET LOCAL jit = off`);
    return loadDashboardOrganizationData(since7d, tx);
  }, { accessMode: "read only" });
}

export function dashboardOrganizationQuery(since7d: Date) {
  return sql`
    WITH membership AS MATERIALIZED (
      SELECT rollup.project_id, rollup.conversation_id, max(rollup.activity_at) AS activity_at
      FROM project_conversation_rollups rollup
      JOIN projects p ON p.id = rollup.project_id AND NOT p.archived
      GROUP BY rollup.project_id, rollup.conversation_id
    ), project_counts AS (
      SELECT project_id, count(*)::int AS conversation_count,
        count(*) FILTER (WHERE activity_at >= ${since7d.toISOString()})::int AS growth_7d,
        max(activity_at) AS latest_activity_at FROM membership GROUP BY project_id
    ), categories AS MATERIALIZED (
      SELECT p.id AS "projectId", p.name AS "projectName", p.description,
        coalesce(pc.conversation_count, 0) AS "conversationCount",
        coalesce(pc.growth_7d, 0) AS "growth7d",
        greatest(p.updated_at, pc.latest_activity_at) AS "latestActivityAt"
      FROM projects p LEFT JOIN project_counts pc ON pc.project_id = p.id WHERE NOT p.archived
    )
    SELECT coalesce((SELECT jsonb_agg(to_jsonb(c) || jsonb_build_object('tagCount', (
          SELECT count(DISTINCT ct.tag_id) FROM conversation_projects cp
          JOIN conversation_tags ct ON ct.conversation_id = cp.conversation_id
          WHERE cp.project_id = c."projectId"
        )) ORDER BY "latestActivityAt" DESC, "growth7d" DESC, "projectName")
        FROM (SELECT * FROM categories WHERE "growth7d" > 0
          ORDER BY "latestActivityAt" DESC, "growth7d" DESC, "projectName" LIMIT 12) c), '[]'::jsonb) AS "categoryStats",
      jsonb_build_object(
        'recentActiveCategoryCount', (SELECT count(*) FROM categories WHERE "growth7d" > 0),
        'activeCategoryCount', (SELECT count(*) FROM categories WHERE "conversationCount" > 0),
        'emptyCategoryCount', (SELECT count(*) FROM categories WHERE "conversationCount" = 0),
        'categorizedConversationCount', (SELECT count(DISTINCT conversation_id) FROM membership),
        'growth7d', (SELECT count(DISTINCT conversation_id) FROM membership WHERE activity_at >= ${since7d.toISOString()})
      ) AS "categoryTotals"
  `;
}

async function loadDashboardOrganizationData(since7d: Date, reader: DashboardReader) {
  const [[[conversationCount], [unclassifiedCount]], rows] = await Promise.all([
    Promise.all([buildDashboardConversationCountQuery(reader), buildDashboardUnclassifiedCountQuery(reader)]),
    reader.execute<{ categoryStats: unknown[]; categoryTotals: Record<string, number> }>(dashboardOrganizationQuery(since7d)),
  ]);
  return {
    conversationCount: conversationCount?.value ?? 0,
    categoryTotals: {
      ...rows[0]?.categoryTotals,
      unclassifiedConversationCount: unclassifiedCount?.value ?? 0,
    },
    categoryStats: rows[0]?.categoryStats ?? [],
  };
}

export async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/dashboard/text-stats", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return loadDashboardTextStats();
  });

  app.get("/api/v1/dashboard/organization", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return loadDashboardOrganization();
  });

  app.get("/api/v1/dashboard", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = (request.query ?? {}) as {
      includeOrganization?: string;
      includeTextStats?: string;
    };
    const includeOrganization = query.includeOrganization !== "false";
    const includeTextStats = query.includeTextStats !== "false";
    const since = new Date(Date.now() - 24 * 60 * 60_000);
    const [
      [projectCount],
      [tagCount],
      [deviceCount],
      organization,
      tokenStatRows,
      captures24h,
      recentReports,
    ] = await Promise.all([
      db.select({ value: count() }).from(projects),
      db.select({ value: count() }).from(tags),
      db.select({ value: count() }).from(devices).where(isNull(devices.revokedAt)),
      includeOrganization ? loadDashboardOrganization() : Promise.resolve(null),
      includeTextStats ? loadDashboardTextStats() : Promise.resolve(null),
      db
        .select({
          provider: captureRuns.provider,
          status: captureRuns.status,
        })
        .from(captureRuns)
        .where(gte(captureRuns.createdAt, since)),
      db
        .select()
        .from(reports)
        .orderBy(desc(reports.createdAt))
        .limit(5),
    ]);
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
    return {
      counts: {
        ...(organization ? { conversations: organization.conversationCount } : {}),
        projects: projectCount?.value ?? 0,
        tags: tagCount?.value ?? 0,
        devices: deviceCount?.value ?? 0,
      },
      ...(tokenStatRows ? { textStats: tokenStatRows } : {}),
      ...(organization ? {
        categoryTotals: organization.categoryTotals,
        categoryStats: organization.categoryStats,
      } : {}),
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
