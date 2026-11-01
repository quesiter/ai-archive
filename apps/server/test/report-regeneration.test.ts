import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { analysisRuns, reports } from "../src/schema.js";

type RunRow = {
  id: string;
  kind: string;
  windowStart: Date;
  windowEnd: Date;
  status: string;
  stats: Record<string, unknown>;
  updatedAt: Date;
  completedAt: Date | null;
  error: string | null;
};
type ReportRow = { id: string; kind: string; periodStart: Date; periodEnd: Date; bodyMarkdown: string; emailStatus: string };
type Query = { operation: string; table: unknown; where?: unknown; lock?: string; values?: Record<string, unknown> };

const mocks = vi.hoisted(() => ({
  run: null as RunRow | null,
  report: null as ReportRow | null,
  queries: [] as Query[],
  transactionGate: Promise.resolve(),
  enqueueAnalysis: vi.fn(),
  writeOperationLog: vi.fn(),
}));

vi.mock("../src/db.js", async () => {
  const tables = await import("../src/schema.js");
  const db = {
    select: () => ({ from: (table: unknown) => {
      const entry: Query = { operation: "select", table };
      mocks.queries.push(entry);
      return { where: (where: unknown) => {
        entry.where = where;
        return { for: async (lock: string) => {
          entry.lock = lock;
          const row = table === tables.reports ? mocks.report : mocks.run;
          return row ? [structuredClone(row)] : [];
        } };
      } };
    } }),
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => {
      const entry: Query = { operation: "update", table, values };
      mocks.queries.push(entry);
      return { where: (where: unknown) => {
        entry.where = where;
        const execute = async () => {
          if (table === tables.analysisRuns && mocks.run) mocks.run = { ...mocks.run, ...structuredClone(values) };
          return mocks.run ? [structuredClone(mocks.run)] : [];
        };
        return { returning: execute, then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => execute().then(resolve, reject) };
      } };
    } }),
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
      mocks.queries.push({ operation: "insert", table, values });
      return { returning: async () => {
        mocks.run = { id: "inserted-run", ...structuredClone(values) } as RunRow;
        return [structuredClone(mocks.run)];
      } };
    } }),
  };
  return { db: { ...db, transaction: async (run: (tx: typeof db) => unknown) => {
    const previous = mocks.transactionGate;
    let release!: () => void;
    mocks.transactionGate = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await run(db); } finally { release(); }
  } } };
});

vi.mock("../src/services/queue.js", () => ({ enqueueAnalysis: mocks.enqueueAnalysis }));
vi.mock("../src/services/operation-log.js", () => ({
  safeStoredError: (error: unknown) => error instanceof Error ? error.message : String(error),
  writeOperationLog: mocks.writeOperationLog,
}));

import { queueReportRegeneration, ReportRegenerationQueueError } from "../src/services/report-regeneration.js";

const periodStart = new Date("2026-09-06T16:00:00Z");
const periodEnd = new Date("2026-09-13T16:00:00Z");
function existingRun(status = "completed"): RunRow {
  return {
    id: "original-run", kind: "weekly", windowStart: periodStart, windowEnd: periodEnd,
    status, stats: { generationId: "previous-generation", reportId: "original-report", responseDiagnostics: [{ content: "...", status: "accepted" }] },
    updatedAt: new Date("2026-09-14T00:00:00Z"), completedAt: new Date("2026-09-14T00:00:00Z"), error: null,
  };
}

beforeEach(() => {
  mocks.run = existingRun();
  mocks.report = { id: "original-report", kind: "weekly", periodStart, periodEnd, bodyMarkdown: "Previously stored report body", emailStatus: "sent" };
  mocks.queries = [];
  mocks.transactionGate = Promise.resolve();
  mocks.enqueueAnalysis.mockReset().mockResolvedValue("queued-job");
  mocks.writeOperationLog.mockReset().mockResolvedValue(undefined);
});

