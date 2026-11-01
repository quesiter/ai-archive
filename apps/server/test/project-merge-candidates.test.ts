import { describe, expect, it } from "vitest";
import {
  findProjectMergeCandidates,
  projectCatalogFingerprint,
  projectPairKey,
  type MergeCandidateProject,
} from "../src/services/project-merge-candidates.js";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";

function project(id: string, name: string, values: Partial<MergeCandidateProject> = {}): MergeCandidateProject {
  return { id, name, description: "", conversationCount: 1, conversations: [], tags: [], ...values };
}

describe("project merge candidate discovery", () => {
  it("finds Chinese project names with platform and version decorations", () => {
    const candidates = findProjectMergeCandidates([
      project(firstId, "知言归藏 V2.4.7（Codex）", { conversationCount: 12 }),
      project(secondId, "知言归藏 v2.3.0", { conversationCount: 30 }),
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ targetProjectId: secondId, level: "high", source: "local" });
    expect(candidates[0]!.reasons[0]).toContain("规范化后相同");
    expect(findProjectMergeCandidates([
      project(firstId, "知言归藏codex-day"), project(secondId, "知言归藏"),
    ])).toHaveLength(1);
  });

  it("recognizes specific near names and common Chinese abbreviations", () => {
    expect(findProjectMergeCandidates([
      project(firstId, "家庭电子相框管理"), project(secondId, "电子相框系统"),
    ])).toHaveLength(1);
    expect(findProjectMergeCandidates([
      project(firstId, "软著材料生成"), project(secondId, "软件著作权材料生成"),
    ])).toHaveLength(1);
    expect(findProjectMergeCandidates([
      project(firstId, "Home Assistant"), project(secondId, "HomeAssistant系统"),
    ])).toHaveLength(1);
  });

  it("connects differently named projects through a substantive shared conversation", () => {
    const title = "配置 WireGuard 回家访问群晖相册";
    const result = findProjectMergeCandidates([
      project(firstId, "家网守望", { conversations: [{ id: "a", title }] }),
      project(secondId, "家庭网络运维", { conversations: [{ id: "b", title }] }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.reasons.join(" ")).toContain(title);
  });

  it("uses concrete descriptions as evidence even if project names differ", () => {
    const description = "采集跨平台聊天正文，保存会话历史，检索归档消息并生成项目上下文";
    expect(findProjectMergeCandidates([
      project(firstId, "知言归藏", { description }),
      project(secondId, "AI会话归档", { description }),
    ])).toHaveLength(1);
  });

  it("retains exact specific descriptions containing only one distinctive English term", () => {
    expect(findProjectMergeCandidates([
      project(firstId, "Saffron", { description: "PhotographArchiveCache" }),
      project(secondId, "Violet", { description: "PhotographArchiveCache" }),
      project("unrelated", "Tangerine", { description: "PhotoGalleryBackground" }),
    ]).map((candidate) => candidate.id)).toEqual([projectPairKey([firstId, secondId])]);
  });

  it("retains title evidence supported by only two name terms or three description terms", () => {
    const leftTitles = [{ id: "left", title: "Orchid Birch Photograph Directory Refresh Rotate" }];
    const rightTitles = [{ id: "right", title: "Orchid Birch Photograph Directory Refresh Rotate Fresh" }];
    expect(findProjectMergeCandidates([
      project(firstId, "Orchid Birch Cedar", { conversations: leftTitles }),
      project(secondId, "Orchid Birch Maple", { conversations: rightTitles }),
      project("unrelated", "Orchid Tulip Pine"),
    ]).map((candidate) => candidate.id)).toEqual([projectPairKey([firstId, secondId])]);
    expect(findProjectMergeCandidates([
      project(firstId, "Saffron", { description: "Orchid Birch Cedar Cloud Water", conversations: leftTitles }),
      project(secondId, "Violet", { description: "Orchid Birch Cedar Earth Fire", conversations: rightTitles }),
      project("unrelated", "Tangerine", { description: "Orchid Birch Pine River Meadow" }),
    ]).map((candidate) => candidate.id)).toEqual([projectPairKey([firstId, secondId])]);
  });

  it("does not equate Java and JavaScript, generic technology or generic titles", () => {
    const values = { tags: ["React", "TypeScript", "AI", "开发"], conversations: [{ id: "a", title: "检查系统功能，修复开发问题" }] };
    expect(findProjectMergeCandidates([
      project(firstId, "Java", values), project(secondId, "JavaScript", values),
    ])).toEqual([]);
    expect(findProjectMergeCandidates([
      project(firstId, "家庭药箱", values), project(secondId, "旅行相册", values),
    ])).toEqual([]);
    expect(findProjectMergeCandidates([
      project(firstId, "AI 项目开发"), project(secondId, "AI 系统开发"),
    ])).toEqual([]);
  });

  it("does not suggest merges from tags alone, even for specific tags", () => {
    expect(findProjectMergeCandidates([
      project(firstId, "相册处理", { tags: ["群晖相册", "WireGuard"] }),
      project(secondId, "路由器部署", { tags: ["群晖相册", "WireGuard"] }),
    ])).toEqual([]);
  });

  it("keeps explicitly different years, destinations and patients separate", () => {
    const values = { conversations: [{ id: "a", title: "规划春节自驾海南的酒店与路线" }] };
    expect(findProjectMergeCandidates([
      project(firstId, "2025 海南旅行", values), project(secondId, "2026 海南旅行", values),
    ])).toEqual([]);
    expect(findProjectMergeCandidates([
      project(firstId, "北京旅行", values), project(secondId, "上海旅行", values),
    ])).toEqual([]);
    const health = { description: "定期跟踪肝功能和血常规检查记录，整理药物服用记录" };
    expect(findProjectMergeCandidates([
      project(firstId, "父亲健康跟踪", health), project(secondId, "母亲健康管理", health),
    ])).toEqual([]);
    expect(findProjectMergeCandidates([
      project(firstId, "张三病情跟踪", health), project(secondId, "李四病情跟踪", health),
    ])).toEqual([]);
  });

  it("does not invent evidence from empty descriptions or empty titles", () => {
    expect(findProjectMergeCandidates([
      project(firstId, "甲方IT指南", { conversations: [{ id: "a", title: "" }] }),
      project(secondId, "知言归藏", { conversations: [{ id: "b", title: "" }] }),
    ])).toEqual([]);
  });

  it("returns stable pairs, honors ignores and deterministically chooses a target", () => {
    const a = project(firstId, "电子相框");
    const b = project(secondId, "电子相框系统");
    const forward = findProjectMergeCandidates([a, b]);
    expect(forward).toEqual(findProjectMergeCandidates([b, a]));
    expect(forward[0]!.targetProjectId).toBe(firstId);
    expect(findProjectMergeCandidates([a, b], new Set([projectPairKey([secondId, firstId])]))).toEqual([]);
    expect(findProjectMergeCandidates([a, b, a])).toHaveLength(1);
    expect(projectPairKey(["BBBB", "aaaa", "AAAA"])).toBe("aaaa:bbbb");
  });

  it("keeps pairwise evidence instead of transitively grouping projects", () => {
    const a = project(firstId, "左侧项目", { conversations: [{ id: "a", title: "配置 WireGuard 回家访问群晖相册" }] });
    const b = project(secondId, "中央项目", { conversations: [
      { id: "b1", title: "配置 WireGuard 回家访问群晖相册" },
      { id: "b2", title: "优化电子相框照片缓存轮播逻辑" },
    ] });
    const c = project("00000000-0000-4000-8000-000000000003", "右侧项目", { conversations: [{ id: "c", title: "优化电子相框照片缓存轮播逻辑" }] });
    const result = findProjectMergeCandidates([a, b, c]);
    expect(result).toHaveLength(2);
    expect(result.map((item) => item.id)).not.toContain(projectPairKey([a.id, c.id]));
    expect(result.every((item) => item.projects.length === 2)).toBe(true);
  });

  it("fingerprints all displayed evidence and ignores input ordering", () => {
    const a = project(firstId, "知言归藏", { tags: ["同步", "采集"], conversations: [{ id: "b", title: "乙" }, { id: "a", title: "甲" }] });
    const b = project(secondId, "历史归档");
    const fingerprint = projectCatalogFingerprint([a, b]);
    expect(fingerprint).toBe(projectCatalogFingerprint([b, { ...a, tags: [...a.tags].reverse(), conversations: [...a.conversations].reverse() }]));
    expect(fingerprint).not.toBe(projectCatalogFingerprint([{ ...a, description: "新的说明" }, b]));
    expect(fingerprint).not.toBe(projectCatalogFingerprint([{ ...a, conversationCount: 10 }, b]));
  });
});
