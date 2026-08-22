import { Cron } from "croner";
import { config } from "./config.js";
import { closeDatabase } from "./db.js";
import { processArchive, scanImportInbox } from "./jobs/import-job.js";
import {
  classifyConversation,
  reclassifyUnlockedConversations,
  retryDeferredAnalysisRuns,
  runAnalysis,
} from "./services/analysis.js";
import { sendReportEmailById } from "./services/email.js";
import {
  NIGHTLY_AI_MAINTENANCE_HOUR,
  ensureOrganizationTask,
  nightlyAiRunKey,
  runNightlyAiMaintenance,
} from "./services/nightly-ai.js";
import {
  enqueueAnalysis,
  enqueueConversationClassification,
  enqueueNightlyAiMaintenance,
  enqueueUnlockedReclassification,
  getBoss,
  queueNames,
  type NightlyAiMaintenanceJobData,
  type ReclassificationJobData,
  stopBoss,
} from "./services/queue.js";
import {
  deferredAiRetrySchedule,
  isRetryableRateLimitError,
  resolveAiRetrySchedule,
} from "./services/llm.js";
import { failStaleBackgroundTasks } from "./services/background-tasks.js";
import { getBooleanSetting, getSetting } from "./services/settings.js";
import { redactStoredArchive } from "./services/storage-redaction.js";
import { safeStoredError } from "./services/operation-log.js";

const boss = await getBoss();

async function aiRetrySchedule(error: unknown) {
  return deferredAiRetrySchedule(error) ?? await resolveAiRetrySchedule(error);
}

async function runAnalysisJob(kind: "weekly" | "monthly") {
  const result = await runAnalysis(kind);
  if ("deferred" in result) {
    await enqueueAnalysis(kind, { startAfter: result.retryAt });
  }
  return result;
}

await failStaleBackgroundTasks("classification_rebuild").catch((error) => {
  console.warn("Failed to mark stale classification tasks", safeStoredError(error));
});
await failStaleBackgroundTasks("storage_redaction", 24 * 60 * 60_000).catch((error) => {
  console.warn("Failed to mark stale storage redaction tasks", safeStoredError(error));
});

