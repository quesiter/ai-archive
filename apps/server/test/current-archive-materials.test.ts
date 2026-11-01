import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { captureRuns, conversationRevisions, conversations } from "../src/schema.js";

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][],
  queries: [] as Array<{ table?: unknown; fields?: Record<string, unknown>; where?: unknown }>,
  loadArchive: vi.fn(),
  completeStructured: vi.fn(),
}));

vi.mock("../src/db.js", async () => {
  const { sql } = await import("drizzle-orm");
  return { db: { select: (fields?: Record<string, unknown>) => {
    const entry = { fields } as (typeof mocks.queries)[number];
    mocks.queries.push(entry);
    const query = {
      from: (table: unknown) => { entry.table = table; return query; },
      where: (where: unknown) => { entry.where = where; return query; },
      innerJoin: () => query,
      leftJoin: () => query,
      orderBy: () => query,
      limit: () => query,
      getSQL: () => sql`select 1`,
      then: (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) => Promise.resolve(mocks.rows.shift() ?? []).then(resolve, reject),
    };
    return query;
  } } };
});
vi.mock("../src/services/revision-storage.js", () => ({ loadCurrentConversationArchive: mocks.loadArchive }));
vi.mock("../src/services/llm.js", async (original) => ({ ...await original<typeof import("../src/services/llm.js")>(), completeStructured: mocks.completeStructured }));
vi.mock("../src/services/redaction.js", () => ({ redactForCloud: async (text: string) => ({ text }) }));

import { loadConversationMaterial, loadWindowMaterials } from "../src/services/analysis.js";
import { generateProjectContext } from "../src/services/project-context.js";

const windowStart = new Date("2026-09-01T00:00:00Z");
const windowEnd = new Date("2026-09-08T00:00:00Z");
const receiptAt = new Date("2026-09-06T10:00:00Z");
const futureAt = new Date("2026-09-12T00:00:00Z");
const conversation = { id: "one", title: "Separately read title", provider: "chatgpt", externalSessionId: "session", updatedAt: receiptAt, archiveUpdatedAt: futureAt };
const revision = { id: "fixed-archive", conversationId: "one", capturedAt: futureAt, createdAt: windowStart, completeness: "partial", isAccumulated: true, capturedTitle: "Snapshot title", metadataCaptured: true };
const message = (content: string, ordinal: number, createdAt: Date, sourceCreatedAt = windowStart) => ({
  id: `message-${ordinal}`, externalMessageId: `external-${ordinal}`, revisionId: revision.id,
  ordinal, role: ordinal % 2 ? "assistant" : "user", createdAt, sourceCreatedAt,
  segments: [{ type: "text", content }],
});
const archive = () => ({ revision, messages: [message("Included history", 0, receiptAt), message("End boundary message", 1, windowEnd), message("Future addition with old source time", 2, futureAt)] });

beforeEach(() => {
  mocks.rows.length = 0;
  mocks.queries.length = 0;
  mocks.loadArchive.mockReset().mockResolvedValue(archive());
  mocks.completeStructured.mockReset().mockResolvedValue({ currentContextMarkdown: "### 当前目标\n\nChecked context" });
});

describe("mutable archive analysis materials", () => {
  it("uses the archive snapshot's title, timestamp and body and considers changed receipt arrival time", async () => {
    mocks.rows.push([conversation]);
    const material = await loadConversationMaterial("one");
    expect(mocks.loadArchive).toHaveBeenCalledWith("one");
    expect(material).toMatchObject({ revisionId: "fixed-archive", title: "Snapshot title", capturedAt: futureAt, archiveUpdatedAt: futureAt });
    expect(material?.text).toContain("Future addition with old source time");
    const field = mocks.queries.find((query) => query.table === conversations)?.fields?.archiveUpdatedAt;
    const sql = new PgDialect().sqlToQuery(field as never).sql;
    expect(sql).toContain('max("capture_runs"."created_at")');
    expect(sql).toContain("->>'unchanged'");
    expect(sql).toContain("<> 'true'");
  });

  it("keeps receipt-window activity after the archive advances and excludes messages first archived later", async () => {
    mocks.rows.push(
      [{ conversationId: "one", capturedAt: receiptAt }, { conversationId: "one", capturedAt: windowStart }],
      [], [conversation], [], [],
    );
    const materials = await loadWindowMaterials(windowStart, windowEnd);
    expect(materials).toHaveLength(1);
    expect(materials[0]).toMatchObject({ revisionId: "fixed-archive", capturedAt: receiptAt.toISOString(), title: "Snapshot title" });
    expect(materials[0]?.content).toContain("Included history");
    expect(materials[0]?.content).toContain("End boundary message");
    expect(materials[0]?.content).not.toContain("Future addition");
    const query = mocks.queries.find((item) => item.table === captureRuns && item.fields?.capturedAt);
    const where = new PgDialect().sqlToQuery(query!.where as never);
    expect(where.params).toContain("complete");
    expect(where.params).toContain("partial");
    expect(where.sql).toContain('"capture_runs"."captured_at" >=');
    expect(where.sql).toContain('"capture_runs"."captured_at" <');
  });

  it("retains a historic import without successful receipts through its revision-time fallback", async () => {
    mocks.rows.push([], [{ conversationId: "one", capturedAt: receiptAt }], [conversation], [], []);
    expect((await loadWindowMaterials(windowStart, windowEnd))[0]?.capturedAt).toBe(receiptAt.toISOString());
    const query = mocks.queries.find((item) => item.table === conversationRevisions);
    expect(new PgDialect().sqlToQuery(query!.where as never).sql).toContain("not exists");
  });
});

describe("project context uses the current archive", () => {
  function prepareRows() {
    mocks.rows.push(
      [{ id: "project", name: "Project", description: "Description" }],
      [conversation],
      [{ ...revision, id: "legacy-complete", isAccumulated: false, completeness: "complete", capturedTitle: "Obsolete title" }, { ...revision, capturedAt: receiptAt, capturedTitle: "Initial canonical metadata" }],
      [],
    );
  }

  it("sends model content and metadata from the same current read and links to the unified conversation", async () => {
    prepareRows();
    const output = await generateProjectContext("project", { ai: true });
    const payload = JSON.parse(mocks.completeStructured.mock.calls[0]![0].user);
    expect(payload.conversations[0]).toMatchObject({ revisionId: "fixed-archive", title: "Snapshot title", capturedAt: futureAt.toISOString() });
    expect(payload.conversations[0].content).toContain("Future addition with old source time");
    expect(output?.markdown).toContain("/conversations/one)");
    expect(output?.markdown).not.toContain("revisionId=");
    expect(output?.markdown).not.toContain("Obsolete title");
  });

  it("prefers canonical metadata over a legacy complete revision without loading bodies in index-only mode", async () => {
    prepareRows();
    const output = await generateProjectContext("project", { ai: false });
    expect(output?.markdown).toContain("Initial canonical metadata");
    expect(output?.markdown).not.toContain("Obsolete title");
    expect(mocks.loadArchive).not.toHaveBeenCalled();
    expect(mocks.completeStructured).not.toHaveBeenCalled();
  });
});
