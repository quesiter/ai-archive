import {
  createBackgroundTask,
  failBackgroundTask,
  failStaleBackgroundTasks,
  getBackgroundTask,
  getLatestBackgroundTask,
} from "./background-tasks.js";
import { writeOperationLog } from "./operation-log.js";
import {
  enqueueKnowledgeRebuild,
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
  if (!jobId) throw new Error("夜间 AI 维护后续检查没有成功进入队列");
}

async function ensureClassificationTask(): Promise<string> {
  await failStaleBackgroundTasks("classification_rebuild");
  const active = await getLatestBackgroundTask("classification_rebuild", [
    "queued",
    "running",
  ]);
  if (active) return active.id;
  const task = await createBackgroundTask(
    "classification_rebuild",
    "每日 22:00 夜间维护：等待执行增量智能归类",
  );
  const jobId = await enqueueUnlockedReclassification({
    taskId: task.id,
    mode: "economy",
    scope: "incremental",
  });
  if (!jobId) {
    await failBackgroundTask(task.id, "夜间智能归类任务没有成功进入队列");
    throw new Error("夜间智能归类任务没有成功进入队列");
  }
  return task.id;
}

async function ensureKnowledgeTask(): Promise<string> {
  await failStaleBackgroundTasks("knowledge_rebuild");
  const active = await getLatestBackgroundTask("knowledge_rebuild", [
    "queued",
    "running",
  ]);
  if (active) return active.id;
  const task = await createBackgroundTask(
    "knowledge_rebuild",
    "夜间智能归类已结束，等待分析项目知识",
  );
  const jobId = await enqueueKnowledgeRebuild({ taskId: task.id });
  if (!jobId) {
    await failBackgroundTask(task.id, "夜间项目知识分析没有成功进入队列");
    throw new Error("夜间项目知识分析没有成功进入队列");
  }
  return task.id;
}

export async function runNightlyAiMaintenance(
  input: NightlyAiMaintenanceJobData,
): Promise<{ stage: string; waiting?: boolean }> {
  if (input.stage === "classification") {
    const classificationTaskId = await ensureClassificationTask();
    await writeOperationLog({
      scope: "analysis",
      message: "每日 22:00 夜间维护已启动：先执行增量智能归类",
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

  if (input.stage === "wait_classification") {
    const task = input.classificationTaskId
      ? await getBackgroundTask(input.classificationTaskId)
      : null;
    if (task && (task.status === "queued" || task.status === "running")) {
      await scheduleNext(input);
      return { stage: input.stage, waiting: true };
    }
    const knowledgeTaskId = await ensureKnowledgeTask();
    await writeOperationLog({
      scope: "analysis",
      level: task?.status === "failed" ? "warning" : "info",
      message: "夜间智能归类已结束，开始分析项目知识",
      status: "running",
      entityType: "background_task",
      entityId: knowledgeTaskId,
      metadata: {
        runKey: input.runKey,
        stage: "knowledge",
        classificationTaskId: input.classificationTaskId,
        classificationStatus: task?.status ?? "missing",
      },
    });
    await scheduleNext({
      ...input,
      stage: "wait_knowledge",
      knowledgeTaskId,
    });
    return { stage: "wait_knowledge", waiting: true };
  }

  if (input.stage === "knowledge") {
    const knowledgeTaskId = await ensureKnowledgeTask();
    await scheduleNext({ ...input, stage: "wait_knowledge", knowledgeTaskId });
    return { stage: "wait_knowledge", waiting: true };
  }

  const task = input.knowledgeTaskId
    ? await getBackgroundTask(input.knowledgeTaskId)
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
        ? "本次夜间项目知识分析失败，次日 22:00 将再次执行"
        : "本次夜间智能归类和项目知识分析已完成",
    status: task?.status ?? "completed",
    entityType: input.knowledgeTaskId ? "background_task" : "system",
    entityId: input.knowledgeTaskId ?? null,
    metadata: {
      runKey: input.runKey,
      stage: "completed",
      classificationTaskId: input.classificationTaskId,
      knowledgeTaskId: input.knowledgeTaskId,
    },
  });
  return { stage: "completed" };
}
