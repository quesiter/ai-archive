import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { analysisRuns, captureRuns, reports } from "../src/schema.js";

type RunRow = { id: string; kind: "weekly"; status: string; windowStart: Date; windowEnd: Date; stats: Record<string, unknown>; updatedAt: Date; completedAt: Date | null; error: string | null };
type ReportRow = { id: string; kind: string; periodStart: Date; periodEnd: Date; title: string; summary: string; bodyMarkdown: string; emailStatus: string };
type Query = { operation: string; table?: unknown; fields?: Record<string, unknown>; where?: unknown; values?: Record<string, unknown>; transaction: boolean };
const mocks = vi.hoisted(() => ({
  run: null as RunRow | null,
  report: null as ReportRow | null,
  queries: [] as Query[],
  transactionActive: false,
  failCompletedWrite: false,
  claimAvailable: true,
  create: vi.fn(),
  loadArchive: vi.fn(),
  enqueueAnalysis: vi.fn(),
  enqueueReportEmail: vi.fn(),
  writeOperationLog: vi.fn(),
  queueSend: vi.fn(),
}));

vi.mock("../src/db.js", async () => {
  const tables = await import("../src/schema.js");
  const { sql } = await import("drizzle-orm");
  const { PgDialect: TestDialect } = await import("drizzle-orm/pg-core");
  const passesStaleGuard = (where: unknown): boolean => {
    if (!where || mocks.run?.status !== "running") return true;
    const query = new TestDialect().sqlToQuery(where as never);
    const comparison = /"analysis_runs"\."updated_at" < \$(\d+)/.exec(query.sql);
    if (!comparison) return true;
    const cutoff = new Date(String(query.params[Number(comparison[1]) - 1]));
    return mocks.run.updatedAt < cutoff;
  };
  const db = {
    select: (fields?: Record<string, unknown>) => {
      const entry: Query = { operation: "select", transaction: mocks.transactionActive, ...(fields ? { fields } : {}) };
      mocks.queries.push(entry);
      const execute = async () => {
        if (entry.table === tables.analysisRuns) return mocks.run && passesStaleGuard(entry.where) ? [structuredClone(mocks.run)] : [];
        if (entry.table === tables.captureRuns) return [{ conversationId: "conversation-1", capturedAt: new Date("2026-09-09T00:00:00Z") }];
        if (entry.table === tables.conversations) return [{ id: "conversation-1", title: "Weekly project work", provider: "chatgpt", externalSessionId: "session-1", archiveUpdatedAt: new Date("2026-09-09T00:00:00Z") }];
        if (entry.table === tables.conversationProjects) return [{ projectId: "project-1", projectName: "AI archive" }];
        if (entry.table === tables.conversationTags) return [{ name: "Testing" }];
        return [];
      };
      const query = {
        from: (table: unknown) => { entry.table = table; return query; },
        where: (where: unknown) => { entry.where = where; return query; },
        innerJoin: () => query, leftJoin: () => query, orderBy: () => query, limit: () => query, for: () => query,
        getSQL: () => sql`select 1`,
        then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => execute().then(resolve, reject),
      };
      return query;
    },
    update: (table: unknown) => ({ set: (values: Record<string, unknown>) => {
      const entry: Query = { operation: "update", table, values, transaction: mocks.transactionActive };
      mocks.queries.push(entry);
      return { where: (where: unknown) => {
        entry.where = where;
        const execute = async () => {
          if (table === tables.analysisRuns) {
            if (!passesStaleGuard(where)) return [];
            if (values.status === "running" && !mocks.claimAvailable) return [];
            if (values.status === "completed" && mocks.failCompletedWrite) throw new Error("completion commit failed");
            if (mocks.run) mocks.run = { ...mocks.run, ...structuredClone(values) };
            return mocks.run ? [structuredClone(mocks.run)] : [];
          }
          if (table === tables.reports && mocks.report) mocks.report = { ...mocks.report, ...structuredClone(values) };
          return mocks.report ? [structuredClone(mocks.report)] : [];
        };
        return { returning: execute, then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) => execute().then(resolve, reject) };
      } };
    } }),
    insert: (table: unknown) => ({ values: (values: Record<string, unknown>) => {
      const entry: Query = { operation: "insert", table, values, transaction: mocks.transactionActive };
      mocks.queries.push(entry);
      const query = {
        onConflictDoUpdate: () => query, onConflictDoNothing: () => query,
        returning: async () => {
          if (table === tables.reports) {
            mocks.report = { ...mocks.report, ...structuredClone(values) } as ReportRow;
            return [structuredClone(mocks.report)];
          }
          return [];
        },
      };
      return query;
    } }),
  };
  return { db: { ...db, transaction: async (run: (tx: typeof db) => unknown) => {
    const previousRun = structuredClone(mocks.run);
    const previousReport = structuredClone(mocks.report);
    mocks.transactionActive = true;
    try { return await run(db); }
    catch (error) { mocks.run = previousRun; mocks.report = previousReport; throw error; }
    finally { mocks.transactionActive = false; }
  } } };
});

