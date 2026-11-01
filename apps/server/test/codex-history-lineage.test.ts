import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { backfillCodexHistoryLineage, CodexHistoryLineageSchema } from "../src/services/codex-history-lineage.js";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), persist: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/services/conversation-lineage.js", () => ({ persistConversationParent: mocks.persist }));

function database(rows: unknown[][]) {
  const tx = { execute: vi.fn(async (_query: import("drizzle-orm").SQL) => []), select: vi.fn(() => {
    const chain = { from: () => chain, where: () => chain, limit: async () => rows.shift() ?? [] };
    return chain;
  }) };
  mocks.transaction.mockImplementation((run) => run(tx));
  return tx;
}
describe("Codex full history lineage backfill", () => {
  beforeEach(() => vi.clearAllMocks());
  it("repairs only relation metadata, never inserting, restoring, or rewriting archived content", async () => {
    const tx = database([[{ id: "child-id", parent: null }], [{ parent: "root" }]]);
    expect(await backfillCodexHistoryLineage({ relations: [{ sessionId: "child", parentSessionId: "root" }] }))
      .toEqual({ updated: 1, unchanged: 0, notFound: 0, rejected: 0 });
    expect(mocks.persist).toHaveBeenCalledWith(tx, "child-id", { provider: "codex", sessionId: "child", parentSessionId: "root" });
  });
  it("is idempotent and does not create rows for files never archived", async () => {
    database([[{ id: "child-id", parent: "root" }], []]);
    expect(await backfillCodexHistoryLineage({ relations: [
      { sessionId: "child", parentSessionId: "root" }, { sessionId: "absent", parentSessionId: "root" },
    ] })).toEqual({ updated: 0, unchanged: 1, notFound: 1, rejected: 0 });
    expect(mocks.persist).not.toHaveBeenCalled();
  });
  it("reports rejected cyclic relationships instead of claiming a successful repair", async () => {
    database([[{ id: "child-id", parent: null }], [{ parent: null }]]);
    expect(await backfillCodexHistoryLineage({ relations: [{ sessionId: "child", parentSessionId: "root" }] }))
      .toMatchObject({ updated: 0, rejected: 1 });
  });
  it("takes all conversation locks in a stable order before reading or changing the graph", async () => {
    const tx = database([[], [], []]);
    await backfillCodexHistoryLineage({ relations: [
      { sessionId: "z", parentSessionId: "root" },
      { sessionId: "a", parentSessionId: "root" },
      { sessionId: "z", parentSessionId: "root" },
    ] });
    expect(tx.execute.mock.calls.map((call) => new PgDialect().sqlToQuery(call[0]!).params))
      .toEqual([["conversation:codex:a"], ["conversation:codex:z"]]);
    expect(tx.execute.mock.invocationCallOrder.at(-1)).toBeLessThan(tx.select.mock.invocationCallOrder[0]!);
  });
  it("rejects self relationships and unbounded requests before opening a transaction", async () => {
    expect(CodexHistoryLineageSchema.safeParse({ relations: [{ sessionId: "root", parentSessionId: "root" }] }).success).toBe(false);
    await expect(backfillCodexHistoryLineage({ relations: Array.from({ length: 501 }, () => ({ sessionId: "child", parentSessionId: "root" })) })).rejects.toThrow();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
