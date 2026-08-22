import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createBackgroundTask: vi.fn(),
  failBackgroundTask: vi.fn(),
  failStaleBackgroundTasks: vi.fn(),
  getBackgroundTask: vi.fn(),
  getLatestBackgroundTask: vi.fn(),
  enqueueNightlyAiMaintenance: vi.fn(),
  enqueueUnlockedReclassification: vi.fn(),
}));

vi.mock("../src/services/background-tasks.js", () => ({
  createBackgroundTask: mocks.createBackgroundTask,
  failBackgroundTask: mocks.failBackgroundTask,
  failStaleBackgroundTasks: mocks.failStaleBackgroundTasks,
  getBackgroundTask: mocks.getBackgroundTask,
  getLatestBackgroundTask: mocks.getLatestBackgroundTask,
}));

vi.mock("../src/services/operation-log.js", () => ({
  writeOperationLog: vi.fn(),
}));

vi.mock("../src/services/queue.js", () => ({
  enqueueNightlyAiMaintenance: mocks.enqueueNightlyAiMaintenance,
  enqueueUnlockedReclassification: mocks.enqueueUnlockedReclassification,
}));

beforeEach(() => {
  vi.resetModules();
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.failStaleBackgroundTasks.mockResolvedValue([]);
  mocks.failBackgroundTask.mockResolvedValue(null);
});

describe("ensureOrganizationTask", () => {
  it("reuses an active tracked task instead of queuing duplicate work", async () => {
    mocks.getLatestBackgroundTask.mockResolvedValue({ id: "active-task", status: "running" });

    const { ensureOrganizationTask } = await import("../src/services/nightly-ai.js");
    const taskId = await ensureOrganizationTask("自动整理");

    expect(taskId).toBe("active-task");
    expect(mocks.createBackgroundTask).not.toHaveBeenCalled();
    expect(mocks.enqueueUnlockedReclassification).not.toHaveBeenCalled();
  });

  it("creates a tracked incremental job when no organization task is active", async () => {
    mocks.getLatestBackgroundTask.mockResolvedValue(null);
    mocks.createBackgroundTask.mockResolvedValue({ id: "new-task" });
    mocks.enqueueUnlockedReclassification.mockResolvedValue("job-id");

    const { ensureOrganizationTask } = await import("../src/services/nightly-ai.js");
    const taskId = await ensureOrganizationTask("自动整理");

    expect(taskId).toBe("new-task");
    expect(mocks.createBackgroundTask).toHaveBeenCalledWith(
      "classification_rebuild",
      "自动整理",
    );
    expect(mocks.enqueueUnlockedReclassification).toHaveBeenCalledWith({
      taskId: "new-task",
      mode: "economy",
      scope: "incremental",
    });
  });
});
