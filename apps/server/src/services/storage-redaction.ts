import { asc, count, eq, gt, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  captureRuns,
  conversationRevisions,
  conversations,
  importJobs,
  messageSegments,
  messages,
  operationLogs,
  projects,
  reports,
  savedSearches,
  tags,
} from "../schema.js";
import {
  completeBackgroundTask,
  failBackgroundTask,
  startBackgroundTask,
  updateBackgroundTask,
} from "./background-tasks.js";
import { safeStoredError } from "./operation-log.js";
import {
  type CompiledCustomRedactionRule,
  loadEnabledCustomRedactionRules,
  redactSensitiveTextForStorage,
  redactSensitiveUrlForStorage,
} from "./redaction.js";
import { normalizeProjectName } from "./projects.js";
import { normalizeTagName } from "./tags.js";

const BATCH_SIZE = 200;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

type CleanupProgress = {
  processed: number;
  redactedRows: number;
  replacements: number;
};

function redactOptionalText(
  value: string | null,
  rules: readonly CompiledCustomRedactionRule[],
): { value: string | null; replacements: number } {
  if (value === null) return { value: null, replacements: 0 };
  const result = redactSensitiveTextForStorage(value, rules);
  return { value: result.text, replacements: result.replacements };
}

function redactJsonValue(
  value: unknown,
  rules: readonly CompiledCustomRedactionRule[],
): { value: unknown; replacements: number } {
  if (typeof value === "string") {
    const result = redactSensitiveTextForStorage(value, rules);
    return { value: result.text, replacements: result.replacements };
  }
  if (Array.isArray(value)) {
    let replacements = 0;
    const items = value.map((item) => {
      const result = redactJsonValue(item, rules);
      replacements += result.replacements;
      return result.value;
    });
    return { value: items, replacements };
  }
  if (value && typeof value === "object") {
    let replacements = 0;
    const entries = Object.entries(value).map(([key, item]) => {
      const result = redactJsonValue(item, rules);
      replacements += result.replacements;
      return [key, result.value] as const;
    });
    return { value: Object.fromEntries(entries), replacements };
  }
  return { value, replacements: 0 };
}

async function updateProgress(
  taskId: string,
  stage: string,
  progress: CleanupProgress,
  total: number,
): Promise<void> {
  await updateBackgroundTask(
    taskId,
    {
      processedCount: progress.processed,
      succeededCount: progress.redactedRows,
      message: `正在脱敏历史归档：${stage}`,
      stats: {
        stage,
        totalRows: total,
        redactedRows: progress.redactedRows,
        replacements: progress.replacements,
      },
    },
    { log: false },
  );
}

