import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalog: [] as Array<{
    id: string; name: string; description: string; conversationCount: number;
    conversations: Array<{ id: string; title: string }>; tags: string[];
  }>,
  settings: new Map<string, string>(),
  complete: vi.fn(),
  setSettings: vi.fn(),
  cloudRedaction: vi.fn(async (text: string) => ({ text, replacements: 0 })),
  storageRedaction: vi.fn(async (text: string) => ({ text, replacements: 0 })),
  deletedFilters: [] as SQL[],
  execute: vi.fn(),
}));

vi.mock("../src/db.js", () => ({
  db: {
    execute: mocks.execute,
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: async () => "key" in selection
          ? [...mocks.settings.keys()].filter((key) => key.startsWith("internal.projectMerge.ignored.")).map((key) => ({ key }))
          : mocks.catalog.map((project) => ({ id: project.id })),
      }),
    }),
    delete: () => ({ where: async (filter: SQL) => {
      mocks.deletedFilters.push(filter);
      for (const param of new PgDialect().sqlToQuery(filter).params) if (typeof param === "string") mocks.settings.delete(param);
    } }),
  },
}));
vi.mock("../src/services/settings.js", () => ({
  getSetting: vi.fn(async (key: string) => mocks.settings.get(key) ?? null),
  setSetting: vi.fn(async (key: string, value: string) => { mocks.settings.set(key, value); }),
  setSettings: mocks.setSettings,
}));
vi.mock("../src/services/llm.js", () => ({ completeStructured: mocks.complete }));
vi.mock("../src/services/redaction.js", () => ({
  loadEnabledCustomRedactionRules: vi.fn(async () => []),
  redactForCloud: mocks.cloudRedaction,
  redactForStorage: mocks.storageRedaction,
}));

import {
  analyzeProjectMergeSuggestions,
  buildMergeSuggestionCatalogQuery,
  dismissProjectMergeSuggestion,
  listIgnoredProjectMergeSuggestions,
  listProjectMergeSuggestions,
  restoreProjectMergeSuggestion,
  validateAiMergePairs,
  validateAiMergeGroups,
} from "../src/services/project-merge-suggestions.js";
import {
  projectCatalogFingerprint,
  projectPairKey,
  type MergeCandidateProject,
} from "../src/services/project-merge-candidates.js";
import * as mergeCandidates from "../src/services/project-merge-candidates.js";

const leftId = "abcdef00-0000-4000-8000-000000000001";
const rightId = "abcdef00-0000-4000-8000-000000000002";
const thirdId = "abcdef00-0000-4000-8000-000000000003";
const prefix = "internal.projectMerge.";
const cacheKey = `${prefix}aiCache`;
const page = { limit: 8, offset: 0 };
const dialect = new PgDialect();

function catalog(): MergeCandidateProject[] {
  return [
    { id: leftId, name: "归藏", description: "跨平台会话归档", conversationCount: 8,
      conversations: [{ id: "main-a", title: "浏览器采集器正文完整性" }], tags: ["归档"] },
    { id: rightId, name: "ArchiveDesk", description: "本地聊天历史整合", conversationCount: 2,
      conversations: [{ id: "main-b", title: "命令行代理历史接入" }], tags: ["归档"] },
  ];
}

function aiPair() {
  return {
    projectIds: [leftId, rightId] as [string, string], level: "high" as const,
    reason: "两种入口共同构成会话存档产品，值得核对别名",
    evidence: [
      { projectId: leftId, quote: "跨平台会话归档" },
      { projectId: rightId, quote: "本地聊天历史整合" },
    ],
  };
}

function modelPair() {
  return {
    ...aiPair(), projectIds: ["p0", "p1"] as [string, string],
    evidence: aiPair().evidence.map((item, index) => ({ ...item, projectId: `p${index}` })),
  };
}

function cachedGroups() {
  const metadata = JSON.parse(mocks.settings.get(cacheKey)!);
  return metadata.groupKeys.map((key: string) => JSON.parse(mocks.settings.get(key)!)) as ReturnType<typeof aiPair>[];
}

function addThird(count = 3) {
  mocks.catalog.push({ ...catalog()[0]!, id: thirdId, name: "会话材料工作台", description: "统一导入并检索聊天材料", conversationCount: count });
}

type ModelInput = { projects: Array<{ id: string; name: string; description?: string; titles?: string[]; tags?: string[] }>; keepSeparatePairs: Array<[string, string]> };

