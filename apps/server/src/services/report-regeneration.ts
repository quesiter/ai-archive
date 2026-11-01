import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { analysisRuns, reports } from "../schema.js";
import { safeStoredError, writeOperationLog } from "./operation-log.js";
import { enqueueAnalysis } from "./queue.js";

export class ReportRegenerationQueueError extends Error {}

export async function queueReportRegeneration(reportId: string) {
  const result = await db.transaction(async (tx) => {
    // Serialize requests for the same report, including insertion of its run.
    const [report] = await tx.select().from(reports).where(eq(reports.id, reportId)).for("update");
    if (!report) return null;
    const [existing] = await tx.select().from(analysisRuns).where(and(
      eq(analysisRuns.kind, report.kind),
      eq(analysisRuns.windowStart, report.periodStart),
      eq(analysisRuns.windowEnd, report.periodEnd),
    )).for("update");
    if (existing && ["queued", "running"].includes(existing.status)) {
      return { run: existing, alreadyActive: true };
    }
    const generationId = randomUUID();
    const stats = {
      generationId,
      stage: "queued",
      regeneratingReportId: report.id,
      sendEmail: false,
      responseDiagnostics: [],
      ...(existing ? { previousGeneration: {
        generationId: existing.stats.generationId ?? null,
        status: existing.status,
        completedAt: existing.completedAt?.toISOString() ?? null,
        responseDiagnostics: Array.isArray(existing.stats.responseDiagnostics)
          ? existing.stats.responseDiagnostics.slice(-6) : [],
      } } : {}),
    };
    const values = { status: "queued" as const, error: null, completedAt: null, stats, updatedAt: new Date() };
    const [run] = existing
      ? await tx.update(analysisRuns).set(values).where(eq(analysisRuns.id, existing.id)).returning()
      : await tx.insert(analysisRuns).values({ ...values, kind: report.kind, windowStart: report.periodStart, windowEnd: report.periodEnd }).returning();
    if (!run) throw new Error("Failed to queue report regeneration");
    return { run, alreadyActive: false };
  });
  if (!result) return null;
  if (result.alreadyActive) return { ...result, jobId: null };
  const { run } = result;
  try {
    const jobId = await enqueueAnalysis(run.kind as "weekly" | "monthly", undefined, {
      runId: run.id,
      generationId: String(run.stats.generationId),
    });
    if (!jobId) throw new Error("报告重新生成任务未成功进入队列");
    await writeOperationLog({
      scope: "analysis", message: "报告重新生成已入队", status: "queued",
      entityType: "analysis_run", entityId: run.id,
      metadata: { reportId, generationId: run.stats.generationId, windowStart: run.windowStart, windowEnd: run.windowEnd, jobId },
    });
    return { ...result, jobId };
  } catch (error) {
    const message = safeStoredError(error);
    await db.update(analysisRuns).set({ status: "failed", error: message, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(analysisRuns.id, run.id), eq(analysisRuns.status, "queued"), sql`${analysisRuns.stats}->>'generationId' = ${String(run.stats.generationId)}`));
    await writeOperationLog({ scope: "analysis", level: "error", message: "报告重新生成入队失败", status: "failed", entityType: "analysis_run", entityId: run.id, metadata: { reportId, error: message } });
    throw new ReportRegenerationQueueError("报告重新生成入队失败，可再次重试");
  }
}