export async function redactStoredArchive(taskId: string): Promise<CleanupProgress> {
  const rules = await loadEnabledCustomRedactionRules();
  const totals = await Promise.all([
    db.select({ value: count() }).from(messageSegments),
    db.select({ value: count() }).from(conversationRevisions),
    db.select({ value: count() }).from(conversations),
    db.select({ value: count() }).from(reports),
    db.select({ value: count() }).from(captureRuns),
    db.select({ value: count() }).from(importJobs),
    db.select({ value: count() }).from(operationLogs),
    db.select({ value: count() }).from(projects),
    db.select({ value: count() }).from(tags),
    db.select({ value: count() }).from(savedSearches),
  ]);
  // startBackgroundTask writes one operation log that is also scanned below.
  const total = totals.reduce((sum, rows) => sum + Number(rows[0]?.value ?? 0), 0) + 1;
  const progress: CleanupProgress = { processed: 0, redactedRows: 0, replacements: 0 };
  await startBackgroundTask(taskId, total, "正在扫描已有归档中的密码、密钥和登录信息");

  try {
    let cursor = NIL_UUID;
    while (true) {
      const rows = await db
        .select({
          id: messageSegments.id,
          revisionId: messages.revisionId,
          content: messageSegments.content,
          href: messageSegments.href,
        })
        .from(messageSegments)
        .innerJoin(messages, eq(messages.id, messageSegments.messageId))
        .where(gt(messageSegments.id, cursor))
        .orderBy(asc(messageSegments.id))
        .limit(BATCH_SIZE);
      if (!rows.length) break;
      for (const row of rows) {
        const content = redactSensitiveTextForStorage(row.content, rules);
        const href = row.href
          ? redactSensitiveUrlForStorage(row.href, rules)
          : { text: null, replacements: 0 };
        const replacements = content.replacements + href.replacements;
        if (replacements > 0) {
          await db
            .update(messageSegments)
            .set({ content: content.text, href: href.text })
            .where(eq(messageSegments.id, row.id));
          await db
            .update(conversationRevisions)
            .set({ contentIntegrityHash: null })
            .where(eq(conversationRevisions.id, row.revisionId));
        }
        progress.processed += 1;
        progress.redactedRows += replacements > 0 ? 1 : 0;
        progress.replacements += replacements;
      }
      cursor = rows.at(-1)!.id;
      await updateProgress(taskId, "消息正文", progress, total);
    }

    const fragmentedPrivateKeyRows = await db.execute(sql`
      with starts as (
        select message_id, ordinal as start_ordinal
        from message_segments
        where content ~ '-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'
      ), blocks as (
        select
          starts.message_id,
          starts.start_ordinal,
          coalesce(
            (
              select min(ending.ordinal)
              from message_segments ending
              where ending.message_id = starts.message_id
                and ending.ordinal >= starts.start_ordinal
                and ending.content ~ '-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----'
            ),
            (
              select max(tail_segment.ordinal)
              from message_segments tail_segment
              where tail_segment.message_id = starts.message_id
            )
          ) as end_ordinal
        from starts
      )
      update message_segments target
      set content = '[PRIVATE_KEY]', href = null
      from blocks
      where target.message_id = blocks.message_id
        and target.ordinal between blocks.start_ordinal and blocks.end_ordinal
        and (target.content <> '[PRIVATE_KEY]' or target.href is not null)
      returning target.id, target.message_id
    `);
    const fragmentedCount = fragmentedPrivateKeyRows.length;
    if (fragmentedCount > 0) {
      const affectedMessageIds = [
        ...new Set(
          fragmentedPrivateKeyRows.flatMap((row) =>
            typeof row.message_id === "string" ? [row.message_id] : [],
          ),
        ),
      ];
      for (const messageId of affectedMessageIds) {
        const [message] = await db
          .select({ revisionId: messages.revisionId })
          .from(messages)
          .where(eq(messages.id, messageId))
          .limit(1);
        if (message) {
          await db
            .update(conversationRevisions)
            .set({ contentIntegrityHash: null })
            .where(eq(conversationRevisions.id, message.revisionId));
        }
      }
      progress.redactedRows += fragmentedCount;
      progress.replacements += fragmentedCount;
      await updateProgress(taskId, "跨片段私钥", progress, total);
    }

    cursor = NIL_UUID;
    while (true) {
      const rows = await db
        .select({
          id: conversationRevisions.id,
          searchText: conversationRevisions.searchText,
          completenessReason: conversationRevisions.completenessReason,
          capturedTitle: conversationRevisions.capturedTitle,
          capturedCanonicalUrl: conversationRevisions.capturedCanonicalUrl,
        })
        .from(conversationRevisions)
        .where(gt(conversationRevisions.id, cursor))
        .orderBy(asc(conversationRevisions.id))
        .limit(BATCH_SIZE);
      if (!rows.length) break;
      for (const row of rows) {
        const searchText = redactSensitiveTextForStorage(row.searchText, rules);
        const reason = redactOptionalText(row.completenessReason, rules);
        const capturedTitle = redactOptionalText(row.capturedTitle, rules);
        const capturedUrl = row.capturedCanonicalUrl
          ? redactSensitiveUrlForStorage(row.capturedCanonicalUrl, rules)
          : { text: null, replacements: 0 };
        const replacements = searchText.replacements + reason.replacements + capturedTitle.replacements + capturedUrl.replacements;
        if (replacements > 0) {
          await db
            .update(conversationRevisions)
            .set({
              searchText: searchText.text,
              completenessReason: reason.value,
              capturedTitle: capturedTitle.value,
              capturedCanonicalUrl: capturedUrl.text,
              ...(
                reason.replacements + capturedTitle.replacements + capturedUrl.replacements > 0
                  ? { contentIntegrityHash: null }
                  : {}
              ),
            })
            .where(eq(conversationRevisions.id, row.id));
        }
        progress.processed += 1;
        progress.redactedRows += replacements > 0 ? 1 : 0;
        progress.replacements += replacements;
      }
      cursor = rows.at(-1)!.id;
      await updateProgress(taskId, "搜索索引", progress, total);
    }

    cursor = NIL_UUID;
    while (true) {
      const rows = await db
        .select({
          id: conversations.id,
          title: conversations.title,
          canonicalUrl: conversations.canonicalUrl,
        })
        .from(conversations)
        .where(gt(conversations.id, cursor))
        .orderBy(asc(conversations.id))
        .limit(BATCH_SIZE);
      if (!rows.length) break;
      for (const row of rows) {
        const title = redactOptionalText(row.title, rules);
        const url = row.canonicalUrl
          ? redactSensitiveUrlForStorage(row.canonicalUrl, rules)
          : { text: null, replacements: 0 };
        const replacements = title.replacements + url.replacements;
        if (replacements > 0) {
          await db
            .update(conversations)
            .set({ title: title.value, canonicalUrl: url.text })
            .where(eq(conversations.id, row.id));
        }
        progress.processed += 1;
        progress.redactedRows += replacements > 0 ? 1 : 0;
        progress.replacements += replacements;
      }
      cursor = rows.at(-1)!.id;
      await updateProgress(taskId, "会话信息", progress, total);
    }

    const [projectRows, tagRows, savedRows] = await Promise.all([
      db.select().from(projects).orderBy(asc(projects.createdAt)),
      db.select().from(tags).orderBy(asc(tags.createdAt)),
      db.select().from(savedSearches).orderBy(asc(savedSearches.createdAt)),
    ]);
    await db.transaction(async (tx) => {
      for (const row of projectRows) {
        await tx.update(projects).set({ normalizedName: `__redaction__${row.id}` }).where(eq(projects.id, row.id));
      }
      for (const row of tagRows) {
        await tx.update(tags).set({ normalizedName: `__redaction__${row.id}` }).where(eq(tags.id, row.id));
      }
      for (const row of savedRows) {
        await tx.update(savedSearches).set({ normalizedName: `__redaction__${row.id}` }).where(eq(savedSearches.id, row.id));
      }

      const usedProjects = new Set<string>();
      for (const row of projectRows) {
        const nameResult = redactSensitiveTextForStorage(row.name, rules);
        const description = redactSensitiveTextForStorage(row.description, rules);
        let candidate = nameResult.text.trim() || `已脱敏项目-${row.id.slice(0, 8)}`;
        let normalized = normalizeProjectName(candidate);
        let suffix = 2;
        while (usedProjects.has(normalized.normalizedName)) {
          normalized = normalizeProjectName(`${candidate} (${suffix++})`);
        }
        usedProjects.add(normalized.normalizedName);
        await tx.update(projects).set({
          name: normalized.name,
          normalizedName: normalized.normalizedName,
          description: description.text,
          updatedAt: new Date(),
        }).where(eq(projects.id, row.id));
        const replacements = nameResult.replacements + description.replacements;
        progress.processed += 1;
        progress.redactedRows += replacements > 0 ? 1 : 0;
        progress.replacements += replacements;
      }

      const usedTags = new Set<string>();
      for (const row of tagRows) {
        const redacted = redactSensitiveTextForStorage(row.name, rules);
        const candidate = redacted.text.trim() || `已脱敏标签-${row.id.slice(0, 8)}`;
        let normalized = normalizeTagName(candidate);
        let suffix = 2;
        while (usedTags.has(normalized.normalizedName)) normalized = normalizeTagName(`${candidate} (${suffix++})`);
        usedTags.add(normalized.normalizedName);
        await tx.update(tags).set({ ...normalized, updatedAt: new Date() }).where(eq(tags.id, row.id));
        progress.processed += 1;
        progress.redactedRows += redacted.replacements > 0 ? 1 : 0;
        progress.replacements += redacted.replacements;
      }

      const usedSaved = new Set<string>();
      for (const row of savedRows) {
        const redactedName = redactSensitiveTextForStorage(row.name, rules);
        const redactedQuery = redactJsonValue(row.query, rules);
        const candidate = redactedName.text.trim() || `已脱敏搜索-${row.id.slice(0, 8)}`;
        let name = candidate;
        let normalizedName = candidate.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
        let suffix = 2;
        while (usedSaved.has(normalizedName)) {
          name = `${candidate} (${suffix++})`;
          normalizedName = name.toLocaleLowerCase("en-US");
        }
        usedSaved.add(normalizedName);
        await tx.update(savedSearches).set({
          name,
          normalizedName,
          query: redactedQuery.value as Record<string, string>,
          updatedAt: new Date(),
        }).where(eq(savedSearches.id, row.id));
        const replacements = redactedName.replacements + redactedQuery.replacements;
        progress.processed += 1;
        progress.redactedRows += replacements > 0 ? 1 : 0;
        progress.replacements += replacements;
      }
    });
    await updateProgress(taskId, "项目、标签与常用视图", progress, total);

    cursor = NIL_UUID;
    while (true) {
      const rows = await db
        .select({
          id: reports.id,
          title: reports.title,
          summary: reports.summary,
          bodyMarkdown: reports.bodyMarkdown,
        })
        .from(reports)
        .where(gt(reports.id, cursor))
        .orderBy(asc(reports.id))
        .limit(BATCH_SIZE);
      if (!rows.length) break;
      for (const row of rows) {
        const title = redactSensitiveTextForStorage(row.title, rules);
        const summary = redactSensitiveTextForStorage(row.summary, rules);
        const body = redactSensitiveTextForStorage(row.bodyMarkdown, rules);
        const replacements = title.replacements + summary.replacements + body.replacements;
        if (replacements > 0) {
          await db
            .update(reports)
            .set({ title: title.text, summary: summary.text, bodyMarkdown: body.text })
            .where(eq(reports.id, row.id));
        }
        progress.processed += 1;
        progress.redactedRows += replacements > 0 ? 1 : 0;
        progress.replacements += replacements;
      }
      cursor = rows.at(-1)!.id;
      await updateProgress(taskId, "报告", progress, total);
    }

    for (const [stage, table, errorColumn] of [
      ["采集错误", captureRuns, captureRuns.error],
      ["导入错误", importJobs, importJobs.error],
    ] as const) {
      cursor = NIL_UUID;
      while (true) {
        const rows = await db
          .select({ id: table.id, error: errorColumn })
          .from(table)
          .where(gt(table.id, cursor))
          .orderBy(asc(table.id))
          .limit(BATCH_SIZE);
        if (!rows.length) break;
        for (const row of rows) {
          const error = redactOptionalText(row.error, rules);
          if (error.replacements > 0) {
            await db.update(table).set({ error: error.value }).where(eq(table.id, row.id));
          }
          progress.processed += 1;
          progress.redactedRows += error.replacements > 0 ? 1 : 0;
          progress.replacements += error.replacements;
        }
        cursor = rows.at(-1)!.id;
        await updateProgress(taskId, stage, progress, total);
      }
    }

    cursor = NIL_UUID;
    while (true) {
      const rows = await db
        .select({ id: operationLogs.id, message: operationLogs.message, metadata: operationLogs.metadata })
        .from(operationLogs)
        .where(gt(operationLogs.id, cursor))
        .orderBy(asc(operationLogs.id))
        .limit(BATCH_SIZE);
      if (!rows.length) break;
      for (const row of rows) {
        const message = redactSensitiveTextForStorage(row.message, rules);
        const metadata = redactJsonValue(row.metadata, rules);
        const replacements = message.replacements + metadata.replacements;
        if (replacements > 0) {
          await db
            .update(operationLogs)
            .set({ message: message.text, metadata: metadata.value as Record<string, unknown> })
            .where(eq(operationLogs.id, row.id));
        }
        progress.processed += 1;
        progress.redactedRows += replacements > 0 ? 1 : 0;
        progress.replacements += replacements;
      }
      cursor = rows.at(-1)!.id;
      await updateProgress(taskId, "操作日志", progress, total);
    }

    await completeBackgroundTask(taskId, {
      processedCount: progress.processed,
      succeededCount: progress.redactedRows,
      failedCount: 0,
      message: "历史归档敏感信息脱敏完成",
      stats: {
        stage: "completed",
        totalRows: total,
        redactedRows: progress.redactedRows,
        replacements: progress.replacements,
      },
    });
    return progress;
  } catch (error) {
    await failBackgroundTask(taskId, safeStoredError(error));
    throw error;
  }
}
