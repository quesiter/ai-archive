import type { MergeCandidateProject } from "./project-merge-candidates.js";

export interface ProjectMergeAiAliasPair {
  projectIds: [string, string];
  level: "high" | "medium";
  reason: string;
  evidence: Array<{ projectId: string; quote: string }>;
}

export interface ProjectMergeAiAliasGroup extends Omit<ProjectMergeAiAliasPair, "projectIds"> {
  projectIds: string[];
}

export function expandProjectMergeAiGroups(
  groups: readonly ProjectMergeAiAliasGroup[], aliases: ReadonlyMap<string, string>,
): ProjectMergeAiAliasGroup[] {
  return groups.flatMap((group) => {
    const ids = group.projectIds.map((alias) => aliases.get(alias));
    if (ids.length < 2 || ids.length > 20 || ids.some((id) => !id) || new Set(ids).size !== ids.length) return [];
    const evidence: ProjectMergeAiAliasGroup["evidence"] = [];
    for (const item of group.evidence) {
      const projectId = aliases.get(item.projectId);
      if (!projectId || !group.projectIds.includes(item.projectId)) return [];
      evidence.push({ ...item, projectId });
    }
    return [{ ...group, projectIds: ids as string[], evidence }];
  });
}

type CompactProject = {
  id: string;
  name: string;
  description?: string;
  titles?: string[];
  tags?: string[];
};

function prefix(value: string, length: number): string {
  return [...value].slice(0, length).join("");
}

function requestTooLarge(): Error & { statusCode: number } {
  return Object.assign(new Error("全部项目名称已超出单次 AI 分析范围；自动匹配仍覆盖全部项目，请先审阅现有候选。"), { statusCode: 422 });
}

/** Keep every complete project name; spend the remaining request budget on
 * equally sized context excerpts. Compact aliases remove repeated UUIDs from
 * the model request without changing persisted project identity. */
export function buildProjectMergeAiCatalog(
  catalog: readonly MergeCandidateProject[],
  ignoredPairs: ReadonlySet<string> = new Set(),
  maxChars = 120_000,
): { user: string; aliases: Map<string, string> } {
  const ordered = [...catalog].sort((left, right) => left.id.toLowerCase().localeCompare(right.id.toLowerCase()));
  const aliases = new Map(ordered.map((project, index) => [`p${index}`, project.id]));
  const aliasesById = new Map([...aliases].map(([alias, id]) => [id.toLowerCase(), alias]));
  const keepSeparatePairs = [...ignoredPairs].sort().flatMap((key): Array<[string, string]> => {
    const ids = key.toLowerCase().split(":");
    if (ids.length !== 2 || ids[0] === ids[1]) return [];
    const left = aliasesById.get(ids[0]!);
    const right = aliasesById.get(ids[1]!);
    return left && right ? [[left, right]] : [];
  });

  function serialize(depth: number): string {
    const projects = ordered.map((project, index): CompactProject => {
      const item: CompactProject = { id: `p${index}`, name: project.name };
      if (!depth) return item;
      if (project.description) item.description = prefix(project.description, depth);
      // When space is tight, each project gets one source of context before a
      // second context field is added to every eligible project.
      if (!project.description || depth >= 32) {
        const titleCount = depth >= 160 ? 3 : depth >= 80 ? 2 : 1;
        const titles = project.conversations.map((entry) => entry.title).filter(Boolean)
          .slice(0, titleCount).map((title) => prefix(title, Math.min(depth, 160)));
        if (titles.length) item.titles = titles;
      }
      if (depth >= 48 && project.tags.length) {
        const tagCount = depth >= 192 ? 8 : depth >= 96 ? 4 : 2;
        item.tags = project.tags.slice(0, tagCount).map((tag) => prefix(tag, Math.min(depth, 80)));
      }
      return item;
    });
    return JSON.stringify({ projects, keepSeparatePairs });
  }

  const minimum = serialize(0);
  if (!Number.isFinite(maxChars) || maxChars < 0 || minimum.length > maxChars) throw requestTooLarge();
  let user = minimum;
  let low = 1;
  let high = 240;
  while (low <= high) {
    const depth = Math.floor((low + high) / 2);
    const candidate = serialize(depth);
    if (candidate.length <= maxChars) {
      user = candidate;
      low = depth + 1;
    } else {
      high = depth - 1;
    }
  }
  return { user, aliases };
}

/** Resolve only aliases supplied in this request. Unknown, self and unrelated
 * evidence aliases are discarded before the UUID/quotation validation layer. */
export function expandProjectMergeAiPairs(
  pairs: readonly ProjectMergeAiAliasPair[],
  aliases: ReadonlyMap<string, string>,
): ProjectMergeAiAliasPair[] {
  return pairs.flatMap((pair): ProjectMergeAiAliasPair[] => {
    const left = aliases.get(pair.projectIds[0]);
    const right = aliases.get(pair.projectIds[1]);
    if (!left || !right || left.toLowerCase() === right.toLowerCase()) return [];
    const evidence: ProjectMergeAiAliasPair["evidence"] = [];
    for (const entry of pair.evidence) {
      const projectId = aliases.get(entry.projectId);
      if (!projectId || !pair.projectIds.includes(entry.projectId)) return [];
      evidence.push({ ...entry, projectId });
    }
    return [{ ...pair, projectIds: [left, right], evidence }];
  });
}
