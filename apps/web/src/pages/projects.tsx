import type { ProjectOverview, ProjectGroup, ProjectConversation, ProjectMergeResult, BackgroundTask, Tag } from "../api-types.js";
import type { PageEnvelope as TypedPageEnvelope, ProjectOption, TimelineItem } from "../api-types.js";
import { FormEvent, useCallback, useEffect, useState } from "react";
import { ProjectMergeSuggestions, prepareSuggestedMerge, type ProjectMergeSuggestion } from "../project-merge-suggestions.js";
import { setVisibleInterval } from "../visible-poll";
import { Link } from "react-router-dom";
import { providerLabels } from "@ai-archive/contracts/presentation";
import type { Provider } from "@ai-archive/contracts";
import { api, jsonBody } from "../api.js";
import { filterConversationTags } from "../conversation-list.js";
import { conversationArchiveHref } from "../conversation-archive.js";
import { ConversationGroupedTitle } from "../conversation-lineage.js";
import { PageEnvelope, useLoad, Loading, ErrorBanner, Pagination, Modal, PageHeader, isActiveStatus, statusLabel, stageLabel, taskPercent, formatTaskTime, useTaskClock, deferredAiTaskMessage, formatCount, taskStats, taskFailureSamples, classificationScopeLabels, classificationCandidateReasonLabels, taskCandidateReasonEntries, downloadResponse, ExportLinks } from "../shared-ui.js";

