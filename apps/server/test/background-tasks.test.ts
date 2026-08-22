import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  updateRows: [] as unknown[][],
  updateValues: [] as Array<Record<string, unknown>>,
  sqlRows: [] as unknown[][],
  writeOperationLog: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  sqlClient: vi.fn(async () => mocks.sqlRows.shift() ?? []),
  db: {
    select: () => ({
      from: () => ({
        where: async () => mocks.selectRows.shift() ?? [],
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updateValues.push(values);
        return {
          where: () => ({
            returning: async () => mocks.updateRows.shift() ?? [],
          }),
        };
      },
    }),
  },
}));

vi.mock("../src/services/operation-log.js", () => ({
  safeStoredError: (error: unknown) => error instanceof Error ? error.message : String(error),
  writeOperationLog: mocks.writeOperationLog,
}));

const staleUpdatedAt = new Date("2026-08-22T14:00:00.000Z");

function backgroundTask(id: string) {
  return {
    id,
    kind: "classification_rebuild" as const,
    status: "running" as const,
    totalCount: 2_001,
    processedCount: 5,
    succeededCount: 5,
    failedCount: 0,
    message: "项目与标签整理进度 5/2001",
    error: null,
    stats: {},
    completedAt: null,
    updatedAt: staleUpdatedAt,
    createdAt: new Date("2026-08-22T13:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.selectRows = [];
  mocks.updateRows = [];
  mocks.updateValues = [];
  mocks.sqlRows = [];
  mocks.writeOperationLog.mockReset();
});

describe("background task state transitions", () => {
  it("does not fail a stale-looking task while PgBoss still has a live job", async () => {
    mocks.selectRows.push([backgroundTask("live-task")]);
    mocks.sqlRows.push([{ task_id: "live-task" }]);

    const { failStaleBackgroundTasks } = await import(
      "../src/services/background-tasks.js"
    );
    const failed = await failStaleBackgroundTasks("classification_rebuild", 1);

    expect(failed).toEqual([]);
    expect(mocks.updateValues).toEqual([]);
    expect(mocks.writeOperationLog).not.toHaveBeenCalled();
  });

  it("fails an orphaned stale task and logs its actual last heartbeat", async () => {
    const staleTask = backgroundTask("orphan-task");
    mocks.selectRows.push([staleTask]);
    mocks.sqlRows.push([]);
    mocks.updateRows.push([
      {
        ...staleTask,
        status: "failed",
        error: "任务长时间没有进度更新，请重新运行。",
        completedAt: new Date(),
        updatedAt: new Date(),
      },
    ]);

    const { failStaleBackgroundTasks } = await import(
      "../src/services/background-tasks.js"
    );
    const failed = await failStaleBackgroundTasks("classification_rebuild", 1);

    expect(failed).toHaveLength(1);
    expect(mocks.updateValues).toHaveLength(1);
    expect(mocks.updateValues[0]).toMatchObject({ status: "failed" });
    expect(mocks.writeOperationLog).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: "orphan-task",
        metadata: expect.objectContaining({
          staleUpdatedAt: staleUpdatedAt.toISOString(),
        }),
      }),
    );
  });

  it("keeps stale tasks recoverable when PgBoss state cannot be checked", async () => {
    mocks.selectRows.push([backgroundTask("unknown-task")]);
    const { sqlClient } = await import("../src/db.js");
    vi.mocked(sqlClient).mockRejectedValueOnce(new Error("queue unavailable"));

    const { failStaleBackgroundTasks } = await import(
      "../src/services/background-tasks.js"
    );
    const failed = await failStaleBackgroundTasks("classification_rebuild", 1);

    expect(failed).toEqual([]);
    expect(mocks.updateValues).toEqual([]);
  });

  it("clears stale terminal fields when an active task starts or completes", async () => {
    const activeTask = backgroundTask("active-task");
    mocks.updateRows.push(
      [{ ...activeTask, status: "running" }],
      [{ ...activeTask, status: "completed" }],
    );

    const { completeBackgroundTask, startBackgroundTask } = await import(
      "../src/services/background-tasks.js"
    );
    await startBackgroundTask("active-task", 2_001, "正在整理");
    await completeBackgroundTask("active-task", { message: "整理完成" });

    expect(mocks.updateValues[0]).toMatchObject({
      status: "running",
      error: null,
      completedAt: null,
    });
    expect(mocks.updateValues[1]).toMatchObject({
      status: "completed",
      error: null,
    });
  });
});
