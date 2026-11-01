import PgBoss from "pg-boss";
import { config } from "../config.js";
import { AI_RATE_LIMIT_RETRY_DELAY_MS } from "./llm.js";
import { safeStoredError } from "./operation-log.js";

const AI_RETRY_DELAY_SECONDS = Math.round(AI_RATE_LIMIT_RETRY_DELAY_MS / 1_000);
// Safety retries cover a full weekly quota window if creating a delayed replacement job fails.
const AI_RETRY_LIMIT = 7 * 24;

export const queueNames = {
  weekly: "analysis-weekly",
  monthly: "analysis-monthly",
  classifyConversation: "classify-conversation",
  reclassifyUnlocked: "reclassify-unlocked",
  nightlyAiMaintenance: "nightly-ai-maintenance",
  importArchive: "import-archive",
  emailReport: "email-report",
  redactStorage: "redact-storage",
  archiveIntegrity: "archive-integrity",
  restoreBackup: "restore-backup",
} as const;

export interface ReclassificationJobData {
  taskId?: string;
  mode?: "economy" | "full";
  scope?: "incremental" | "all";
  conversationIds?: string[];
  offset?: number;
}

export type NightlyAiMaintenanceStage =
  | "classification"
  | "wait_classification";

export interface NightlyAiMaintenanceJobData {
  runKey: string;
  stage: NightlyAiMaintenanceStage;
  classificationTaskId?: string;
}

export interface AiQueueScheduleOptions {
  startAfter?: Date | string;
}

export interface AnalysisJobData {
  requestedAt?: string;
  runId?: string;
  generationId?: string;
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
let stoppingPromise: Promise<void> | null = null;

async function closeBoss(boss: PgBoss, graceful: boolean): Promise<void> {
  let stopFailed = false;
  let stopError: unknown;
  try {
    await boss.stop({ graceful, timeout: 10_000 });
  } catch (error) {
    stopFailed = true;
    stopError = error;
  }
  try {
    // pg-boss 10's stop() skips cleanup if start() opened its pool but failed
    // before marking the instance started. Close that owned pool explicitly.
    const database = boss.getDb() as PgBoss.Db & {
      opened?: boolean;
      close?: () => Promise<void>;
    };
    if (database.opened && database.close) await database.close();
  } catch (error) {
    if (!stopFailed) throw error;
  }
  if (stopFailed) throw stopError;
}

export function getBoss(): Promise<PgBoss> {
  if (stoppingPromise) {
    return stoppingPromise.catch(() => undefined).then(() => getBoss());
  }
  if (!bossPromise) {
    const initialization: Promise<PgBoss> = Promise.resolve().then(async () => {
      let boss: PgBoss | undefined;
      try {
        boss = new PgBoss({
          connectionString: config.DATABASE_URL,
          schema: "pgboss",
          application_name: "ai-conversation-archive",
        });
        boss.on("error", (error) => {
          console.warn("Queue client error:", safeStoredError(error));
        });
        await boss.start();
        for (const name of Object.values(queueNames)) {
          await boss.createQueue(name);
        }
        return boss;
      } catch (error) {
        // A failed initialization must neither poison later enqueue attempts
        // nor leave the abandoned client's connections running.
        if (boss) await closeBoss(boss, false).catch(() => undefined);
        if (bossPromise === initialization) bossPromise = null;
        throw error;
      }
    });
    bossPromise = initialization;
  }
  return bossPromise;
}

export async function enqueueAnalysis(
  kind: "weekly" | "monthly",
  schedule?: AiQueueScheduleOptions,
  data: AnalysisJobData = {},
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    kind === "weekly" ? queueNames.weekly : queueNames.monthly,
    { ...data, requestedAt: new Date().toISOString() },
    {
      ...(schedule?.startAfter ? { startAfter: schedule.startAfter } : {}),
      retryLimit: 0,
      expireInMinutes: 30,
      singletonKey: scheduledSingletonKey(data.runId ? `${kind}:${data.runId}:${data.generationId ?? "current"}` : kind, schedule),
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

export async function enqueueNightlyAiMaintenance(
  input: NightlyAiMaintenanceJobData,
  schedule?: AiQueueScheduleOptions,
): Promise<string | null> {
  const boss = await getBoss();
  const taskKey = input.classificationTaskId ?? "start";
  return boss.send(
    queueNames.nightlyAiMaintenance,
    { ...input, requestedAt: new Date().toISOString() },
    {
      ...(schedule?.startAfter ? { startAfter: schedule.startAfter } : {}),
      singletonKey: scheduledSingletonKey(
        `${input.runKey}:${input.stage}:${taskKey}`,
        schedule,
      ),
      // pg-boss 10 rejects expiration values at or above its 24-hour ceiling.
      // Keep enough time for the staged maintenance flow without crashing the
      // worker as soon as the nightly cron tries to enqueue it.
      expireInHours: 23,
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

export async function enqueueArchiveIntegrity(taskId: string): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(queueNames.archiveIntegrity, { taskId }, {
    expireInHours: 23,
    retryLimit: 1,
    retryDelay: 60,
    singletonKey: taskId,
  });
}

export async function enqueueRestoreBackup(restoreJobId: string): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(queueNames.restoreBackup, { restoreJobId }, {
    expireInHours: 23,
    retryLimit: 0,
    singletonKey: restoreJobId,
  });
}

export function stopBoss(): Promise<void> {
  if (stoppingPromise) return stoppingPromise;
  const current = bossPromise;
  if (!current) return Promise.resolve();
  const stopping = (async () => {
    // Initialization already cleans up its own failure. Shutdown must still
    // finish when the database was unavailable during the first enqueue.
    const boss = await current.catch(() => null);
    if (boss) await closeBoss(boss, true);
  })().finally(() => {
    if (bossPromise === current) bossPromise = null;
    if (stoppingPromise === stopping) stoppingPromise = null;
  });
  stoppingPromise = stopping;
  return stopping;
}