vi.mock("openai", () => ({ default: class { chat = { completions: { create: mocks.create } }; } }));
vi.mock("pg-boss", () => ({ default: class {
  on() { return this; }
  start = async () => undefined;
  createQueue = async () => undefined;
  send = mocks.queueSend;
} }));
vi.mock("../src/services/settings.js", () => ({
  getSetting: async (key: string) => ({ "llm.baseUrl": "https://llm.example.test/v1", "llm.apiKey": "test-secret", "llm.model": "test-model" })[key],
  getBooleanSetting: async () => false,
  getNumberSetting: async () => 0,
}));
vi.mock("../src/services/network-target.js", () => ({
  withPinnedNetworkDispatcher: async (_url: string, run: (dispatcher: unknown) => unknown) => run({}),
}));
vi.mock("../src/services/revision-storage.js", () => ({ loadCurrentConversationArchive: mocks.loadArchive }));
vi.mock("../src/services/redaction.js", () => ({
  redactForCloud: async (text: string) => ({ text }),
  loadEnabledCustomRedactionRules: async () => [],
  redactSensitiveTextForStorage: (text: string) => ({ text }),
}));
vi.mock("../src/services/queue.js", () => ({ enqueueAnalysis: mocks.enqueueAnalysis, enqueueReportEmail: mocks.enqueueReportEmail, enqueueUnlockedReclassification: vi.fn() }));
vi.mock("../src/services/operation-log.js", () => ({
  safeStoredError: (error: unknown) => error instanceof Error ? error.message : String(error),
  redactLogText: (value: string) => value,
  writeOperationLog: mocks.writeOperationLog,
}));

import { retryDeferredAnalysisRuns, runAnalysis } from "../src/services/analysis.js";
import { REPORT_SECTION_HEADINGS } from "../src/services/report-content.js";