await boss.work(queueNames.weekly, async () => runAnalysisJob("weekly"));
await boss.work(queueNames.monthly, async () => runAnalysisJob("monthly"));
await boss.work(
  queueNames.classifyConversation,
  { includeMetadata: true },
  async (jobs) => {
    const conversationId = (
      jobs[0]?.data as { conversationId?: unknown } | undefined
    )?.conversationId;
    if (typeof conversationId !== "string") {
      throw new Error("Classification job conversationId is missing");
    }
    try {
      return await classifyConversation(conversationId);
    } catch (error) {
      if (!isRetryableRateLimitError(error)) throw error;
      const schedule = await aiRetrySchedule(error);
      const jobId = await enqueueConversationClassification(conversationId, {
        startAfter: schedule.retryAt,
      });
      if (!jobId) throw error;
      return { deferred: true, retryAt: schedule.retryAt };
    }
  },
);
await boss.work(
  queueNames.reclassifyUnlocked,
  { includeMetadata: true },
  async (jobs) => {
    const data = jobs[0]?.data as ReclassificationJobData | undefined;
    const taskId = data?.taskId;
    const mode = data?.mode;
    const input: {
      taskId?: string;
      modeOverride?: "economy" | "full";
      scope?: "incremental" | "all";
      conversationIds?: string[];
      offset?: number;
    } = {};
    if (typeof taskId === "string") input.taskId = taskId;
    if (mode === "economy" || mode === "full") input.modeOverride = mode;
    if (data?.scope === "incremental" || data?.scope === "all") {
      input.scope = data.scope;
    }
    if (Array.isArray(data?.conversationIds)) {
      input.conversationIds = data.conversationIds.filter(
        (id): id is string => typeof id === "string",
      );
    }
    if (typeof data?.offset === "number") input.offset = data.offset;
    try {
      return await reclassifyUnlockedConversations(input);
    } catch (error) {
      if (!isRetryableRateLimitError(error)) throw error;
      const schedule = await aiRetrySchedule(error);
      const jobId = await enqueueUnlockedReclassification(
        data,
        undefined,
        { startAfter: schedule.retryAt },
      );
      if (!jobId) throw error;
      return { deferred: true, retryAt: schedule.retryAt };
    }
  },
);
await boss.work(
  queueNames.nightlyAiMaintenance,
  { includeMetadata: true },
  async (jobs) => {
    const data = jobs[0]?.data as NightlyAiMaintenanceJobData | undefined;
    if (!data?.runKey || !data.stage) {
      throw new Error("Nightly AI maintenance job data is missing");
    }
    return runNightlyAiMaintenance(data);
  },
);
await boss.work(queueNames.importArchive, { includeMetadata: true }, async (jobs) => {
  const job = jobs[0];
  const path = (job?.data as { path?: unknown } | undefined)?.path;
  if (typeof path !== "string") throw new Error("Import job path is missing");
  await processArchive(path, {
    finalAttempt: Boolean(job && job.retryCount >= job.retryLimit),
  });
});
await boss.work(queueNames.emailReport, async (jobs) => {
  const reportId = (jobs[0]?.data as { reportId?: unknown } | undefined)?.reportId;
  if (typeof reportId !== "string") throw new Error("Email report ID is missing");
  await sendReportEmailById(reportId);
});
await boss.work(queueNames.redactStorage, async (jobs) => {
  const taskId = (jobs[0]?.data as { taskId?: unknown } | undefined)?.taskId;
  if (typeof taskId !== "string") throw new Error("Storage redaction task ID is missing");
  return redactStoredArchive(taskId);
});

const weeklyCron = new Cron(
  "30 7 * * 1",
  { timezone: config.TZ, protect: true },
  async () => {
    if ((await getSetting("reports.weeklyEnabled")) !== "false") {
      await enqueueAnalysis("weekly");
    }
  },
);

const monthlyCron = new Cron(
  "0 8 1 * *",
  { timezone: config.TZ, protect: true },
  async () => {
    if ((await getSetting("reports.monthlyEnabled")) !== "false") {
      await enqueueAnalysis("monthly");
    }
  },
);

// Revisit unlocked historical assignments even when no report is requested.
// This picks up newly configured models and richer project context over time.
const reclassificationCron = new Cron(
  "15 6 * * 0",
  { timezone: config.TZ, protect: true },
  async () => {
    if (await getBooleanSetting("classification.autoReclassify", false)) {
      await ensureOrganizationTask("每周日 06:15 自动增量整理项目与标签");
    }
  },
);

const analysisRetryCron = new Cron("*/5 * * * *", { timezone: config.TZ, protect: true }, async () => {
  await retryDeferredAnalysisRuns();
});

const nightlyAiMaintenanceCron = new Cron(
  `0 ${NIGHTLY_AI_MAINTENANCE_HOUR} * * *`,
  { timezone: config.TZ, protect: true },
  async () => {
    if (await getBooleanSetting("ai.nightlyMaintenanceEnabled", true)) {
      await enqueueNightlyAiMaintenance({
        runKey: nightlyAiRunKey(new Date(), config.TZ),
        stage: "classification",
      });
    }
  },
);

const inboxCron = new Cron("*/5 * * * *", { protect: true }, async () => {
  await scanImportInbox();
});
await scanImportInbox();

async function shutdown(): Promise<void> {
  weeklyCron.stop();
  monthlyCron.stop();
  reclassificationCron.stop();
  analysisRetryCron.stop();
  nightlyAiMaintenanceCron.stop();
  inboxCron.stop();
  await stopBoss();
  await closeDatabase();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

console.log(`Worker started with timezone ${config.TZ}`);
