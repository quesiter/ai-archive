import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import { desc, eq } from "drizzle-orm";
import { db } from "../db.js";
import { config } from "../config.js";
import { requireWebUser } from "../http.js";
import { importJobs } from "../schema.js";
import { writeOperationLog } from "../services/operation-log.js";
import { enqueueImport } from "../services/queue.js";

async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export async function importRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/imports", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return db.select().from(importJobs).orderBy(desc(importJobs.createdAt)).limit(100);
  });

  app.post("/api/v1/imports", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const part = await request.file({ limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
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
      .select({ id: importJobs.id, status: importJobs.status })
      .from(importJobs)
      .where(eq(importJobs.fileHash, hash))
      .limit(1);
    if (existing[0]) {
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
    await enqueueImport(path);
    return reply.code(202).send({ duplicate: false, job });
  });
}
