import { desc, gte, ne } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { providerLabels, type Provider } from "@ai-archive/contracts";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import {
  analysisRuns,
  backgroundTasks,
  captureRuns,
  importJobs,
} from "../schema.js";

function boundedPercent(value: number): number {
  return Math.min(100, Math.max(0, Math.round(value)));
}

function ratioPercent(processed: unknown, total: unknown, fallback = 0): number {
  const processedCount = Number(processed ?? 0);
  const totalCount = Number(total ?? 0);
  if (totalCount <= 0) return fallback;
  return boundedPercent((processedCount / totalCount) * 100);
}

function stageLabel(stage: unknown): string {
  return (
    {
      queued: "等待 Worker 接手",
      preparing: "准备数据",
      extracting: "抽取知识",
      reporting: "生成报告",
      completed: "完成",
    } as Record<string, string>
  )[String(stage)] ?? String(stage ?? "");
}

function analysisProgress(run: typeof analysisRuns.$inferSelect): number {
  if (run.status === "completed") return 100;
  if (run.status === "failed") return 100;
  const stats = run.stats ?? {};
  const total = Number(stats.totalConversations ?? 0);
  const processed = Number(stats.processedConversations ?? 0);
  if (total > 0) return ratioPercent(processed, total, 12);
  return run.status === "running" ? 12 : 0;
}

function importProgress(job: typeof importJobs.$inferSelect): number {
  if (job.status === "completed") return 100;
  if (job.status === "failed") return 100;
  const stats = job.stats ?? {};
  return ratioPercent(
    Number(stats.imported ?? 0) + Number(stats.unchanged ?? 0),
    stats.snapshots,
    job.status === "processing" ? 10 : 0,
  );
}

function taskProgress(task: typeof backgroundTasks.$inferSelect): number {
  if (task.status === "completed") return 100;
  if (task.status === "failed") return 100;
  return ratioPercent(
    task.processedCount,
    task.totalCount,
    task.status === "running" ? 8 : 0,
  );
}

function providerLabel(provider: Provider): string {
  return providerLabels[provider] ?? provider;
}

export async function activityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/activity", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(60).default(20),
      })
      .parse(request.query);
    const captureSince = new Date(Date.now() - 24 * 60 * 60_000);
    const [tasks, runs, imports, captures] = await Promise.all([
      db
        .select()
        .from(backgroundTasks)
        .orderBy(desc(backgroundTasks.updatedAt))
        .limit(20),
      db
        .select()
        .from(analysisRuns)
        .orderBy(desc(analysisRuns.updatedAt))
        .limit(20),
      db.select().from(importJobs).orderBy(desc(importJobs.updatedAt)).limit(20),
      db
        .select()
        .from(captureRuns)
        .where(gte(captureRuns.createdAt, captureSince))
        .orderBy(desc(captureRuns.createdAt))
        .limit(200),
    ]);
    const captureAnomalies = captures.filter(
      (capture) => capture.status !== "complete",
    );
    const failedCaptures = captureAnomalies.filter(
      (capture) => capture.status === "failed",
    ).length;
    const partialCaptures = captureAnomalies.filter(
      (capture) => capture.status === "partial",
    ).length;
    const captureProviders = Array.from(
      new Set(captureAnomalies.map((capture) => providerLabel(capture.provider))),
    ).slice(0, 4);
    const latestCaptureAnomaly = captureAnomalies[0];

    const items = [
      ...tasks.map((task) => ({
        id: task.id,
        type: "classification",
        title: "智能归类",
        status: task.status,
        severity: task.status === "failed" ? "error" : "normal",
        message: task.message ?? task.error ?? "",
        progress: taskProgress(task),
        updatedAt: task.updatedAt,
        createdAt: task.createdAt,
        completedAt: task.completedAt,
        error: task.error,
        stats: task.stats,
        href: "/projects",
      })),
      ...runs.map((run) => {
        const stats = run.stats ?? {};
        return {
          id: run.id,
          type: "analysis",
          title:
            run.kind === "weekly"
              ? "周报生成"
              : run.kind === "monthly"
                ? "月报生成"
                : "手动分析",
          status: run.status,
          severity: run.status === "failed" ? "error" : "normal",
          message: [
            stageLabel(stats.stage),
            typeof stats.processedConversations === "number" &&
            typeof stats.totalConversations === "number"
              ? `会话 ${stats.processedConversations}/${stats.totalConversations}`
              : "",
            typeof stats.knowledgeCount === "number"
              ? `知识 ${stats.knowledgeCount}`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
          progress: analysisProgress(run),
          updatedAt: run.updatedAt,
          createdAt: run.createdAt,
          completedAt: run.completedAt,
          error: run.error,
          stats,
          href: "/reports",
        };
      }),
      ...imports.map((job) => {
        const stats = job.stats ?? {};
        return {
          id: job.id,
          type: "import",
          title: `历史导入 · ${job.provider ? providerLabel(job.provider) : "待识别"}`,
          status: job.status,
          severity: job.status === "failed" ? "error" : "normal",
          message: [
            job.filename,
            typeof stats.snapshots === "number"
              ? `快照 ${Number(stats.imported ?? 0) + Number(stats.unchanged ?? 0)}/${stats.snapshots}`
              : "",
          ]
            .filter(Boolean)
            .join(" · "),
          progress: importProgress(job),
          updatedAt: job.updatedAt,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
          error: job.error,
          stats,
          href: "/imports",
        };
      }),
      ...(latestCaptureAnomaly
        ? [
            {
              id: "capture-anomalies-24h",
              type: "capture",
              title: "近 24 小时采集异常",
              status: failedCaptures > 0 ? "failed" : "partial",
              severity: failedCaptures > 0 ? "error" : "warning",
              message: [
                partialCaptures ? `不完整 ${partialCaptures}` : "",
                failedCaptures ? `失败 ${failedCaptures}` : "",
                captureProviders.length ? captureProviders.join("、") : "",
              ]
                .filter(Boolean)
                .join(" · "),
              progress: failedCaptures > 0 ? 100 : 50,
              updatedAt: latestCaptureAnomaly.createdAt,
              createdAt: latestCaptureAnomaly.createdAt,
              completedAt: latestCaptureAnomaly.createdAt,
              error: failedCaptures > 0 ? "存在采集失败，请查看日志" : null,
              stats: {
                partial: partialCaptures,
                failed: failedCaptures,
                providers: captureProviders,
              },
              href: "/logs?scope=capture",
            },
          ]
        : []),
    ]
      .sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      )
      .slice(0, query.limit);

    return {
      generatedAt: new Date().toISOString(),
      summary: {
        active: items.filter((item) =>
          ["queued", "running", "processing"].includes(String(item.status)),
        ).length,
        failed: items.filter((item) => item.severity === "error").length,
        warnings: items.filter((item) => item.severity === "warning").length,
      },
      items,
    };
  });
}
