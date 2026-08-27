import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { count, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireWebUser } from "../http.js";
import {
  cleanupImportArchives,
  recoverStaleImportJobs,
} from "../jobs/import-job.js";
import { importJobs } from "../schema.js";
import { writeOperationLog } from "../services/operation-log.js";
import { enqueueImport } from "../services/queue.js";

const MAX_IMPORT_ARCHIVE_BYTES = 512 * 1024 * 1024;

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/imports", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    await recoverStaleImportJobs({ requeue: true });
    const [[totalRow], items] = await Promise.all([
      db.select({ total: count() }).from(importJobs),
      db
        .select()
        .from(importJobs)
        .orderBy(desc(importJobs.createdAt))
        .limit(query.limit)
        .offset(query.offset),
    ]);
    const total = Number(totalRow?.total ?? 0);
    return {
      items,
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + items.length < total,
      },
    };
  });

  app.post("/api/v1/imports", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const part = await request.file({ limits: { fileSize: MAX_IMPORT_ARCHIVE_BYTES } });
    if (!part) return reply.code(400).send({ error: "ZIP file is required" });
    if (extname(part.filename).toLowerCase() !== ".zip") {
      return reply.code(400).send({ error: "Only ZIP archives are accepted" });
    }
    await mkdir(config.IMPORT_INBOX, { recursive: true });
    const safeName = `${Date.now()}-${randomUUID()}-${basename(part.filename).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const path = join(config.IMPORT_INBOX, safeName);
    try {
      await pipeline(
        part.file,
        (await import("node:fs")).createWriteStream(path, { flags: "wx" }),
      );
    } catch (error) {
      await unlink(path).catch(() => undefined);
      throw error;
    }
    const hash = await fileSha256(path);
    const existing = await db
      .select()
      .from(importJobs)
      .where(eq(importJobs.fileHash, hash))
      .limit(1);
    if (existing[0]) {
      if (existing[0].status === "failed" || existing[0].status === "partial") {
        await unlink(join(config.IMPORT_FAILED, existing[0].filename)).catch(() => undefined);
        const retryAt = new Date();
        const [job] = await db
          .update(importJobs)
          .set({
            filename: safeName,
            status: "queued",
            error: null,
            completedAt: null,
            lastRetryAt: retryAt,
            stats: {
              ...(existing[0].stats ?? {}),
              stage: "queued",
              retryReason: "same_hash_reupload",
            },
            updatedAt: retryAt,
          })
          .where(eq(importJobs.id, existing[0].id))
          .returning();
        const jobId = await enqueueImport(path);
        if (!jobId) {
          await mkdir(config.IMPORT_FAILED, { recursive: true });
          await rename(path, join(config.IMPORT_FAILED, safeName)).catch(() => undefined);
          await db.update(importJobs).set({
            status: "failed",
            error: "Import retry did not enter the queue",
            completedAt: new Date(),
            updatedAt: new Date(),
          }).where(eq(importJobs.id, existing[0].id));
          return reply.code(503).send({ error: "Failed to queue import retry" });
        }
        await writeOperationLog({
          scope: "import",
          message: `失败归档重新上传并已入队：${part.filename}`,
          status: "queued",
          entityType: "import_job",
          entityId: existing[0].id,
          metadata: { filename: safeName, fileHash: hash, jobId },
        });
        return reply.code(202).send({ duplicate: false, retried: true, job });
      }
      await unlink(path).catch(() => undefined);
      await writeOperationLog({
        scope: "import",
        message: `重复导入已跳过：${part.filename}`,
        status: existing[0].status,
        entityType: "import_job",
        entityId: existing[0].id,
        metadata: { filename: part.filename, fileHash: hash },
      });
      return reply.code(200).send({ duplicate: true, job: existing[0] });
    }
    const [job] = await db
      .insert(importJobs)
      .values({ filename: safeName, fileHash: hash, status: "queued" })
      .returning();
    await writeOperationLog({
      scope: "import",
      message: `历史导入已入队：${part.filename}`,
      status: "queued",
      entityType: "import_job",
      entityId: job?.id ?? null,
      metadata: { filename: safeName, originalFilename: part.filename, fileHash: hash },
    });
    const jobId = await enqueueImport(path);
    if (!jobId) {
      await mkdir(config.IMPORT_FAILED, { recursive: true });
      await rename(path, join(config.IMPORT_FAILED, safeName)).catch(() => undefined);
      await db.update(importJobs).set({
        status: "failed",
        error: "Import job did not enter the queue",
        completedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(importJobs.id, job!.id));
      return reply.code(503).send({ error: "Failed to queue import" });
    }
    return reply.code(202).send({ duplicate: false, job });
  });

  app.post<{ Params: { id: string } }>(
    "/api/v1/imports/:id/retry",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const [job] = await db.select().from(importJobs).where(eq(importJobs.id, params.id)).limit(1);
      if (!job) return reply.code(404).send({ error: "Import job not found" });
      if (job.status !== "failed" && job.status !== "partial") {
        return reply.code(409).send({ error: "Only failed or partial imports can be retried" });
      }
      await mkdir(config.IMPORT_INBOX, { recursive: true });
      const failedPath = join(config.IMPORT_FAILED, job.filename);
      const inboxPath = join(config.IMPORT_INBOX, job.filename);
      try {
        await rename(failedPath, inboxPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return reply.code(409).send({
            error: "The failed ZIP is no longer available; upload it again to retry",
          });
        }
        throw error;
      }
      const retryAt = new Date();
      const [updated] = await db.update(importJobs).set({
        status: "queued",
        error: null,
        completedAt: null,
        lastRetryAt: retryAt,
        stats: { ...(job.stats ?? {}), stage: "queued", retryReason: "manual" },
        updatedAt: retryAt,
      }).where(eq(importJobs.id, job.id)).returning();
      const queueJobId = await enqueueImport(inboxPath);
      if (!queueJobId) {
        await mkdir(config.IMPORT_FAILED, { recursive: true });
        await rename(inboxPath, failedPath).catch(() => undefined);
        await db.update(importJobs).set({
          status: job.status,
          error: "Import retry did not enter the queue",
          completedAt: new Date(),
          updatedAt: new Date(),
        }).where(eq(importJobs.id, job.id));
        return reply.code(503).send({ error: "Failed to queue import retry" });
      }
      await writeOperationLog({
        scope: "import",
        message: `历史导入已手动重试：${job.filename}`,
        status: "queued",
        entityType: "import_job",
        entityId: job.id,
        metadata: { queueJobId, attempt: job.attempt },
      });
      return reply.code(202).send({ job: updated, queueJobId });
    },
  );

  app.post("/api/v1/imports/cleanup", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z.object({
      scope: z.enum(["processed", "failed", "all"]).default("all"),
      includeUnexpired: z.boolean().default(false),
    }).parse(request.body ?? {});
    const result = await cleanupImportArchives(input);
    await writeOperationLog({
      scope: "import",
      message: `导入文件清理完成：${result.processed.files + result.failed.files} 个文件`,
      status: "completed",
      entityType: "import_storage",
      metadata: { ...input, ...result },
    });
    return result;
  });
}
