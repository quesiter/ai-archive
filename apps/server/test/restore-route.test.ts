import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  retryRestoreJob: vi.fn(),
  enqueueRestoreBackup: vi.fn(),
}));

vi.mock("../src/http.js", () => ({
  requireWebUser: vi.fn(async () => true),
}));

vi.mock("../src/db.js", () => ({
  db: {},
}));

vi.mock("../src/services/backup.js", () => ({
  MAX_BACKUP_COMPRESSED_BYTES: 512 * 1024 * 1024,
  createBackupArchiveStream: vi.fn(),
  verifyBackupArchive: vi.fn(),
}));

vi.mock("../src/services/operation-log.js", () => ({
  safeStoredError: vi.fn((error: unknown) => String(error)),
  writeOperationLog: vi.fn(async () => undefined),
}));

vi.mock("../src/services/queue.js", () => ({
  enqueueRestoreBackup: mocks.enqueueRestoreBackup,
}));

vi.mock("../src/services/restore.js", () => ({
  cancelRestoreJob: vi.fn(),
  createRestoreUpload: vi.fn(),
  deleteFailedRestoreStagedFile: vi.fn(),
  discardRestoreUpload: vi.fn(),
  failRestoreUpload: vi.fn(),
  getRestoreJob: vi.fn(),
  listRestoreJobs: vi.fn(),
  retryRestoreJob: mocks.retryRestoreJob,
  toPublicRestoreJob: vi.fn(),
}));

import { backupRoutes } from "../src/routes/backups.js";

describe("restore retry route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requeues post-commit recovery work instead of rejecting it", async () => {
    mocks.retryRestoreJob.mockResolvedValue("recovery_required");
    mocks.enqueueRestoreBackup.mockResolvedValue("queue-job-id");
    const app = Fastify();
    await backupRoutes(app);
    try {
      const restoreJobId = "00000000-0000-4000-8000-000000000001";
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/backups/restores/${restoreJobId}/retry`,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        restoreJobId,
        queueJobId: "queue-job-id",
        status: "recovery_required",
      });
      expect(mocks.enqueueRestoreBackup).toHaveBeenCalledWith(restoreJobId);
    } finally {
      await app.close();
    }
  });
});
