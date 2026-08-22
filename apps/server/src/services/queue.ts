import PgBoss from "pg-boss";
import { config } from "../config.js";
import { AI_RATE_LIMIT_RETRY_DELAY_MS } from "./llm.js";

const AI_RETRY_DELAY_SECONDS = Math.round(AI_RATE_LIMIT_RETRY_DELAY_MS / 1_000);
// Safety retries cover a full weekly quota window if creating a delayed replacement job fails.
const AI_RETRY_LIMIT = 7 * 24;

export const queueNames = {
  weekly: "analysis-weekly",
  monthly: "analysis-monthly",
  classifyConversation: "classify-conversation",
  reclassifyUnlocked: "reclassify-unlocked",
  rebuildKnowledge: "rebuild-knowledge",
  nightlyAiMaintenance: "nightly-ai-maintenance",
  importArchive: "import-archive",
  emailReport: "email-report",
  redactStorage: "redact-storage",
} as const;

export interface ReclassificationJobData {
  taskId?: string;
  mode?: "economy" | "full";
  scope?: "incremental" | "all";
  conversationIds?: string[];
  offset?: number;
}

export interface KnowledgeRebuildJobData {
  taskId?: string;
}

export type NightlyAiMaintenanceStage =
  | "classification"
  | "wait_classification"
  | "knowledge"
  | "wait_knowledge";

export interface NightlyAiMaintenanceJobData {
  runKey: string;
  stage: NightlyAiMaintenanceStage;
  classificationTaskId?: string;
  knowledgeTaskId?: string;
}

export interface AiQueueScheduleOptions {
  startAfter?: Date | string;
}

function scheduledSingletonKey(
  base: string,
  schedule: AiQueueScheduleOptions | undefined,
): string {
  if (!schedule?.startAfter) return base;
  const timestamp = new Date(schedule.startAfter).getTime();
  return `${base}:deferred:${Number.isFinite(timestamp) ? timestamp : String(schedule.startAfter)}`;
}

let bossPromise: Promise<PgBoss> | null = null;

export function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    bossPromise = (async () => {
      const boss = new PgBoss({
        connectionString: config.DATABASE_URL,
        schema: "pgboss",
        application_name: "ai-conversation-archive",
      });
      await boss.start();
      for (const name of Object.values(queueNames)) {
        await boss.createQueue(name);
      }
      return boss;
    })();
  }
  return bossPromise;
}

export async function enqueueAnalysis(
  kind: "weekly" | "monthly",
  schedule?: AiQueueScheduleOptions,
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    kind === "weekly" ? queueNames.weekly : queueNames.monthly,
    { requestedAt: new Date().toISOString() },
    {
      ...(schedule?.startAfter ? { startAfter: schedule.startAfter } : {}),
      singletonKey: scheduledSingletonKey(kind, schedule),
    },
  );
}

export async function enqueueConversationClassification(
  conversationId: string,
  schedule?: AiQueueScheduleOptions,
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    queueNames.classifyConversation,
    { conversationId, requestedAt: new Date().toISOString() },
    {
      retryLimit: AI_RETRY_LIMIT,
      retryDelay: AI_RETRY_DELAY_SECONDS,
      retryBackoff: false,
      ...(schedule?.startAfter ? { startAfter: schedule.startAfter } : {}),
      singletonKey: scheduledSingletonKey(conversationId, schedule),
      singletonSeconds: 30,
    },
  );
}

export async function enqueueUnlockedReclassification(
  input?: string | ReclassificationJobData,
  mode?: "economy" | "full",
  schedule?: AiQueueScheduleOptions,
): Promise<string | null> {
  const boss = await getBoss();
  const data =
    typeof input === "string"
      ? { taskId: input, mode }
      : {
          ...input,
          mode: input?.mode ?? mode,
        };
  const offset = Math.max(0, Math.trunc(data.offset ?? 0));
  const singletonOptions = data.taskId
    ? { singletonKey: scheduledSingletonKey(`${data.taskId}:${offset}`, schedule) }
    : {
        singletonKey: scheduledSingletonKey("all-unlocked", schedule),
        singletonSeconds: 300,
      };
  return boss.send(
    queueNames.reclassifyUnlocked,
    { ...data, offset, requestedAt: new Date().toISOString() },
    {
      ...singletonOptions,
      ...(schedule?.startAfter ? { startAfter: schedule.startAfter } : {}),
      expireInHours: 6,
      retryLimit: AI_RETRY_LIMIT,
      retryDelay: AI_RETRY_DELAY_SECONDS,
      retryBackoff: false,
    },
  );
}

export async function enqueueKnowledgeRebuild(
  input?: string | KnowledgeRebuildJobData,
  schedule?: AiQueueScheduleOptions,
): Promise<string | null> {
  const boss = await getBoss();
  const data = typeof input === "string" ? { taskId: input } : { ...(input ?? {}) };
  const singletonOptions = data.taskId
    ? { singletonKey: scheduledSingletonKey(data.taskId, schedule) }
    : {
        singletonKey: scheduledSingletonKey("all-knowledge", schedule),
        singletonSeconds: 300,
      };
  return boss.send(
    queueNames.rebuildKnowledge,
    { ...data, requestedAt: new Date().toISOString() },
    {
      ...singletonOptions,
      ...(schedule?.startAfter ? { startAfter: schedule.startAfter } : {}),
      // A paced full knowledge pass can legitimately span more than one day.
      expireInHours: 72,
      retryLimit: AI_RETRY_LIMIT,
      retryDelay: AI_RETRY_DELAY_SECONDS,
      retryBackoff: false,
    },
  );
}

export async function enqueueNightlyAiMaintenance(
  input: NightlyAiMaintenanceJobData,
  schedule?: AiQueueScheduleOptions,
): Promise<string | null> {
  const boss = await getBoss();
  const taskKey = input.classificationTaskId ?? input.knowledgeTaskId ?? "start";
  return boss.send(
    queueNames.nightlyAiMaintenance,
    { ...input, requestedAt: new Date().toISOString() },
    {
      ...(schedule?.startAfter ? { startAfter: schedule.startAfter } : {}),
      singletonKey: scheduledSingletonKey(
        `${input.runKey}:${input.stage}:${taskKey}`,
        schedule,
      ),
      expireInHours: 48,
      retryLimit: 12,
      retryDelay: 300,
      retryBackoff: false,
    },
  );
}

export async function enqueueImport(path: string): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    queueNames.importArchive,
    { path },
    {
      expireInHours: 6,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
      singletonKey: path,
    },
  );
}

export async function enqueueReportEmail(reportId: string): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    queueNames.emailReport,
    { reportId },
    {
      retryLimit: 8,
      retryDelay: 60,
      retryBackoff: true,
      singletonKey: reportId,
    },
  );
}

export async function enqueueStorageRedaction(taskId: string): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    queueNames.redactStorage,
    { taskId, requestedAt: new Date().toISOString() },
    {
      // pg-boss 10 rejects an expiration value equal to its 24-hour ceiling.
      expireInHours: 23,
      retryLimit: 2,
      retryDelay: 60,
      retryBackoff: true,
      singletonKey: taskId,
    },
  );
}

export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const boss = await bossPromise;
  await boss.stop({ graceful: true, timeout: 10_000 });
  bossPromise = null;
}
