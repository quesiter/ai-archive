import { describe, expect, it } from "vitest";
import { projectPairKey, type MergeCandidate, type MergeCandidateProject } from "../src/services/project-merge-candidates.js";
import { groupProjectMergeCandidates } from "../src/services/project-merge-groups.js";

function project(id: string, conversationCount = 1): MergeCandidateProject {
  return { id, name: `归档产品 ${id}`, description: "", conversationCount, conversations: [], tags: ["会话归档", `标签${id}`] };
}

function pair(left: MergeCandidateProject, right: MergeCandidateProject, values: Partial<MergeCandidate> = {}): MergeCandidate {
  return {
    id: projectPairKey([left.id, right.id]), projects: [left, right], targetProjectId: left.id,
    level: "high", reasons: [`${left.id} 与 ${right.id} 指向相同产品`], sharedTags: ["会话归档"], score: 94, source: "local", ...values,
  };
}

function clique(projects: MergeCandidateProject[]): MergeCandidate[] {
  return projects.flatMap((left, index) => projects.slice(index + 1).map((right) => pair(left, right)));
}

describe("multi-project merge review groups", () => {
  it.each([3, 4, 5])("combines a %i-project identity cluster into one review group", (size) => {
    const projects = Array.from({ length: size }, (_, index) => project(`p${index}`, index + 1));
    const groups = groupProjectMergeCandidates(clique(projects));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.projects.map((item) => item.id)).toEqual(projects.map((item) => item.id));
    expect(groups[0]!.targetProjectId).toBe(`p${size - 1}`);
    expect(groups[0]!.evidence).toHaveLength(size - 1);
    expect(groups[0]!.sharedTags).toEqual(["会话归档"]);
  });

  it("does not combine unrelated branches merely because they share a bridge project", () => {
    const [a, b, c] = [project("a"), project("b"), project("c")];
    const groups = groupProjectMergeCandidates([pair(a!, b!), pair(b!, c!)]);
    expect(groups.map((group) => group.projects.map((item) => item.id))).toEqual([["a", "b"], ["b", "c"]]);
  });

  it("honors every keep-separate decision inside a potential larger group", () => {
    const projects = [project("a"), project("b"), project("c")];
    const groups = groupProjectMergeCandidates(clique(projects), new Set(["C:A"]));
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => !(group.projects.some((item) => item.id === "a") && group.projects.some((item) => item.id === "c")))).toBe(true);
  });

  it("is deterministic under edge direction and input order, with a stable target on ties", () => {
    const edges = clique([project("c"), project("a"), project("b")]);
    const reversed = edges.map((edge) => ({ ...edge, projects: [...edge.projects].reverse() as [MergeCandidateProject, MergeCandidateProject] })).reverse();
    expect(groupProjectMergeCandidates(edges)).toEqual(groupProjectMergeCandidates(reversed));
    expect(groupProjectMergeCandidates(edges)[0]!.targetProjectId).toBe("a");
  });

  it("does not let empty projects consume content-review groups", () => {
    const zero = project("empty", 0), otherZero = project("also-empty", 0), active = project("active");
    expect(groupProjectMergeCandidates([pair(zero, otherZero), pair(zero, active)])).toEqual([]);
  });

  it("deduplicates repeated pair inputs and retains their concrete evidence", () => {
    const left = project("a"), right = project("b");
    const groups = groupProjectMergeCandidates([
      pair(left, right, { score: 76, level: "medium", reasons: ["相同说明"] }),
      pair(right, left, { score: 94, reasons: ["相同名称"], source: "ai" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ score: 94, source: "ai", level: "high" });
    expect(groups[0]!.reasons).toEqual(expect.arrayContaining(["相同名称", "相同说明"]));
  });

  it("retains overlapping identity clusters only when they cover otherwise missing matches", () => {
    const [a, b, c, d] = [project("a"), project("b"), project("c"), project("d")];
    const groups = groupProjectMergeCandidates([...clique([a!, b!, c!]), ...clique([b!, c!, d!])]);
    expect(groups.map((group) => group.projects.map((item) => item.id))).toEqual([["a", "b", "c"], ["b", "c", "d"]]);
    expect(groups.every((group) => group.projects.length === 3)).toBe(true);
  });

  it("uses the weakest member relationship for group score and limits aggregated explanation size", () => {
    const edges = clique([project("a"), project("b"), project("c")]);
    edges[0] = { ...edges[0]!, score: 76, level: "medium", reasons: Array.from({ length: 9 }, (_, i) => `依据${i}`) };
    const group = groupProjectMergeCandidates(edges)[0]!;
    expect(group).toMatchObject({ score: 76, level: "medium" });
    expect(group.reasons.length).toBeLessThanOrEqual(6);
    expect(group.evidence.every((item) => item.projectIds.includes(group.targetProjectId))).toBe(true);
  });

  it("bounds large cards and preserves every discovered relationship without redundant covered-only expansion", () => {
    const edges = clique(Array.from({ length: 22 }, (_, index) => project(String(index).padStart(2, "0"))));
    const groups = groupProjectMergeCandidates(edges);
    expect(groups.every((group) => group.projects.length <= 20 && group.projects.length >= 2)).toBe(true);
    const covered = new Set(groups.flatMap((group) => clique(group.projects).map((edge) => edge.id)));
    expect(covered).toEqual(new Set(edges.map((edge) => edge.id)));
    expect(new Set(groups.map((group) => group.id)).size).toBe(groups.length);
  });
});