export function ProjectTimeline({
  projectId,
  active,
}: {
  projectId: string;
  active: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const state = useLoad(
    () => active
      ? api<TypedPageEnvelope<TimelineItem>>(`/api/v1/projects/${projectId}/timeline?limit=50&offset=${offset}`)
      : Promise.resolve(null as TypedPageEnvelope<TimelineItem> | null),
    [active, projectId, offset],
  );
  if (!active) return null;
  if (state.loading) return <Loading label="加载项目会话中…" />;
  if (state.error) return <ErrorBanner message={state.error} />;
  const items = Array.isArray(state.data?.items) ? state.data.items : [];
  return (
    <div className="project-timeline">
      <div className="section-title-row">
        <strong>项目会话</strong>
        <span className="muted">按最近采集时间排序，子代理归入主会话</span>
      </div>
      {items.length ? items.map((item) => (
        <div className="timeline-item" key={item.conversationId}>
          <time>{new Date(item.capturedAt).toLocaleDateString()}</time>
          <div>
            <ConversationGroupedTitle
              conversationId={item.conversationId}
              href={conversationArchiveHref(item.conversationId)}
              title={`${providerLabels[item.provider as Provider] ?? item.provider} · ${item.title || "未命名会话"}`}
              childCount={item.childCount ?? 0}
            />
            <span>{Array.isArray(item.tags) ? item.tags.map((tag: Tag & { count?: number }) => tag.name).join(" · ") : ""}</span>
          </div>
        </div>
      )) : <p className="muted">这个项目还没有可展示的会话归档。</p>}
      <Pagination
        loading={state.loading}
        pagination={state.data?.pagination}
        onOffsetChange={setOffset}
      />
    </div>
  );
}

export function Projects() {
  const overviewState = useLoad(() => api<ProjectOverview>("/api/v1/projects/overview"), []);
  const [mergeSuggestionsReload, setMergeSuggestionsReload] = useState(0);
  const [projectOffset, setProjectOffset] = useState(0);
  const [projectSearchInput, setProjectSearchInput] = useState("");
  const [projectSearch, setProjectSearch] = useState("");
  const [unclassifiedOffset, setUnclassifiedOffset] = useState(0);
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(new Set());
  const projectState = useLoad(
    () => api<PageEnvelope<ProjectGroup>>(`/api/v1/projects?${new URLSearchParams({ limit: "40", offset: String(projectOffset), q: projectSearch })}`),
    [projectOffset, projectSearch],
  );
  const unclassifiedState = useLoad(
    () => api<PageEnvelope<ProjectConversation>>(`/api/v1/unclassified?limit=40&offset=${unclassifiedOffset}`),
    [unclassifiedOffset],
  );
  const projectOptionsState = useLoad(
    () => api<ProjectOption[]>("/api/v1/projects/options"),
    [],
  );
  const [error, setError] = useState("");
  const [classificationMessage, setClassificationMessage] = useState("");
  const [classificationTask, setClassificationTask] = useState<BackgroundTask | null>(null);
  const [classificationRunMode, setClassificationRunMode] = useState<"economy" | "full">("economy");
  const [mergeSourceIds, setMergeSourceIds] = useState<string[]>([]);
  const [mergeSourceSearch, setMergeSourceSearch] = useState("");
  const [mergeTargetSearch, setMergeTargetSearch] = useState("");
  const [mergePending, setMergePending] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState("");
  const [mergeTargetName, setMergeTargetName] = useState("");
  const [mergeMessage, setMergeMessage] = useState("");
  const [projectDialog, setProjectDialog] = useState<"create" | "merge" | null>(null);
  const [contextDownload, setContextDownload] = useState<{
    projectId: string;
    ai: boolean;
  } | null>(null);
  const classificationActive = isActiveStatus(classificationTask?.status);
  const classificationClock = useTaskClock(classificationActive);
  const overview = overviewState.data ?? { totals: {} };
  const projectGroups = projectState.data?.items ?? [];
  const projectOptions = projectOptionsState.data ?? [];
  const visibleMergeSources = filterConversationTags(projectOptions, mergeSourceSearch);
  const eligibleMergeTargets = projectOptions.filter((project) => !project.archived && !mergeSourceIds.includes(project.id));
  const visibleMergeTargets = filterConversationTags(eligibleMergeTargets, mergeTargetSearch);
  const selectedMergeTarget = eligibleMergeTargets.find((project) => project.id === mergeTargetId);
  const activeProjectGroups = projectGroups.filter((project) => !project.archived);
  const archivedProjectGroups = projectGroups.filter((project) => project.archived);
  const categorizedProjectGroups = activeProjectGroups.filter(
    (project) => Number(project.conversationCount ?? 0) > 0,
  );
  const emptyProjectGroups = activeProjectGroups.filter(
    (project) => Number(project.conversationCount ?? 0) <= 0,
  );
  const unclassified = unclassifiedState.data?.items ?? [];
  const totals = overview.totals ?? {};
  const totalProjectCount = Number(totals.projectCount ?? activeProjectGroups.length);
  const archivedProjectCount = Number(
    totals.archivedProjectCount ?? archivedProjectGroups.length,
  );
  const activeCategoryCount = Number(
    totals.activeProjectCount ?? categorizedProjectGroups.length,
  );
  const categorizedConversationCount = Number(
    totals.categorizedConversationCount ??
      projectGroups.reduce(
        (sum, project) => sum + Number(project.conversationCount ?? 0),
        0,
      ),
  );
  const unclassifiedConversationCount = Number(
    totals.unclassifiedConversationCount ?? unclassified.length,
  );
  const tagCount = Number(totals.tagCount ?? 0);
  const reloadProjectsData = useCallback(() => {
    setMergeSuggestionsReload(value => value + 1);
    overviewState.reload();
    projectState.reload();
    unclassifiedState.reload();
    projectOptionsState.reload();
  }, [overviewState.reload, projectState.reload, unclassifiedState.reload, projectOptionsState.reload]);

  function reviewMergeSuggestion(suggestion: ProjectMergeSuggestion) {
    const prepared = prepareSuggestedMerge(suggestion);
    if (!prepared || suggestion.projects.some(project => !projectOptions.some(option => option.id === project.id && !option.archived))) {
      setError("候选项目已变化，请重新检查后再审阅。");
      reloadProjectsData();
      return;
    }
    setError("");
    setMergeMessage("");
    setMergeSourceSearch("");
    setMergeTargetSearch("");
    setMergeSourceIds(prepared.sourceProjectIds);
    setMergeTargetId(prepared.targetProjectId);
    setMergeTargetName(prepared.targetName);
    setProjectDialog("merge");
  }

  function setProjectExpanded(projectId: string, expanded: boolean): void {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (expanded) next.add(projectId);
      else next.delete(projectId);
      return next;
    });
  }

  useEffect(() => {
    let cancelled = false;
    void api<{ task: BackgroundTask | null }>("/api/v1/classification/tasks/latest")
      .then((payload) => {
        if (!cancelled && payload.task && isActiveStatus(payload.task.status)) {
          setClassificationTask(payload.task);
          setClassificationMessage(payload.task.message ?? "项目与标签整理正在运行");
        }
      })
      .catch(() => null);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!classificationTask?.id || !classificationActive) return;
    const timer = setVisibleInterval(() => {
      void api<BackgroundTask>(`/api/v1/classification/tasks/${classificationTask.id}`)
        .then((task) => {
          setClassificationTask(task);
          setClassificationMessage(task.message ?? statusLabel(task.status));
          if (!isActiveStatus(task.status)) {
            reloadProjectsData();
          }
        })
        .catch((reason) =>
          setClassificationMessage(
            reason instanceof Error ? reason.message : String(reason),
          ),
        );
    }, 2000);
    return () => window.clearInterval(timer);
  }, [
    classificationTask?.id,
    classificationActive,
    reloadProjectsData,
  ]);

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      await api("/api/v1/projects", {
        method: "POST",
        ...jsonBody({
          name: form.get("name"),
          description: form.get("description"),
        }),
      });
      formElement.reset();
      setProjectDialog(null);
      reloadProjectsData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }
  async function runClassification() {
    setClassificationMessage("正在加入项目与标签整理队列…");
    setClassificationTask(null);
    try {
      const payload = await api<{
        jobId: string | null;
        task: BackgroundTask;
        reused?: boolean;
      }>("/api/v1/classification/run", {
        method: "POST",
        ...jsonBody({
          mode: classificationRunMode,
          scope: classificationRunMode === "full" ? "all" : "incremental",
        }),
      });
      setClassificationTask(payload.task);
      setClassificationMessage(
        payload.reused
          ? "已有项目与标签整理任务正在运行，已切换到当前任务进度"
          : payload.task.message ?? "已加入队列，等待 Worker 接手",
      );
    } catch (reason) {
      setClassificationMessage(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function mergeProjects(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mergePending) return;
    const sources = projectOptions.filter((project) => mergeSourceIds.includes(project.id));
    const target = projectOptions.find((project) => project.id === mergeTargetId);
    const targetName = mergeTargetName.trim();
    if (!sources.length || sources.length !== mergeSourceIds.length || !target || target.archived || mergeSourceIds.includes(target.id) || !targetName) return;
    if (!window.confirm(`确认把 ${sources.length} 个源项目（${sources.map((project) => `“${project.name}”`).join("、")}）合并到“${target.name}”，并将合并后的项目命名为“${targetName}”？所有源项目将在迁移完成后删除，此操作不可撤销。`)) return;
    setError("");
    setMergePending(true);
    setMergeMessage("正在合并项目…");
    try {
      const result = await api<ProjectMergeResult>("/api/v1/projects/merge", {
        method: "POST",
        ...jsonBody({ sourceProjectIds: mergeSourceIds, targetProjectId: target.id, targetName }),
      });
      setMergeMessage(`已将 ${result.sourceProjectIds.length} 个源项目合并到“${result.targetProjectName}”：迁移 ${result.movedConversationCount ?? 0} 个会话和 ${result.movedReportCount ?? 0} 份关联报告。`);
      setMergeSourceIds([]);
      setMergeSourceSearch("");
      setMergeTargetSearch("");
      setMergeTargetId("");
      setMergeTargetName("");
      setProjectDialog(null);
      setProjectOffset(0);
      reloadProjectsData();
    } catch (reason) {
      setMergeMessage("");
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setMergePending(false);
    }
  }

  async function editProject(project: ProjectOption) {
    const name = window.prompt("项目名称", String(project.name ?? ""));
    if (!name?.trim()) return;
    const description = window.prompt("项目说明", String(project.description ?? ""));
    if (description === null) return;
    try {
      await api(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        ...jsonBody({ name: name.trim(), description: description.trim() }),
      });
      reloadProjectsData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function setProjectArchived(project: ProjectOption, archived: boolean) {
    const action = archived ? "归档" : "恢复";
    if (!window.confirm(`确认${action}项目“${project.name}”？会话不会被删除。`)) return;
    try {
      await api(`/api/v1/projects/${project.id}`, {
        method: "PATCH",
        ...jsonBody({ archived }),
      });
      reloadProjectsData();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }

  async function downloadProjectContext(project: ProjectOption, ai = true) {
    if (contextDownload) return;
    setError("");
    async function download(useAi: boolean) {
      setContextDownload({ projectId: String(project.id), ai: useAi });
      await downloadResponse(
        `/api/v1/projects/${project.id}/context`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ai: useAi }),
        },
        "PROJECT-CONTEXT.md",
      );
    }
    try {
      await download(ai);
    } catch (reason) {
      if (ai && window.confirm("智能总结生成失败，是否改为生成不使用 AI 的基础版本？")) {
        try {
          await download(false);
          return;
        } catch (fallbackReason) {
          setError(fallbackReason instanceof Error ? fallbackReason.message : String(fallbackReason));
          return;
        }
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setContextDownload(null);
    }
  }

  function confidenceLabel(value: unknown): string {
    return typeof value === "number" ? `${Math.round(value * 100)}%` : "未评分";
  }

  const percent = taskPercent(classificationTask);
  const stats = taskStats(classificationTask);
  const classificationDeferredMessage = deferredAiTaskMessage(
    stats,
    classificationClock,
  );
  const visibleClassificationMessage =
    classificationDeferredMessage || classificationMessage;
  const failureSamples = taskFailureSamples(classificationTask);
  const candidateReasonEntries = taskCandidateReasonEntries(classificationTask);
  const classificationScopeLabel =
    classificationScopeLabels[String(stats.scope ?? "")] ?? "未记录";
  return (
    <>
      <PageHeader
        title="项目"
        subtitle="用一个主项目组织每段归档会话；跨项目主题请前往独立标签页。"
        actions={
          <div className="button-group">
            <select
              disabled={classificationActive}
              value={classificationRunMode}
              onChange={(event) =>
                setClassificationRunMode(
                  event.target.value === "full" ? "full" : "economy",
                )
              }
            >
              <option value="economy">增量整理</option>
              <option value="full">完整整理未锁定会话</option>
            </select>
            <button disabled={classificationActive} onClick={() => void runClassification()}>
              {classificationActive ? "整理中" : "整理项目与标签"}
            </button>
          </div>
        }
      />
      <ErrorBanner message={error || overviewState.error || projectState.error || unclassifiedState.error} />
      {mergeMessage && <div className="alert success">{mergeMessage}</div>}
      <section className={`panel project-status-panel${classificationTask ? " has-task" : ""}`}>
        <div className="project-status-summary">
          <strong>{classificationTask ? `项目与标签整理 · ${statusLabel(classificationTask.status)}` : "项目概况"}</strong>
          <span>
            {visibleClassificationMessage || (
              activeCategoryCount > 0
                ? `当前 ${activeCategoryCount} 个已启用项目，已归类 ${categorizedConversationCount} 个会话，待归类 ${unclassifiedConversationCount} 个。`
                : "当前还没有可展示的组织结果，先创建项目或运行一次整理。"
            )}
          </span>
          {classificationTask && <time>{formatTaskTime(classificationTask.updatedAt)}</time>}
        </div>
        {classificationTask && (
          <>
            <div className="project-status-progress">
              <div className="progress-bar">
                <span style={{ width: `${percent}%` }} />
              </div>
              <strong>{percent}%</strong>
            </div>
            <div className="project-status-details">
              <span>范围 {classificationScopeLabel}</span>
              <span>已处理 {classificationTask.processedCount ?? 0}/{classificationTask.totalCount ?? 0}</span>
              <span>已归类 {stats.classified ?? 0}</span>
              <span>标签关联 {stats.tagAssignments ?? 0}</span>
              <span>失败 {classificationTask.failedCount ?? 0}</span>
              {stats.stage && <span>阶段 {stageLabel(stats.stage)}</span>}
              {candidateReasonEntries.map((item) => (
                <span className="project-status-pill" key={item.key}>
                  {classificationCandidateReasonLabels[item.key] ?? item.key} {formatCount(item.count)}
                </span>
              ))}
            </div>
            {classificationTask.error && !classificationActive && !classificationDeferredMessage && (
              <p className="progress-error">{classificationTask.error}</p>
            )}
            {failureSamples.length > 0 && (
              <details className="failure-list compact-failure-list">
                <summary>查看 {failureSamples.length} 条失败样例</summary>
                {failureSamples.map((sample, index) => (
                  <p key={`${sample.conversationId ?? index}`}>
                    {sample.title || sample.conversationId || `样例 ${index + 1}`}：
                    {sample.error}
                  </p>
                ))}
              </details>
            )}
          </>
        )}
      </section>

      <section className="project-metrics">
        <article className="metric">
          <span>项目</span>
          <strong>{activeCategoryCount}</strong>
          <small>共 {totalProjectCount} 个项目{archivedProjectCount > 0 ? `，另 ${archivedProjectCount} 个已归档` : ""}</small>
        </article>
        <article className="metric">
          <span>已归类会话</span>
          <strong>{categorizedConversationCount}</strong>
          <small>按项目分组展示</small>
        </article>
        <article className="metric">
          <span>待归类会话</span>
          <strong>{unclassifiedConversationCount}</strong>
          <small>含仅有建议的会话</small>
        </article>
        <article className="metric">
          <span>标签</span>
          <strong>{tagCount}</strong>
          <small>可跨项目组合筛选</small>
        </article>
      </section>

      <section className="project-board">
        <div className="section-title-row">
          <div>
            <h2>项目</h2>
            <p className="panel-subtitle">展开项目可查看会话、标签分布、时间线与导出入口。</p>
          </div>
          <div className="project-board-actions">
            <span className="pill">{activeCategoryCount} 个活跃项目</span>
            <button
              className="secondary small"
              onClick={() => {
                setError("");
                setMergeMessage("");
                setMergeSourceIds([]);
                setMergeSourceSearch("");
                setMergeTargetSearch("");
                setMergeTargetId("");
                setMergeTargetName("");
                setProjectDialog("merge");
              }}
            >合并项目</button>
            <button
              className="small"
              onClick={() => {
                setError("");
                setProjectDialog("create");
              }}
            >新建项目</button>
          </div>
        </div>
        <form
          className="project-search-row"
          role="search"
          aria-label="项目搜索"
          onSubmit={(event) => {
            event.preventDefault();
            setProjectSearch(projectSearchInput.trim());
            setProjectOffset(0);
            setExpandedProjectIds(new Set());
          }}
        >
          <input
            aria-label="搜索项目名称"
            type="search"
            maxLength={200}
            placeholder="搜索项目名称（含已归档项目）"
            value={projectSearchInput}
            onChange={(event) => setProjectSearchInput(event.target.value)}
          />
          <button type="submit" className="secondary">搜索</button>
          {(projectSearchInput || projectSearch) && (
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setProjectSearchInput("");
                setProjectSearch("");
                setProjectOffset(0);
                setExpandedProjectIds(new Set());
              }}
            >清除</button>
          )}
          {projectSearch && !projectState.loading && !projectState.error && (
            <span className="muted" role="status">找到 {projectState.data?.pagination.total ?? 0} 个项目</span>
          )}
        </form>
        {projectState.loading ? (
          <Loading label="加载项目中…" />
        ) : activeProjectGroups.length ? (
          <div className="project-group-list">
            {categorizedProjectGroups.map((project) => {
              const conversations = Array.isArray(project.conversations)
                ? project.conversations
                : [];
              const conversationCount = Number(project.conversationCount ?? conversations.length);
              const projectId = String(project.id);
              const contextBusy = contextDownload?.projectId === projectId;
              return (
                <details
                  className="project-group"
                  key={project.id}
                  onToggle={(event) => setProjectExpanded(projectId, event.currentTarget.open)}
                >
                  <summary>
                    <div className="project-group-title">
                      <strong>{project.name}</strong>
                      <p>{project.description || "暂无描述"}</p>
                    </div>
                    <div className="project-group-counts">
                      <span>{conversationCount} 会话</span>
                      <span>近 7 日 +{project.growth7d ?? 0}</span>
                      <span>近 30 日 +{project.growth30d ?? 0}</span>
                    </div>
                  </summary>
                  <div className="project-group-actions">
                    <ExportLinks path={`/api/v1/projects/${project.id}/export`} />
                    <button
                      className="secondary small"
                      disabled={contextDownload !== null}
                      onClick={() => void downloadProjectContext(project, true)}
                    >{contextBusy && contextDownload.ai ? "正在生成智能上下文…" : "智能上下文（推荐）"}</button>
                    <button
                      className="ghost small"
                      disabled={contextDownload !== null}
                      onClick={() => void downloadProjectContext(project, false)}
                    >{contextBusy && !contextDownload.ai ? "正在生成历史索引…" : "仅历史索引"}</button>
                    <button className="secondary small" onClick={() => void editProject(project)}>编辑</button>
                    <button className="danger small" onClick={() => void setProjectArchived(project, true)}>归档</button>
                  </div>
                  {Array.isArray(project.commonTags) && project.commonTags.length > 0 && (
                    <div className="project-common-tags">
                      {project.commonTags.map((tag: Tag & { count?: number }) => (
                        <Link className="pill" key={tag.id} to={`/conversations?projectId=${project.id}&tagIds=${tag.id}`}>
                          {tag.name} · {tag.count}
                        </Link>
                      ))}
                    </div>
                  )}
                  {conversations.length ? (
                    <div className="project-conversation-list">
                      {conversations.map((conversation: ProjectConversation) => (
                        <Link
                          className="project-conversation-row"
                          key={conversation.id}
                          to={`/conversations/${conversation.id}`}
                        >
                          <div className="project-conversation-main">
                            <strong>{conversation.title || conversation.id}</strong>
                            <span>
                              {providerLabels[conversation.provider as Provider] ??
                                conversation.provider} · {formatTaskTime(conversation.updatedAt)}
                            </span>
                          </div>
                          <div className="project-conversation-tags">
                            {conversation.lockedByUser && (
                              <span className="pill complete">人工锁定</span>
                            )}
                            <span>{confidenceLabel(conversation.confidence)}</span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  ) : conversationCount <= 0 ? (
                    <p className="project-empty">这个项目暂时还没有归入会话。</p>
                  ) : null}
                  <ProjectTimeline
                    active={expandedProjectIds.has(projectId)}
                    projectId={projectId}
                  />
                </details>
              );
            })}
            {emptyProjectGroups.length > 0 && (
              <details className="project-group empty-project-group" key={projectSearch} open={projectSearch ? true : undefined}>
                <summary>
                  <div className="project-group-title">
                    <strong>空项目</strong>
                    <p>这些项目目前没有会话，可作为人工整理的候选。</p>
                  </div>
                  <div className="project-group-counts">
                    <span>{emptyProjectGroups.length} 个</span>
                  </div>
                </summary>
                <div className="empty-project-list">
                  {emptyProjectGroups.map((project) => (
                    <div className="empty-project-item" key={project.id}>
                      <span>{project.name}</span>
                      <div className="button-group">
                        <ExportLinks path={`/api/v1/projects/${project.id}/export`} />
                        <button className="secondary small" onClick={() => void editProject(project)}>编辑</button>
                        <button className="danger small" onClick={() => void setProjectArchived(project, true)}>归档</button>
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        ) : (
          <Loading label={projectSearch
            ? (archivedProjectGroups.length ? "本页匹配的项目均已归档，请查看下方列表。" : "没有找到匹配的项目，请更换关键词或清除搜索。")
            : "本页没有未归档项目。可翻页查看，或创建项目。"} />
        )}
      </section>

      {!projectState.loading && archivedProjectGroups.length > 0 && (
        <section className="project-board">
          <div className="section-title-row">
            <div>
              <h2>已归档项目</h2>
              <p className="panel-subtitle">保留原有会话、标签、时间线和导出；恢复后可重新接收归类。</p>
            </div>
            <span className="pill">本页 {archivedProjectGroups.length} 个</span>
          </div>
          <div className="project-group-list">
            {archivedProjectGroups.map((project) => {
              const conversations = Array.isArray(project.conversations)
                ? project.conversations
                : [];
              const projectId = String(project.id);
              const contextBusy = contextDownload?.projectId === projectId;
              return (
                <details
                  className="project-group empty-project-group"
                  key={project.id}
                  onToggle={(event) => setProjectExpanded(projectId, event.currentTarget.open)}
                >
                  <summary>
                    <div className="project-group-title">
                      <strong>{project.name}</strong>
                      <p>{project.description || "暂无描述"}</p>
                    </div>
                    <div className="project-group-counts">
                      <span>{project.conversationCount ?? conversations.length} 会话</span>
                      <span>已归档</span>
                    </div>
                  </summary>
                  <div className="project-group-actions">
                    <ExportLinks path={`/api/v1/projects/${project.id}/export`} />
                    <button
                      className="secondary small"
                      disabled={contextDownload !== null}
                      onClick={() => void downloadProjectContext(project, true)}
                    >{contextBusy && contextDownload.ai ? "正在生成智能上下文…" : "智能上下文（推荐）"}</button>
                    <button
                      className="ghost small"
                      disabled={contextDownload !== null}
                      onClick={() => void downloadProjectContext(project, false)}
                    >{contextBusy && !contextDownload.ai ? "正在生成历史索引…" : "仅历史索引"}</button>
                    <button className="secondary small" onClick={() => void editProject(project)}>编辑</button>
                    <button className="secondary small" onClick={() => void setProjectArchived(project, false)}>恢复项目</button>
                  </div>
                  {conversations.length > 0 && (
                    <div className="project-conversation-list">
                      {conversations.map((conversation: ProjectConversation) => (
                        <Link className="project-conversation-row" key={conversation.id} to={`/conversations/${conversation.id}`}>
                          <div className="project-conversation-main">
                            <strong>{conversation.title || conversation.id}</strong>
                            <span>{providerLabels[conversation.provider as Provider] ?? conversation.provider} · {formatTaskTime(conversation.updatedAt)}</span>
                          </div>
                        </Link>
                      ))}
                    </div>
                  )}
                  <ProjectTimeline
                    active={expandedProjectIds.has(projectId)}
                    projectId={projectId}
                  />
                </details>
              );
            })}
          </div>
        </section>
      )}
      <Pagination loading={projectState.loading} pagination={projectState.data?.pagination} onOffsetChange={setProjectOffset} />

      <ProjectMergeSuggestions reloadKey={mergeSuggestionsReload} onReview={reviewMergeSuggestion} />

      <section className="project-board">
        <div className="section-title-row">
          <div>
            <h2>待归类</h2>
            <p className="panel-subtitle">这些会话还没有确认项目，可能只有 AI 建议名。</p>
          </div>
          <span className="pill partial">{unclassifiedConversationCount} 条</span>
        </div>
        {unclassifiedState.loading ? (
          <Loading label="加载待归类会话中…" />
        ) : unclassified.length ? (
          <div className="project-conversation-list unclassified-list">
            {unclassified.map((item) => (
              <div
                className="project-conversation-row"
                key={item.id}
              >
                <div className="project-conversation-main">
                  <ConversationGroupedTitle
                    conversationId={item.id}
                    href={`/conversations/${item.id}`}
                    title={item.title || item.id}
                    childCount={item.childCount ?? 0}
                  />
                  <span>
                    {providerLabels[item.provider as Provider] ?? item.provider} ·
                    {item.suggestedName ? ` 建议：${item.suggestedName}` : " 等待分析"}
                  </span>
                </div>
                <div className="project-conversation-tags">
                  <span>{confidenceLabel(item.confidence)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Loading label="当前没有待归类会话。" />
        )}
        <Pagination loading={unclassifiedState.loading} pagination={unclassifiedState.data?.pagination} onOffsetChange={setUnclassifiedOffset} />
      </section>

      {projectDialog === "create" && (
        <Modal
          description="新增后可重新运行整理，或在会话详情中人工锁定项目。"
          onClose={() => setProjectDialog(null)}
          title="新建项目"
        >
          <ErrorBanner message={error} />
          <form className="stack modal-form" onSubmit={createProject}>
            <label>项目名称<input name="name" autoFocus placeholder="例如：知识归档系统" required /></label>
            <label>项目描述（可选）<textarea name="description" placeholder="简要说明项目范围" rows={3} /></label>
            <div className="modal-actions">
              <button className="secondary" onClick={() => setProjectDialog(null)} type="button">取消</button>
              <button type="submit">创建项目</button>
            </div>
          </form>
        </Modal>
      )}

      {projectDialog === "merge" && (
        <Modal
          description="可选择多个源项目，将全部会话和关联报告迁移到一个目标项目，随后删除源项目。"
          onClose={() => { if (!mergePending) setProjectDialog(null); }}
          title="合并项目"
        >
          <ErrorBanner message={error || projectOptionsState.error} />
          <form className="stack modal-form" onSubmit={mergeProjects}>
            <fieldset className="merge-source-fieldset" disabled={mergePending || projectOptionsState.loading}>
              <legend>A · 源项目（可多选，已选 {mergeSourceIds.length} 个）</legend>
              <input
                aria-label="搜索源项目"
                type="search"
                placeholder="搜索源项目名称"
                value={mergeSourceSearch}
                onChange={(event) => setMergeSourceSearch(event.target.value)}
              />
              <div className="merge-source-list">
                {projectOptionsState.loading ? <p className="muted">加载项目中…</p> : visibleMergeSources.length ? (
                  visibleMergeSources.map((project) => (
                    <label className="merge-source-option" key={project.id}>
                      <input
                        type="checkbox"
                        checked={mergeSourceIds.includes(project.id)}
                        disabled={project.id === mergeTargetId}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setMergeSourceIds((current) => checked
                            ? [...current, project.id]
                            : current.filter((id) => id !== project.id));
                        }}
                      />
                      <span>{project.name}{project.archived ? "（已归档）" : ""}{project.id === mergeTargetId ? "（目标项目）" : ""}</span>
                    </label>
                  ))
                ) : <p className="muted">没有匹配的源项目。</p>}
              </div>
              <div className="button-group">
                <button
                  className="secondary small"
                  type="button"
                  disabled={!visibleMergeSources.some((project) => project.id !== mergeTargetId && !mergeSourceIds.includes(project.id))}
                  onClick={() => setMergeSourceIds((current) => [...new Set([
                    ...current,
                    ...visibleMergeSources.filter((project) => project.id !== mergeTargetId).map((project) => String(project.id)),
                  ])])}
                >全选当前结果</button>
                {mergeSourceIds.length > 0 && (
                  <button className="secondary small" type="button" onClick={() => setMergeSourceIds([])}>清空已选</button>
                )}
              </div>
            </fieldset>
            <div className="modal-merge-arrow">↓ 会话和报告迁移至</div>
            <label>B · 目标项目
              <input
                aria-label="搜索目标项目"
                type="search"
                placeholder="输入项目名称搜索目标项目"
                disabled={mergePending || projectOptionsState.loading}
                value={mergeTargetSearch}
                onChange={(event) => setMergeTargetSearch(event.target.value)}
              />
              <select
                aria-label="选择目标项目"
                disabled={mergePending || projectOptionsState.loading}
                value={mergeTargetId}
                onChange={(event) => {
                  const targetId = event.target.value;
                  setMergeTargetId(targetId);
                  const selectedProject = projectOptions.find((project) => project.id === targetId);
                  setMergeTargetName(String(selectedProject?.name ?? ""));
                }}
                required
              >
                <option value="">请选择保留的目标项目</option>
                {selectedMergeTarget && !visibleMergeTargets.some((project) => project.id === selectedMergeTarget.id) && (
                  <option value={selectedMergeTarget.id}>{selectedMergeTarget.name}（已选）</option>
                )}
                {visibleMergeTargets.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
            </label>
            {mergeTargetSearch.trim() && !visibleMergeTargets.length && <p className="muted" role="status">没有匹配的目标项目，请调整搜索关键词。</p>}
            <label>合并后项目名称
              <input
                disabled={mergePending || !mergeTargetId}
                maxLength={200}
                onChange={(event) => setMergeTargetName(event.target.value)}
                placeholder="请先选择目标项目"
                required
                value={mergeTargetName}
              />
            </label>
            <p className="modal-warning">合并后无法撤销，请确认源项目与目标项目选择正确。</p>
            <div className="modal-actions">
              <button className="secondary" disabled={mergePending} onClick={() => setProjectDialog(null)} type="button">取消</button>
              <button className="danger" disabled={mergePending || !mergeSourceIds.length || !mergeTargetId || !mergeTargetName.trim() || mergeSourceIds.includes(mergeTargetId)}>{mergePending ? "正在合并…" : `确认合并${mergeSourceIds.length ? ` ${mergeSourceIds.length} 个项目` : ""}`}</button>
            </div>
          </form>
        </Modal>
      )}

    </>
  );
}

