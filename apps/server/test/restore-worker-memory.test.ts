import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  job: {} as Record<string, unknown>,
  size: 100,
  readFile: vi.fn(),
  unlink: vi.fn(),
  assertReadMemory: vi.fn(),
  parse: vi.fn(),
  verify: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("node:fs/promises", async (original) => ({
  ...await original<typeof import("node:fs/promises")>(),
  stat: vi.fn(async () => ({ size: mocks.size })),
  readFile: mocks.readFile,
  unlink: mocks.unlink,
}));
vi.mock("../src/db.js", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => [mocks.job] }) }) }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => { Object.assign(mocks.job, values); },
      }),
    }),
  },
}));
vi.mock("../src/config.js", () => ({ config: {} }));
vi.mock("../src/services/backup.js", () => ({
  assertBackupReadMemory: mocks.assertReadMemory,
  parseBackupArchive: mocks.parse,
  verifyParsedBackupArchive: mocks.verify,
  restoreParsedBackupArchive: mocks.restore,
}));
vi.mock("../src/services/archive-integrity.js", () => ({
  checkArchiveIntegrity: vi.fn(async () => ({ ok: true, errors: [] })),
}));
vi.mock("../src/services/operation-log.js", () => ({
  safeStoredError: (error: Error) => error.message,
  writeOperationLog: vi.fn(async () => undefined),
}));
vi.mock("../src/services/search-chunks.js", () => ({
  rebuildConversationSearchChunks: vi.fn(async () => 0),
}));
vi.mock("../src/services/conversation-accumulation.js", () => ({
  consolidateArchiveConversations: vi.fn(async () => undefined),
}));
vi.mock("../src/services/archive-read-models.js", () => ({ backfillArchiveReadModels: vi.fn(async () => 0) }));

import { processRestoreJob } from "../src/services/restore.js";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.size = 100;
  mocks.job = {
    id: "restore-job",
    filename: "backup.json.gz",
    stagedPath: "/staging/restore-job.backup",
    stagedDeletedAt: null,
    status: "queued",
    factsCommittedAt: null,
  };
  mocks.readFile.mockResolvedValue(Buffer.from("archive"));
  mocks.parse.mockResolvedValue({ tables: {} });
  mocks.verify.mockReturnValue({ ok: true });
  mocks.restore.mockImplementation(async () => {
    mocks.job.factsCommittedAt = new Date();
    return { counts: {}, warnings: [] };
  });
});

describe("restore worker memory boundaries", () => {
  it("rejects an unsafe staged file before allocating its Buffer and leaves original facts intact", async () => {
    const failure = new Error("Insufficient memory; increase worker memory and retry");
    mocks.assertReadMemory.mockImplementation(() => { throw failure; });

    await expect(processRestoreJob("restore-job")).rejects.toBe(failure);
    expect(mocks.assertReadMemory).toHaveBeenCalledWith(mocks.size);
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.job).toMatchObject({ status: "failed", factsCommittedAt: null, error: failure.message });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("passes one parsed archive through verification and restoration", async () => {
    const parsed = { tables: { conversations: [] } };
    mocks.parse.mockResolvedValue(parsed);

    await processRestoreJob("restore-job");
    expect(mocks.parse).toHaveBeenCalledExactlyOnceWith("backup.json.gz", Buffer.from("archive"));
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(parsed);
    expect(mocks.restore).toHaveBeenCalledExactlyOnceWith(parsed, expect.objectContaining({ restoreJobId: "restore-job" }));
    expect(mocks.job.status).toBe("completed");
    expect(mocks.unlink).toHaveBeenCalledExactlyOnceWith("/staging/restore-job.backup");
  });

  it("keeps a rejected expanded archive available for retry without entering data replacement", async () => {
    const failure = new Error("Insufficient memory to expand backup");
    mocks.parse.mockRejectedValue(failure);

    await expect(processRestoreJob("restore-job")).rejects.toBe(failure);
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.verify).not.toHaveBeenCalled();
    expect(mocks.job).toMatchObject({ status: "failed", factsCommittedAt: null, stagedDeletedAt: null });
    expect(mocks.unlink).not.toHaveBeenCalled();
  });

  it("resumes committed restores without loading the original archive again", async () => {
    mocks.job.factsCommittedAt = new Date();
    mocks.job.status = "recovery_required";

    await processRestoreJob("restore-job");
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.assertReadMemory).not.toHaveBeenCalled();
    expect(mocks.parse).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.job.status).toBe("completed");
  });
});
