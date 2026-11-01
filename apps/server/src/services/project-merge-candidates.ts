import { createHash } from "node:crypto";

export interface MergeCandidateProject {
  id: string;
  name: string;
  description: string;
  conversationCount: number;
  conversations: Array<{ id: string; title: string }>;
  tags: string[];
}

export interface MergeCandidate {
  id: string;
  projects: [MergeCandidateProject, MergeCandidateProject];
  targetProjectId: string;
  level: "high" | "medium";
  reasons: string[];
  sharedTags: string[];
  score: number;
  source: "local" | "ai";
}

// These are context, rather than evidence that two independently named projects
// represent the same work. Specific conversation titles can still establish it.
const GENERIC_TERMS = new Set([
  "ai", "llm", "it", "web", "app", "api", "ui", "ux", "sql", "git", "github",
  "python", "javascript", "typescript", "java", "react", "vue", "node", "nodejs",
  "html", "css", "docker", "linux", "windows", "macos", "ios", "android",
  "codex", "claude", "chatgpt", "gemini", "gpt", "code", "project", "system",
  "development", "management", "test", "testing", "update", "version",
  "项目", "系统", "平台", "工具", "应用", "软件", "开发", "管理", "研究",
  "分析", "方案", "计划", "设计", "配置", "部署", "维护", "运维", "优化",
  "问题", "修复", "排查", "检查", "测试", "评估", "更新", "升级", "版本",
  "实现", "使用", "整理", "功能", "指南", "建议", "报告", "结果", "解读",
  "生成", "制定", "推荐", "相关", "个人", "家庭", "智能", "本地", "学习",
  "记录", "跟踪", "日志", "技术", "一个", "这个", "支持", "服务", "进行",
  "旅行", "旅游", "出行", "行程", "旅程", "自驾", "春节", "国庆", "暑假",
  "健康", "医疗", "病情", "体检", "病历", "用药", "复查", "处理", "持续",
]);

const GENERIC_CHINESE = [...GENERIC_TERMS]
  .filter((term) => /\p{Script=Han}/u.test(term))
  .sort((left, right) => right.length - left.length);

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US")
    .replace(/home\s+assistant/gu, "homeassistant")
    .replace(/软著/gu, "软件著作权")
    .replace(/电子像框/gu, "电子相框")
    .replace(/\s+/gu, " ").trim();
}

function compact(value: string): string {
  return normalize(value).replace(/[^\p{L}\p{N}]+/gu, "");
}

function nameCore(value: string): string {
  return normalize(value)
    .replace(/[([【（]\s*(?:codex|claude(?:\s*code)?|chatgpt|gemini|windows|macos|linux|web|ios|android)[^\])】）]*[\])】）]/gu, " ")
    .replace(/(?<![a-z0-9])codex(?:-[a-z]+)?\s*$/u, " ")
    .replace(/(?:\bv\s*\d+(?:\.\d+){0,3}\b|\b\d+(?:\.\d+){1,3}\b)/gu, " ")
    .replace(/(?:项目|系统|平台|开发|维护|升级|部署|重构|方案|管理)\s*$/u, "")
    .trim();
}

