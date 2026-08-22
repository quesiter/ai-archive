import { and, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db.js";
import { backgroundTasks } from "../schema.js";
import { safeStoredError, writeOperationLog } from "./operation-log.js";

export type BackgroundTask = typeof backgroundTasks.$inferSelect;
export type BackgroundTaskKind = BackgroundTask["kind"];
export type BackgroundTaskStatus = BackgroundTask["status"];

const DEFAULT_STALE_BACKGROUND_TASK_MS = 30 * 60_000;

interface BackgroundTaskUpdate {
  status?: BackgroundTaskStatus;
  totalCount?: number;
  processedCount?: number;
  succeededCount?: number;
  failedCount?: number;
  message?: string | null;
  error?: string | null;
  stats?: Record<string, unknown>;
  completedAt?: Date | null;
}

interface BackgroundTaskUpdateOptions {
  log?: boolean;
}

function operationScope(kind: BackgroundTaskKind) {
  if (kind === "knowledge_rebuild") return "analysis";
  if (kind === "storage_redaction") return "system";
  return "classification";
}

export async function createBackgroundTask(
  kind: BackgroundTaskKind,
  message: string,
): Promise<BackgroundTask> {
  const [task] = await db
    .insert(backgroundTasks)
    .values({ kind, status: "queued", message, updatedAt: new Date() })
    .returning();
  if (!task) throw new Error("Failed to create background task");
  await writeOperationLog({
    scope: operationScope(kind),
    message,
    status: task.status,
    entityType: "background_task",
    entityId: task.id,
    metadata: { kind },
  });
  return task;
}

export async function updateBackgroundTask(
  id: string,
  values: BackgroundTaskUpdate,
  options: BackgroundTaskUpdateOptions = {},
): Promise<BackgroundTask | null> {
  const [task] = await db
    .update(backgroundTasks)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(backgroundTasks.id, id))
    .returning();
  if (task && options.log !== false && (values.status || values.message || values.error)) {
    await writeOperationLog({
      scope: operationScope(task.kind),
      message: values.error ?? values.message ?? `智能归类任务${task.status}`,
      status: task.status,
      entityType: "background_task",
      entityId: task.id,
      metadata: {
        totalCount: task.totalCount,
        processedCount: task.processedCount,
        succeededCount: task.succeededCount,
        failedCount: task.failedCount,
        stats: task.stats,
      },
    });
  }
  return task ?? null;
}

export async function getBackgroundTask(id: string): Promise<BackgroundTask | null> {
  const [task] = await db
    .select()
    .from(backgroundTasks)
    .where(eq(backgroundTasks.id, id))
    .limit(1);
  return task ?? null;
}

export async function getLatestBackgroundTask(
  kind: BackgroundTaskKind,
  statuses?: BackgroundTaskStatus[],
): Promise<BackgroundTask | null> {
  const [task] = await db
    .select()
    .from(backgroundTasks)
    .where(
      statuses?.length
        ? and(eq(backgroundTasks.kind, kind), inArray(backgroundTasks.status, statuses))
        : eq(backgroundTasks.kind, kind),
    )
    .orderBy(desc(backgroundTasks.createdAt))
    .limit(1);
  return task ?? null;
}

export async function failStaleBackgroundTasks(
  kind: BackgroundTaskKind,
  olderThanMs = DEFAULT_STALE_BACKGROUND_TASK_MS,
): Promise<BackgroundTask[]> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - olderThanMs);
  const staleTasks = await db
    .update(backgroundTasks)
    .set({
      status: "failed",
      message: "任务运行超时或 Worker 已重启，已自动标记失败。",
      error: "任务长时间没有进度更新，请重新运行。",
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(backgroundTasks.kind, kind),
        inArray(backgroundTasks.status, ["queued", "running"]),
        lte(backgroundTasks.updatedAt, cutoff),
        sql`coalesce(${backgroundTasks.stats}->>'stage', '') <> 'deferred'`,
      ),
    )
    .returning();

  for (const task of staleTasks) {
    await writeOperationLog({
      scope: operationScope(task.kind),
      level: "error",
      message: "超时智能归类任务已自动标记失败",
      status: task.status,
      entityType: "background_task",
      entityId: task.id,
      metadata: {
        totalCount: task.totalCount,
        processedCount: task.processedCount,
        succeededCount: task.succeededCount,
        failedCount: task.failedCount,
        staleUpdatedAt: task.updatedAt.toISOString(),
      },
    });
  }

  return staleTasks;
}

export async function startBackgroundTask(
  id: string,
  totalCount: number,
  message: string,
): Promise<BackgroundTask | null> {
  return updateBackgroundTask(id, {
    status: "running",
    totalCount,
    processedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    message,
    error: null,
    stats: {},
    completedAt: null,
  });
}

export async function completeBackgroundTask(
  id: string,
  values: Omit<BackgroundTaskUpdate, "status" | "completedAt">,
): Promise<BackgroundTask | null> {
  return updateBackgroundTask(id, {
    ...values,
    status: "completed",
    completedAt: new Date(),
  });
}

export async function failBackgroundTask(
  id: string,
  error: string,
): Promise<BackgroundTask | null> {
  return updateBackgroundTask(id, {
    status: "failed",
    error: safeStoredError(error),
    message: "任务失败",
    completedAt: new Date(),
  });
}