function saveCache(fingerprint = projectCatalogFingerprint(mocks.catalog)) {
  mocks.settings.set(cacheKey, JSON.stringify({
    version: 1, fingerprint, generatedAt: "2026-10-26T00:00:00.000Z", pairs: [aiPair()],
  }));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.catalog = catalog();
  mocks.settings = new Map([
    ["llm.baseUrl", "https://llm.example/v1"], ["llm.apiKey", "configured-secret"], ["llm.model", "model"],
  ]);
  mocks.deletedFilters = [];
  mocks.execute.mockImplementation(async () => mocks.catalog);
  mocks.complete.mockResolvedValue({ groups: [] });
  mocks.setSettings.mockImplementation(async (values: ReadonlyArray<readonly [string, string]>) => {
    for (const [, value] of values) if (value.length > 20_000) throw new Error("Setting exceeds 20k");
    for (const [key, value] of values) mocks.settings.set(key, value);
  });
  mocks.cloudRedaction.mockImplementation(async (text: string) => ({ text, replacements: 0 }));
  mocks.storageRedaction.mockImplementation(async (text: string) => ({ text, replacements: 0 }));
});

describe("project merge discovery service", () => {
  it("samples each active project's main conversations separately and excludes deleted source records", () => {
    const query = dialect.sqlToQuery(buildMergeSuggestionCatalogQuery()).sql;
    expect(query).toContain("with memberships as materialized");
    expect(query).toContain("group by ancestry.project_id, ancestry.id");
    expect(query).toContain("row_number() over (partition by membership.project_id");
    expect(query).toContain("from ranked_titles where position <= 5");
    expect(query).toContain("source.deleted_at is null");
    expect(query).toContain("where not project.archived");
    expect(query).toContain("from ranked_tags where position <= 8");
    expect(query).not.toMatch(/limit\s+\d+/i);
  });

  it("includes fresh semantic candidates using current project details and total counts", async () => {
    saveCache();
    const result = await listProjectMergeSuggestions(page);
    expect(result.ai).toMatchObject({ available: true, cached: true, stale: false });
    const candidate = result.items.find((item) => item.source === "ai");
    expect(candidate).toMatchObject({ targetProjectId: leftId, level: "high" });
    expect(candidate?.projects.map((project) => project.conversationCount)).toEqual([8, 2]);
    expect(candidate?.reasons).toContain(aiPair().reason);
    expect(result.scannedProjectCount).toBe(2);
    expect(result.pagination.total).toBe(result.items.length);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("hides cached semantic evidence after the catalog changes instead of attaching it to new contents", async () => {
    saveCache("old-catalog");
    const result = await listProjectMergeSuggestions(page);
    expect(result.ai).toMatchObject({ cached: false, stale: true });
    expect(result.items.some((item) => item.source === "ai")).toBe(false);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("keeps an ignored pair hidden from both local and semantic results across reversed selections", async () => {
    mocks.catalog[1]!.name = "归藏 V2";
    mocks.catalog[1]!.description = mocks.catalog[0]!.description;
    saveCache();
    expect((await listProjectMergeSuggestions(page)).items.length).toBeGreaterThan(0);
    await dismissProjectMergeSuggestion([rightId, leftId]);
    expect(mocks.settings.get(`${prefix}ignored.${projectPairKey([leftId, rightId])}`)).toBe("independent");
    const result = await listProjectMergeSuggestions(page);
    expect(result.items).toEqual([]);
    expect(result.ignoredCount).toBe(1);
    await expect(listIgnoredProjectMergeSuggestions()).resolves.toEqual([{
      projectIds: [leftId, rightId], projectNames: ["归藏", "归藏 V2"],
    }]);
    await restoreProjectMergeSuggestion([rightId, leftId]);
    expect(dialect.sqlToQuery(mocks.deletedFilters[0]!).params).toContain(`${prefix}ignored.${projectPairKey([leftId, rightId])}`);
  });

  it("does not return removed or archived pairs as reviewable decisions", async () => {
    mocks.settings.set(`${prefix}ignored.${projectPairKey([leftId, thirdId])}`, "independent");
    const result = await listProjectMergeSuggestions(page);
    expect(result.ignoredCount).toBe(0);
    await expect(listIgnoredProjectMergeSuggestions()).resolves.toEqual([]);
  });

  it("reuses local discovery for paging and review decisions and invalidates it when project materials change", async () => {
    mocks.catalog[0]!.name = "缓存验证独立项目甲";
    const discovery = vi.spyOn(mergeCandidates, "findProjectMergeCandidates");
    try {
      await listProjectMergeSuggestions(page);
      await listProjectMergeSuggestions({ limit: 8, offset: 8 });
      await dismissProjectMergeSuggestion([leftId, rightId]);
      await listProjectMergeSuggestions(page);
      await listIgnoredProjectMergeSuggestions();
      expect(discovery).toHaveBeenCalledTimes(1);
      mocks.catalog[0]!.description = "项目内容已发生改变";
      await listProjectMergeSuggestions(page);
      expect(discovery).toHaveBeenCalledTimes(2);
    } finally { discovery.mockRestore(); }
  });

  it("only retains model pairs with distinct known projects and exact evidence from both sides", () => {
    const valid = aiPair();
    const differentProject = { ...valid, projectIds: [leftId, thirdId] as [string, string] };
    const self = { ...valid, projectIds: [leftId, leftId] as [string, string] };
    const invented = { ...valid, evidence: [{ projectId: leftId, quote: "不存在的原文" }, valid.evidence[1]!] };
    const thirdParty = { ...valid, evidence: [{ projectId: thirdId, quote: valid.evidence[0]!.quote }, valid.evidence[1]!] };
    const missingSide = { ...valid, evidence: [valid.evidence[0]!, valid.evidence[0]!] };
    const reversed = { ...valid, projectIds: [rightId.toUpperCase(), leftId.toUpperCase()] as [string, string] };
    expect(validateAiMergePairs([differentProject, self, invented, thirdParty, missingSide, valid, reversed], mocks.catalog)).toEqual([valid]);
  });

  it("saves validated AI evidence with the full catalog fingerprint after successful explicit discovery", async () => {
    mocks.complete.mockResolvedValue({ groups: [modelPair()] });
    await analyzeProjectMergeSuggestions();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(mocks.cloudRedaction).toHaveBeenCalled();
    expect(mocks.storageRedaction).toHaveBeenCalled();
    const saved = JSON.parse(mocks.settings.get(cacheKey)!);
    expect(saved).toMatchObject({ version: 2, fingerprint: projectCatalogFingerprint(mocks.catalog) });
    expect(cachedGroups()).toEqual([aiPair()]);
    expect(new Date(saved.generatedAt).toISOString()).toBe(saved.generatedAt);
  });

  it("preserves the previous cache when the model fails, and allows a later retry", async () => {
    saveCache();
    const before = mocks.settings.get(cacheKey);
    mocks.complete.mockRejectedValueOnce(new Error("Model unavailable"));
    await expect(analyzeProjectMergeSuggestions()).rejects.toThrow("Model unavailable");
    expect(mocks.settings.get(cacheKey)).toBe(before);
    mocks.complete.mockResolvedValueOnce({ groups: [modelPair()] });
    await expect(analyzeProjectMergeSuggestions()).resolves.toBeUndefined();
    expect(mocks.complete).toHaveBeenCalledTimes(2);
  });

  it("keeps JSON valid and project identities intact when redaction introduces quotes and newlines", async () => {
    mocks.cloudRedaction.mockImplementation(async (text: string) => ({
      text: text.replace("跨平台会话归档", '跨平台"会话"\n归档'), replacements: 1,
    }));
    mocks.storageRedaction.mockImplementation(async (text: string) => ({
      text: text.replace("值得核对", '值得"核对"\n'), replacements: 1,
    }));
    mocks.complete.mockImplementation(async (input: { user: string }) => {
      const supplied = (JSON.parse(input.user) as ModelInput).projects;
      expect(supplied.map((project) => project.id)).toEqual(["p0", "p1"]);
      expect(supplied[0]!.titles).toEqual(["浏览器采集器正文完整性"]);
      expect(input.user).not.toContain("main-a");
      expect(input.user).not.toContain(leftId);
      expect(supplied[0]!.description).toContain('"会话"\n');
      return { groups: [{ ...modelPair(), evidence: supplied.map((project) => ({ projectId: project.id, quote: project.description! })) }] };
    });
    await analyzeProjectMergeSuggestions();
    const cached = cachedGroups();
    expect(cached[0]!.projectIds).toEqual([leftId, rightId]);
    expect(cached[0]!.reason).toContain('值得"核对"\n');
    expect((await listProjectMergeSuggestions(page)).items.some((candidate) => candidate.source === "ai")).toBe(true);
  });

  it("keeps expanded storage redaction readable beyond the model's shorter output limits", async () => {
    const expandedReason = `已脱敏说明${"长".repeat(300)}`;
    const expandedQuote = `已脱敏证据${"长".repeat(140)}`;
    mocks.complete.mockResolvedValue({ groups: [modelPair()] });
    mocks.storageRedaction.mockImplementation(async (text: string) => ({
      text: text === aiPair().reason ? expandedReason : expandedQuote, replacements: 1,
    }));
    await analyzeProjectMergeSuggestions();
    const cache = cachedGroups();
    expect(cache[0]!.reason.length).toBeGreaterThan(220);
    expect(cache[0]!.evidence[0]!.quote.length).toBeGreaterThan(100);
    const listed = await listProjectMergeSuggestions(page);
    expect(listed.ai.cached).toBe(true);
    const candidate = listed.items.find((item) => item.source === "ai");
    expect(candidate?.reasons).toContain(expandedReason);
    expect(candidate?.reasons.some((reason) => reason.includes(expandedQuote))).toBe(true);
  });

  it("rejects redaction expansion beyond the request budget before calling the model", async () => {
    saveCache();
    const before = mocks.settings.get(cacheKey);
    mocks.cloudRedaction.mockImplementation(async (text: string) => ({
      text: `${text}${"脱".repeat(61_000)}`, replacements: 1,
    }));
    await expect(analyzeProjectMergeSuggestions()).rejects.toMatchObject({ statusCode: 422 });
    expect(mocks.cloudRedaction).toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.settings.get(cacheKey)).toBe(before);
  });

  it("supplies active keep-separate decisions to the model and rejects their reintroduction", async () => {
    const keptSeparate = projectPairKey([rightId, leftId]);
    mocks.settings.set(`${prefix}ignored.${keptSeparate}`, "independent");
    mocks.settings.set(`${prefix}ignored.${projectPairKey([leftId, thirdId])}`, "independent");
    mocks.complete.mockImplementation(async (input: { user: string }) => {
      const supplied = JSON.parse(input.user) as ModelInput;
      expect(supplied.keepSeparatePairs).toEqual([["p0", "p1"]]);
      expect(supplied.projects.map((project) => project.id)).toEqual(["p0", "p1"]);
      return { groups: [modelPair()] };
    });
    await analyzeProjectMergeSuggestions();
    expect(cachedGroups()).toEqual([]);
    expect(mocks.settings.get(`${prefix}ignored.${keptSeparate}`)).toBe("independent");
    expect((await listProjectMergeSuggestions(page)).items).toEqual([]);
  });

  it("rejects a concurrent semantic request and clears the guard after the in-flight one fails", async () => {
    const request = deferred<{ groups: ReturnType<typeof aiPair>[] }>();
    const entered = deferred<void>();
    mocks.complete.mockImplementationOnce(() => { entered.resolve(); return request.promise; });
    const first = analyzeProjectMergeSuggestions().catch((error: unknown) => error);
    await entered.promise;
    await expect(analyzeProjectMergeSuggestions()).rejects.toMatchObject({ statusCode: 409 });
    request.reject(new Error("Interrupted model request"));
    expect(await first).toMatchObject({ message: "Interrupted model request" });
    mocks.complete.mockResolvedValueOnce({ groups: [] });
    await expect(analyzeProjectMergeSuggestions()).resolves.toBeUndefined();
  });

  it("compresses contextual excerpts to keep every project name when full profiles exceed the budget", async () => {
    mocks.catalog = Array.from({ length: 400 }, (_, index) => ({
      ...catalog()[0]!, id: `abcdef00-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `项目${index}`, description: "详".repeat(240),
      conversations: Array.from({ length: 3 }, (_unused, position) => ({ id: `session-${index}-${position}`, title: "题".repeat(160) })),
    }));
    expect(JSON.stringify(mocks.catalog).length).toBeGreaterThan(120_000);
    mocks.complete.mockImplementation(async (input: { user: string }) => {
      const supplied = JSON.parse(input.user) as ModelInput;
      expect(input.user.length).toBeLessThanOrEqual(120_000);
      expect(supplied.projects).toHaveLength(400);
      expect(supplied.projects.map((project) => project.name)).toEqual(mocks.catalog.map((project) => project.name));
      return { groups: [] };
    });
    await expect(analyzeProjectMergeSuggestions()).resolves.toBeUndefined();
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(cachedGroups()).toEqual([]);
  });

  it("reports a names-only catalog overflow without calling the model or silently omitting projects", async () => {
    mocks.catalog = Array.from({ length: 1000 }, (_, index) => ({
      ...catalog()[0]!, id: `abcdef00-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `${"项目".repeat(98)}${String(index).padStart(4, "0")}`,
    }));
    await expect(analyzeProjectMergeSuggestions()).rejects.toMatchObject({ statusCode: 422 });
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.settings.has(cacheKey)).toBe(false);
  });

  it("rejects quotations from a long original description that were not present in the compressed request", async () => {
    const hiddenQuote = "这一段没有发送给模型";
    mocks.catalog = Array.from({ length: 1972 }, (_, index) => ({
      id: `abcdef00-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `归档项目${index}`, description: `${"内容".repeat(90)}${hiddenQuote}${"续".repeat(30)}`,
      conversationCount: 1, conversations: [], tags: [],
    }));
    mocks.complete.mockImplementation(async (input: { user: string }) => {
      const supplied = JSON.parse(input.user) as ModelInput;
      expect(supplied.projects).toHaveLength(1972);
      expect(supplied.projects[0]?.description ?? "").not.toContain(hiddenQuote);
      return { groups: [{ ...modelPair(), evidence: [
        { projectId: "p0", quote: hiddenQuote }, { projectId: "p1", quote: hiddenQuote },
      ] }] };
    });
    await analyzeProjectMergeSuggestions();
    expect(cachedGroups()).toEqual([]);
  });

  it("skips model calls when fewer than two active projects exist", async () => {
    mocks.catalog = mocks.catalog.slice(0, 1);
    await analyzeProjectMergeSuggestions();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.settings.has(cacheKey)).toBe(false);
  });

  it("marks semantic discovery unavailable when a model credential is missing", async () => {
    mocks.settings.delete("llm.apiKey");
    const result = await listProjectMergeSuggestions(page);
    expect(result.ai.available).toBe(false);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("excludes empty projects from both matching and the AI prompt, with a separate count", async () => {
    addThird(0);
    const result = await listProjectMergeSuggestions(page);
    expect(result.scannedProjectCount).toBe(2);
    expect(result.emptyProjectCount).toBe(1);
    expect(result.items.every((group) => group.projects.every((project) => project.conversationCount > 0))).toBe(true);
    mocks.complete.mockImplementation(async (input: { user: string }) => {
      const supplied = JSON.parse(input.user) as ModelInput;
      expect(supplied.projects).toHaveLength(2);
      expect(input.user).not.toContain("会话材料工作台");
      return { groups: [modelPair()] };
    });
    await analyzeProjectMergeSuggestions();
    expect(cachedGroups()[0]!.projectIds).toEqual([leftId, rightId]);
  });

  it("shows a validated three-project semantic identity as one card instead of repeated pairs", async () => {
    addThird();
    mocks.complete.mockResolvedValue({ groups: [{
      ...modelPair(), projectIds: ["p0", "p1", "p2"],
      evidence: [...modelPair().evidence, { projectId: "p2", quote: mocks.catalog[2]!.description }],
    }] });
    await analyzeProjectMergeSuggestions();
    const result = await listProjectMergeSuggestions(page);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.projects).toHaveLength(3);
    expect(result.items[0]!.targetProjectId).toBe(leftId);
    expect(result.items[0]!.evidence).toHaveLength(2);
  });

  it("atomically saves every internal pair of a three-way independent decision and restores all of them", async () => {
    addThird();
    mocks.catalog = mocks.catalog.map((project) => ({ ...project, name: "归藏会话档案", description: "统一跨平台对话归档产品" }));
    expect((await listProjectMergeSuggestions(page)).items[0]!.projects).toHaveLength(3);
    await dismissProjectMergeSuggestion([thirdId, rightId, leftId]);
    const expected = [[leftId, rightId], [leftId, thirdId], [rightId, thirdId]].map((ids) => `${prefix}ignored.${projectPairKey(ids)}`);
    expect(mocks.setSettings).toHaveBeenCalledOnce();
    expect(mocks.setSettings.mock.calls[0]![0].map(([key]: [string, string]) => key).sort()).toEqual(expected.sort());
    expect((await listProjectMergeSuggestions(page)).items).toEqual([]);
    expect(await listIgnoredProjectMergeSuggestions()).toHaveLength(3);
    await restoreProjectMergeSuggestion([thirdId, leftId, rightId]);
    expect(expected.every((key) => !mocks.settings.has(key))).toBe(true);
    expect((await listProjectMergeSuggestions(page)).items[0]!.projects).toHaveLength(3);
  });

  it("requires a known nonempty project and exact quotation for every semantic group member", () => {
    addThird();
    const group = { ...aiPair(), projectIds: [leftId, rightId, thirdId], evidence: [...aiPair().evidence, { projectId: thirdId, quote: mocks.catalog[2]!.description }] };
    const valid = validateAiMergeGroups([
      { ...group, evidence: aiPair().evidence },
      { ...group, projectIds: [leftId, rightId, "missing"] },
      { ...group, evidence: [...aiPair().evidence, { projectId: thirdId, quote: "并未提供的原文" }] },
      { ...group, projectIds: [leftId, rightId, rightId] },
      group,
    ], mocks.catalog);
    expect(valid).toHaveLength(1);
    expect(new Set(valid[0]!.projectIds)).toEqual(new Set(group.projectIds));
    mocks.catalog[2]!.conversationCount = 0;
    expect(validateAiMergeGroups([group], mocks.catalog)).toEqual([]);
  });

  it("stores large multi-project results as bounded immutable chunks in one atomic settings update", async () => {
    mocks.catalog = Array.from({ length: 100 }, (_, index) => ({
      ...catalog()[0]!, id: `abcdef00-0000-4000-8000-${String(index).padStart(12, "0")}`,
      name: `具体归档应用${index}`, description: `项目依据${"文".repeat(96)}`,
    }));
    mocks.complete.mockImplementation(async (input: { user: string }) => {
      const supplied = (JSON.parse(input.user) as ModelInput).projects;
      return { groups: Array.from({ length: 20 }, (_, groupIndex) => {
        const members = supplied.slice(groupIndex * 5, groupIndex * 5 + 5);
        return { level: "high", reason: "相同产品的资料来源。".repeat(20), projectIds: members.map((project) => project.id),
          evidence: members.map((project) => ({ projectId: project.id, quote: project.description! })) };
      }) };
    });
    await analyzeProjectMergeSuggestions();
    expect(mocks.setSettings).toHaveBeenCalledOnce();
    const metadata = JSON.parse(mocks.settings.get(cacheKey)!);
    expect(metadata).toMatchObject({ version: 2, fingerprint: projectCatalogFingerprint(mocks.catalog) });
    expect(metadata.groupKeys).toHaveLength(20);
    expect(cachedGroups()).toHaveLength(20);
    const values = mocks.setSettings.mock.calls[0]![0] as Array<[string, string]>;
    expect(values.every(([, value]) => value.length <= 20_000)).toBe(true);
    expect(values.reduce((sum, [, value]) => sum + value.length, 0)).toBeGreaterThan(20_000);
    expect((await listProjectMergeSuggestions(page)).ai.cached).toBe(true);
  });

  it("does not expose an incomplete group-cache manifest as a successful cached analysis", async () => {
    mocks.settings.set(cacheKey, JSON.stringify({ version: 2, fingerprint: projectCatalogFingerprint(mocks.catalog), generatedAt: "2026-10-26T00:00:00Z", groupKeys: [`${prefix}aiCacheGroup.abcdef00-0000-4000-8000-000000000099.0`] }));
    const result = await listProjectMergeSuggestions(page);
    expect(result.ai.cached).toBe(false);
    expect(result.items.some((item) => item.source === "ai")).toBe(false);
  });

  it("preserves previous cache metadata on atomic-write failure and permits a later retry", async () => {
    saveCache();
    const before = mocks.settings.get(cacheKey);
    mocks.complete.mockResolvedValue({ groups: [modelPair()] });
    mocks.setSettings.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(analyzeProjectMergeSuggestions()).rejects.toThrow("Database unavailable");
    expect(mocks.settings.get(cacheKey)).toBe(before);
    await expect(analyzeProjectMergeSuggestions()).resolves.toBeUndefined();
    expect(cachedGroups()[0]!.projectIds).toEqual([leftId, rightId]);
  });

  it("skips semantic analysis when only one project has conversations even if many empty names remain", async () => {
    mocks.catalog[1]!.conversationCount = 0;
    addThird(0);
    await analyzeProjectMergeSuggestions();
    expect(mocks.complete).not.toHaveBeenCalled();
    expect(mocks.settings.has(cacheKey)).toBe(false);
  });
});
