import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import { analysisRuns, reports } from "../schema.js";
import { analysisWindow } from "../services/analysis.js";
import { writeOperationLog } from "../services/operation-log.js";
import { enqueueAnalysis } from "../services/queue.js";

async function queueAnalysisRun(kind: "weekly" | "monthly") {
  const { windowStart, windowEnd } = analysisWindow(kind, new Date());
  let [run] = await db
    .insert(analysisRuns)
    .values({
      kind,
      status: "queued",
      windowStart,
      windowEnd,
      stats: { stage: "queued" },
    })
    .onConflictDoNothing({
      target: [analysisRuns.kind, analysisRuns.windowStart, analysisRuns.windowEnd],
    })
    .returning();
  if (run) return run;

  const [existing] = await db
    .select()
    .from(analysisRuns)
    .where(
      and(
        eq(analysisRuns.kind, kind),
        eq(analysisRuns.windowStart, windowStart),
        eq(analysisRuns.windowEnd, windowEnd),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Failed to resolve queued analysis run");
  if (existing.status === "completed" || existing.status === "running") return existing;

  [run] = await db
    .update(analysisRuns)
    .set({
      status: "queued",
      error: null,
      completedAt: null,
      stats: { stage: "queued" },
      updatedAt: new Date(),
    })
    .where(eq(analysisRuns.id, existing.id))
    .returning();
  return run ?? existing;
}

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/reports", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return db.select().from(reports).orderBy(desc(reports.createdAt)).limit(100);
  });

  app.get("/api/v1/analysis/runs", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z
      .object({
        kind: z.enum(["weekly", "monthly"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .parse(request.query);
    const baseQuery = db
      .select()
      .from(analysisRuns)
      .orderBy(desc(analysisRuns.createdAt))
      .limit(query.limit);
    if (!query.kind) return baseQuery;
    return db
      .select()
      .from(analysisRuns)
      .where(eq(analysisRuns.kind, query.kind))
      .orderBy(desc(analysisRuns.createdAt))
      .limit(query.limit);
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/reports/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const [report] = await db
        .select()
        .from(reports)
        .where(eq(reports.id, params.id))
        .limit(1);
      if (!report) return reply.code(404).send({ error: "Report not found" });
      return report;
    },
  );

  app.post("/api/v1/analysis/run", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z
      .object({ kind: z.enum(["weekly", "monthly"]).default("weekly") })
      .parse(request.body ?? {});
    const run = await queueAnalysisRun(input.kind);
    const jobId = await enqueueAnalysis(input.kind);
    await writeOperationLog({
      scope: "analysis",
      message: `${input.kind === "weekly" ? "周报" : "月报"}生成已入队`,
      status: run.status,
      entityType: "analysis_run",
      entityId: run.id,
      metadata: {
        kind: input.kind,
        jobId,
        windowStart: run.windowStart,
        windowEnd: run.windowEnd,
      },
    });
    return reply.code(202).send({ jobId, run });
  });
}