function terms(value: string): Set<string> {
  let normalized = normalize(value).replace(/\b(?:19|20)\d{2}\b/gu, " ");
  const found = new Set<string>();
  for (const match of normalized.matchAll(/[a-z][a-z0-9+#._-]{1,}/gu)) {
    const term = match[0].replace(/[._-]+$/u, "");
    if (!GENERIC_TERMS.has(term) && !/^v?\d+(?:\.\d+)*$/u.test(term)) found.add(term);
  }
  // Remove whole generic phrases before generating n-grams: otherwise the
  // boundary grams in “项目管理” falsely look like distinctive words.
  for (const generic of GENERIC_CHINESE) normalized = normalized.replaceAll(generic, " ");
  for (const match of normalized.matchAll(/\p{Script=Han}+/gu)) {
    const characters = [...match[0]];
    for (let size = 2; size <= 3; size += 1) {
      for (let offset = 0; offset + size <= characters.length; offset += 1) {
        found.add(characters.slice(offset, offset + size).join(""));
      }
    }
  }
  return found;
}

function intersection(left: ReadonlySet<string>, right: ReadonlySet<string>): string[] {
  return [...left].filter((term) => right.has(term));
}

function overlap(left: ReadonlySet<string>, right: ReadonlySet<string>): { shared: string[]; dice: number } {
  const shared = intersection(left, right);
  return { shared, dice: left.size + right.size ? 2 * shared.length / (left.size + right.size) : 0 };
}

function substantive(value: string): boolean {
  const meaningful = terms(value);
  return meaningful.size >= 3 || [...meaningful].some((term) => /^[a-z][a-z0-9+#._-]{4,}$/u.test(term));
}

function yearSet(project: MergeCandidateProject, travel: boolean): Set<string> {
  const explicit = [...project.name.matchAll(/(?:19|20)\d{2}/gu)].map((match) => match[0]);
  if (explicit.length || !travel) return new Set(explicit);
  const titleYears = new Set(project.conversations.flatMap((item) =>
    [...item.title.matchAll(/(?:19|20)\d{2}/gu)].map((match) => match[0])));
  return titleYears.size === 1 ? titleYears : new Set();
}

function entityCore(name: string, kind: "travel" | "health"): string {
  let value = normalize(name).replace(/(?:19|20)\d{2}/gu, " ");
  const removable = kind === "travel"
    ? /旅行|旅游|出行|行程|旅程|自驾游?|春节|国庆|清明|暑假|寒假|五一|省内|安排|规划|计划|方案|攻略|研究|项目|家庭|全家|父母|的/gu
    : /病情|健康|医疗|体检|病历|用药|复查|疾病|情况|跟踪|管理|记录|分析|方案|计划|项目|家庭|的/gu;
  value = value.replace(removable, " ").replace(/[^\p{L}\p{N}]+/gu, "");
  return value.replace(/爸爸|老爸/gu, "父亲").replace(/妈妈|老妈/gu, "母亲");
}

function conflictingIdentity(left: MergeCandidateProject, right: MergeCandidateProject): boolean {
  const travel = /旅行|旅游|出行|自驾|行程|旅程|春节|国庆|暑假/u.test(`${left.name} ${right.name}`);
  const leftYears = yearSet(left, travel);
  const rightYears = yearSet(right, travel);
  if (leftYears.size && rightYears.size && !intersection(leftYears, rightYears).length) return true;
  for (const kind of ["travel", "health"] as const) {
    const pattern = kind === "travel" ? /旅行|旅游|出行|自驾|行程|旅程/u : /病情|健康|医疗|体检|病历|用药/u;
    if (!pattern.test(left.name) || !pattern.test(right.name)) continue;
    const a = entityCore(left.name, kind);
    const b = entityCore(right.name, kind);
    if (a.length >= 2 && b.length >= 2 && !a.includes(b) && !b.includes(a)
      && !intersection(terms(a), terms(b)).length) return true;
  }
  return false;
}

export function projectPairKey(ids: readonly string[]): string {
  return [...new Set(ids.map((id) => id.toLocaleLowerCase("en-US")))].sort().join(":");
}

export function projectCatalogFingerprint(projects: MergeCandidateProject[]): string {
  const catalog = projects.map((project) => ({
    id: project.id.toLocaleLowerCase("en-US"),
    name: project.name,
    description: project.description,
    conversationCount: project.conversationCount,
    tags: [...new Set(project.tags)].sort(),
    conversations: project.conversations.map((item) => ({ id: item.id, title: item.title }))
      .sort((a, b) => a.id.localeCompare(b.id) || a.title.localeCompare(b.title)),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

/** Enumerate only pairs that can satisfy a scoring branch below. A project
 * contributes each term once, so posting counts are exact intersection sizes.
 * The thresholds deliberately overapproximate the scoring rules. */
function indexedPotentialPairs(prepared: Array<{
  core: string;
  nameTerms: Set<string>;
  descriptionTerms: Set<string>;
  exactDescriptionKey: string;
  substantiveTitles: Map<string, string>;
}>): Set<number> {
  const size = prepared.length;
  const pairs = new Set<number>();

  function addExactGroups(keys: (row: typeof prepared[number]) => Iterable<string>): void {
    const index = new Map<string, number[]>();
    prepared.forEach((row, position) => {
      for (const key of keys(row)) {
        if (!key) continue;
        const previous = index.get(key) ?? [];
        for (const other of previous) pairs.add(other * size + position);
        previous.push(position);
        index.set(key, previous);
      }
    });
  }

  addExactGroups((row) => row.core.length >= 4 ? [row.core] : []);
  addExactGroups((row) => row.exactDescriptionKey ? [row.exactDescriptionKey] : []);
  addExactGroups((row) => row.substantiveTitles.keys());

  function addSharedTerms(termsFor: (row: typeof prepared[number]) => Set<string>, minimum: number): void {
    const index = new Map<string, number[]>();
    prepared.forEach((row, position) => {
      for (const term of termsFor(row)) {
        const positions = index.get(term) ?? [];
        positions.push(position);
        index.set(term, positions);
      }
    });
    const sharedCounts = new Map<number, number>();
    for (const positions of index.values()) {
      for (let left = 0; left < positions.length - 1; left += 1) {
        const offset = positions[left]! * size;
        for (let right = left + 1; right < positions.length; right += 1) {
          const pair = offset + positions[right]!;
          if (pairs.has(pair)) continue;
          const shared = (sharedCounts.get(pair) ?? 0) + 1;
          if (shared >= minimum) {
            pairs.add(pair);
            sharedCounts.delete(pair);
          } else sharedCounts.set(pair, shared);
        }
      }
    }
  }

  // Near names require >=3; thematic titles require >=2 name terms OR >=3
  // description terms; strong descriptions require >=5. Exact evidence was
  // seeded separately, including single distinctive English descriptions.
  addSharedTerms((row) => row.nameTerms, 2);
  addSharedTerms((row) => row.descriptionTerms, 3);
  return pairs;
}

export function findProjectMergeCandidates(
  projects: MergeCandidateProject[],
  ignoredPairs: ReadonlySet<string> = new Set(),
): MergeCandidate[] {
  const ordered = [...new Map(projects.map((project) => [project.id.toLocaleLowerCase("en-US"), project])).values()]
    .sort((a, b) => a.id.toLocaleLowerCase("en-US").localeCompare(b.id.toLocaleLowerCase("en-US")));
  const prepared = ordered.map((project) => ({
    project,
    core: compact(nameCore(project.name)),
    nameTerms: terms(nameCore(project.name)),
    descriptionTerms: terms(project.description),
    exactDescriptionKey: compact(project.description).length >= 12
      ? compact(project.description) : "",
    substantiveDescription: substantive(project.description),
    titleTerms: terms(project.conversations.map((item) => item.title).join("\n")),
    substantiveTitles: new Map(project.conversations
      .filter((item) => compact(item.title).length >= 8 && substantive(item.title))
      .map((item) => [compact(item.title), item.title])),
  }));
  const candidates: MergeCandidate[] = [];
  for (const encodedPair of indexedPotentialPairs(prepared)) {
    const a = Math.floor(encodedPair / prepared.length);
    const b = encodedPair % prepared.length;
    const left = prepared[a]!;
    const right = prepared[b]!;
    const id = projectPairKey([left.project.id, right.project.id]);
    if (ignoredPairs.has(id)) continue;
    const reasons: string[] = [];
    let score = 0;
    const nameOverlap = overlap(left.nameTerms, right.nameTerms);
    const exactCore = left.core === right.core && left.core.length >= 4 && left.nameTerms.size > 0;
    const nearName = left.core.length >= 4 && right.core.length >= 4
      && nameOverlap.shared.length >= 3 && nameOverlap.dice >= 0.72;
    if (exactCore) {
      score = 94;
      reasons.push("项目名称规范化后相同，主要差异是格式、版本或平台标记。");
    } else if (nearName) {
      score = 76;
      reasons.push("项目名称中的具体主题高度重合，可能是同一项目的不同命名。");
    }
    const matchingTitle = [...left.substantiveTitles.entries()].find(([title]) => right.substantiveTitles.has(title));
    if (matchingTitle) {
      score = Math.max(score, 86) + (score ? 4 : 0);
      reasons.push(`两边都有同主题会话：“${matchingTitle[1].slice(0, 100)}”。`);
    }
    const descriptionOverlap = overlap(left.descriptionTerms, right.descriptionTerms);
    const exactDescription = Boolean(left.exactDescriptionKey)
      && left.exactDescriptionKey === right.exactDescriptionKey && left.substantiveDescription;
    const strongDescription = descriptionOverlap.shared.length >= 5 && descriptionOverlap.dice >= 0.7;
    if (exactDescription || strongDescription) {
      score = Math.max(score, exactDescription ? 85 : 76) + (score ? 3 : 0);
      reasons.push(exactDescription ? "两个项目的具体说明一致。" : "项目说明描述了高度相近的具体工作。");
    }
    const titleOverlap = overlap(left.titleTerms, right.titleTerms);
    const strongTitles = titleOverlap.shared.length >= 6 && titleOverlap.dice >= 0.65;
    if (strongTitles && (nameOverlap.shared.length >= 2 || descriptionOverlap.shared.length >= 3)) {
      score = Math.max(score, 77) + (score ? 3 : 0);
      reasons.push("最近会话中的具体主题重合，并与项目名称或说明相互印证。");
    }
    if (score < 75 || conflictingIdentity(left.project, right.project)) continue;
    const rightTags = new Set(right.project.tags.map(normalize));
    const sharedTags = [...new Map(left.project.tags
      .filter((tag) => rightTags.has(normalize(tag)))
      .map((tag) => [normalize(tag), tag])).values()].sort((x, y) => x.localeCompare(y, "zh-CN"));
    const specificSharedTags = sharedTags.filter((tag) => terms(tag).size > 0);
    if (specificSharedTags.length) {
      reasons.push(`共同标签：${specificSharedTags.slice(0, 4).join("、")}。`);
      score += Math.min(3, specificSharedTags.length);
    }
    const target = left.project.conversationCount >= right.project.conversationCount ? left.project : right.project;
    candidates.push({
      id,
      projects: [left.project, right.project],
      targetProjectId: target.id,
      level: score >= 88 ? "high" : "medium",
      reasons,
      sharedTags,
      score: Math.min(score, 99),
      source: "local",
    });
  }
  return candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
