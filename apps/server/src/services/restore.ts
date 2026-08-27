import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { and, desc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db.js";
import { restoreJobs } from "../schema.js";
import { checkArchiveIntegrity } from "./archive-integrity.js";
import { restoreBackupArchive, verifyBackupArchive, type BackupPhase } from "./backup.js";
import { safeStoredError, writeOperationLog } from "./operation-log.js";
import { rebuildConversationSearchChunks } from "./search-chunks.js";

export const ACTIVE_RESTORE_STATUSES = [
  "restoring",
  "rebuilding_search",
  "verifying",
  "recovery_required",
] as const;

const cancellableStatuses = ["queued", "validating", "validated"] as const;
const resumablePostCommitStatuses = [
  "rebuilding_search",
  "verifying",
  "recovery_required",
] as const;
type RestoreJob = typeof restoreJobs.$inferSelect;

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

async function removeStagedFile(job: Pick<RestoreJob, "id" | "stagedPath">): Promise<number> {
  let bytes = 0;
  try {
    bytes = (await stat(job.stagedPath)).size;
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  try {
    await unlink(job.stagedPath);
  } catch (error) {
    if (!isMissingFileError(error)) throw error;
  }
  await db.update(restoreJobs).set({
    stagedDeletedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(restoreJobs.id, job.id));
  return bytes;
}

function publicRestoreJob(job: RestoreJob) {
  const { stagedPath: _stagedPath, ...publicJob } = job;
  return {
    ...publicJob,
    stagedAvailable: publicJob.stagedDeletedAt === null,
  };
}

export async function createRestoreUpload(filename: string) {
  await mkdir(resolve(config.RESTORE_STAGING), { recursive: true });
  const id = randomUUID();
  const stagedPath = resolve(config.RESTORE_STAGING, `${id}.backup`);
  const [job] = await db.insert(restoreJobs).values({
    id,
    filename,
    stagedPath,
    status: "queued",
    progress: 0,
    phaseMessage: "文件正在上传",
  }).returning();
  if (!job) throw new Error("Failed to create restore job");
  return job;
}

export async function failRestoreUpload(id: string, error: unknown): Promise<void> {
  const job = await getRestoreJob(id);
  const requiresRecovery = Boolean(job?.factsCommittedAt);
  await db.update(restoreJobs).set({
    status: requiresRecovery ? "recovery_required" : "failed",
    error: safeStoredError(error),
    phaseMessage: requiresRecovery
      ? "事实数据已提交，但恢复后处理未入队；系统保持维护模式"
      : "备份上传或入队失败",
    completedAt: requiresRecovery ? null : new Date(),
    updatedAt: new Date(),
  }).where(eq(restoreJobs.id, id));
}

export async function discardRestoreUpload(id: string): Promise<void> {
  const job = await getRestoreJob(id);
  if (job) await removeStagedFile(job);
}

export async function listRestoreJobs(limit = 20) {
  const rows = await db.select().from(restoreJobs)
    .orderBy(desc(restoreJobs.createdAt))
    .limit(limit);
  return rows.map(publicRestoreJob);
}

export async function getRestoreJob(id: string) {
  const [job] = await db.select().from(restoreJobs).where(eq(restoreJobs.id, id)).limit(1);
  return job ?? null;
}

export function toPublicRestoreJob(job: RestoreJob) {
  return publicRestoreJob(job);
}

export async function maintenanceRestoreJob() {
  const [job] = await db.select({
    id: restoreJobs.id,
    status: restoreJobs.status,
    progress: restoreJobs.progress,
    phaseMessage: restoreJobs.phaseMessage,
  }).from(restoreJobs).where(inArray(restoreJobs.status, [...ACTIVE_RESTORE_STATUSES]))
    .orderBy(desc(restoreJobs.updatedAt)).limit(1);
  return job ?? null;
}

export async function cancelRestoreJob(id: string): Promise<boolean> {
  const rows = await db.update(restoreJobs).set({
    status: "cancelled",
    phaseMessage: "恢复已在数据替换前取消",
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(restoreJobs.id, id),
    inArray(restoreJobs.status, [...cancellableStatuses]),
  )).returning();
  const job = rows[0];
  if (job) {
    await removeStagedFile(job).catch(async (error) => {
      await db.update(restoreJobs).set({
        phaseMessage: "恢复已取消；暂存文件清理失败，将由 housekeeping 重试",
        error: safeStoredError(error),
        updatedAt: new Date(),
      }).where(eq(restoreJobs.id, id));
    });
  }
  return rows.length > 0;
}

export type RetryRestoreResult =
  | "queued"
  | "recovery_required"
  | "not_found"
  | "not_failed"
  | "missing_file";

export async function retryRestoreJob(id: string): Promise<RetryRestoreResult> {
  const job = await getRestoreJob(id);
  if (!job) return "not_found";
  if (job.status !== "failed" && job.status !== "recovery_required") return "not_failed";
  if (job.status === "failed") {
    if (job.stagedDeletedAt) return "missing_file";
    try {
      await access(job.stagedPath);
    } catch {
      await db.update(restoreJobs).set({
        stagedDeletedAt: new Date(),
        phaseMessage: "恢复源文件已不存在，请重新上传备份",
        error: "Restore staging file is missing",
        updatedAt: new Date(),
      }).where(and(eq(restoreJobs.id, id), eq(restoreJobs.status, "failed")));
      return "missing_file";
    }
  }
  const nextStatus = job.status === "recovery_required" ? "recovery_required" : "queued";
  const rows = await db.update(restoreJobs).set({
    status: nextStatus,
    progress: job.status === "recovery_required" ? 75 : 0,
    phaseMessage: job.status === "recovery_required"
      ? "等待重新执行检索重建与完整性验证"
      : "等待重新执行",
    error: null,
    startedAt: job.status === "recovery_required" ? job.startedAt : null,
    completedAt: null,
    updatedAt: new Date(),
  }).where(and(
    eq(restoreJobs.id, id),
    eq(restoreJobs.status, job.status),
  )).returning({ id: restoreJobs.id });
  if (!rows.length) return "not_failed";
  return nextStatus;
}

export type DeleteRestoreStagedFileResult =
  | "deleted"
  | "not_found"
  | "not_failed"
  | "already_deleted";

export async function deleteFailedRestoreStagedFile(
  id: string,
): Promise<DeleteRestoreStagedFileResult> {
  const job = await getRestoreJob(id);
  if (!job) return "not_found";
  if (job.status !== "failed") return "not_failed";
  if (job.stagedDeletedAt) return "already_deleted";

  const claimedAt = new Date();
  const [claimed] = await db.update(restoreJobs).set({
    stagedDeletedAt: claimedAt,
    phaseMessage: "失败恢复文件已删除，不能重试；可重新上传备份",
    updatedAt: new Date(),
  }).where(and(
    eq(restoreJobs.id, id),
    eq(restoreJobs.status, "failed"),
    isNull(restoreJobs.stagedDeletedAt),
  )).returning();
  if (!claimed) return "already_deleted";
  try {
    await unlink(claimed.stagedPath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      await db.update(restoreJobs).set({
        stagedDeletedAt: null,
        phaseMessage: "失败恢复文件删除失败，可稍后重试",
        error: safeStoredError(error),
        updatedAt: new Date(),
      }).where(and(
        eq(restoreJobs.id, id),
        eq(restoreJobs.stagedDeletedAt, claimedAt),
      ));
      throw error;
    }
  }
  return "deleted";
}

const phaseMessages: Record<BackupPhase, string> = {
  validating: "正在校验压缩包与备份格式",
  validated: "文件与数据结构校验通过",
  restoring: "正在替换归档业务数据；此阶段不可取消",
  rebuilding_search: "事实数据已提交，正在重建全文检索分块",
  verifying: "正在执行恢复后一致性检查",
};

async function completeRestore(
  job: RestoreJob,
  counts: Record<string, number>,
  warnings: string[],
  integrity: Awaited<ReturnType<typeof checkArchiveIntegrity>>,
): Promise<void> {
  await db.update(restoreJobs).set({
    status: "completed",
    progress: 100,
    phaseMessage: "备份恢复和一致性验证完成",
    counts,
    warnings,
    error: null,
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(restoreJobs.id, job.id));
  await removeStagedFile(job).catch(async (error) => {
    await writeOperationLog({
      scope: "system",
      level: "warning",
      message: "恢复完成，但暂存文件未能立即删除",
      status: "partial",
      entityType: "restore_job",
      entityId: job.id,
      metadata: { error: safeStoredError(error) },
    }).catch(() => undefined);
  });
  await writeOperationLog({
    scope: "system",
    message: "系统备份异步恢复完成",
    status: "completed",
    entityType: "restore_job",
    entityId: job.id,
    metadata: { filename: job.filename, counts, integrity },
  }).catch(() => undefined);
}

async function verifyRestoredArchive(
  job: RestoreJob,
  counts: Record<string, number>,
  warnings: string[],
): Promise<void> {
  await db.update(restoreJobs).set({
    status: "verifying",
    progress: 92,
    phaseMessage: phaseMessages.verifying,
    counts,
    warnings,
    updatedAt: new Date(),
  }).where(eq(restoreJobs.id, job.id));
  const integrity = await checkArchiveIntegrity();
  if (!integrity.ok) {
    throw new Error(
      `Post-restore integrity check failed: ${integrity.errors.slice(0, 5).join("; ")}`,
    );
  }
  await completeRestore(job, counts, warnings, integrity);
}

async function resumePostCommitRestore(job: RestoreJob): Promise<void> {
  await db.update(restoreJobs).set({
    status: "rebuilding_search",
    progress: 75,
    phaseMessage: "事实数据已提交，正在重新构建全文检索分块",
    error: null,
    completedAt: null,
    updatedAt: new Date(),
  }).where(eq(restoreJobs.id, job.id));
  const searchChunkCount = await rebuildConversationSearchChunks();
  const rebuildWarning = `已从恢复后的消息重建 ${searchChunkCount} 个全文检索分块。`;
  const warnings = [...new Set([...(job.warnings ?? []), rebuildWarning])];
  await verifyRestoredArchive(job, job.counts ?? {}, warnings);
}

export function restoreFailureStatus(input: {
  status: string;
  factsCommittedAt: Date | null;
}): "failed" | "recovery_required" {
  return input.factsCommittedAt || resumablePostCommitStatuses.includes(
    input.status as (typeof resumablePostCommitStatuses)[number],
  )
    ? "recovery_required"
    : "failed";
}

export async function processRestoreJob(id: string): Promise<void> {
  const job = await getRestoreJob(id);
  if (!job || job.status === "cancelled" || job.status === "completed") return;
  try {
    if (
      job.factsCommittedAt &&
      resumablePostCommitStatuses.includes(
        job.status as (typeof resumablePostCommitStatuses)[number],
      )
    ) {
      await resumePostCommitRestore(job);
      return;
    }

    await db.update(restoreJobs).set({
      status: "validating",
      progress: 5,
      phaseMessage: phaseMessages.validating,
      startedAt: new Date(),
      factsCommittedAt: null,
      completedAt: null,
      error: null,
      updatedAt: new Date(),
    }).where(eq(restoreJobs.id, id));
    const buffer = await readFile(job.stagedPath);
    const verification = await verifyBackupArchive(job.filename, buffer);
    if (!verification.ok) {
      throw new Error(`Backup verification failed: ${verification.errors.join("; ")}`);
    }
    const current = await getRestoreJob(id);
    if (current?.status === "cancelled") return;
    const result = await restoreBackupArchive(job.filename, buffer, {
      restoreJobId: id,
      onPhase: async (phase, progress) => {
        if (phase === "restoring") {
          const latest = await getRestoreJob(id);
          if (latest?.status === "cancelled") {
            throw Object.assign(new Error("Restore was cancelled before data replacement"), {
              code: "RESTORE_CANCELLED",
            });
          }
        }
        await db.update(restoreJobs).set({
          status: phase,
          progress,
          phaseMessage: phaseMessages[phase],
          updatedAt: new Date(),
        }).where(eq(restoreJobs.id, id));
      },
    });
    await verifyRestoredArchive(job, result.counts, result.warnings);
  } catch (error) {
    const latest = await getRestoreJob(id);
    if (latest?.status === "cancelled") return;
    const message = safeStoredError(error);
    const status = restoreFailureStatus({
      status: latest?.status ?? job.status,
      factsCommittedAt: latest?.factsCommittedAt ?? job.factsCommittedAt,
    });
    await db.update(restoreJobs).set({
      status,
      phaseMessage: status === "recovery_required"
        ? "事实数据已提交，但恢复后处理失败；系统保持维护模式，请重试"
        : "备份恢复在事实数据提交前失败，可保留原文件后重试",
      error: message,
      completedAt: status === "failed" ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(restoreJobs.id, id));
    await writeOperationLog({
      scope: "system",
      level: "error",
      message: status === "recovery_required"
        ? "系统备份事实数据已提交，恢复后处理需要人工重试"
        : "系统备份异步恢复失败",
      status,
      entityType: "restore_job",
      entityId: id,
      metadata: { filename: job.filename, error: message },
    }).catch(() => undefined);
    throw error;
  }
}

export async function failStaleRestoreJobs(): Promise<number> {
  const cutoff = new Date(Date.now() - 12 * 60 * 60_000);
  const preCommitRows = await db.update(restoreJobs).set({
    status: "failed",
    phaseMessage: "Restore Worker 在事实数据提交前超时中断，可重新执行",
    error: "Restore job did not update for 12 hours",
    completedAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    inArray(restoreJobs.status, ["queued", "validating", "validated", "restoring"]),
    isNull(restoreJobs.factsCommittedAt),
    lt(restoreJobs.updatedAt, cutoff),
  )).returning({ id: restoreJobs.id });
  const postCommitRows = await db.update(restoreJobs).set({
    status: "recovery_required",
    phaseMessage: "事实数据已提交，但 Restore Worker 超时中断；系统保持维护模式，请重试",
    error: "Post-commit restore processing did not update for 12 hours",
    completedAt: null,
    updatedAt: new Date(),
  }).where(and(
    or(
      inArray(restoreJobs.status, [...resumablePostCommitStatuses]),
      and(eq(restoreJobs.status, "restoring"), isNull(restoreJobs.completedAt)),
    ),
    lt(restoreJobs.updatedAt, cutoff),
  )).returning({ id: restoreJobs.id });
  return preCommitRows.length + postCommitRows.length;
}

export async function cleanupExpiredRestoreFiles(): Promise<{
  files: number;
  bytes: number;
}> {
  const cutoff = new Date(
    Date.now() - config.RESTORE_FAILED_RETENTION_DAYS * 24 * 60 * 60_000,
  );
  const candidates = await db.select().from(restoreJobs).where(and(
    isNull(restoreJobs.stagedDeletedAt),
    or(
      inArray(restoreJobs.status, ["completed", "cancelled"]),
      and(eq(restoreJobs.status, "failed"), lt(restoreJobs.updatedAt, cutoff)),
    ),
  )).orderBy(restoreJobs.updatedAt).limit(500);

  let files = 0;
  let bytes = 0;
  for (const job of candidates) {
    if (job.status === "failed") {
      const before = await stat(job.stagedPath).catch(() => null);
      const result = await deleteFailedRestoreStagedFile(job.id);
      if (result === "deleted") {
        files += 1;
        bytes += before?.size ?? 0;
      }
      continue;
    }
    try {
      bytes += await removeStagedFile(job);
      files += 1;
    } catch (error) {
      await writeOperationLog({
        scope: "system",
        level: "warning",
        message: "Restore housekeeping 未能删除暂存文件",
        status: "partial",
        entityType: "restore_job",
        entityId: job.id,
        metadata: { error: safeStoredError(error) },
      }).catch(() => undefined);
    }
  }
  return { files, bytes };
}
