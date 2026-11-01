import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import {
  createMergeSuggestionsController,
  MergeSuggestionsView,
  prepareSuggestedMerge,
  selectSuggestedProjects,
  type MergeSuggestionsResponse,
  type MergeSuggestionsState,
  type ProjectMergeSuggestion,
} from "./project-merge-suggestions.js";

const candidate: ProjectMergeSuggestion = {
  id: "source:target",
  projects: [
    { id: "source", name: "归档插件", description: "浏览器采集", conversationCount: 2, conversations: [{ id: "conversation-a", title: "修复网页归档" }], tags: ["归档"] },
    { id: "target", name: "知言归藏", description: "个人会话归档", conversationCount: 10, conversations: [{ id: "conversation-b", title: "插件与服务端同步" }], tags: ["归档"] },
  ],
  targetProjectId: "target", level: "high", reasons: ["会话中出现相同项目名“知言归藏”"], sharedTags: ["归档"], score: 0.85, source: "local",
};

function response(items = [candidate]): MergeSuggestionsResponse {
  return {
    items, ignoredCount: 0, scannedProjectCount: 80,
    ai: { available: true, cached: false, generatedAt: null, stale: false },
    pagination: { total: items.length, limit: 8, offset: 0, hasMore: false },
  };
}

function setup(request = vi.fn<typeof api>()) {
  let latest: MergeSuggestionsState | null = null;
  const controller = createMergeSuggestionsController({ request: request as typeof api, onChange: state => { latest = state; } });
  return { controller, request, latest: () => latest! };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function groupCandidate(count = 3): ProjectMergeSuggestion {
  return {
    ...candidate,
    id: "multi-project-group",
    projects: [
      ...candidate.projects,
      ...Array.from({ length: count - candidate.projects.length }, (_, index) => ({
        id: `source-${index + 2}`, name: `归档模块 ${index + 2}`, description: "知言归藏的会话归档模块", conversationCount: 3,
        conversations: [{ id: `extra-conversation-${index}`, title: "统一归档模块数据" }], tags: ["归档"],
      })),
    ],
    evidence: [{ projectIds: ["source", "target"], source: "local", reasons: ["两者会话中出现相同产品名称"] }],
  };
}

function renderView(data: MergeSuggestionsResponse) {
  const noop = () => {};
  return renderToStaticMarkup(<MemoryRouter><MergeSuggestionsView
    state={{ data, loading: false, pending: false, error: "", message: "", showIgnored: false, ignoredLoading: false, ignored: [] }}
    onReview={noop} onReload={noop} onAnalyze={noop} onDismiss={noop} onToggleIgnored={noop} onRestore={noop}
  /></MemoryRouter>);
}

describe("project merge suggestions", () => {
  it("prepares a direction without mutating the candidate or applying a merge", () => {
    expect(prepareSuggestedMerge(candidate)).toEqual({ sourceProjectIds: ["source"], targetProjectId: "target", targetName: "知言归藏" });
    expect(candidate.projects.map(project => project.id)).toEqual(["source", "target"]);
    expect(prepareSuggestedMerge({ ...candidate, targetProjectId: "removed" })).toBeNull();
    expect(prepareSuggestedMerge({ ...candidate, projects: [candidate.projects[0]!, candidate.projects[0]!] })).toBeNull();
  });

  it("prepares every selected source in a multi-project group for the existing confirmation dialog", () => {
    const group = groupCandidate(4);
    expect(prepareSuggestedMerge(group)).toEqual({
      sourceProjectIds: ["source", "source-2", "source-3"], targetProjectId: "target", targetName: "知言归藏",
    });
    expect(group.projects).toHaveLength(4);
    expect(prepareSuggestedMerge({ ...group, projects: [] })).toBeNull();
    expect(prepareSuggestedMerge({ ...group, projects: [group.projects[0]!] })).toBeNull();
    expect(prepareSuggestedMerge(groupCandidate(21))).toBeNull();
  });

  it("reviews only the checked subset and permits a different retained target", () => {
    const group = groupCandidate(4);
    const selected = selectSuggestedProjects(group, new Set(["source-2", "source"]), "source-2");
    expect(selected?.projects.map(project => project.id)).toEqual(["source", "source-2"]);
    expect(selected && prepareSuggestedMerge(selected)).toEqual({
      sourceProjectIds: ["source"], targetProjectId: "source-2", targetName: "归档模块 2",
    });
    expect(group.projects).toHaveLength(4);
    expect(selectSuggestedProjects(group, new Set(["source", "target"]), "source-2")).toBeNull();
    expect(selectSuggestedProjects(group, new Set(["target"]))).toBeNull();
    expect(selectSuggestedProjects(group, new Set(["removed", "target"]))).toBeNull();
  });

  it("renders one group with project checkboxes, a retained target and group evidence", () => {
    const markup = renderView(response([groupCandidate(3)]));
    expect(markup).toContain("疑似同一项目 · 3 个项目");
    expect(markup).toContain("审阅合并 3 个项目");
    expect(markup).toContain("选择项目 归档模块 2");
    expect(markup.match(/type="checkbox"/g)).toHaveLength(3);
    expect(markup.match(/checked=""/g)).toHaveLength(3);
    expect(markup).toContain('aria-label="候选组保留的目标项目"');
    expect(markup).toContain("知言归藏（建议保留）");
    expect(markup).toContain("查看项目间匹配依据");
    expect(markup).toContain("两者会话中出现相同产品名称");
  });

  it("keeps larger groups compact while exposing the total selected project count", () => {
    const markup = renderView(response([groupCandidate(7)]));
    expect(markup.match(/type="checkbox"/g)).toHaveLength(4);
    expect(markup).toContain("展开其余 3 个项目");
    expect(markup).toContain("已选 7/7 个项目");
    expect(markup).toContain("审阅合并 7 个项目");
  });

  it("explains excluded empty projects and labels any stale zero-count profile clearly", () => {
    const data = response([{ ...candidate, projects: [{ ...candidate.projects[0]!, conversationCount: 0 }, candidate.projects[1]!] }]);
    data.emptyProjectCount = 712;
    const markup = renderView(data);
    expect(markup).toContain("已检查 80 个有会话项目");
    expect(markup).toContain("另有 712 个空项目未参与推荐，仍保留在项目列表中");
    expect(markup).toContain("暂无会话（空项目）");
    expect(markup).not.toContain(">0 个会话<");
  });

  it("renders both projects, direct evidence links and review actions without performing a request", () => {
    const request = vi.fn();
    const markup = renderToStaticMarkup(<MemoryRouter><MergeSuggestionsView
      state={{ data: response(), loading: false, pending: false, error: "", message: "", showIgnored: false, ignoredLoading: false, ignored: [] }}
      onReview={request} onReload={request} onAnalyze={request} onDismiss={request} onToggleIgnored={request} onRestore={request}
    /></MemoryRouter>);
    expect(markup).toContain("知言归藏");
    expect(markup).toContain("归档插件");
    expect(markup).toContain("/conversations?projectId=source");
    expect(markup).toContain("/conversations/conversation-b");
    expect(markup).toContain("会话中出现相同项目名");
    expect(markup).toContain("审阅合并");
    expect(markup).toContain("所选项目保持独立");
    expect(markup).not.toContain("85%");
    expect(request).not.toHaveBeenCalled();
  });

  it("does not display stale AI results as current analysis", () => {
    const data = response();
    data.ai = { available: true, cached: true, generatedAt: "2026-10-20T12:00:00Z", stale: true };
    const noop = () => {};
    const markup = renderToStaticMarkup(<MemoryRouter><MergeSuggestionsView
      state={{ data, loading: false, pending: false, error: "", message: "", showIgnored: false, ignoredLoading: false, ignored: [] }}
      onReview={noop} onReload={noop} onAnalyze={noop} onDismiss={noop} onToggleIgnored={noop} onRestore={noop}
    /></MemoryRouter>);
    expect(markup).toContain("项目内容已变化");
    expect(markup).not.toContain("AI 分析时间");
  });

  it("keeps the latest page when an older request finishes later", async () => {
    const old = deferred<MergeSuggestionsResponse>();
    const task = setup();
    task.request.mockReturnValueOnce(old.promise).mockResolvedValueOnce(response([{ ...candidate, id: "latest" }]));
    const first = task.controller.load();
    await task.controller.load(8);
    old.resolve(response());
    await first;
    expect(task.latest().data?.items.map(item => item.id)).toEqual(["latest"]);
    expect(task.request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    task.controller.dispose();
  });

  it("returns to the first page when a concurrent change empties the final page", async () => {
    const task = setup();
    task.request.mockResolvedValueOnce(response([])).mockResolvedValueOnce(response());
    await task.controller.load(16);
    expect(task.request.mock.calls.map(call => call[0])).toEqual([
      "/api/v1/projects/merge-suggestions?limit=8&offset=16",
      "/api/v1/projects/merge-suggestions?limit=8&offset=0",
    ]);
    expect(task.latest().data?.items).toHaveLength(1);
    task.controller.dispose();
  });

  it("uses dismissal only after a deliberate action and preserves candidates on failure", async () => {
    const task = setup();
    task.request.mockResolvedValueOnce(response()).mockRejectedValueOnce(new Error("保存失败"));
    await task.controller.load();
    expect(task.request.mock.calls).toHaveLength(1);
    await task.controller.dismiss(candidate);
    expect(task.request.mock.calls[1]?.[0]).toBe("/api/v1/projects/merge-suggestions/dismiss");
    expect(task.request.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(task.request.mock.calls[1]?.[1]?.body))).toEqual({ projectIds: ["source", "target"] });
    expect(task.latest().data?.items).toHaveLength(1);
    expect(task.latest().error).toBe("保存失败");
    expect(task.latest().pending).toBe(false);
    expect(task.request.mock.calls.some(call => call[0] === "/api/v1/projects/merge")).toBe(false);
    task.controller.dispose();
  });

  it("blocks duplicate analysis submissions and fetches the current page after analysis", async () => {
    const analysis = deferred<MergeSuggestionsResponse>();
    const task = setup();
    task.request.mockResolvedValueOnce(response()).mockReturnValueOnce(analysis.promise).mockResolvedValueOnce(response());
    await task.controller.load();
    const first = task.controller.analyze();
    await task.controller.analyze();
    expect(task.request.mock.calls).toHaveLength(2);
    expect(task.latest().pending).toBe(true);
    analysis.resolve(response());
    await first;
    expect(task.request.mock.calls[1]?.[0]).toBe("/api/v1/projects/merge-suggestions/analyze");
    expect(task.request.mock.calls[2]?.[0]).toBe("/api/v1/projects/merge-suggestions?limit=8&offset=0");
    expect(task.latest().message).toBe("AI 补充分析已完成。");
    expect(task.latest().pending).toBe(false);
    task.controller.dispose();
  });

  it("persists the complete selected group as independent projects without submitting a merge", async () => {
    const group = groupCandidate(4);
    const selected = selectSuggestedProjects(group, new Set(["target", "source", "source-3"]))!;
    const task = setup();
    task.request.mockResolvedValueOnce(response([group])).mockResolvedValueOnce({ ok: true }).mockResolvedValueOnce(response([]));
    await task.controller.load();
    await task.controller.dismiss(selected);
    expect(task.request.mock.calls[1]?.[0]).toBe("/api/v1/projects/merge-suggestions/dismiss");
    expect(JSON.parse(String(task.request.mock.calls[1]?.[1]?.body))).toEqual({ projectIds: ["source", "target", "source-3"] });
    expect(task.latest().message).toBe("已记住所选项目应分别保留。");
    expect(task.request.mock.calls.some(call => call[0] === "/api/v1/projects/merge")).toBe(false);
    task.controller.dispose();
  });

  it("does not save an invalid one-member or repeated-member group decision", async () => {
    const task = setup();
    await task.controller.dismiss({ ...candidate, projects: [candidate.projects[0]!] });
    await task.controller.dismiss({ ...candidate, projects: [candidate.projects[0]!, candidate.projects[0]!] });
    expect(task.request).not.toHaveBeenCalled();
    task.controller.dispose();
  });

  it("loads ignored pairs on demand and explicitly restores one pair", async () => {
    const pair = { projectIds: ["source", "target"] as [string, string], projectNames: ["归档插件", "知言归藏"] as [string, string] };
    const task = setup();
    task.request.mockResolvedValueOnce(response()).mockResolvedValueOnce({ items: [pair] })
      .mockResolvedValueOnce({}).mockResolvedValueOnce(response()).mockResolvedValueOnce({ items: [] });
    await task.controller.load();
    expect(task.latest().showIgnored).toBe(false);
    await task.controller.toggleIgnored();
    expect(task.latest().ignored).toEqual([pair]);
    await task.controller.restore(pair);
    expect(task.request.mock.calls[2]?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(String(task.request.mock.calls[2]?.[1]?.body))).toEqual({ projectIds: pair.projectIds });
    expect(task.latest().ignored).toEqual([]);
    task.controller.dispose();
  });

  it("does not publish results from a disposed page", async () => {
    const pending = deferred<MergeSuggestionsResponse>();
    const task = setup();
    task.request.mockReturnValueOnce(pending.promise);
    const load = task.controller.load();
    const initial = task.latest();
    task.controller.dispose();
    pending.resolve(response());
    await load;
    expect(task.latest()).toBe(initial);
    expect(task.request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
