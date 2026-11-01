import { describe, expect, it } from "vitest";
import type { MergeCandidateProject } from "../src/services/project-merge-candidates.js";
import {
  buildProjectMergeAiCatalog,
  expandProjectMergeAiPairs,
  expandProjectMergeAiGroups,
  type ProjectMergeAiAliasPair,
} from "../src/services/project-merge-ai-catalog.js";

function project(index: number, overrides: Partial<MergeCandidateProject> = {}): MergeCandidateProject {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    name: `知识归档示例项目 ${index}`,
    description: `这是示例 ${index} 的浏览器归档系统，保存对话与项目历史。`.repeat(8),
    conversationCount: 3,
    conversations: [0, 1, 2].map((position) => ({ id: `session-${index}-${position}`, title: `核对示例 ${index} 归档完整性与插件同步 ${position}` })),
    tags: ["会话归档", "浏览器采集", "历史检索"],
    ...overrides,
  };
}

describe("compact AI project catalog", () => {
  it("keeps all 1972 full names and fairly budgeted context within one request", () => {
    const catalog = Array.from({ length: 1972 }, (_, index) => project(index));
    const result = buildProjectMergeAiCatalog(catalog);
    const input = JSON.parse(result.user);
    expect(result.user.length).toBeLessThanOrEqual(120_000);
    expect(input.projects).toHaveLength(1972);
    expect(input.projects.map((item: { name: string }) => item.name)).toEqual(catalog.map((item) => item.name));
    expect(input.projects.every((item: { description?: string }) => Boolean(item.description))).toBe(true);
    const lengths = input.projects.map((item: { description: string }) => [...item.description].length);
    expect(new Set(lengths).size).toBe(1);
    expect(result.aliases.size).toBe(1972);
    expect(result.user).not.toContain(catalog[0]!.id);
    expect(result.aliases.get("p1971")).toBe(catalog[1971]!.id);
  });

  it("includes richer context for smaller catalogs without splitting Unicode", () => {
    const catalog = [project(1, { name: '相框“家庭”😀\\第一版\n项目', description: "😀".repeat(250) })];
    const input = JSON.parse(buildProjectMergeAiCatalog(catalog).user);
    expect(input.projects[0].name).toBe(catalog[0]!.name);
    expect([...input.projects[0].description]).toHaveLength(240);
    expect(input.projects[0].titles).toHaveLength(3);
    expect(input.projects[0].tags).toEqual(catalog[0]!.tags);
    expect(input.projects[0].description).not.toContain("\ufffd");
  });

  it("uses a title as context for projects with no description", () => {
    const catalog = [project(1, { description: "" })];
    const input = JSON.parse(buildProjectMergeAiCatalog(catalog).user);
    expect(input.projects[0].description).toBeUndefined();
    expect(input.projects[0].titles).toEqual(catalog[0]!.conversations.map((item) => item.title));
  });

  it("sorts aliases stably and maps only active distinct ignored pairs", () => {
    const a = project(1), b = project(2), missing = project(3);
    const ignored = new Set([`${a.id}:${b.id}`, `${a.id}:${missing.id}`, `${a.id}:${a.id}`, "not-a-pair"]);
    const forward = buildProjectMergeAiCatalog([a, b], ignored);
    const reversed = buildProjectMergeAiCatalog([b, a], ignored);
    expect(reversed.user).toBe(forward.user);
    expect([...reversed.aliases]).toEqual([...forward.aliases]);
    expect(JSON.parse(forward.user).keepSeparatePairs).toEqual([["p0", "p1"]]);
  });

  it("never truncates project names and explicitly rejects an oversized minimum", () => {
    const catalog = [project(1, { name: "具体名称".repeat(50) }), project(2)];
    expect(() => buildProjectMergeAiCatalog(catalog, new Set(), 50)).toThrowError(expect.objectContaining({ statusCode: 422 }));
    const minimum = JSON.stringify({ projects: catalog.map((item, index) => ({ id: `p${index}`, name: item.name })), keepSeparatePairs: [] });
    const input = JSON.parse(buildProjectMergeAiCatalog(catalog, new Set(), minimum.length).user);
    expect(input.projects).toEqual(catalog.map((item, index) => ({ id: `p${index}`, name: item.name })));
  });

  it("accounts for JSON escaping and ignored pair overhead in the actual limit", () => {
    const catalog = [project(1, { name: '"\\\n'.repeat(25) }), project(2)];
    const ignored = new Set([`${catalog[0]!.id}:${catalog[1]!.id}`]);
    const result = buildProjectMergeAiCatalog(catalog, ignored, 400);
    expect(result.user.length).toBeLessThanOrEqual(400);
    expect(JSON.parse(result.user).projects.map((item: { name: string }) => item.name)).toEqual(catalog.map((item) => item.name));
    expect(JSON.parse(result.user).keepSeparatePairs).toEqual([["p0", "p1"]]);
  });

  it("expands known aliases while preserving reasons and exact quotations", () => {
    const a = project(1), b = project(2);
    const aliases = buildProjectMergeAiCatalog([a, b]).aliases;
    const pair: ProjectMergeAiAliasPair = {
      projectIds: ["p0", "p1"], level: "medium", reason: "可能是同一项目",
      evidence: [{ projectId: "p0", quote: a.name }, { projectId: "p1", quote: b.name }],
    };
    expect(expandProjectMergeAiPairs([pair], aliases)).toEqual([{
      ...pair, projectIds: [a.id, b.id],
      evidence: [{ projectId: a.id, quote: a.name }, { projectId: b.id, quote: b.name }],
    }]);
    expect(pair.projectIds).toEqual(["p0", "p1"]);
  });

  it("rejects unknown, self and third-project aliases before later quotation checks", () => {
    const catalog = [project(1), project(2), project(3)];
    const aliases = buildProjectMergeAiCatalog(catalog).aliases;
    const base: ProjectMergeAiAliasPair = { projectIds: ["p0", "p1"], level: "high", reason: "候选", evidence: [{ projectId: "p0", quote: "示例" }, { projectId: "p1", quote: "示例" }] };
    expect(expandProjectMergeAiPairs([
      { ...base, projectIds: ["p0", "p99"] },
      { ...base, projectIds: ["p0", "p0"] },
      { ...base, evidence: [{ projectId: "p99", quote: "示例" }] },
      { ...base, evidence: [{ projectId: "p2", quote: "示例" }] },
    ], aliases)).toEqual([]);
  });

  it("resolves a whole group with evidence for each member while rejecting invalid membership", () => {
    const catalog = [project(1), project(2), project(3), project(4)];
    const aliases = buildProjectMergeAiCatalog(catalog).aliases;
    const group = { projectIds: ["p0", "p1", "p2"], level: "high" as const, reason: "同一归档产品的三个入口",
      evidence: ["p0", "p1", "p2"].map((projectId, index) => ({ projectId, quote: catalog[index]!.name })) };
    expect(expandProjectMergeAiGroups([group], aliases)).toEqual([{
      ...group, projectIds: catalog.slice(0, 3).map((item) => item.id),
      evidence: catalog.slice(0, 3).map((item) => ({ projectId: item.id, quote: item.name })),
    }]);
    expect(expandProjectMergeAiGroups([
      { ...group, projectIds: ["p0", "p1", "p99"] },
      { ...group, projectIds: ["p0", "p1", "p1"] },
      { ...group, evidence: [...group.evidence, { projectId: "p3", quote: "不属于本组" }] },
    ], aliases)).toEqual([]);
  });
});
