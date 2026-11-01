import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
const mocks = vi.hoisted(() => ({ select: vi.fn(), execute: vi.fn(), transaction: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: mocks }));
import { loadConversationEvidencePage, loadCurrentConversationPage } from "../src/services/conversation-page.js";

function query(rows: unknown[]) {
  const chain: any = {};
  for (const key of ["from", "where", "orderBy", "limit"]) chain[key] = () => chain;
  chain.then = (resolve: (rows: unknown[]) => unknown) => Promise.resolve(rows).then(resolve);
  return chain;
}
const revision = (extra: object = {}) => ({ id: "revision", messageCount: 120,
  presentationMessageCount: 120, archiveReview: null, ...extra });
const physicalEntry = (ordinal: number) => ({ ordinal, storedOrdinal: ordinal,
  physical: { id: `message-${ordinal}`, revision_id: "base-revision", ordinal, role: "assistant" },
  variant: null, segments: [{ id: "segment", ordinal: 0, type: "text", content: "A bounded page" }] });
const compile = (call: number) => new PgDialect().sqlToQuery(mocks.execute.mock.calls[call]![0]);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation(reader => reader(mocks));
});

describe("conversation message pages", () => {
  it("reads only the target window of a delta chain and omits large evidence from detail metadata", async () => {
    mocks.select.mockReturnValue(query([revision()]));
    mocks.execute.mockResolvedValue([physicalEntry(75)]);
    const page = await loadCurrentConversationPage("conversation", {
      messageLimit: 20, messageOffset: 0, messageOrdinal: 75,
    });
    expect(page?.messagePagination).toEqual({ total: 120, limit: 20, offset: 60, hasMore: true });
    expect(page?.messages[0]).toMatchObject({ ordinal: 75, storedOrdinal: 75,
      revisionId: "base-revision", segments: [{ content: "A bounded page" }] });
    expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "repeatable read", accessMode: "read only",
    });
    const fields = mocks.select.mock.calls[0]![0];
    expect(fields).not.toHaveProperty("searchText");
    const metadata = new PgDialect().sqlToQuery(fields.mergeEvidence).sql;
    expect(metadata).toContain("- 'variants' - 'sourceReview' - 'warnings'");
    const sql = compile(0);
    expect(sql.sql).toContain("child.storage_kind = 'delta'");
    expect(sql.sql).toContain("message.ordinal in (select stored_ordinal from page_entries");
    expect(sql.params).toContain(60);
    expect(sql.params).toContain(79);
  });

  it("locates a reviewed source ordinal in its reordered page and hydrates variant bodies", async () => {
    mocks.select.mockReturnValue(query([revision({ archiveReview: { verifiedAt: "2026-11-01" } })]));
    mocks.execute.mockResolvedValueOnce([{ ordinal: 75 }]).mockResolvedValueOnce([{
      ordinal: 75, storedOrdinal: null, physical: null, segments: [],
      variant: { ordinal: 11, externalMessageId: "source-message", role: "assistant",
        segments: [{ type: "code", content: "Chosen alternate body", language: "ts" }] },
    }]);
    const page = await loadCurrentConversationPage("conversation", {
      messageLimit: 20, messageOffset: 0, messageOrdinal: 11,
    });
    expect(page?.messagePagination.offset).toBe(60);
    expect(page?.messages[0]).toMatchObject({ ordinal: 75, storedOrdinal: null,
      externalMessageId: "source-message", segments: [{ content: "Chosen alternate body", language: "ts" }] });
    const sql = compile(1);
    expect(sql.sql).toContain("from conversation_revision_presentation");
    expect(sql.params).toContain(60);
  });

  it("bounds an offset beyond the current tail after a transcript changes", async () => {
    mocks.select.mockReturnValue(query([revision({ messageCount: 120, presentationMessageCount: 31 })]));
    mocks.execute.mockResolvedValue([physicalEntry(30)]);
    const page = await loadCurrentConversationPage("conversation", { messageLimit: 20, messageOffset: 500 });
    expect(page?.messagePagination).toEqual({ total: 31, limit: 20, offset: 20, hasMore: true });
  });

  it("returns an empty page for a conversation without a revision", async () => {
    mocks.select.mockReturnValue(query([]));
    expect(await loadCurrentConversationPage("conversation", { messageLimit: 20, messageOffset: 0 })).toBeNull();
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});

describe("lazy historical evidence", () => {
  it("paginates all evidence categories together and locates historical source ordinals", async () => {
    mocks.select.mockReturnValue(query([{ id: "revision" }]));
    mocks.execute.mockResolvedValueOnce([{ total: 51, target: 26 }])
      .mockResolvedValueOnce([{ ...physicalEntry(26), category: "resolved", observationKind: "map_rendering" }])
      .mockResolvedValueOnce([{ warnings: [{ type: "order_conflict", messageIds: [] }], warningCount: 1 }]);
    const page = await loadConversationEvidencePage("conversation", { limit: 20, offset: 0, messageOrdinal: 26 });
    expect(page.pagination).toEqual({ total: 51, limit: 20, offset: 20, hasMore: true });
    expect(page.items[0]).toMatchObject({ kind: "resolved", reviewKind: "map_rendering",
      message: { ordinal: 26, storedOrdinal: 26 } });
    expect(page.warnings).toHaveLength(1);
    expect(compile(1).sql).toContain("from conversation_revision_observations");
    expect(compile(1).params).toContain(20);
  });
});