const periodStart = new Date("2026-09-06T16:00:00Z");
const periodEnd = new Date("2026-09-13T16:00:00Z");
const laterWeek = new Date("2026-10-13T00:00:00Z");
const fullReport = {
  title: "Regenerated weekly report",
  summary: "Completed the report validation implementation.",
  bodyMarkdown: REPORT_SECTION_HEADINGS.weekly.map((heading) => `## ${heading}\n\n归档项目完成了正文校验与诊断记录开发，测试结果已记录。`).join("\n\n"),
};
function completion(content: string) {
  return { id: "response-id", model: "test-model", choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
}

beforeEach(() => {
  mocks.run = {
    id: "historical-run", kind: "weekly", status: "queued", windowStart: periodStart, windowEnd: periodEnd,
    stats: { generationId: "current-generation", stage: "queued", sendEmail: false, regeneratingReportId: "existing-report", responseDiagnostics: [] },
    updatedAt: new Date("2026-09-14T00:00:00Z"), completedAt: null, error: null,
  };
  mocks.report = { id: "existing-report", kind: "weekly", periodStart, periodEnd, title: "Old title", summary: "Old summary", bodyMarkdown: "Original saved content", emailStatus: "sent" };
  mocks.queries = [];
  mocks.transactionActive = false;
  mocks.failCompletedWrite = false;
  mocks.claimAvailable = true;
  mocks.create.mockReset().mockResolvedValue(completion(JSON.stringify(fullReport)));
  mocks.loadArchive.mockReset().mockResolvedValue({
    revision: { id: "revision-1", capturedAt: new Date("2026-09-09T00:00:00Z"), capturedTitle: "AI archive", metadataCaptured: true },
    messages: [{ ordinal: 1, role: "user", createdAt: new Date("2026-09-09T00:00:00Z"), segments: [{ type: "text", content: "Implemented report validation and response diagnostics." }] }],
  });
  mocks.enqueueReportEmail.mockReset().mockResolvedValue("email-job");
  mocks.enqueueAnalysis.mockReset().mockResolvedValue("replacement-analysis-job");
  mocks.writeOperationLog.mockReset().mockResolvedValue(undefined);
  mocks.queueSend.mockReset().mockResolvedValue("analysis-job");
});

describe("report generation run safety", () => {
  it("ignores a stale generation job before claiming or calling the model", async () => {
    await expect(runAnalysis("weekly", laterWeek, { runId: "historical-run", generationId: "old-generation" })).resolves.toEqual({ active: true, runId: "historical-run" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
  });

  it("does not restart a failed generation when its duplicate job arrives", async () => {
    mocks.run!.status = "failed";
    mocks.run!.error = "Quality retries exhausted";
    mocks.run!.completedAt = new Date("2026-09-14T00:10:00Z");
    const failedRun = structuredClone(mocks.run);
    await expect(runAnalysis("weekly", laterWeek, { runId: "historical-run", generationId: "current-generation" })).resolves.toEqual({ active: true, runId: "historical-run" });
    expect(mocks.run).toEqual(failedRun);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.loadArchive).not.toHaveBeenCalled();
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
  });

  it("returns the original retry time when a deferred job arrives before its quota window opens", async () => {
    const retryAt = "2026-11-15T00:00:00.000Z";
    mocks.run!.stats = { ...mocks.run!.stats, stage: "deferred", retryAt };
    const queuedRun = structuredClone(mocks.run);
    await expect(runAnalysis("weekly", laterWeek, { runId: "historical-run", generationId: "current-generation" })).resolves.toEqual({
      deferred: true, retryAt, runId: "historical-run", generationId: "current-generation",
    });
    expect(mocks.run).toEqual(queuedRun);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.loadArchive).not.toHaveBeenCalled();
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
  });

  it("does no report work when another worker has claimed the run", async () => {
    mocks.claimAvailable = false;
    await expect(runAnalysis("weekly", laterWeek, { runId: "historical-run", generationId: "current-generation" })).resolves.toEqual({ active: true, runId: "historical-run" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.loadArchive).not.toHaveBeenCalled();
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
    const claim = mocks.queries.find((query) => query.values?.status === "running")!;
    const guard = new PgDialect().sqlToQuery(claim.where as never);
    expect(guard.sql).toContain("->>'generationId'");
    expect(guard.params).toEqual(["historical-run", "queued", "current-generation"]);
  });

  it("leaves a freshly running generation untouched when a duplicate job starts", async () => {
    mocks.run!.status = "running";
    mocks.run!.updatedAt = laterWeek;
    const runningRun = structuredClone(mocks.run);
    await expect(runAnalysis("weekly", laterWeek, { runId: "historical-run", generationId: "current-generation" })).resolves.toEqual({ active: true, runId: "historical-run" });
    expect(mocks.run).toEqual(runningRun);
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.loadArchive).not.toHaveBeenCalled();
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
  });

  it("preserves the old report and stores all rejection diagnostics when content validation exhausts retries", async () => {
    const original = structuredClone(mocks.report);
    const raw = JSON.stringify({ title: "Incomplete report", summary: "This week included report work.", bodyMarkdown: "..." });
    mocks.create.mockResolvedValue(completion(raw));
    await expect(runAnalysis("weekly", laterWeek, { runId: "historical-run", generationId: "current-generation" })).rejects.toThrow("报告正文");
    expect(mocks.create).toHaveBeenCalledTimes(3);
    expect(mocks.run).toMatchObject({ status: "failed", stats: { generationId: "current-generation", analyzedConversations: 1 } });
    const diagnostics = mocks.run!.stats.responseDiagnostics as Array<Record<string, unknown>>;
    expect(diagnostics.map((item) => [item.attempt, item.status, item.content])).toEqual([[1, "rejected", raw], [2, "rejected", raw], [3, "rejected", raw]]);
    expect(mocks.report).toEqual(original);
    expect(mocks.queries.some((query) => query.table === reports && query.operation !== "select")).toBe(false);
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
  });

  it("regenerates the stored period without sending another email", async () => {
    await expect(runAnalysis("weekly", laterWeek, { runId: "historical-run", generationId: "current-generation" })).resolves.toEqual({ reportId: "existing-report", conversations: 1 });
    expect(mocks.run).toMatchObject({ status: "completed", windowStart: periodStart, windowEnd: periodEnd, stats: { sendEmail: false, reportId: "existing-report" } });
    expect(mocks.report).toMatchObject({ periodStart, periodEnd, emailStatus: "sent", bodyMarkdown: expect.stringContaining(fullReport.bodyMarkdown) });
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
    const source = JSON.parse(mocks.create.mock.calls[0]![0].messages[1].content);
    expect(source.period).toEqual({ start: periodStart.toISOString(), end: periodEnd.toISOString() });
    const receiptQuery = mocks.queries.find((query) => query.operation === "select" && query.table === captureRuns && query.fields?.capturedAt)!;
    const receiptFilter = new PgDialect().sqlToQuery(receiptQuery.where as never);
    expect(receiptFilter.params).toContain(periodStart.toISOString());
    expect(receiptFilter.params).toContain(periodEnd.toISOString());
    expect(mocks.queries.some((query) => query.operation === "insert" && query.table === analysisRuns)).toBe(false);
    const bodyWrite = mocks.queries.find((query) => query.operation === "insert" && query.table === reports)!;
    const completedWrite = mocks.queries.find((query) => query.values?.status === "completed")!;
    expect(bodyWrite.transaction).toBe(true);
    expect(completedWrite.transaction).toBe(true);
  });

  it("rolls back the replacement body when completing its run fails", async () => {
    const original = structuredClone(mocks.report);
    mocks.failCompletedWrite = true;
    await expect(runAnalysis("weekly", laterWeek, { runId: "historical-run", generationId: "current-generation" })).rejects.toThrow("completion commit failed");
    expect(mocks.report).toEqual(original);
    expect(mocks.run).toMatchObject({ status: "failed", stats: { responseDiagnostics: [expect.objectContaining({ status: "accepted" })] } });
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
  });

  it("preserves the old report when its source material is no longer available", async () => {
    const original = structuredClone(mocks.report);
    mocks.loadArchive.mockResolvedValue(null);
    await expect(runAnalysis("weekly", laterWeek, { runId: "historical-run", generationId: "current-generation" })).rejects.toThrow("没有可用会话材料");
    expect(mocks.report).toEqual(original);
    expect(mocks.run?.status).toBe("failed");
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
  });

  it("resumes a deferred run after a calendar boundary using its original run and window", async () => {
    mocks.run!.stats = { ...mocks.run!.stats, stage: "deferred", retryAt: "2026-09-15T00:00:00Z" };
    await expect(retryDeferredAnalysisRuns(laterWeek)).resolves.toBe(1);
    expect(mocks.run).toMatchObject({ id: "historical-run", status: "completed", windowStart: periodStart, windowEnd: periodEnd, stats: { generationId: "current-generation" } });
    const source = JSON.parse(mocks.create.mock.calls[0]![0].messages[1].content);
    expect(source.period).toEqual({ start: periodStart.toISOString(), end: periodEnd.toISOString() });
    expect(mocks.queries.some((query) => query.operation === "insert" && query.table === analysisRuns)).toBe(false);
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
  });

  it("leaves a deferred run alone until its scheduled retry time", async () => {
    mocks.run!.stats = { ...mocks.run!.stats, stage: "deferred", retryAt: "2026-11-15T00:00:00Z" };
    await expect(retryDeferredAnalysisRuns(laterWeek)).resolves.toBe(0);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
  });

  it("requeues a stranded queued generation after five minutes without changing its identity or report", async () => {
    mocks.run!.updatedAt = new Date(laterWeek.getTime() - 6 * 60_000);
    const queuedRun = structuredClone(mocks.run);
    const original = structuredClone(mocks.report);
    await retryDeferredAnalysisRuns(laterWeek);
    expect(mocks.enqueueAnalysis).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueAnalysis).toHaveBeenCalledWith("weekly", undefined, { runId: "historical-run", generationId: "current-generation" });
    expect(mocks.run).toEqual(queuedRun);
    expect(mocks.report).toEqual(original);
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.loadArchive).not.toHaveBeenCalled();
  });

  it("does not duplicate a queued job less than five minutes old", async () => {
    mocks.run!.updatedAt = new Date(laterWeek.getTime() - 4 * 60_000);
    await retryDeferredAnalysisRuns(laterWeek);
    expect(mocks.enqueueAnalysis).not.toHaveBeenCalled();
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("fails a running generation stale for more than thirty minutes while preserving the old report", async () => {
    mocks.run!.status = "running";
    mocks.run!.updatedAt = new Date(laterWeek.getTime() - 31 * 60_000);
    const original = structuredClone(mocks.report);
    const originalStats = structuredClone(mocks.run!.stats);
    await retryDeferredAnalysisRuns(laterWeek);
    expect(mocks.run).toMatchObject({ status: "failed", error: expect.stringContaining("原报告已保留"), completedAt: laterWeek, stats: originalStats });
    expect(mocks.report).toEqual(original);
    const failedWrite = mocks.queries.find((query) => query.values?.status === "failed")!;
    const guard = new PgDialect().sqlToQuery(failedWrite.where as never);
    expect(guard.sql).toContain('"analysis_runs"."updated_at" <');
    expect(guard.params).toEqual(["historical-run", "running", new Date(laterWeek.getTime() - 30 * 60_000).toISOString()]);
    expect(mocks.queries.some((query) => query.table === reports && query.operation !== "select")).toBe(false);
    expect(mocks.enqueueAnalysis).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.enqueueReportEmail).not.toHaveBeenCalled();
  });

  it.each([29, 30])("does not interrupt a running generation last updated %s minutes ago", async (minutes) => {
    mocks.run!.status = "running";
    mocks.run!.updatedAt = new Date(laterWeek.getTime() - minutes * 60_000);
    const runningRun = structuredClone(mocks.run);
    await retryDeferredAnalysisRuns(laterWeek);
    expect(mocks.run).toEqual(runningRun);
    expect(mocks.queries.filter((query) => query.operation !== "select")).toEqual([]);
    expect(mocks.enqueueAnalysis).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    const recoveryQuery = mocks.queries.find((query) => query.table === analysisRuns)!;
    const filter = new PgDialect().sqlToQuery(recoveryQuery.where as never);
    expect(filter.sql).toContain('"analysis_runs"."updated_at" <');
    expect(filter.params).toContain(new Date(laterWeek.getTime() - 30 * 60_000).toISOString());
  });

  it("queues report attempts without PgBoss retries and preserves generation identity on delayed jobs", async () => {
    const { enqueueAnalysis } = await vi.importActual<typeof import("../src/services/queue.js")>("../src/services/queue.js");
    const startAfter = new Date("2026-11-15T00:00:00Z");
    await expect(enqueueAnalysis("weekly", { startAfter }, { runId: "historical-run", generationId: "current-generation" })).resolves.toBe("analysis-job");
    expect(mocks.queueSend).toHaveBeenCalledWith("analysis-weekly", {
      runId: "historical-run", generationId: "current-generation", requestedAt: expect.any(String),
    }, {
      startAfter, retryLimit: 0, expireInMinutes: 30,
      singletonKey: `weekly:historical-run:current-generation:deferred:${startAfter.getTime()}`,
    });
  });
});
