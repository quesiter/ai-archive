import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { api, jsonBody } from "./api.js";
import { conversationArchiveHref } from "./conversation-archive.js";

export type MergeSuggestionProject = {
  id: string;
  name: string;
  description: string;
  conversationCount: number;
  conversations: Array<{ id: string; title: string }>;
  tags: string[];
};

export type ProjectMergeSuggestion = {
  id: string;
  projects: MergeSuggestionProject[];
  targetProjectId: string;
  level: "high" | "medium";
  reasons: string[];
  sharedTags: string[];
  score: number;
  source: "local" | "ai";
  evidence?: Array<{ projectIds: [string, string]; reasons: string[]; source: "local" | "ai" }>;
};

export type MergeSuggestionsResponse = {
  items: ProjectMergeSuggestion[];
  ignoredCount: number;
  scannedProjectCount: number;
  emptyProjectCount?: number;
  ai: { available: boolean; cached: boolean; generatedAt: string | null; stale: boolean };
  pagination?: { total: number; limit: number; offset: number; hasMore: boolean };
};

type IgnoredPair = { projectIds: [string, string]; projectNames: [string, string] };
export type MergeSuggestionsState = {
  data: MergeSuggestionsResponse | null;
  loading: boolean;
  pending: boolean;
  error: string;
  message: string;
  showIgnored: boolean;
  ignoredLoading: boolean;
  ignored: IgnoredPair[];
};

const initialState: MergeSuggestionsState = {
  data: null, loading: true, pending: false, error: "", message: "",
  showIgnored: false, ignoredLoading: false, ignored: [],
};
const path = "/api/v1/projects/merge-suggestions";

// Produces form values only. The existing merge dialog owns final confirmation.
export function prepareSuggestedMerge(suggestion: ProjectMergeSuggestion) {
  if (suggestion.projects.length < 2 || suggestion.projects.length > 20
    || new Set(suggestion.projects.map(project => project.id)).size !== suggestion.projects.length) return null;
  const target = suggestion.projects.find(project => project.id === suggestion.targetProjectId);
  if (!target) return null;
  return {
    sourceProjectIds: suggestion.projects.filter(project => project.id !== target.id).map(project => project.id),
    targetProjectId: target.id,
    targetName: target.name,
  };
}

// Review a selected subset without losing the original group's evidence. This
// only prepares form values; the parent dialog still owns final confirmation.
export function selectSuggestedProjects(
  suggestion: ProjectMergeSuggestion,
  selectedProjectIds: ReadonlySet<string>,
  targetProjectId = suggestion.targetProjectId,
): ProjectMergeSuggestion | null {
  if (!prepareSuggestedMerge(suggestion) || !selectedProjectIds.has(targetProjectId)) return null;
  const projects = suggestion.projects.filter(project => selectedProjectIds.has(project.id));
  const selected = { ...suggestion, projects, targetProjectId };
  return prepareSuggestedMerge(selected) ? selected : null;
}

