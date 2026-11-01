import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  locked: true,
  assignedProjectId: "00000000-0000-4000-8000-000000000001" as string | null,
  inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  complete: vi.fn(),
  persistTags: vi.fn(),
  archive: vi.fn(),
}));

vi.mock("../src/db.js", async () => {
  const schema = await import("../src/schema.js");
  return { db: {
    select: () => ({
      from: (table: unknown) => {
        const rows = table === schema.conversations ? [{
          id: "00000000-0000-4000-8000-000000000010", provider: "codex", externalSessionId: "synthetic-session",
          title: "ThetaArchive 浏览器会话采集", archiveUpdatedAt: new Date("2026-10-26T00:00:00Z"),
        }] : table === schema.projects ? [{
          id: "00000000-0000-4000-8000-000000000001", name: "家庭医疗跟踪", description: "",
        }] : table === schema.conversationProjects ? [{
          conversationId: "00000000-0000-4000-8000-000000000010",
          projectId: mocks.assignedProjectId, confidence: 1,
          lockedByUser: mocks.locked, suggestedName: "人工保留的项目建议", updatedAt: new Date("2026-10-26T00:00:00Z"),
        }] : [];
        const query: Record<string, unknown> = {};
        for (const method of ["where", "orderBy", "innerJoin"]) query[method] = () => query;
        query.limit = async () => rows;
        query.then = (resolve: (value: unknown) => unknown) => Promise.resolve(rows).then(resolve);
        return query;
      },
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        mocks.inserts.push({ table, values });
        return { onConflictDoUpdate: () => ({
          returning: async () => [{ id: "00000000-0000-4000-8000-000000000002" }],
          then: (resolve: (value: undefined) => unknown) => Promise.resolve(undefined).then(resolve),
        }) };
      },
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
import { conversationProjects, projects } from "../src/schema.js";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.locked = true;
  mocks.assignedProjectId = "00000000-0000-4000-8000-000000000001";
  mocks.inserts = [];
  mocks.complete.mockResolvedValue({
    project: { projectId: null, suggestedProjectName: "ThetaArchive 会话归档", confidence: 0.99 },
    tags: [{ name: "浏览器采集", confidence: 0.96 }],
  });
  mocks.persistTags.mockResolvedValue([{ id: "synthetic-tag" }]);
  mocks.archive.mockResolvedValue({
    revision: { id: "synthetic-revision", metadataCaptured: true, capturedTitle: "ThetaArchive 浏览器会话采集", capturedAt: new Date("2026-10-26T00:00:00Z") },
    messages: [{ ordinal: 0, role: "user", createdAt: new Date("2026-10-26T00:00:00Z"),
      segments: [{ type: "text", content: "ThetaArchive 会话归档需要统一浏览器采集与服务端保存。" }] }],
  });
});

describe("classification with a manually locked project", () => {
  it("does not create an unused suggested project while continuing to classify tags", async () => {
    const result = await classifyConversation("00000000-0000-4000-8000-000000000010", "full");

    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      projectId: mocks.assignedProjectId, suggestedName: "人工保留的项目建议",
      reason: "locked", confidence: 1, usedAi: true, tagCount: 1,
    });
    expect(mocks.inserts.some((write) => write.table === projects || write.table === conversationProjects)).toBe(false);
    expect(mocks.persistTags).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000010", [{ name: "浏览器采集", confidence: 0.96 }]);
  });

  it("preserves a manually locked unclassified conversation without creating a project", async () => {
    mocks.assignedProjectId = null;
    const result = await classifyConversation("00000000-0000-4000-8000-000000000010", "full");

    expect(result).toMatchObject({ projectId: null, reason: "locked", tagCount: 1 });
    expect(mocks.inserts).toEqual([]);
    expect(mocks.persistTags).toHaveBeenCalledOnce();
  });

  it("still creates and assigns a sufficiently confident new project after the manual lock is released", async () => {
    mocks.locked = false;
    const result = await classifyConversation("00000000-0000-4000-8000-000000000010", "full");

    expect(result).toMatchObject({ projectId: "00000000-0000-4000-8000-000000000002", reason: "new", tagCount: 1 });
    expect(mocks.inserts.find((write) => write.table === projects)?.values).toMatchObject({ name: "ThetaArchive 会话归档" });
    expect(mocks.inserts.find((write) => write.table === conversationProjects)?.values).toMatchObject({
      projectId: "00000000-0000-4000-8000-000000000002", lockedByUser: false,
    });
    expect(mocks.persistTags).toHaveBeenCalledOnce();
  });
});
