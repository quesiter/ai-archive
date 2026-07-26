import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dbResults: [] as Array<Array<{ status: string; updatedAt: Date }>>,
  enqueueImport: vi.fn<() => Promise<string | null>>(),
}));

vi.mock("../src/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => mocks.dbResults.shift() ?? [],
        }),
      }),
    }),
  },
}));

vi.mock("../src/services/queue.js", () => ({
  enqueueImport: mocks.enqueueImport,
}));

let inbox: string | null = null;
let previousImportInbox: string | undefined;

beforeEach(async () => {
  vi.resetModules();
  inbox = await mkdtemp(join(tmpdir(), "ai-archive-import-inbox-"));
  previousImportInbox = process.env.IMPORT_INBOX;
  process.env.IMPORT_INBOX = inbox;
  mocks.dbResults = [];
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
    mocks.dbResults.push([{ status: "queued", updatedAt: new Date() }]);

    const { scanImportInbox } = await import("../src/jobs/import-job.js");
    const queued = await scanImportInbox();

    expect(queued).toBe(1);
    expect(mocks.enqueueImport).toHaveBeenCalledWith(path);
  });

  it("requeues stale processing files", async () => {
    if (!inbox) throw new Error("Test inbox was not created");
    const path = join(inbox, "stale.zip");
    await writeFile(path, "zip fixture");
    mocks.dbResults.push([
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
    mocks.dbResults.push(
      [{ status: "processing", updatedAt: new Date() }],
      [{ status: "completed", updatedAt: new Date() }],
    );

    const { scanImportInbox } = await import("../src/jobs/import-job.js");
    const queued = await scanImportInbox();

    expect(queued).toBe(0);
    expect(mocks.enqueueImport).not.toHaveBeenCalled();
  });
});