export function createMergeSuggestionsController({
  onChange, request = api,
}: {
  onChange: (state: MergeSuggestionsState) => void;
  request?: typeof api;
}) {
  let state = { ...initialState };
  let disposed = false;
  let readVersion = 0;
  let readAbort: AbortController | undefined;
  let mutationAbort: AbortController | undefined;
  let ignoredVersion = 0;

  function update(patch: Partial<MergeSuggestionsState>) {
    if (disposed) return;
    state = { ...state, ...patch };
    onChange(state);
  }

  async function load(offset = 0) {
    if (disposed || state.pending) return;
    const version = ++readVersion;
    readAbort?.abort();
    readAbort = new AbortController();
    update({ loading: true, error: "" });
    try {
      const data = await request<MergeSuggestionsResponse>(`${path}?limit=8&offset=${offset}`, { signal: readAbort.signal });
      if (disposed || version !== readVersion) return;
      // A concurrent merge/dismissal can remove the final page.
      if (!data.items.length && offset > 0) { await load(0); return; }
      update({ data, loading: false });
    } catch (reason) {
      if (!disposed && version === readVersion) update({ loading: false, error: errorMessage(reason) });
    }
  }

  async function loadIgnored() {
    const version = ++ignoredVersion;
    update({ showIgnored: true, ignoredLoading: true, error: "" });
    try {
      const result = await request<{ items: IgnoredPair[] }>(`${path}/ignored`);
      if (version === ignoredVersion) update({ ignored: result.items, ignoredLoading: false });
    } catch (reason) {
      if (version === ignoredVersion) update({ ignoredLoading: false, error: errorMessage(reason) });
    }
  }

  async function mutate(action: "analyze" | "dismiss" | "restore", projectIds?: string[]) {
    if (disposed || state.pending) return;
    readVersion += 1;
    readAbort?.abort();
    mutationAbort = new AbortController();
    update({ pending: true, loading: false, error: "", message: action === "analyze" ? "正在比较项目含义与会话线索，请稍候…" : "" });
    try {
      await request(`${path}/${action === "restore" ? "dismiss" : action}`, {
        method: action === "restore" ? "DELETE" : "POST",
        signal: mutationAbort.signal,
        ...(projectIds ? jsonBody({ projectIds }) : {}),
      });
      if (disposed) return;
      update({ pending: false, message: action === "analyze" ? "AI 补充分析已完成。" : action === "dismiss" ? "已记住所选项目应分别保留。" : "已恢复对这两个项目的检查。" });
      await load(0);
      if (state.showIgnored) await loadIgnored();
    } catch (reason) {
      if (!disposed) update({ pending: false, message: "", error: errorMessage(reason) });
    }
  }

  return {
    load,
    analyze: () => mutate("analyze"),
    dismiss: (suggestion: ProjectMergeSuggestion) => prepareSuggestedMerge(suggestion)
      ? mutate("dismiss", suggestion.projects.map(project => project.id)) : Promise.resolve(),
    restore: (pair: IgnoredPair) => mutate("restore", pair.projectIds),
    toggleIgnored: async () => {
      if (state.showIgnored) { ignoredVersion += 1; update({ showIgnored: false, ignoredLoading: false }); }
      else await loadIgnored();
    },
    dispose() {
      disposed = true;
      readVersion += 1;
      ignoredVersion += 1;
      readAbort?.abort();
      mutationAbort?.abort();
    },
  };
}

function errorMessage(reason: unknown) {
  return reason instanceof Error ? reason.message : String(reason);
}

