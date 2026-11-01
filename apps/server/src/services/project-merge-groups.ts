import {
  projectPairKey,
  type MergeCandidate,
  type MergeCandidateProject,
} from "./project-merge-candidates.js";

export interface MergeCandidateGroup {
  id: string;
  projects: MergeCandidateProject[];
  targetProjectId: string;
  level: "high" | "medium";
  reasons: string[];
  sharedTags: string[];
  score: number;
  source: "local" | "ai";
  evidence: Array<{
    projectIds: [string, string];
    reasons: string[];
    source: "local" | "ai";
  }>;
}

const MAX_GROUP_SIZE = 20;

function compareEdges(left: MergeCandidate, right: MergeCandidate): number {
  return right.score - left.score || left.id.localeCompare(right.id);
}

function normalizeTag(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
}

/** A review group requires a direct eligible match between every member pair.
 * Connected components alone would combine unrelated branches through a shared
 * project. Keep genuine overlapping groups only when they cover new evidence. */
export function groupProjectMergeCandidates(
  candidates: readonly MergeCandidate[],
  ignoredPairs: ReadonlySet<string> = new Set(),
): MergeCandidateGroup[] {
  const ignored = new Set([...ignoredPairs].map((key) => projectPairKey(key.split(":"))));
  const edges = new Map<string, MergeCandidate>();
  const projects = new Map<string, MergeCandidateProject>();
  const adjacency = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    if (!Number.isFinite(candidate.score) || candidate.projects.length !== 2) continue;
    const ordered = candidate.projects.map((project) => ({ ...project, id: project.id.toLowerCase() }))
      .sort((left, right) => left.id.localeCompare(right.id)) as [MergeCandidateProject, MergeCandidateProject];
    if (ordered[0].id === ordered[1].id || ordered.some((project) => project.conversationCount <= 0)) continue;
    const id = projectPairKey(ordered.map((project) => project.id));
    if (ignored.has(id)) continue;
    const previous = edges.get(id);
    const preferred = !previous || candidate.score > previous.score ||
      (candidate.score === previous.score && candidate.source === "ai" && previous.source !== "ai")
      ? candidate : previous;
    const reasons = [...new Set([...(previous?.reasons ?? []), ...candidate.reasons])].sort();
    edges.set(id, { ...preferred, id, projects: ordered, reasons });
    for (const project of ordered) projects.set(project.id, project);
    const [left, right] = ordered.map((project) => project.id) as [string, string];
    if (!adjacency.has(left)) adjacency.set(left, new Set());
    if (!adjacency.has(right)) adjacency.set(right, new Set());
    adjacency.get(left)!.add(right);
    adjacency.get(right)!.add(left);
  }

  const covered = new Set<string>();
  const groups: MergeCandidateGroup[] = [];
  const orderedEdges = [...edges.values()].sort(compareEdges);
  for (const seed of orderedEdges) {
    if (covered.has(seed.id)) continue;
    const members = seed.projects.map((project) => project.id);
    let pool = new Set([...adjacency.get(members[0]!)!]
      .filter((id) => adjacency.get(members[1]!)!.has(id)));

    while (members.length < MAX_GROUP_SIZE && pool.size) {
      const choices = [...pool].map((id) => {
        const links = members.map((member) => edges.get(projectPairKey([id, member]))!);
        return {
          id,
          newLinks: links.filter((edge) => !covered.has(edge.id)).length,
          compatible: [...pool].filter((other) => adjacency.get(id)!.has(other)).length,
          weakestScore: Math.min(...links.map((edge) => edge.score)),
        };
      }).filter((choice) => choice.newLinks > 0)
        .sort((left, right) => right.compatible - left.compatible || right.newLinks - left.newLinks ||
          right.weakestScore - left.weakestScore || left.id.localeCompare(right.id));
      const next = choices[0];
      if (!next) break;
      members.push(next.id);
      pool = new Set([...pool].filter((id) => adjacency.get(next.id)!.has(id)));
    }

    members.sort();
    const memberProjects = members.map((id) => projects.get(id)!);
    const memberEdges: MergeCandidate[] = [];
    for (let left = 0; left < members.length - 1; left += 1) {
      for (let right = left + 1; right < members.length; right += 1) {
        const edge = edges.get(projectPairKey([members[left]!, members[right]!]))!;
        memberEdges.push(edge);
        covered.add(edge.id);
      }
    }
    memberEdges.sort(compareEdges);
    const target = [...memberProjects].sort((left, right) =>
      right.conversationCount - left.conversationCount || left.id.localeCompare(right.id))[0]!;
    const sharedTags = [...new Map(memberProjects[0]!.tags.map((tag) => [normalizeTag(tag), tag])).entries()]
      .filter(([normalized]) => memberProjects.every((project) => project.tags.some((tag) => normalizeTag(tag) === normalized)))
      .map(([, tag]) => tag).sort((left, right) => left.localeCompare(right, "zh-CN"));
    groups.push({
      id: projectPairKey(members), projects: memberProjects, targetProjectId: target.id,
      level: memberEdges.every((edge) => edge.level === "high") ? "high" : "medium",
      reasons: [...new Set(memberEdges.flatMap((edge) => edge.reasons))].slice(0, 6),
      sharedTags, score: Math.min(...memberEdges.map((edge) => edge.score)),
      source: memberEdges.some((edge) => edge.source === "ai") ? "ai" : "local",
      evidence: memberProjects.filter((project) => project.id !== target.id).map((project) => {
        const edge = edges.get(projectPairKey([target.id, project.id]))!;
        return { projectIds: edge.projects.map((value) => value.id) as [string, string], reasons: edge.reasons, source: edge.source };
      }),
    });
  }
  return groups.sort((left, right) => right.projects.length - left.projects.length ||
    right.score - left.score || left.id.localeCompare(right.id));
}
