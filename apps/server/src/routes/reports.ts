import { and, count, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import { analysisRuns, reports } from "../schema.js";
import { analysisWindow } from "../services/analysis.js";
import { writeOperationLog } from "../services/operation-log.js";
import { enqueueAnalysis, enqueueReportEmail } from "../services/queue.js";

function safeReportFilename(value: string): string {
  return value.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || "report";
}

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
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    const [[totalRow], items] = await Promise.all([
      db.select({ total: count() }).from(reports),
      db.select().from(reports).orderBy(desc(reports.createdAt)).limit(query.limit).offset(query.offset),
    ]);
    const total = Number(totalRow?.total ?? 0);
    return {
      items,
      pagination: { total, limit: query.limit, offset: query.offset, hasMore: query.offset + items.length < total },
    };
  });

  app.get("/api/v1/analysis/runs", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z
      .object({
        kind: z.enum(["weekly", "monthly"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(request.query);
    const where = query.kind ? eq(analysisRuns.kind, query.kind) : undefined;
    const [[totalRow], items] = await Promise.all([
      db.select({ total: count() }).from(analysisRuns).where(where),
      db.select().from(analysisRuns).where(where).orderBy(desc(analysisRuns.createdAt)).limit(query.limit).offset(query.offset),
    ]);
    const total = Number(totalRow?.total ?? 0);
    return {
      items,
      pagination: { total, limit: query.limit, offset: query.offset, hasMore: query.offset + items.length < total },
    };
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

  app.get<{ Params: { id: string } }>("/api/v1/reports/:id/download", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [report] = await db.select().from(reports).where(eq(reports.id, params.id)).limit(1);
    if (!report) return reply.code(404).send({ error: "Report not found" });
    const content = `# ${report.title}\n\n> ${report.summary}\n\n${report.bodyMarkdown}\n`;
    reply.header("Content-Type", "text/markdown; charset=utf-8")
      .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(`${safeReportFilename(report.title)}.md`)}`)
      .header("Cache-Control", "no-store");
    return reply.send(content);
  });

  app.post<{ Params: { id: string } }>("/api/v1/reports/:id/email/retry", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    const [report] = await db.update(reports).set({
      emailStatus: "queued",
      emailError: null,
    }).where(eq(reports.id, params.id)).returning();
    if (!report) return reply.code(404).send({ error: "Report not found" });
    const jobId = await enqueueReportEmail(report.id);
    if (!jobId) {
      await db.update(reports).set({ emailStatus: "failed", emailError: "邮件任务未成功进入队列" }).where(eq(reports.id, report.id));
      return reply.code(503).send({ error: "Email delivery was not enqueued" });
    }
    return reply.code(202).send({ jobId, reportId: report.id });
  });

  app.post("/api/v1/analysis/run", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z
      .object({ kind: z.enum(["weekly", "monthly"]).default("weekly") })
      .parse(request.body ?? {});
    const run = await queueAnalysisRun(input.kind);
    const jobId = await enqueueAnalysis(input.kind);
    if (!jobId) {
      const [failedRun] = await db
        .update(analysisRuns)
        .set({
          status: "failed",
          error: "报告生成任务没有成功进入队列",
          stats: { stage: "failed", reason: "enqueue_returned_null" },
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(analysisRuns.id, run.id))
        .returning();
      await writeOperationLog({
        scope: "analysis",
        level: "error",
        message: `${input.kind === "weekly" ? "周报" : "月报"}生成入队失败，可重新发起`,
        status: "failed",
        entityType: "analysis_run",
        entityId: run.id,
        metadata: {
          kind: input.kind,
          reason: "enqueue_returned_null",
          windowStart: run.windowStart,
          windowEnd: run.windowEnd,
        },
      });
      return reply.code(503).send({
        error: "Failed to queue report generation; retry is allowed",
        run: failedRun ?? run,
      });
    }
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
