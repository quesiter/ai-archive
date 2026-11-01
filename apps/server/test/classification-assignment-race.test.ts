import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assignment: {
    conversationId: "00000000-0000-4000-8000-000000000010",
    projectId: null as string | null,
    confidence: 0.5,
    lockedByUser: false,
    suggestedName: null as string | null,
    updatedAt: new Date("2026-10-25T00:00:00Z"),
  },
  guard: null as { sql: string; params: unknown[] } | null,
  complete: vi.fn(),
  persistTags: vi.fn(),
  archive: vi.fn(),
}));

vi.mock("../src/db.js", async () => {
  const schema = await import("../src/schema.js");
  const { getTableColumns } = await import("drizzle-orm");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const fields = new Map(Object.entries(getTableColumns(schema.conversationProjects))
    .map(([field, column]) => [column.name, field]));
  return { db: {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === schema.conversations ? [{
          id: mocks.assignment.conversationId, provider: "codex", externalSessionId: "synthetic-session",
          title: "ThetaArchive 浏览器会话采集", archiveUpdatedAt: new Date("2026-10-26T00:00:00Z"),
        }] : table === schema.projects ? [{
          id: "00000000-0000-4000-8000-000000000002", name: "ThetaArchive 会话归档", description: "浏览器采集和服务端归档",
        }] : table === schema.conversationProjects ? [{ ...mocks.assignment }] : [];
        const query: Record<string, unknown> = {};
        for (const method of ["where", "orderBy", "innerJoin"]) query[method] = () => query;
        query.limit = async () => rows;
        query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: () => ({
        onConflictDoUpdate: (options: { set: Record<string, unknown>; setWhere?: Parameters<typeof dialect.sqlToQuery>[0] }) => {
          if (table !== schema.conversationProjects) throw new Error("Unexpected project creation");
          // Execute the generated conflict predicate against the latest stored row,
          // after the AI request has resumed, just as PostgreSQL does on conflict.
          let allowed = true;
          if (options.setWhere) {
            const query = dialect.sqlToQuery(options.setWhere);
            mocks.guard = query;
            const comparison = /"conversation_projects"\."([^"]+)"\s*(<=|=)\s*\$(\d+)/g;
            const comparisons = [...query.sql.matchAll(comparison)];
            if (query.sql.replace(comparison, "").replace(/\band\b|[()\s]/g, "")) {
              throw new Error(`Unsupported fixture predicate: ${query.sql}`);
            }
            allowed = comparisons.every((match) => {
              const field = fields.get(match[1]!) as keyof typeof mocks.assignment;
              if (!field) throw new Error(`Unknown assignment field: ${match[1]}`);
              const actual = mocks.assignment[field];
              const expected = query.params[Number(match[3]) - 1];
              if (match[2] === "=") return actual === expected;
              if (!(actual instanceof Date)) throw new Error("Expected a timestamp comparison");
              return actual.getTime() <= new Date(expected as string).getTime();
            });
          }
          if (allowed) Object.assign(mocks.assignment, options.set);
          return Promise.resolve();
        },
      }),
    }),
  } };
});

vi.mock("../src/services/settings.js", () => ({
  getSetting: vi.fn(async () => null),
  getBooleanSetting: vi.fn(async () => false),
  getNumberSetting: vi.fn(async (_key: string, fallback: number) => fallback),
}));
vi.mock("../src/services/revision-storage.js", () => ({ loadCurrentConversationArchive: mocks.archive }));
vi.mock("../src/services/redaction.js", () => ({ loadEnabledCustomRedactionRules: async () => [], redactForCloud: async (text: string) => ({ text, replacements: 0 }) }));
vi.mock("../src/services/llm.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/llm.js")>(),
  completeStructured: mocks.complete,
}));
vi.mock("../src/services/tags.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/services/tags.js")>(),
  persistAutoTags: mocks.persistTags,
}));

import { classifyConversation } from "../src/services/analysis.js";

const observedAt = new Date("2026-10-26T00:00:00Z");
const aiProjectId = "00000000-0000-4000-8000-000000000002";
const newerProjectId = "00000000-0000-4000-8000-000000000003";
const response = { project: { projectId: aiProjectId, confidence: 0.99 }, tags: [] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(observedAt);
  Object.assign(mocks.assignment, {
    projectId: null, confidence: 0.5, lockedByUser: false, suggestedName: null,
    updatedAt: new Date("2026-10-25T00:00:00Z"),
  });
  mocks.guard = null;
  mocks.persistTags.mockResolvedValue([]);
  mocks.archive.mockResolvedValue({
    revision: { id: "synthetic-revision", metadataCaptured: true, capturedTitle: "ThetaArchive 浏览器会话采集", capturedAt: observedAt },
    messages: [{ ordinal: 0, role: "user", createdAt: observedAt,
      segments: [{ type: "text", content: "ThetaArchive 会话归档需要统一浏览器采集与服务端保存。" }] }],
  });
});

afterEach(() => vi.useRealTimers());

async function classifyWhile(changeAssignment: () => void) {
  let markStarted!: () => void;
  let resume!: (value: typeof response) => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const paused = new Promise<typeof response>((resolve) => { resume = resolve; });
  mocks.complete.mockImplementation(() => { markStarted(); return paused; });
  const result = classifyConversation(mocks.assignment.conversationId, "full");
  await started;
  changeAssignment();
  resume(response);
  return result;
}

describe("classification assignment races", () => {
  it.each([newerProjectId, null])("preserves a manual lock to %s added while AI is running", async (projectId) => {
    await classifyWhile(() => Object.assign(mocks.assignment, {
      projectId, confidence: 1, lockedByUser: true,
      // The same timestamp also exercises lock protection at clock resolution.
      updatedAt: observedAt,
    }));

    expect(mocks.assignment).toMatchObject({ projectId, confidence: 1, lockedByUser: true, updatedAt: observedAt });
    expect(mocks.guard?.sql).toContain('"conversation_projects"."locked_by_user" =');
    expect(mocks.persistTags).toHaveBeenCalledOnce();
  });

  it("preserves a newer unlocked assignment made while AI is running", async () => {
    const newerAt = new Date(observedAt.getTime() + 1);
    await classifyWhile(() => Object.assign(mocks.assignment, {
      projectId: newerProjectId, confidence: 0.9, lockedByUser: false, updatedAt: newerAt,
    }));

    expect(mocks.assignment).toMatchObject({ projectId: newerProjectId, confidence: 0.9, lockedByUser: false, updatedAt: newerAt });
    expect(mocks.guard?.sql).toContain('"conversation_projects"."updated_at" <=');
    expect(mocks.guard?.params).toEqual([false, observedAt.toISOString()]);
  });

  it.each([new Date("2026-10-25T00:00:00Z"), observedAt])("persists an unchanged unlocked assignment last updated at %s", async (updatedAt) => {
    mocks.assignment.updatedAt = updatedAt;
    await classifyWhile(() => undefined);

    expect(mocks.assignment).toMatchObject({
      projectId: aiProjectId, confidence: 0.99, lockedByUser: false, updatedAt: observedAt,
    });
    expect(mocks.guard).not.toBeNull();
  });
});
