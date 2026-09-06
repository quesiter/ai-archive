import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  selectRows: [] as Array<{ id: string; name: string; archived: boolean }>,
  movedRows: [] as unknown[][],
  lockQueries: [] as SQL[],
  mutationFilters: [] as SQL[],
  updateValues: [] as Array<Record<string, unknown>>,
  operations: [] as string[],
  renameError: null as unknown,
}));

vi.mock("../src/db.js", () => ({
  db: {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      let updateIndex = 0;
      const tx = {
        execute: vi.fn(async (query: SQL) => { mocks.lockQueries.push(query); }),
        select: () => ({
          from: () => ({
            where: () => ({ orderBy: () => ({ for: async () => mocks.selectRows }) }),
          }),
        }),
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: (filter: SQL) => {
              mocks.mutationFilters.push(filter);
              const index = updateIndex++;
              mocks.updateValues.push(values);
              mocks.operations.push(typeof values.name === "string" ? "rename" : "update");
              if (typeof values.name === "string" && mocks.renameError) {
                throw mocks.renameError;
              }
              return { returning: async () => mocks.movedRows[index] ?? [] };
            },
          }),
        }),
        delete: () => ({
          where: async (filter: SQL) => {
            mocks.mutationFilters.push(filter);
            mocks.operations.push("delete");
          },
        }),
      };
      return callback(tx);
    }),
  },
}));

import { mergeProjectIntoProject, mergeProjectsIntoProject } from "../src/services/project-merge.js";
import { db } from "../src/db.js";

const sourceProject = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "源项目",
  archived: false,
};
const targetProject = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "目标项目",
  archived: false,
};
const secondSource = {
  id: "00000000-0000-4000-8000-000000000003",
  name: "另一个源项目",
  archived: true,
};
const dialect = new PgDialect();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.selectRows = [sourceProject, targetProject];
  mocks.movedRows = [
    [{ conversationId: "conversation-1" }],
    [{ id: "report-1" }],
  ];
  mocks.updateValues = [];
  mocks.operations = [];
  mocks.renameError = null;
  mocks.lockQueries = [];
  mocks.mutationFilters = [];
});

describe("project merge", () => {
  it("renames the surviving project in the same transaction", async () => {
    const result = await mergeProjectIntoProject({
      sourceProjectId: sourceProject.id,
      targetProjectId: targetProject.id,
      targetProjectName: "合并后的项目",
    });

    expect(result).toMatchObject({
      targetProjectId: targetProject.id,
      targetProjectName: "合并后的项目",
      movedConversationCount: 1,
      movedReportCount: 1,
    });
    expect(mocks.updateValues.at(-1)).toMatchObject({ name: "合并后的项目" });
    expect(mocks.operations.indexOf("delete")).toBeLessThan(
      mocks.operations.indexOf("rename"),
    );
  });

  it("keeps the target name for older callers that omit a new name", async () => {
    const result = await mergeProjectIntoProject({
      sourceProjectId: sourceProject.id,
      targetProjectId: targetProject.id,
    });

    expect(result?.targetProjectName).toBe("目标项目");
    expect(mocks.updateValues.at(-1)).toMatchObject({ name: "目标项目" });
  });

  it("maps a normalized target-name collision to HTTP 409", async () => {
    mocks.renameError = new Error("Failed query", {
      cause: Object.assign(new Error("duplicate key"), { code: "23505" }),
    });

    await expect(mergeProjectIntoProject({
      sourceProjectId: sourceProject.id,
      targetProjectId: targetProject.id,
      targetProjectName: " 第三项目 ",
    })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("merges all sources once, preserving locks and reporting actual moved rows", async () => {
    mocks.selectRows.push(secondSource);
    mocks.movedRows = [[{ conversationId: "a" }, { conversationId: "b" }], [{ id: "r" }]];
    const result = await mergeProjectsIntoProject({
      sourceProjectIds: [secondSource.id, sourceProject.id, secondSource.id],
      targetProjectId: targetProject.id,
      targetProjectName: "  Ｍｅｒｇｅｄ　Project  ",
    });
    expect(result).toEqual({
      sourceProjectIds: [secondSource.id, sourceProject.id],
      sourceProjectNames: [secondSource.name, sourceProject.name],
      targetProjectId: targetProject.id,
      targetProjectName: "Merged Project",
      movedConversationCount: 2,
      movedReportCount: 1,
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.lockQueries.flatMap((query) => dialect.sqlToQuery(query).params)).toEqual(
      [sourceProject.id, targetProject.id, secondSource.id].map((id) => `project:${id}`),
    );
    for (const filter of mocks.mutationFilters.slice(0, 3)) {
      expect(dialect.sqlToQuery(filter).params).toEqual([secondSource.id, sourceProject.id]);
    }
    expect(mocks.updateValues[0]).toMatchObject({ projectId: targetProject.id, suggestedName: null });
    expect(mocks.updateValues[0]).not.toHaveProperty("lockedByUser");
    expect(mocks.updateValues[0]).not.toHaveProperty("confidence");
    expect(mocks.operations).toEqual(["update", "update", "delete", "rename"]);
  });

  it.each([{ sourceProjectIds: [] }, { sourceProjectIds: [sourceProject.id, targetProject.id] }])("rejects invalid sources before opening a transaction: $sourceProjectIds", async ({ sourceProjectIds }) => {
    await expect(mergeProjectsIntoProject({ sourceProjectIds, targetProjectId: targetProject.id }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it("does not move any data if one source is missing", async () => {
    expect(await mergeProjectsIntoProject({
      sourceProjectIds: [sourceProject.id, secondSource.id],
      targetProjectId: targetProject.id,
    })).toBeNull();
    expect(mocks.operations).toEqual([]);
  });

  it("canonicalizes UUID casing before deduplication and project lookup", async () => {
    const source = { ...sourceProject, id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" };
    const target = { ...targetProject, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    mocks.selectRows = [source, target];
    const result = await mergeProjectsIntoProject({
      sourceProjectIds: [source.id, source.id.toUpperCase()],
      targetProjectId: target.id.toUpperCase(),
    });
    expect(result?.sourceProjectIds).toEqual([source.id]);
    expect(result?.targetProjectId).toBe(target.id);
    await expect(mergeProjectsIntoProject({
      sourceProjectIds: [target.id.toUpperCase()], targetProjectId: target.id,
    })).rejects.toMatchObject({ statusCode: 400 });
  });

  it.each(["missing", "archived"])("does not move data when the target is %s", async (state) => {
    mocks.selectRows = state === "missing"
      ? [sourceProject]
      : [sourceProject, { ...targetProject, archived: true }];
    expect(await mergeProjectsIntoProject({ sourceProjectIds: [sourceProject.id], targetProjectId: targetProject.id })).toBeNull();
    expect(mocks.operations).toEqual([]);
  });

  it.each(["　 \t", "a".repeat(201)])("rejects invalid normalized names before mutations", async (targetProjectName) => {
    await expect(mergeProjectsIntoProject({ sourceProjectIds: [sourceProject.id], targetProjectId: targetProject.id, targetProjectName }))
      .rejects.toMatchObject({ statusCode: 400 });
    expect(mocks.operations).toEqual([]);
  });
});
