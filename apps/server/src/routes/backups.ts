import type { FastifyInstance } from "fastify";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireWebUser } from "../http.js";
import {
  createBackupArchiveStream,
  verifyBackupArchive,
} from "../services/backup.js";
import { writeOperationLog } from "../services/operation-log.js";
import { safeStoredError } from "../services/operation-log.js";
import { MAX_BACKUP_COMPRESSED_BYTES } from "../services/backup.js";
import { restoreJobs } from "../schema.js";
import {
  cancelRestoreJob,
  createRestoreUpload,
  deleteFailedRestoreStagedFile,
  discardRestoreUpload,
  failRestoreUpload,
  getRestoreJob,
  listRestoreJobs,
  retryRestoreJob,
  toPublicRestoreJob,
} from "../services/restore.js";
import { enqueueRestoreBackup } from "../services/queue.js";

async function readFilePart(part: { file: AsyncIterable<Buffer | Uint8Array | string> }): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of part.file) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function backupRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/backups/export", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const archive = await createBackupArchiveStream();
    archive.stream.once("error", (error) => {
      request.log.error(
        { error: safeStoredError(error) },
        "backup export stream failed",
      );
    });
    await writeOperationLog({
      scope: "system",
      message: "系统备份下载已开始",
      status: "completed",
      entityType: "backup",
      entityId: archive.filename,
      metadata: { filename: archive.filename, counts: archive.counts },
    });
    reply
      .header("Content-Type", "application/gzip")
      .header("Content-Disposition", `attachment; filename="${archive.filename}"`)
      .header("Cache-Control", "no-store");
    return reply.send(archive.stream);
  });

  app.post("/api/v1/backups/verify", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const part = await request.file({ limits: { fileSize: MAX_BACKUP_COMPRESSED_BYTES } });
    if (!part) return reply.code(400).send({ error: "Backup file is required" });
    const lowerName = part.filename.toLowerCase();
    if (
      !lowerName.endsWith(".json") &&
      !lowerName.endsWith(".json.gz") &&
      !lowerName.endsWith(".gz")
    ) {
      return reply.code(400).send({ error: "Only .json or .json.gz backup files are accepted" });
    }
    const buffer = await readFilePart(part);
    try {
      return await verifyBackupArchive(part.filename, buffer);
    } catch (error) {
      return reply.code(400).send({ error: safeStoredError(error) });
    }
  });

  app.post("/api/v1/backups/import", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const part = await request.file({ limits: { fileSize: MAX_BACKUP_COMPRESSED_BYTES } });
    if (!part) return reply.code(400).send({ error: "Backup file is required" });
    const lowerName = part.filename.toLowerCase();
    if (!lowerName.endsWith(".json") && !lowerName.endsWith(".json.gz") && !lowerName.endsWith(".gz")) {
      return reply.code(400).send({ error: "Only .json or .json.gz backup files are accepted" });
    }
    const job = await createRestoreUpload(part.filename);
    try {
      await pipeline(part.file, createWriteStream(job.stagedPath, { flags: "wx", mode: 0o600 }));
    } catch (error) {
      await failRestoreUpload(job.id, error);
      await discardRestoreUpload(job.id).catch(() => undefined);
      throw error;
    }
    await db.update(restoreJobs).set({
      phaseMessage: "文件上传完成，等待 Restore Worker",
      updatedAt: new Date(),
    }).where(eq(restoreJobs.id, job.id));
    const queueJobId = await enqueueRestoreBackup(job.id);
    if (!queueJobId) {
      await failRestoreUpload(job.id, new Error("Restore job was not enqueued"));
      return reply.code(503).send({ error: "Restore job was not enqueued", restoreJobId: job.id });
    }
    await writeOperationLog({
      scope: "system",
      message: "系统备份已上传并进入恢复队列",
      status: "queued",
      entityType: "restore_job",
      entityId: job.id,
      metadata: { filename: part.filename, queueJobId },
    });
    return reply.code(202).send({ restoreJobId: job.id, queueJobId, status: "queued" });
  });

  app.get("/api/v1/backups/restores", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return {
      items: await listRestoreJobs(),
      failedRetentionDays: config.RESTORE_FAILED_RETENTION_DAYS,
    };
  });

  app.get<{ Params: { id: string } }>("/api/v1/backups/restores/:id", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const job = await getRestoreJob(id);
    if (!job) return reply.code(404).send({ error: "Restore job not found" });
    return toPublicRestoreJob(job);
  });

  app.delete<{ Params: { id: string } }>("/api/v1/backups/restores/:id", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    if (!(await cancelRestoreJob(id))) {
      return reply.code(409).send({ error: "Restore cannot be cancelled after data replacement starts" });
    }
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/backups/restores/:id/staged-file",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const result = await deleteFailedRestoreStagedFile(id);
      if (result === "not_found") return reply.code(404).send({ error: "Restore job not found" });
      if (result === "not_failed") {
        return reply.code(409).send({ error: "Only pre-commit failed restore files can be deleted" });
      }
      if (result === "already_deleted") {
        return reply.code(410).send({ error: "Restore staging file has already been deleted" });
      }
      await writeOperationLog({
        scope: "system",
        message: "失败恢复任务的暂存文件已删除",
        status: "completed",
        entityType: "restore_job",
        entityId: id,
      });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>("/api/v1/backups/restores/:id/retry", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const retryResult = await retryRestoreJob(id);
    if (retryResult === "not_found") return reply.code(404).send({ error: "Restore job not found" });
    if (retryResult === "missing_file") {
      return reply.code(410).send({ error: "Restore staging file is missing; upload the backup again" });
    }
    if (retryResult !== "queued" && retryResult !== "recovery_required") {
      return reply.code(409).send({
        error: "Only failed or recovery-required restore jobs can be retried",
      });
    }
    const queueJobId = await enqueueRestoreBackup(id);
    if (!queueJobId) {
      await failRestoreUpload(id, new Error("Restore retry was not enqueued"));
      return reply.code(503).send({ error: "Restore retry was not enqueued" });
    }
    return reply.code(202).send({ restoreJobId: id, queueJobId, status: retryResult });
  });
}
