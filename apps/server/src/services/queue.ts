import PgBoss from "pg-boss";
import { config } from "../config.js";

export const queueNames = {
  weekly: "analysis-weekly",
  monthly: "analysis-monthly",
  classifyConversation: "classify-conversation",
  reclassifyUnlocked: "reclassify-unlocked",
  importArchive: "import-archive",
  emailReport: "email-report",
} as const;

export interface ReclassificationJobData {
  taskId?: string;
  mode?: "economy" | "full";
  conversationIds?: string[];
  offset?: number;
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
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    kind === "weekly" ? queueNames.weekly : queueNames.monthly,
    { requestedAt: new Date().toISOString() },
    { singletonKey: kind },
  );
}

export async function enqueueConversationClassification(
  conversationId: string,
): Promise<string | null> {
  const boss = await getBoss();
  return boss.send(
    queueNames.classifyConversation,
    { conversationId, requestedAt: new Date().toISOString() },
    {
      retryLimit: 4,
      retryDelay: 60,
      retryBackoff: true,
      singletonKey: conversationId,
      singletonSeconds: 30,
    },
  );
}

export async function enqueueUnlockedReclassification(
  input?: string | ReclassificationJobData,
  mode?: "economy" | "full",
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
  const options = data.taskId
    ? { singletonKey: `${data.taskId}:${offset}` }
    : { singletonKey: "all-unlocked", singletonSeconds: 300 };
  return boss.send(
    queueNames.reclassifyUnlocked,
    { ...data, offset, requestedAt: new Date().toISOString() },
    {
      ...options,
      expireInHours: 6,
      retryLimit: 1,
      retryDelay: 60,
      retryBackoff: true,
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

export async function stopBoss(): Promise<void> {
  if (!bossPromise) return;
  const boss = await bossPromise;
  await boss.stop({ graceful: true, timeout: 10_000 });
  bossPromise = null;
}
