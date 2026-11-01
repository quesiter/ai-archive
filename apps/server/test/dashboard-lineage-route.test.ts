import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { dashboardRoutes } from "../src/routes/dashboard.js";

const mocks = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn(), transaction: vi.fn(), jit: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: mocks }));
vi.mock("../src/http.js", () => ({ requireWebUser: vi.fn(async () => true) }));

describe("dashboard lineage route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(reader => reader({ ...mocks, execute: (statement: SQL) => {
      if (new PgDialect().sqlToQuery(statement).sql === "SET LOCAL jit = off") return mocks.jit();
      return mocks.execute(statement);
    } }));
  });

  it("keeps the initial dashboard response off expensive history queries", async () => {
    const selectRows: unknown[][] = [
      [{ value: 2 }],
      [{ value: 3 }],
      [{ value: 1 }],
      [],
      [],
    ];
    mocks.select.mockImplementation(() => {
      const rows = selectRows.shift();
      if (!rows) throw new Error("Unexpected select");
      const chain: Record<string, unknown> = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
      };
      return chain;
    });
    const handlers = new Map<string, (request: unknown, reply: unknown) => Promise<unknown>>();
    await dashboardRoutes({
      get: (path: string, callback: (request: unknown, reply: unknown) => Promise<unknown>) => {
        handlers.set(path, callback);
      },
    } as unknown as FastifyInstance);

    const result = await handlers.get("/api/v1/dashboard")!(
      { query: { includeOrganization: "false", includeTextStats: "false" } },
      {},
    );

    expect(result).toMatchObject({ counts: { projects: 2, tags: 3, devices: 1 } });
    expect(result).not.toHaveProperty("textStats");
    expect(result).not.toHaveProperty("categoryStats");
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(selectRows).toEqual([]);
  });

  it.each(["date", "raw_timestamp"] as const)("groups counts and preserves costs with %s project-assignment dates", async (dateShape) => {
    const now = new Date();
    const selectRows: unknown[][] = [
      [{ value: 1 }], [{ value: 0 }], [{ value: 1 }],
      Array.from({ length: 6 }, () => ({ provider: "codex", status: "complete" })), [],
      [{ value: 1 }], [{ value: 0 }],
    ];
    const selectedTables: Array<{ table?: unknown; where?: SQL }> = [];
    mocks.select.mockImplementation(() => {
      const rows = selectRows.shift();
      if (!rows) throw new Error("Unexpected select");
      const selected: { table?: unknown; where?: SQL } = {};
      selectedTables.push(selected);
      const chain: Record<string, unknown> = {
        from: (table: unknown) => { selected.table = table; return chain; },
        where: (condition: SQL) => { selected.where = condition; return chain; },
        leftJoin: () => chain,
        innerJoin: () => chain,
        orderBy: () => chain,
        limit: () => chain,
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve(rows)),
      };
      return chain;
    });
    mocks.execute.mockImplementation(async (statement: SQL) => {
      const query = new PgDialect().sqlToQuery(statement).sql;
      return query.includes('AS "categoryStats"') ? [{
        categoryStats: [{ projectId: "project", conversationCount: 1, growth7d: 1, latestActivityAt: now.toISOString() }],
        categoryTotals: { categorizedConversationCount: 1 },
      }] : [{
        reported_tokens: 6000, model_tokens: 6000, usage_backed_conversations: 6,
        text_units: 5000, reported_reasoning_tokens: 500,
        latest_revision_count: 6, latest_message_count: 75,
      }];
    });
    let handler: ((request: unknown, reply: unknown) => Promise<unknown>) | undefined;
    await dashboardRoutes({
      get: (_path: string, callback: typeof handler) => { handler = callback; },
    } as unknown as FastifyInstance);
    expect(handler).toBeDefined();
    const result = await handler!({}, {});
    expect(result).toMatchObject({
      counts: { conversations: 1 },
      categoryTotals: { categorizedConversationCount: 1, unclassifiedConversationCount: 0 },
      categoryStats: [{ conversationCount: 1, growth7d: 1, latestActivityAt: now.toISOString() }],
      textStats: { latestRevisionCount: 6, latestMessageCount: 75, reportedTokens: 6000, usageBackedConversationCount: 6 },
      captureStatus24h: { complete: 6 },
      captureProviders24h: [{ provider: "codex", total: 6 }],
    });
    const dialect = new PgDialect();
    const tokenSql = dialect.sqlToQuery(mocks.execute.mock.calls[0]![0]).sql;
    expect(tokenSql).toContain("WHERE conversation.deleted_at IS NULL");
    expect(tokenSql).toContain("count(*) AS latest_revision_count");
    expect(tokenSql).toContain("COALESCE(sum(message_count), 0) AS latest_message_count");
    expect(tokenSql).not.toContain("parent_external_session_id");
    expect(tokenSql).not.toContain("project_ancestry");
    expect(selectRows).toEqual([]);
  });
});
