import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

interface BossMock extends EventEmitter {
  start: Mock<() => Promise<void>>;
  createQueue: Mock<(name: string) => Promise<void>>;
  send: Mock<(...args: unknown[]) => Promise<string>>;
  stop: Mock<(options: unknown) => Promise<void>>;
  database: { opened: boolean; close: Mock<() => Promise<void>> };
}

const mocks = vi.hoisted(() => ({
  instances: [] as BossMock[],
  configure: null as ((boss: BossMock) => void) | null,
}));

vi.mock("pg-boss", () => ({
  default: class MockPgBoss extends EventEmitter {
    database = {
      opened: false,
      close: vi.fn(async () => { this.database.opened = false; }),
    };
    start = vi.fn(async () => { this.database.opened = true; });
    createQueue = vi.fn(async (_name: string) => undefined);
    send = vi.fn(async (..._args: unknown[]) => "job-id");
    stop = vi.fn(async (_options: unknown) => { await this.database.close(); });
    getDb() { return this.database; }
    constructor() {
      super();
      mocks.instances.push(this);
      mocks.configure?.(this);
    }
  },
}));

vi.mock("../src/config.js", () => ({ config: { DATABASE_URL: "postgres://test" } }));
vi.mock("../src/services/llm.js", () => ({ AI_RATE_LIMIT_RETRY_DELAY_MS: 60_000 }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetModules();
  mocks.instances = [];
  mocks.configure = null;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("queue connection recovery", () => {
  it("handles asynchronous client errors without exposing credentials in logs", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { getBoss, stopBoss } = await import("../src/services/queue.js");
    await getBoss();

    expect(() => mocks.instances[0]!.emit("error", new Error("failed postgres://user:private-password@db/archive"))).not.toThrow();
    expect(warn).toHaveBeenCalledWith("Queue client error:", "failed [DATABASE_URL]");
    await stopBoss();
  });

  it("retries a failed start after recovery and closes the pool pg-boss stop leaves open", async () => {
    const failure = new Error("database temporarily unavailable");
    mocks.configure = (boss) => {
      if (mocks.instances.length !== 1) return;
      boss.start.mockImplementation(async () => {
        boss.database.opened = true;
        throw failure;
      });
      boss.stop.mockResolvedValue(undefined);
    };
    const { enqueueReportEmail, stopBoss } = await import("../src/services/queue.js");

    await expect(enqueueReportEmail("report-1")).rejects.toBe(failure);
    expect(mocks.instances[0]!.stop).toHaveBeenCalledWith({ graceful: false, timeout: 10_000 });
    expect(mocks.instances[0]!.database.close).toHaveBeenCalledOnce();
    await expect(enqueueReportEmail("report-1")).resolves.toBe("job-id");
    expect(mocks.instances).toHaveLength(2);
    expect(mocks.instances[1]!.send).toHaveBeenCalled();
    await stopBoss();
  });

  it("retries queue registration failure and releases the partially initialized client", async () => {
    const failure = new Error("connection lost while creating queue");
    mocks.configure = (boss) => {
      if (mocks.instances.length === 1) boss.createQueue.mockRejectedValueOnce(failure);
    };
    const { getBoss, queueNames, stopBoss } = await import("../src/services/queue.js");

    await expect(getBoss()).rejects.toBe(failure);
    expect(mocks.instances[0]!.stop).toHaveBeenCalledOnce();
    expect(mocks.instances[0]!.database.opened).toBe(false);
    const recovered = await getBoss();
    expect(recovered).toBe(mocks.instances[1]);
    expect(mocks.instances[1]!.createQueue.mock.calls.map(([name]) => name)).toEqual(Object.values(queueNames));
    await stopBoss();
  });

  it("shares one initialization between concurrent callers and caches the ready client", async () => {
    const starting = deferred();
    mocks.configure = (boss) => { boss.start.mockReturnValue(starting.promise); };
    const { getBoss, stopBoss } = await import("../src/services/queue.js");
    const first = getBoss();
    const second = getBoss();

    expect(second).toBe(first);
    await Promise.resolve();
    expect(mocks.instances).toHaveLength(1);
    starting.resolve();
    const [one, two] = await Promise.all([first, second]);
    expect(one).toBe(two);
    expect(await getBoss()).toBe(one);
    expect(mocks.instances[0]!.start).toHaveBeenCalledOnce();
    await stopBoss();
  });

  it("shares failed initialization and waits for abandoned-client cleanup before retrying", async () => {
    const cleaning = deferred();
    const failure = new Error("database unavailable");
    mocks.configure = (boss) => {
      if (mocks.instances.length !== 1) return;
      boss.start.mockRejectedValue(failure);
      boss.stop.mockReturnValue(cleaning.promise);
    };
    const { getBoss, stopBoss } = await import("../src/services/queue.js");
    const first = getBoss();
    const firstResult = expect(first).rejects.toBe(failure);
    await vi.waitFor(() => expect(mocks.instances[0]!.stop).toHaveBeenCalledOnce());
    const second = getBoss();
    const secondResult = expect(second).rejects.toBe(failure);
    expect(second).toBe(first);
    expect(mocks.instances).toHaveLength(1);

    cleaning.resolve();
    await Promise.all([firstResult, secondResult]);
    await getBoss();
    expect(mocks.instances).toHaveLength(2);
    await stopBoss();
  });

  it("preserves the initialization error when cleanup fails and still permits retry", async () => {
    const failure = new Error("database unavailable");
    mocks.configure = (boss) => {
      if (mocks.instances.length !== 1) return;
      boss.start.mockImplementation(async () => {
        boss.database.opened = true;
        throw failure;
      });
      boss.stop.mockRejectedValue(new Error("stop failed"));
      boss.database.close.mockRejectedValue(new Error("close failed"));
    };
    const { getBoss, stopBoss } = await import("../src/services/queue.js");

    await expect(getBoss()).rejects.toBe(failure);
    expect(mocks.instances[0]!.database.close).toHaveBeenCalledOnce();
    await expect(stopBoss()).resolves.toBeUndefined();
    await getBoss();
    expect(mocks.instances).toHaveLength(2);
    await stopBoss();
  });
});

describe("queue shutdown", () => {
  it("does not initialize a client when there is nothing to stop", async () => {
    const { stopBoss } = await import("../src/services/queue.js");
    await stopBoss();
    expect(mocks.instances).toEqual([]);
  });

  it("waits for initialization before stopping and shares concurrent shutdown", async () => {
    const starting = deferred();
    mocks.configure = (boss) => { boss.start.mockReturnValue(starting.promise); };
    const { getBoss, stopBoss } = await import("../src/services/queue.js");
    const connection = getBoss();
    const firstStop = stopBoss();
    const secondStop = stopBoss();
    expect(secondStop).toBe(firstStop);

    starting.resolve();
    await Promise.all([connection, firstStop, secondStop]);
    expect(mocks.instances[0]!.stop).toHaveBeenCalledExactlyOnceWith({ graceful: true, timeout: 10_000 });
    await getBoss();
    expect(mocks.instances).toHaveLength(2);
    await stopBoss();
  });

  it("finishes shutdown when in-flight initialization fails", async () => {
    const failure = new Error("startup failed");
    mocks.configure = (boss) => { boss.start.mockRejectedValue(failure); };
    const { getBoss, stopBoss } = await import("../src/services/queue.js");
    const connection = getBoss();
    const result = expect(connection).rejects.toBe(failure);

    await expect(stopBoss()).resolves.toBeUndefined();
    await result;
    expect(mocks.instances[0]!.stop).toHaveBeenCalledExactlyOnceWith({ graceful: false, timeout: 10_000 });
  });

  it("prevents a new client from overlapping shutdown and lets waiting callers share recovery", async () => {
    const stopping = deferred();
    const { getBoss, stopBoss } = await import("../src/services/queue.js");
    const old = await getBoss();
    mocks.instances[0]!.stop.mockReturnValue(stopping.promise);
    const shutdown = stopBoss();
    const first = getBoss();
    const second = getBoss();
    await Promise.resolve();
    expect(mocks.instances).toHaveLength(1);

    stopping.resolve();
    await shutdown;
    const [one, two] = await Promise.all([first, second]);
    expect(one).not.toBe(old);
    expect(one).toBe(two);
    expect(mocks.instances).toHaveLength(2);
    await stopBoss();
  });

  it("closes the owned pool after stop failure and releases the stale client", async () => {
    const failure = new Error("stop failed");
    const { getBoss, stopBoss } = await import("../src/services/queue.js");
    await getBoss();
    mocks.instances[0]!.stop.mockRejectedValue(failure);
    const stopping = stopBoss();
    const result = expect(stopping).rejects.toBe(failure);
    const recovering = getBoss();

    await result;
    expect(mocks.instances[0]!.database.close).toHaveBeenCalledOnce();
    await recovering;
    expect(mocks.instances).toHaveLength(2);
    await stopBoss();
  });
});