function MergeSuggestionCard({ suggestion, disabled, onReview, onDismiss }: {
  suggestion: ProjectMergeSuggestion;
  disabled: boolean;
  onReview: (suggestion: ProjectMergeSuggestion) => void;
  onDismiss: (suggestion: ProjectMergeSuggestion) => void;
}) {
  const [selectedIds, setSelectedIds] = useState(() => new Set(suggestion.projects.map(project => project.id)));
  const [targetId, setTargetId] = useState(suggestion.targetProjectId);
  const [showAll, setShowAll] = useState(false);
  const selected = selectSuggestedProjects(suggestion, selectedIds, targetId);
  const selectedCount = suggestion.projects.filter(project => selectedIds.has(project.id)).length;
  const orderedProjects = [...suggestion.projects].sort((left, right) =>
    Number(right.id === targetId) - Number(left.id === targetId));
  const shownProjects = showAll ? orderedProjects : orderedProjects.slice(0, 4);
  const projectName = (id: string) => suggestion.projects.find(project => project.id === id)?.name ?? "项目";
  return (
    <article className="merge-suggestion">
      <div className="merge-suggestion-header">
        <strong>疑似同一项目 · {suggestion.projects.length} 个项目</strong>
        <span className="pill">{suggestion.level === "high" ? "优先核对" : "可核对"} · {suggestion.source === "ai" ? "AI 建议" : "线索匹配"}</span>
      </div>
      <div className={`merge-suggestion-projects${suggestion.projects.length > 2 ? " has-many-projects" : ""}`}>
        {shownProjects.map(project => (
          <div className={`merge-suggestion-project${selectedIds.has(project.id) ? " is-selected" : ""}`} key={project.id}>
            <label className="merge-suggestion-selection">
              <input
                type="checkbox"
                aria-label={`选择项目 ${project.name}`}
                checked={selectedIds.has(project.id)}
                disabled={disabled || project.id === targetId}
                onChange={event => {
                  const checked = event.target.checked;
                  setSelectedIds(current => {
                    const next = new Set(current);
                    if (checked) next.add(project.id); else next.delete(project.id);
                    return next;
                  });
                }}
              />
              {project.id === targetId ? "保留项目" : "纳入合并"}
            </label>
            <Link className="merge-suggestion-project-name" to={`/conversations?${new URLSearchParams({ projectId: project.id })}`}>{project.name}</Link>
            <span className="muted">{project.conversationCount > 0 ? `${project.conversationCount} 个会话` : "暂无会话（空项目）"}</span>
            {project.description && <p className="merge-suggestion-description">{project.description}</p>}
            {project.conversations.length > 0 && <ul className="merge-suggestion-conversations">
              {project.conversations.slice(0, 3).map(conversation => <li key={conversation.id}><Link to={conversationArchiveHref(conversation.id)}>{conversation.title || "未命名会话"}</Link></li>)}
            </ul>}
          </div>
        ))}
      </div>
      {suggestion.projects.length > 4 && <button className="ghost small merge-suggestion-expand" type="button" onClick={() => setShowAll(value => !value)} aria-expanded={showAll}>
        {showAll ? "收起项目" : `展开其余 ${suggestion.projects.length - 4} 个项目`}
      </button>}
      <ul className="merge-suggestion-reasons" aria-label="候选依据">{suggestion.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      {suggestion.projects.length > 2 && Boolean(suggestion.evidence?.length) && <details className="merge-suggestion-evidence">
        <summary>查看项目间匹配依据</summary>
        {suggestion.evidence?.map((evidence, index) => <div key={index}>
          <strong>{evidence.projectIds.map(projectName).join(" / ")}</strong>
          <ul>{evidence.reasons.map((reason, reasonIndex) => <li key={reasonIndex}>{reason}</li>)}</ul>
        </div>)}
      </details>}
      {suggestion.sharedTags.length > 0 && <p className="merge-suggestion-tags muted">共同标签：{suggestion.sharedTags.join("、")}</p>}
      <div className="merge-suggestion-review-options">
        <label>保留的目标项目
          <select aria-label="候选组保留的目标项目" value={targetId} disabled={disabled} onChange={event => {
            const id = event.target.value;
            setTargetId(id);
            setSelectedIds(current => new Set([...current, id]));
          }}>
            {suggestion.projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.id === suggestion.targetProjectId ? "（建议保留）" : ""}</option>)}
          </select>
        </label>
        <span className="muted">已选 {selectedCount}/{suggestion.projects.length} 个项目，可取消勾选不合并的项目。</span>
        <div className="button-group">
          <button type="button" className="ghost small" disabled={disabled || selectedCount === suggestion.projects.length}
            onClick={() => setSelectedIds(new Set(suggestion.projects.map(project => project.id)))}>全选本组</button>
          <button type="button" className="ghost small" disabled={disabled || selectedCount <= 1}
            onClick={() => setSelectedIds(new Set([targetId]))}>取消其他勾选</button>
        </div>
      </div>
      <div className="button-group">
        <button type="button" className="small" disabled={disabled || !selected} onClick={() => { if (selected) onReview(selected); }}>审阅合并 {selectedCount} 个项目</button>
        <button type="button" className="secondary small" disabled={disabled || !selected} onClick={() => { if (selected) onDismiss(selected); }}>所选项目保持独立</button>
      </div>
      <p className="merge-suggestion-selection-note muted">合并前仍需确认；保持独立会记住所选项目之间的判断。</p>
    </article>
  );
}

