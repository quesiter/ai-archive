import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as Array<{ key: string; value: string; encrypted: boolean }>,
}));
vi.mock("../src/db.js", () => ({
  db: { select: () => ({ from: async () => mocks.rows }) },
}));

import { getPublicSettings } from "../src/services/settings.js";

beforeEach(() => { mocks.rows = []; });

describe("project merge review settings visibility", () => {
  it("keeps review decisions and semantic caches out of the public settings response", async () => {
    mocks.rows = [
      { key: "internal.projectMerge.ignored.project-a:project-b", value: "keep separate", encrypted: false },
      { key: "internal.projectMerge.aiCache", value: "private candidate evidence", encrypted: false },
      { key: "classification.autoReclassify", value: "true", encrypted: false },
      { key: "llm.model", value: "configured-model", encrypted: false },
    ];
    await expect(getPublicSettings()).resolves.toEqual({
      "classification.autoReclassify": "true",
      "llm.model": "configured-model",
    });
  });

  it("continues masking configured credentials and preserving empty ones", async () => {
    mocks.rows = [
      { key: "llm.apiKey", value: "encrypted-api-key", encrypted: true },
      { key: "smtp.password", value: "", encrypted: true },
      { key: "internal.projectMerge.futureRecord", value: "hidden", encrypted: false },
    ];
    const result = await getPublicSettings();
    expect(result).toEqual({ "llm.apiKey": "********", "smtp.password": "" });
    expect(JSON.stringify(result)).not.toContain("encrypted-api-key");
  });
});
