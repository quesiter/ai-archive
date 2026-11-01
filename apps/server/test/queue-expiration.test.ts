import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(async () => undefined),
  createQueue: vi.fn(async () => undefined),
  send: vi.fn(async () => "job-id"),
}));

vi.mock("pg-boss", () => ({
  default: class MockPgBoss {
    on() { return this; }
    start = mocks.start;
    createQueue = mocks.createQueue;
    send = mocks.send;
  },
}));

vi.mock("../src/config.js", () => ({
  config: { DATABASE_URL: "postgres://test" },
}));

vi.mock("../src/services/llm.js", () => ({
  AI_RATE_LIMIT_RETRY_DELAY_MS: 60_000,
}));

beforeEach(() => {
  vi.resetModules();
  mocks.start.mockClear();
  mocks.createQueue.mockClear();
  mocks.send.mockClear();
});

describe("queue expiration limits", () => {
  it("keeps nightly maintenance below pg-boss's 24-hour ceiling", async () => {
    const { enqueueNightlyAiMaintenance, queueNames } = await import(
      "../src/services/queue.js"
    );

    await enqueueNightlyAiMaintenance({
      runKey: "2026-09-19",
      stage: "classification",
    });

    expect(mocks.send).toHaveBeenCalledWith(
      queueNames.nightlyAiMaintenance,
      expect.objectContaining({ runKey: "2026-09-19" }),
      expect.objectContaining({ expireInHours: 23 }),
    );
  });
});
