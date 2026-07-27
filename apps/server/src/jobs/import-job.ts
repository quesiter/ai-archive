import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readdir, rename, unlink } from "node:fs/promises";
import { basename, join } from "node:path";
import { and, eq, lt, lte, ne, or } from "drizzle-orm";
import { config } from "../config.js";
import { db, sqlClient } from "../db.js";
import { parseArchive } from "../importers/archive.js";
import { importJobs } from "../schema.js";
import { ingestCapture } from "../services/capture.js";
import { writeOperationLog } from "../services/operation-log.js";
import { enqueueImport, queueNames } from "../services/queue.js";

const IMPORT_PROCESSING_STALE_MS = 2 * 60 * 60 * 1000;
const IMPORT_ORPHAN_GRACE_MS = 20 * 60 * 1000;
const IMPORT_PROGRESS_HEARTBEAT_MS = 5_000;

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function isFileMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function moveArchive(
  path: string,
  directory: string,
  filename: string,
  options: { missingOk?: boolean } = {},
): Promise<void> {
  await mkdir(directory, { recursive: true });
  try {
    await rename(path, join(directory, filename));
  } catch (error) {
    if (options.missingOk && isFileMissing(error)) return;
    throw error;
  }
}

function processingStaleBefore(): Date {
  return new Date(Date.now() - IMPORT_PROCESSING_STALE_MS);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function activeImportJobPaths(): Promise<Set<string> | null> {
  try {
    const rows = await sqlClient`
      select data->>'path' as path
      from pgboss.job
      where name = ${queueNames.importArchive}
        and state in ('created', 'retry', 'active')
    `;
    return new Set(
      (rows as Array<{ path?: unknown }>)
        .map((row) => row.path)
        .filter((path): path is string => typeof path === "string" && path.length > 0),
    );
  } catch {
    return null;
  }
}

export async function recoverStaleImportJobs(options: {
  olderThanMs?: number;
  requeue?: boolean;
} = {}): Promise<{
  inspected: number;
  recovered: number;
  failed: number;
  skippedActive: number;
}> {
  const olderThanMs = options.olderThanMs ?? IMPORT_ORPHAN_GRACE_MS;
  const cutoff = new Date(Date.now() - olderThanMs);
  const staleJobs = await db
    .select({
      id: importJobs.id,
      filename: importJobs.filename,
      stats: importJobs.stats,
      updatedAt: importJobs.updatedAt,
    })
    .from(importJobs)
    .where(and(eq(importJobs.status, "processing"), lte(importJobs.updatedAt, cutoff)));

  if (!staleJobs.length) {
    return { inspected: 0, recovered: 0, failed: 0, skippedActive: 0 };
  }

  const activePaths = await activeImportJobPaths();
  if (!activePaths) {
    return { inspected: staleJobs.length, recovered: 0, failed: 0, skippedActive: staleJobs.length };
  }

  let recovered = 0;
  let failed = 0;
  let skippedActive = 0;
  for (const job of staleJobs) {
    const path = join(config.IMPORT_INBOX, job.filename);
    if (activePaths.has(path)) {
      skippedActive += 1;
      continue;
    }

    const present = await fileExists(path);
    const now = new Date();
    const nextStatus = present ? "queued" : "failed";
    const error = present
      ? null
      : "Import job stopped updating and the source archive is missing.";
    const [updated] = await db
      .update(importJobs)
      .set({
        status: nextStatus,
        error,
        stats: {
          ...(job.stats ?? {}),
          stage: nextStatus,
          recoveredFromStaleProcessing: true,
          staleUpdatedAt: job.updatedAt.toISOString(),
        },
        completedAt: present ? null : now,
        updatedAt: now,
      })
      .where(
        and(
          eq(importJobs.id, job.id),
          eq(importJobs.status, "processing"),
          lte(importJobs.updatedAt, cutoff),
        ),
      )
      .returning({ id: importJobs.id });

    if (!updated) continue;
    await writeOperationLog({
      scope: "import",
      level: present ? "warning" : "error",
      message: present
        ? `历史导入任务超时中断，已自动重新入队：${job.filename}`
        : `历史导入任务超时中断且源文件不存在，已标记失败：${job.filename}`,
      status: nextStatus,
      entityType: "import_job",
      entityId: job.id,
      metadata: {
        filename: job.filename,
        staleUpdatedAt: job.updatedAt.toISOString(),
        recoveredFromStaleProcessing: true,
      },
    });

    if (present) {
      recovered += 1;
      if (options.requeue) await enqueueImport(path).catch(() => null);
    } else {
      failed += 1;
    }
  }

  return { inspected: staleJobs.length, recovered, failed, skippedActive };
}

export async function processArchive(
  path: string,
  options: { finalAttempt?: boolean } = {},
): Promise<void> {
  const filename = basename(path);
  let [job] = await db
    .select()
    .from(importJobs)
    .where(eq(importJobs.filename, filename))
    .limit(1);
  if (!job) {
    const hash = await fileHash(path);
    [job] = await db
      .insert(importJobs)
      .values({ filename, fileHash: hash, status: "queued", updatedAt: new Date() })
      .onConflictDoNothing()
      .returning();
    if (!job) {
      await moveArchive(path, config.IMPORT_PROCESSED, filename).catch(async () => {
        await unlink(path).catch(() => undefined);
      });
      return;
    }
  }
  if (job.status === "completed") {
    await writeOperationLog({
      scope: "import",
      message: `历史导入已完成，跳过重复处理：${filename}`,
      status: "completed",
      entityType: "import_job",
      entityId: job.id,
      metadata: { filename },
    });
    await moveArchive(path, config.IMPORT_PROCESSED, filename, { missingOk: true }).catch(
      () => undefined,
    );
    return;
  }
  const [claimed] = await db
    .update(importJobs)
    .set({
      status: "processing",
      error: null,
      stats: { stage: "parsing" },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(importJobs.id, job.id),
        ne(importJobs.status, "completed"),
        or(
          ne(importJobs.status, "processing"),
          lt(importJobs.updatedAt, processingStaleBefore()),
        ),
      ),
    )
    .returning({ id: importJobs.id });
  if (!claimed) return;
  await writeOperationLog({
    scope: "import",
    message: `开始解析历史导入：${filename}`,
    status: "processing",
    entityType: "import_job",
    entityId: job.id,
    metadata: { filename, stage: "parsing" },
  });
  try {
    const parsed = await parseArchive(path);
    let imported = 0;
    let unchanged = 0;
    let lastProgressAt = Date.now();
    await db
      .update(importJobs)
      .set({
        provider: parsed.provider,
        stats: {
          stage: "importing",
          imported,
          unchanged,
          snapshots: parsed.snapshots.length,
        },
        updatedAt: new Date(),
      })
      .where(eq(importJobs.id, job.id));
    await writeOperationLog({
      scope: "import",
      message: `开始写入历史导入：${filename}`,
      status: "processing",
      entityType: "import_job",
      entityId: job.id,
      metadata: {
        provider: parsed.provider,
        stage: "importing",
        snapshots: parsed.snapshots.length,
      },
    });
    for (const snapshot of parsed.snapshots) {
      const result = await ingestCapture(snapshot, null);
      result.unchanged ? (unchanged += 1) : (imported += 1);
      if (Date.now() - lastProgressAt >= IMPORT_PROGRESS_HEARTBEAT_MS) {
        await db
          .update(importJobs)
          .set({
            stats: {
              stage: "importing",
              imported,
              unchanged,
              snapshots: parsed.snapshots.length,
            },
            updatedAt: new Date(),
          })
          .where(eq(importJobs.id, job.id));
        await writeOperationLog({
          scope: "import",
          message: `历史导入进度：${imported + unchanged}/${parsed.snapshots.length}`,
          status: "processing",
          entityType: "import_job",
          entityId: job.id,
          metadata: {
            provider: parsed.provider,
            imported,
            unchanged,
            snapshots: parsed.snapshots.length,
          },
        });
        lastProgressAt = Date.now();
      }
    }
    const completedAt = new Date();
    await db
      .update(importJobs)
      .set({
        provider: parsed.provider,
        status: "completed",
        stats: {
          stage: "completed",
          imported,
          unchanged,
          snapshots: parsed.snapshots.length,
        },
        completedAt,
        updatedAt: completedAt,
      })
      .where(eq(importJobs.id, job.id));
    await writeOperationLog({
      scope: "import",
      message: `历史导入完成：新增 ${imported}，未变 ${unchanged}`,
      status: "completed",
      entityType: "import_job",
      entityId: job.id,
      metadata: { provider: parsed.provider, imported, unchanged, snapshots: parsed.snapshots.length },
    });
  } catch (error) {
    const completedAt = options.finalAttempt ? new Date() : null;
    const message = error instanceof Error ? error.message : "Unknown import error";
    await db
      .update(importJobs)
      .set({
        status: options.finalAttempt ? "failed" : "queued",
        error: message,
        completedAt,
        updatedAt: completedAt ?? new Date(),
      })
      .where(eq(importJobs.id, job.id));
    await writeOperationLog({
      scope: "import",
      level: options.finalAttempt ? "error" : "warning",
      message: options.finalAttempt
        ? `历史导入失败：${filename}`
        : `历史导入将重试：${filename}`,
      status: options.finalAttempt ? "failed" : "queued",
      entityType: "import_job",
      entityId: job.id,
      metadata: { filename, error: message },
    });
    if (options.finalAttempt) {
      await moveArchive(path, config.IMPORT_FAILED, filename).catch(() => undefined);
    }
    throw error;
  }
  await moveArchive(path, config.IMPORT_PROCESSED, filename, { missingOk: true }).catch(
    () => undefined,
  );
}

export async function scanImportInbox(): Promise<number> {
  await mkdir(config.IMPORT_INBOX, { recursive: true });
  await recoverStaleImportJobs({ requeue: false });
  const files = (await readdir(config.IMPORT_INBOX, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".zip"))
    .map((entry) => join(config.IMPORT_INBOX, entry.name));
  let queued = 0;
  for (const path of files) {
    const filename = basename(path);
    const [existing] = await db
      .select({ status: importJobs.status, updatedAt: importJobs.updatedAt })
      .from(importJobs)
      .where(eq(importJobs.filename, filename))
      .limit(1);
    if (existing?.status === "completed") {
      continue;
    }
    if (
      existing?.status === "processing" &&
      existing.updatedAt >= processingStaleBefore()
    ) {
      continue;
    }
    if (await enqueueImport(path)) queued += 1;
  }
  return queued;
}
