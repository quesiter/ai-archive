import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recoverResults: [] as Array<
    Array<{ id: string; filename: string; stats: Record<string, unknown>; updatedAt: Date }>
  >,
  scanResults: [] as Array<Array<{ status: string; updatedAt: Date }>>,
  updateResults: [] as Array<Array<{ id: string }>>,
  updateValues: [] as Array<Record<string, unknown>>,
  liveJobRows: [] as Array<{ path: string }>,
  enqueueImport: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/db.js", () => ({
  sqlClient: vi.fn(async () => mocks.liveJobRows),
  db: {
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => {
          const rows =
            fields && "id" in fields && "filename" in fields
              ? (mocks.recoverResults.shift() ?? [])
              : (mocks.scanResults.shift() ?? []);
          const result = Promise.resolve(rows) as Promise<unknown[]> & {
            limit: () => Promise<unknown[]>;
          };
          result.limit = async () => rows;
          return result;
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateValues.push(values);
        return {
          where: () => ({
            returning: async () => mocks.updateResults.shift() ?? [{ id: "updated" }],
          }),
        };
      },
    }),
  },
}));

vi.mock("../src/services/operation-log.js", () => ({
  writeOperationLog: vi.fn(),
}));

vi.mock("../src/services/queue.js", () => ({
  enqueueImport: mocks.enqueueImport,
  queueNames: { importArchive: "import-archive" },
}));

let inbox: string | null = null;
let previousImportInbox: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  inbox = await mkdtemp(join(tmpdir(), "ai-archive-import-inbox-"));
  previousImportInbox = process.env.IMPORT_INBOX;
  process.env.IMPORT_INBOX = inbox;
  mocks.recoverResults = [];
  mocks.scanResults = [];
  mocks.updateResults = [];
  mocks.updateValues = [];
  mocks.liveJobRows = [];
  mocks.enqueueImport.mockReset();
  mocks.enqueueImport.mockResolvedValue("job-id");
});

afterEach(async () => {
  if (previousImportInbox === undefined) {
    delete process.env.IMPORT_INBOX;
  } else {
    process.env.IMPORT_INBOX = previousImportInbox;
  }
  if (inbox) await rm(inbox, { recursive: true, force: true });
});

describe("scanImportInbox", () => {
  it("requeues imported files that are still marked queued", async () => {
    if (!inbox) throw new Error("Test inbox was not created");
    const path = join(inbox, "pending.zip");
    await writeFile(path, "zip fixture");
    mocks.scanResults.push([{ status: "queued", updatedAt: new Date() }]);

    const { scanImportInbox } = await import("../src/jobs/import-job.js");
    const queued = await scanImportInbox();

    expect(queued).toBe(1);
    expect(mocks.enqueueImport).toHaveBeenCalledWith(path);
  });

  it("requeues stale processing files", async () => {
    if (!inbox) throw new Error("Test inbox was not created");
    const path = join(inbox, "stale.zip");
    await writeFile(path, "zip fixture");
    mocks.scanResults.push([
      {
        status: "processing",
        updatedAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      },
    ]);

    const { scanImportInbox } = await import("../src/jobs/import-job.js");
    const queued = await scanImportInbox();

    expect(queued).toBe(1);
    expect(mocks.enqueueImport).toHaveBeenCalledWith(path);
  });

  it("skips files that are recently processing or completed", async () => {
    if (!inbox) throw new Error("Test inbox was not created");
    await writeFile(join(inbox, "active.zip"), "zip fixture");
    await writeFile(join(inbox, "done.zip"), "zip fixture");
    mocks.scanResults.push(
      [{ status: "processing", updatedAt: new Date() }],
      [{ status: "completed", updatedAt: new Date() }],
    );

    const { scanImportInbox } = await import("../src/jobs/import-job.js");
    const queued = await scanImportInbox();

    expect(queued).toBe(0);
    expect(mocks.enqueueImport).not.toHaveBeenCalled();
  });

  it("recovers orphaned processing imports when the archive is still in the inbox", async () => {
    if (!inbox) throw new Error("Test inbox was not created");
    const path = join(inbox, "orphan.zip");
    await writeFile(path, "zip fixture");
    const updatedAt = new Date(Date.now() - 30 * 60 * 1000);
    mocks.recoverResults.push([
      { id: "import-job-id", filename: "orphan.zip", stats: { stage: "parsing" }, updatedAt },
    ]);

    const { recoverStaleImportJobs } = await import("../src/jobs/import-job.js");
    const result = await recoverStaleImportJobs({ olderThanMs: 1, requeue: true });

    expect(result).toMatchObject({ inspected: 1, recovered: 1, failed: 0 });
    expect(mocks.updateValues[0]).toMatchObject({ status: "queued", error: null });
    expect(mocks.enqueueImport).toHaveBeenCalledWith(path);
  });

  it("does not recover processing imports that still have a live PgBoss job", async () => {
    if (!inbox) throw new Error("Test inbox was not created");
    const path = join(inbox, "active-import.zip");
    await writeFile(path, "zip fixture");
    mocks.liveJobRows = [{ path }];
    mocks.recoverResults.push([
      {
        id: "import-job-id",
        filename: "active-import.zip",
        stats: { stage: "parsing" },
        updatedAt: new Date(Date.now() - 30 * 60 * 1000),
      },
    ]);

    const { recoverStaleImportJobs } = await import("../src/jobs/import-job.js");
    const result = await recoverStaleImportJobs({ olderThanMs: 1, requeue: true });

    expect(result).toMatchObject({ inspected: 1, recovered: 0, skippedActive: 1 });
    expect(mocks.updateValues).toEqual([]);
    expect(mocks.enqueueImport).not.toHaveBeenCalled();
  });
});