describe("report regeneration queue", () => {
  it.each(["queued", "running"])("reuses a %s generation without enqueueing or altering the report", async (status) => {
    mocks.run = existingRun(status);
    const original = structuredClone(mocks.report);
    const result = await queueReportRegeneration("original-report");
    expect(result).toMatchObject({ alreadyActive: true, jobId: null, run: { id: "original-run", status } });
    expect(mocks.enqueueAnalysis).not.toHaveBeenCalled();
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
    expect(mocks.report).toEqual(original);
    expect(mocks.queries.filter((query) => query.operation === "select").every((query) => query.lock === "update")).toBe(true);
  });

  it("serializes concurrent requests so only one generation is enqueued", async () => {
    const results = await Promise.all([queueReportRegeneration("original-report"), queueReportRegeneration("original-report")]);
    expect(results.map((result) => result?.alreadyActive).sort()).toEqual([false, true]);
    expect(mocks.enqueueAnalysis).toHaveBeenCalledTimes(1);
    expect(mocks.queries.filter((query) => query.operation === "update")).toHaveLength(1);
    expect(results[0]?.run.stats.generationId).toBe(results[1]?.run.stats.generationId);
  });

  it("keeps the original report period and run ID, disables resend, and retains previous diagnostics", async () => {
    const result = await queueReportRegeneration("original-report");
    const generationId = result?.run.stats.generationId;
    expect(generationId).toEqual(expect.any(String));
    expect(generationId).not.toBe("previous-generation");
    expect(result?.run).toMatchObject({
      id: "original-run", windowStart: periodStart, windowEnd: periodEnd, status: "queued", completedAt: null, error: null,
      stats: { sendEmail: false, regeneratingReportId: "original-report", responseDiagnostics: [], previousGeneration: {
        generationId: "previous-generation", status: "completed", responseDiagnostics: [{ content: "...", status: "accepted" }],
      } },
    });
    expect(mocks.enqueueAnalysis).toHaveBeenCalledWith("weekly", undefined, { runId: "original-run", generationId });
    const runLookup = mocks.queries.find((query) => query.operation === "select" && query.table === analysisRuns)!;
    const lookup = new PgDialect().sqlToQuery(runLookup.where as never);
    expect(lookup.params).toEqual(["weekly", periodStart.toISOString(), periodEnd.toISOString()]);
    expect(mocks.queries.some((query) => query.table === reports && query.operation !== "select")).toBe(false);
  });

  it("creates a missing run for the report's stored historical window", async () => {
    mocks.run = null;
    const result = await queueReportRegeneration("original-report");
    expect(result?.run).toMatchObject({ id: "inserted-run", kind: "weekly", windowStart: periodStart, windowEnd: periodEnd, stats: { sendEmail: false } });
    expect(mocks.enqueueAnalysis).toHaveBeenCalledWith("weekly", undefined, expect.objectContaining({ runId: "inserted-run" }));
  });

  it.each(["throw", "null"])("marks only the queued generation failed when enqueue returns %s and preserves the report", async (mode) => {
    if (mode === "throw") mocks.enqueueAnalysis.mockRejectedValue(new Error("queue unavailable"));
    else mocks.enqueueAnalysis.mockResolvedValue(null);
    const original = structuredClone(mocks.report);
    await expect(queueReportRegeneration("original-report")).rejects.toBeInstanceOf(ReportRegenerationQueueError);
    expect(mocks.run).toMatchObject({ status: "failed", completedAt: expect.any(Date), stats: { sendEmail: false, regeneratingReportId: "original-report" } });
    expect(mocks.report).toEqual(original);
    expect(mocks.queries.some((query) => query.table === reports && query.operation !== "select")).toBe(false);
    const failedWrite = mocks.queries.find((query) => query.values?.status === "failed")!;
    const guarded = new PgDialect().sqlToQuery(failedWrite.where as never);
    expect(guarded.sql).toContain("->>'generationId'");
    expect(guarded.params).toEqual(["original-run", "queued", mocks.run?.stats.generationId]);
  });

  it("does not create a generation for an unknown report", async () => {
    mocks.report = null;
    await expect(queueReportRegeneration("missing-report")).resolves.toBeNull();
    expect(mocks.enqueueAnalysis).not.toHaveBeenCalled();
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
  });
});
