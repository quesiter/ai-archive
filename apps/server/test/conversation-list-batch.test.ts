import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ select: vi.fn(), selectDistinct: vi.fn(), selectDistinctOn: vi.fn(), transaction: vi.fn(), execute: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: mocks }));
vi.mock("../src/http.js", () => ({ requireWebUser: vi.fn(async () => true) }));
vi.mock("../src/services/conversation-lineage.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/conversation-lineage.js")>(),
  includeConversationAncestors: vi.fn(async (ids: string[]) => ids),
}));
import { conversationRoutes } from "../src/routes/conversations.js";

function query(rows: unknown[]) {
  const chain: any = {};
  for (const key of ["from", "leftJoin", "innerJoin", "where", "orderBy", "limit", "offset"]) chain[key] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}

describe("conversation page batch reads", () => {
  it.each([2, 50, 100])("loads search snippets for %i results with one batch and preserves result associations", async (size) => {
    const rows = Array.from({ length: size }, (_, index) => ({ id: `conversation-${index}`,
      provider: "codex", externalSessionId: `session-${index}`, title: index ? `Title ${index}` : "Needle title" }));
    const results = [[{ total: size }], rows, []];
    mocks.select.mockReset().mockImplementation(() => query(results.shift()!));
    mocks.selectDistinct.mockReset().mockReturnValue(query(rows.map(row => ({ id: row.id }))));
    mocks.execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([{total:size,rows}]).mockResolvedValueOnce(rows.slice(1).reverse().map(row => ({
      conversationId: row.id, revisionId: `revision-${row.id}`, ordinal: 6, content: `needle body of ${row.id}`
    }))).mockResolvedValue([]);
    mocks.transaction.mockReset().mockImplementation(reader => reader(mocks));
    mocks.selectDistinctOn.mockReset()
      .mockReturnValueOnce(query(rows.map(row => ({ conversationId: row.id, id: `revision-${row.id}`,
        completeness: "complete", messageCount: 7, hasSourceReview: false }))))
      .mockReturnValueOnce(query(rows.slice(1).reverse().map(row => ({ conversationId: row.id,
        revisionId: `revision-${row.id}`, ordinal: 6, content: `needle body of ${row.id}` }))));
    const app = Fastify(); await app.register(conversationRoutes);
    try {
      const response = await app.inject({ method: "GET", url: `/api/v1/conversations?q=needle&limit=${size}` });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(size);
      expect(body.items[0].searchHit.reason).toBe("标题命中");
      for (const item of body.items.slice(1)) {
        expect(item.searchHit).toMatchObject({ revisionId: `revision-${item.id}`, messageOrdinal: 6 });
        expect(item.searchHit.excerpt).toContain(`needle body of ${item.id}`);
      }
      expect(mocks.select).toHaveBeenCalledTimes(3);
      expect(mocks.selectDistinct).not.toHaveBeenCalled();
      expect(mocks.selectDistinctOn).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });

  it("reads persisted review counts for 100 conversations and aggregates child counts once", async () => {
    const rows = Array.from({ length: 100 }, (_, index) => ({ id: `conversation-${index}`, provider: "codex", externalSessionId: `session-${index}`, title: `Title ${index}` }));
    const results = [[{ total: 100 }], rows, [{ conversationId: rows[99]!.id, id: "tag-1", name: "Last tag" }]];
    mocks.select.mockReset().mockImplementation(() => query(results.shift()!));
    mocks.execute.mockReset().mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: rows[99]!.id, childCount: 4 }]);
    mocks.transaction.mockReset().mockImplementation(reader => reader(mocks));
    mocks.selectDistinctOn.mockReset().mockReturnValue(query(rows.slice(0, 99).map(row => ({ conversationId: row.id, id: `revision-${row.id}`, completeness: "complete", messageCount: 3, storedMessageCount: 7, sourceContentPending: true }))));
    const app = Fastify(); await app.register(conversationRoutes);
    try {
      const response = await app.inject({ method: "GET", url: "/api/v1/conversations?limit=100" });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.items).toHaveLength(100);
      expect(body.items[0].latestRevision).toMatchObject({ completeness: "complete", messageCount: 3,
        storedMessageCount: 7, sourceContentPending: true });
      expect(body.items[99].childCount).toBe(4);
      expect(mocks.execute).toHaveBeenCalledTimes(2);
      expect(body.items[0].tags).toEqual([]);
      expect(body.items[99].latestRevision).toBeNull();
      expect(body.items[99].tags).toEqual([{ id: "tag-1", name: "Last tag" }]);
      expect(mocks.select).toHaveBeenCalledTimes(3);
      expect(mocks.selectDistinctOn).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
