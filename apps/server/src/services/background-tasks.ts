import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../db.js";
import { backgroundTasks } from "../schema.js";
import { writeOperationLog } from "./operation-log.js";

export type BackgroundTask = typeof backgroundTasks.$inferSelect;
export type BackgroundTaskKind = BackgroundTask["kind"];
export type BackgroundTaskStatus = BackgroundTask["status"];

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
    scope: "classification",
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
): Promise<BackgroundTask | null> {
  const [task] = await db
    .update(backgroundTasks)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(backgroundTasks.id, id))
    .returning();
  if (task && (values.status || values.message || values.error)) {
    await writeOperationLog({
      scope: "classification",
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
    error,
    message: "任务失败",
    completedAt: new Date(),
  });
}
