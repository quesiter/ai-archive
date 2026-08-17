import type { FastifyInstance } from "fastify";
import { requireWebUser } from "../http.js";
import {
  createBackupArchiveStream,
  restoreBackupArchive,
} from "../services/backup.js";
import { writeOperationLog } from "../services/operation-log.js";
import { MAX_BACKUP_COMPRESSED_BYTES } from "../services/backup.js";

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
      request.log.error({ error }, "backup export stream failed");
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

  app.post("/api/v1/backups/import", async (request, reply) => {
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
    const result = await restoreBackupArchive(part.filename, buffer);
    await writeOperationLog({
      scope: "system",
      message: "系统备份已导入",
      status: "completed",
      entityType: "backup",
      entityId: part.filename,
      metadata: {
        filename: part.filename,
        counts: result.counts,
        warnings: result.warnings,
      },
    });
    return reply.code(202).send(result);
  });
}
