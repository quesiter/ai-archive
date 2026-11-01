import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { backfillCodexHistoryLineage } from "../src/services/codex-history-lineage.js";
import { conversations } from "../src/schema.js";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { transaction: mocks.transaction } }));

describe("deleted Codex history metadata backfill", () => {
  it("uses the real parent persistence helper without restoring or changing archived content", async () => {
    const deletedAt = new Date("2026-09-01T00:00:00Z");
    const updatedAt = new Date("2026-08-31T00:00:00Z");
    const archived = {
      id: "00000000-0000-4000-8000-000000000001",
      parentExternalSessionId: null as string | null,
      deletedAt, updatedAt, title: "Preserved task",
    };
    const predicates: SQL[] = [];
    const tx = {
      execute: vi.fn(async () => []),
      select: vi.fn(() => {
        const chain = {
          from: () => chain,
          where: (predicate: SQL) => { predicates.push(predicate); return chain; },
          limit: async () => [{ id: archived.id, parent: archived.parentExternalSessionId }],
        };
        return chain;
      }),
      insert: vi.fn(() => { throw new Error("History metadata must never create archive content"); }),
      update: vi.fn((table: unknown) => {
        expect(table).toBe(conversations);
        return {
          set: (values: Record<string, unknown>) => {
            expect(Object.keys(values)).toEqual(["parentExternalSessionId"]);
            return { where: async () => { archived.parentExternalSessionId = values.parentExternalSessionId as string; } };
          },
        };
      }),
    };
    mocks.transaction.mockImplementation((run) => run(tx));
    const result = await backfillCodexHistoryLineage({ relations: [{ sessionId: "deleted-child", parentSessionId: "root" }] });
    expect(result).toEqual({ updated: 1, unchanged: 0, notFound: 0, rejected: 0 });
    expect(archived).toEqual({
      id: archived.id, parentExternalSessionId: "root", deletedAt, updatedAt, title: "Preserved task",
    });
    expect(tx.insert).not.toHaveBeenCalled();
    expect(tx.update).toHaveBeenCalledOnce();
    expect(new PgDialect().sqlToQuery(predicates[0]!).params).toEqual(["codex", "deleted-child"]);
  });
});
