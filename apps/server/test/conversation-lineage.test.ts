import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  ancestorConversationQuery,
  conversationChildCount,
  includeConversationAncestors,
  mainConversationFilter,
  parentLineageValidationQuery,
  persistConversationParent,
} from "../src/services/conversation-lineage.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { execute: mocks.execute } }));

const dialect = new PgDialect();
const childId = "00000000-0000-4000-8000-000000000002";
const payload = { provider: "codex" as const, sessionId: "child", parentSessionId: "parent" };

function transaction(invalid = false) {
  const where = vi.fn(async (_condition: SQL) => undefined);
  const set = vi.fn(() => ({ where }));
  const update = vi.fn(() => ({ set }));
  const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce(invalid ? [{ invalid: true }] : []);
  return { tx: { execute, update } as unknown as Parameters<typeof persistConversationParent>[0], execute, update, set, where };
}

describe("conversation parent metadata", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps old-client captures and self references from clearing stored lineage", async () => {
    const { tx, execute, update } = transaction();
    await persistConversationParent(tx, childId, { provider: "codex", sessionId: "child" });
    await persistConversationParent(tx, childId, { ...payload, parentSessionId: "child" });
    expect(execute).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("writes valid metadata after the provider graph lock and ancestor validation", async () => {
    const { tx, execute, update, set, where } = transaction();
    await persistConversationParent(tx, childId, payload);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(dialect.sqlToQuery(execute.mock.calls[0]![0]).params).toEqual(["conversation-lineage:codex"]);
    expect(execute.mock.invocationCallOrder[1]).toBeLessThan(update.mock.invocationCallOrder[0]!);
    expect(set).toHaveBeenCalledWith({ parentExternalSessionId: "parent" });
    expect(dialect.sqlToQuery(where.mock.calls[0]![0]).params).toEqual([childId]);
  });

  it("keeps capture content usable when the parent would introduce a cycle", async () => {
    const { tx, update } = transaction(true);
    await expect(persistConversationParent(tx, childId, payload)).resolves.toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  it("validates deleted ancestors too, preventing cycles from appearing after restore", () => {
    const query = dialect.sqlToQuery(parentLineageValidationQuery(payload));
    expect(query.params).toEqual(["codex", "parent", "codex", "child"]);
    expect(query.sql).toContain("where not ancestry.cycle");
    expect(query.sql).not.toContain("deleted_at is null");
  });

  it("preserves list access for missing/deleted parents and corrupt cycles", () => {
    const query = dialect.sqlToQuery(mainConversationFilter());
    expect(query.sql).toContain("or not exists");
    expect(query.sql).toContain("parent.deleted_at is null");
    expect(query.sql).toContain("select 1 from ancestry where cycle");
    expect(query.sql).toContain('parent.provider = "conversations"."provider"');
    const count = dialect.sqlToQuery(conversationChildCount()).sql;
    expect(count).toContain('child.id <> "conversations"."id"');
    expect(count).toContain("child.deleted_at is null");
  });

  it("promotes only active matching conversations and ancestors and terminates cycles", async () => {
    mocks.execute.mockResolvedValue([{ id: childId }, { id: "parent-id" }]);
    expect(await includeConversationAncestors([childId])).toEqual([childId, "parent-id"]);
    const query = dialect.sqlToQuery(ancestorConversationQuery([childId]));
    expect(query.params).toEqual([childId]);
    expect(query.sql).toContain('"conversations"."id" in ($1) and deleted_at is null');
    expect(query.sql).toContain("parent.deleted_at is null");
    expect(query.sql).toContain("parent.provider = ancestry.provider");
    expect(query.sql).not.toContain("union all");
    mocks.execute.mockClear();
    expect(await includeConversationAncestors([])).toEqual([]);
    expect(mocks.execute).not.toHaveBeenCalled();
  });
});
