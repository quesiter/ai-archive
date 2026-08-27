import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  updateValues: [] as Array<Record<string, unknown>>,
  operations: [] as string[],
  renameError: null as unknown,
}));

vi.mock("../src/db.js", () => ({
  db: {
    transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
      let selectIndex = 0;
      const tx = {
        execute: vi.fn(async () => undefined),
        select: () => {
          const currentIndex = selectIndex++;
          return {
            from: () => ({
              where: () => currentIndex < 2
                ? { limit: async () => mocks.selectRows[currentIndex] ?? [] }
                : Promise.resolve(mocks.selectRows[currentIndex] ?? []),
            }),
          };
        },
        update: () => ({
          set: (values: Record<string, unknown>) => ({
            where: async () => {
              mocks.updateValues.push(values);
              mocks.operations.push(typeof values.name === "string" ? "rename" : "update");
              if (typeof values.name === "string" && mocks.renameError) {
                throw mocks.renameError;
              }
            },
          }),
        }),
        delete: () => ({
          where: async () => {
            mocks.operations.push("delete");
          },
        }),
      };
      return callback(tx);
    }),
  },
}));

import { mergeProjectIntoProject } from "../src/services/project-merge.js";

const sourceProject = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "源项目",
};
const targetProject = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "目标项目",
};

beforeEach(() => {
  mocks.selectRows = [
    [sourceProject],
    [targetProject],
    [{ conversationId: "conversation-1" }],
    [{ id: "report-1" }],
  ];
  mocks.updateValues = [];
  mocks.operations = [];
  mocks.renameError = null;
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
    mocks.renameError = Object.assign(new Error("duplicate key"), { code: "23505" });

    await expect(mergeProjectIntoProject({
      sourceProjectId: sourceProject.id,
      targetProjectId: targetProject.id,
      targetProjectName: " 第三项目 ",
    })).rejects.toMatchObject({ statusCode: 409 });
  });
});
