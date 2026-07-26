import { Cron } from "croner";
import { config } from "./config.js";
import { closeDatabase } from "./db.js";
import { processArchive, scanImportInbox } from "./jobs/import-job.js";
import {
  classifyConversation,
  reclassifyUnlockedConversations,
  runAnalysis,
} from "./services/analysis.js";
import { sendReportEmailById } from "./services/email.js";
import {
  enqueueAnalysis,
  enqueueUnlockedReclassification,
  getBoss,
  queueNames,
  stopBoss,
} from "./services/queue.js";
import { getBooleanSetting, getSetting } from "./services/settings.js";

const boss = await getBoss();

await boss.work(queueNames.weekly, async () => runAnalysis("weekly"));
await boss.work(queueNames.monthly, async () => runAnalysis("monthly"));
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
    return classifyConversation(conversationId);
  },
);
await boss.work(
  queueNames.reclassifyUnlocked,
  { includeMetadata: true },
  async (jobs) => {
    const data = jobs[0]?.data as
      | { taskId?: unknown; mode?: unknown }
      | undefined;
    const taskId = data?.taskId;
    const mode = data?.mode;
    return reclassifyUnlockedConversations(
      typeof taskId === "string" ? taskId : undefined,
      mode === "economy" || mode === "full" ? mode : undefined,
    );
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
      await enqueueUnlockedReclassification();
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
  inboxCron.stop();
  await stopBoss();
  await closeDatabase();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

console.log(`Worker started with timezone ${config.TZ}`);
