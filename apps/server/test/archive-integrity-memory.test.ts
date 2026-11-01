import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadBatch: vi.fn(),
  loadOne: vi.fn(),
}));

vi.mock("../src/services/revision-storage.js", () => ({
  loadCaptureRevisionMessagesBatch: mocks.loadBatch,
  loadCaptureRevisionMessages: mocks.loadOne,
}));

vi.mock("../src/services/capture.js", () => ({
  contentIntegrityHash: vi.fn(() => "hash"),
  storedTokenUsage: vi.fn(() => null),
}));

vi.mock("../src/services/background-tasks.js", () => ({
  completeBackgroundTask: vi.fn(),
  failBackgroundTask: vi.fn(),
  startBackgroundTask: vi.fn(),
  updateBackgroundTask: vi.fn(),
}));

vi.mock("../src/services/operation-log.js", () => ({
  safeStoredError: (error: unknown) => String(error),
}));

const revisions = ["r1", "r2", "r3"].map((id) => ({
  id,
  conversationId: "conversation",
  storageKind: "snapshot",
  baseRevisionId: null,
  contentIntegrityHash: null,
}));

const tx = {
  select: vi.fn(),
  execute: vi.fn(),
};

vi.mock("../src/db.js", () => ({
  db: {
    transaction: vi.fn(async (callback: (executor: typeof tx) => unknown) => callback(tx)),
  },
}));

beforeEach(() => {
  vi.resetModules();
  tx.select.mockReset();
  tx.execute.mockReset();
  tx.select
    .mockReturnValueOnce({
      from: () => Promise.resolve([{
        id: "conversation",
        provider: "chatgpt",
        externalSessionId: "session",
      }]),
    })
    .mockReturnValueOnce({
      from: () => ({ orderBy: () => Promise.resolve(revisions) }),
    });
  tx.execute
    .mockResolvedValueOnce([{ messages: 0, segments: 0, chunks: 0 }])
    .mockResolvedValueOnce([{ orphan_rows: 0, missing_search_chunks: 0 }]);
  mocks.loadBatch.mockReset();
  mocks.loadBatch.mockImplementation(async (ids: string[]) =>
    new Map(ids.map((id) => [id, []])),
  );
  mocks.loadOne.mockReset();
});

describe("archive integrity memory bounds", () => {
  it("hydrates only one revision at a time and reports progress after each one", async () => {
    const progress = vi.fn(async () => undefined);
    const { checkArchiveIntegrity } = await import(
      "../src/services/archive-integrity.js"
    );

    const result = await checkArchiveIntegrity(progress);

    expect(mocks.loadBatch.mock.calls.map(([ids]) => ids)).toEqual([
      ["r1"],
      ["r2"],
      ["r3"],
    ]);
    expect(progress.mock.calls).toEqual([[1, 3], [2, 3], [3, 3]]);
    expect(result).toMatchObject({ ok: true, revisions: 3 });
  });
});