export function MergeSuggestionsView({
  state, onReview, onReload, onAnalyze, onDismiss, onToggleIgnored, onRestore,
}: {
  state: MergeSuggestionsState;
  onReview: (suggestion: ProjectMergeSuggestion) => void;
  onReload: (offset?: number) => void;
  onAnalyze: () => void;
  onDismiss: (suggestion: ProjectMergeSuggestion) => void;
  onToggleIgnored: () => void;
  onRestore: (pair: IgnoredPair) => void;
}) {
  const { data, pending, loading } = state;
  const pagination = data?.pagination;
  return (
    <section className="panel merge-suggestions" aria-labelledby="merge-suggestions-title" aria-busy={loading || pending}>
      <div className="section-title-row">
        <div>
          <h2 id="merge-suggestions-title">可能属于同一项目</h2>
          <p className="panel-subtitle">按共同依据发现多个项目组成的候选组，由你选择哪些项目合并。</p>
        </div>
        <div className="button-group">
          <button type="button" className="secondary small" disabled={loading || pending} onClick={() => onReload()}>重新检查</button>
          <button type="button" className="small" disabled={loading || pending || !data?.ai.available} onClick={onAnalyze}>{pending ? "处理中…" : "AI 补充分析"}</button>
        </div>
      </div>
      {state.error && <div className="alert error" role="alert">{state.error}</div>}
      {state.message && <p className="muted" role="status">{state.message}</p>}
      {data && <p className="merge-suggestions-scope muted">
        已检查 {data.scannedProjectCount} 个有会话项目。{(data.emptyProjectCount ?? 0) > 0 ? `另有 ${data.emptyProjectCount} 个空项目未参与推荐，仍保留在项目列表中。` : ""}候选仅供参考，审阅后仍需确认合并。
        {!data.ai.available ? <> 如需识别名称不同但含义相近的项目，可先<Link to="/settings">配置分析模型</Link>。</> : data.ai.stale ? " 项目内容已变化，可重新运行 AI 补充分析。" : data.ai.cached && data.ai.generatedAt ? ` AI 分析时间：${new Date(data.ai.generatedAt).toLocaleString()}。` : " 可用 AI 补充寻找名称不同但含义相近的项目。"}
      </p>}
      {loading && !data ? <p className="muted" role="status">正在检查合并候选…</p> : data?.items.length ? (
        <div className="merge-suggestions-list">
          {data.items.map(suggestion => <MergeSuggestionCard
            key={suggestion.id} suggestion={suggestion} disabled={pending || loading} onReview={onReview} onDismiss={onDismiss}
          />)}
        </div>
      ) : data && !loading ? <p className="muted">暂未发现有足够共同线索的候选。{data.ai.available ? "可以运行 AI 补充分析，或继续使用人工合并。" : "仍可按需要使用人工合并。"}</p> : null}
      <div className="merge-suggestions-footer">
        <button type="button" className="secondary small" disabled={pending || loading} aria-expanded={state.showIgnored} onClick={onToggleIgnored}>已标记不同项目（{data?.ignoredCount ?? 0}）</button>
        {pagination && pagination.total > 0 && <div className="button-group" aria-label="合并候选分页">
          <span className="muted">{pagination.offset + 1}–{pagination.offset + (data?.items.length ?? 0)} / {pagination.total} 组</span>
          <button type="button" className="secondary small" disabled={loading || pending || pagination.offset === 0} onClick={() => onReload(Math.max(0, pagination.offset - pagination.limit))}>上一页</button>
          <button type="button" className="secondary small" disabled={loading || pending || !pagination.hasMore} onClick={() => onReload(pagination.offset + pagination.limit)}>下一页</button>
        </div>}
      </div>
      {state.showIgnored && <div className="merge-suggestions-ignored">
        {state.ignoredLoading ? <p className="muted" role="status">加载已标记项目…</p> : state.ignored.length ? state.ignored.map(pair => <div key={pair.projectIds.join(":")}>
          <span>{pair.projectNames.join(" / ")}</span>
          <button type="button" className="secondary small" disabled={pending} onClick={() => onRestore(pair)}>恢复检查</button>
        </div>) : <p className="muted">还没有标记为不同项目的候选。</p>}
      </div>}
    </section>
  );
}

export function ProjectMergeSuggestions({ reloadKey, onReview }: {
  reloadKey: number;
  onReview: (suggestion: ProjectMergeSuggestion) => void;
}) {
  const [state, setState] = useState<MergeSuggestionsState>(initialState);
  const controller = useRef<ReturnType<typeof createMergeSuggestionsController> | null>(null);
  useEffect(() => {
    const next = createMergeSuggestionsController({ onChange: setState });
    controller.current = next;
    void next.load();
    return () => { next.dispose(); controller.current = null; };
  }, [reloadKey]);
  return <MergeSuggestionsView
    state={state}
    onReview={onReview}
    onReload={offset => { void controller.current?.load(offset); }}
    onAnalyze={() => { void controller.current?.analyze(); }}
    onDismiss={suggestion => { void controller.current?.dismiss(suggestion); }}
    onToggleIgnored={() => { void controller.current?.toggleIgnored(); }}
    onRestore={pair => { void controller.current?.restore(pair); }}
  />;
}
