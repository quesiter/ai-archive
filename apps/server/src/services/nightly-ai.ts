import {
  createBackgroundTask,
  failBackgroundTask,
  failStaleBackgroundTasks,
  getBackgroundTask,
  getLatestBackgroundTask,
} from "./background-tasks.js";
import { writeOperationLog } from "./operation-log.js";
import {
  enqueueNightlyAiMaintenance,
  enqueueUnlockedReclassification,
  type NightlyAiMaintenanceJobData,
} from "./queue.js";

export const NIGHTLY_AI_MAINTENANCE_HOUR = 22;
export const NIGHTLY_AI_STATUS_POLL_MS = 10 * 60_000;

export function nightlyAiRunKey(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

async function scheduleNext(input: NightlyAiMaintenanceJobData): Promise<void> {
  const jobId = await enqueueNightlyAiMaintenance(input, {
    startAfter: new Date(Date.now() + NIGHTLY_AI_STATUS_POLL_MS),
  });
  if (!jobId) throw new Error("夜间维护后续检查没有成功进入队列");
}

export async function ensureOrganizationTask(
  queuedMessage = "每日 22:00 夜间维护：等待增量整理项目与标签",
): Promise<string> {
  await failStaleBackgroundTasks("classification_rebuild");
  const active = await getLatestBackgroundTask("classification_rebuild", [
    "queued",
    "running",
  ]);
  if (active) return active.id;
  const task = await createBackgroundTask(
    "classification_rebuild",
    queuedMessage,
  );
  const jobId = await enqueueUnlockedReclassification({
    taskId: task.id,
    mode: "economy",
    scope: "incremental",
  });
  if (!jobId) {
    await failBackgroundTask(task.id, "夜间项目与标签整理没有成功进入队列");
    throw new Error("夜间项目与标签整理没有成功进入队列");
  }
  return task.id;
}

export async function runNightlyAiMaintenance(
  input: NightlyAiMaintenanceJobData,
): Promise<{ stage: string; waiting?: boolean }> {
  if (input.stage === "classification") {
    const classificationTaskId = await ensureOrganizationTask();
    await writeOperationLog({
      scope: "analysis",
      message: "每日 22:00 夜间维护已启动：增量整理项目与标签",
      status: "running",
      entityType: "background_task",
      entityId: classificationTaskId,
      metadata: { runKey: input.runKey, stage: "classification" },
    });
    await scheduleNext({
      ...input,
      stage: "wait_classification",
      classificationTaskId,
    });
    return { stage: "wait_classification", waiting: true };
  }

  const task = input.classificationTaskId
    ? await getBackgroundTask(input.classificationTaskId)
    : null;
  if (task && (task.status === "queued" || task.status === "running")) {
    await scheduleNext(input);
    return { stage: input.stage, waiting: true };
  }
  await writeOperationLog({
    scope: "analysis",
    level: task?.status === "failed" ? "warning" : "info",
    message:
      task?.status === "failed"
        ? "本次夜间项目与标签整理失败，次日 22:00 将再次执行"
        : "本次夜间项目与标签整理已完成",
    status: task?.status ?? "completed",
    entityType: input.classificationTaskId ? "background_task" : "system",
    entityId: input.classificationTaskId ?? null,
    metadata: {
      runKey: input.runKey,
      stage: "completed",
      classificationTaskId: input.classificationTaskId,
    },
  });
  return { stage: "completed" };
}
