import type { DashboardResponse, DashboardOrganization, DashboardTextStats, ReliabilitySummary } from "../api-types.js";
import { recentActiveProjects } from "../recent-projects";
import { Link } from "react-router-dom";
import { providerLabels } from "@ai-archive/contracts/presentation";
import type { Provider } from "@ai-archive/contracts";
import { api } from "../api.js";
import { useLoad, Loading, ErrorBanner, PageHeader, toFiniteNumber, formatCount, formatCompactCount } from "../shared-ui.js";

export function Dashboard() {
  const state = useLoad(
    () => api<DashboardResponse>("/api/v1/dashboard?includeOrganization=false&includeTextStats=false"),
    [],
  );
  const organizationState = useLoad(
    () => api<DashboardOrganization>("/api/v1/dashboard/organization"),
    [],
  );
  const textStatsState = useLoad(
    () => api<DashboardTextStats>("/api/v1/dashboard/text-stats"),
    [],
  );
  const reliabilityState = useLoad(
    () => api<ReliabilitySummary>("/api/v1/reliability/summary"),
    [],
  );
  if (state.loading) return <Loading />;
  if (state.error) return <ErrorBanner message={state.error} />;
  const data = state.data!;
  const organization = organizationState.data ?? {};
  const captureProviders = Array.isArray(data.captureProviders24h)
    ? data.captureProviders24h
    : [];
  const captureStatus = data.captureStatus24h ?? {};
  const counts = {
    ...(data.counts ?? {}),
    conversations:
      organization.conversationCount ?? data.counts?.conversations,
  };
  const textStats = textStatsState.data ?? data.textStats ?? {};
  const categoryTotals = organization.categoryTotals ?? data.categoryTotals ?? {};
  const categoryStats = Array.isArray(organization.categoryStats)
    ? organization.categoryStats
    : Array.isArray(data.categoryStats)
    ? data.categoryStats
    : [];
  const tagCount = toFiniteNumber(counts.tags);
  const calibrationSampleCount = toFiniteNumber(
    textStats.calibrationSampleCount,
  );
  const hasTokenCalibration = calibrationSampleCount > 0;
  const displayedModelTokens = hasTokenCalibration
    ? textStats.calibratedEstimatedTokens
    : textStats.estimatedTokens;
  const activeCategories = recentActiveProjects(categoryStats);
  const topCategories = activeCategories.slice(0, 12);
  const maxCategoryCount = Math.max(
    1,
    ...topCategories.map((category) =>
      toFiniteNumber(category.conversationCount),
    ),
  );
  return (
    <>
      <PageHeader title="总览" subtitle="归档规模、组织状态、采集健康与最近报告" />
      <section className="metric-grid dashboard-metrics">
        <article className="metric">
          <span>总会话</span>
          <strong>{organizationState.loading ? "…" : formatCount(counts.conversations)}</strong>
          <small>{organizationState.loading ? "正在整理会话树" : "已去重 Session"}</small>
        </article>
        <article className="metric">
          <span>总项目</span>
          <strong>{formatCount(counts.projects)}</strong>
          <small>
            {organizationState.loading
              ? "正在统计活跃项目"
              : `${formatCount(categoryTotals.activeCategoryCount)} 个已有会话`}
          </small>
        </article>
        <article className="metric">
          <span>已归类会话</span>
          <strong>{organizationState.loading ? "…" : formatCount(categoryTotals.categorizedConversationCount)}</strong>
          <small>
            {organizationState.loading
              ? "正在统计项目归属"
              : `未归类 ${formatCount(categoryTotals.unclassifiedConversationCount)}`}
          </small>
        </article>
        <article className="metric">
          <span>归档文本量</span>
          <strong>{textStatsState.loading ? "…" : formatCompactCount(textStats.textUnits)}</strong>
          <small>
            {textStatsState.loading
              ? "后台统计中，不影响首页其他内容"
              : textStatsState.error
                ? "统计暂不可用"
                : "含正文、思考与工具过程"}
          </small>
        </article>
        <article className="metric">
          <span>{hasTokenCalibration ? "模型 token（校准）" : "模型 token"}</span>
          <strong>{textStatsState.loading ? "…" : formatCompactCount(displayedModelTokens)}</strong>
          <small>
            {textStatsState.loading
              ? "后台统计中，不影响首页其他内容"
              : textStatsState.error
                ? "统计暂不可用"
              : hasTokenCalibration
              ? `区间 ${formatCompactCount(textStats.calibratedEstimatedTokensLow)}–${formatCompactCount(textStats.calibratedEstimatedTokensHigh)}`
              : toFiniteNumber(textStats.usageBackedConversationCount) > 0
                ? `源端 usage ${formatCount(textStats.usageBackedConversationCount)} 个会话；其余含过程估算`
              : (textStats.tokenEstimateRule ?? "含思考与工具过程估算")}
          </small>
        </article>
        <article className="metric">
          <span>标签</span>
          <strong>{formatCount(tagCount)}</strong>
          <small>跨项目复用的细粒度主题</small>
        </article>
        <article className="metric">
          <span>活跃设备</span>
          <strong>{formatCount(counts.devices)}</strong>
          <small>当前未撤销的采集端</small>
        </article>
      </section>
      {organizationState.error && <ErrorBanner message={`会话与项目统计加载失败：${organizationState.error}`} />}
      <section className="panel attention-panel">
        <div className="section-title-row">
          <div>
            <h2>需要处理</h2>
            <p className="panel-subtitle">归档完整性、失败恢复和设备在线状态优先于规模指标。</p>
          </div>
          <strong>{formatCount(reliabilityState.data?.needsAttention ?? 0)} 项</strong>
        </div>
        {reliabilityState.loading ? <Loading label="检查归档可靠性…" /> : reliabilityState.error ? (
          <ErrorBanner message={reliabilityState.error} />
        ) : (
          <div className="metric-grid attention-metrics">
            {(reliabilityState.data?.items ?? []).map((item) => (
              <Link className="metric" key={item.key} to={item.href}>
                <span>{item.label}</span>
                <strong>{formatCount(item.count)}</strong>
                <small>{Number(item.count) > 0 ? "点击定位并处理" : "当前正常"}</small>
              </Link>
            ))}
          </div>
        )}
      </section>
      <section className="dashboard-main-grid">
        <article className="panel category-overview-panel">
          <div className="section-title-row">
            <div>
              <h2>最近活跃项目</h2>
              <p className="panel-subtitle">
                 近 7 日 {formatCount(categoryTotals.recentActiveCategoryCount ?? activeCategories.length)} 个活跃项目 · {formatCount(categoryTotals.growth7d)} 条活跃会话，按最近归档活动排序
              </p>
            </div>
            <Link className="button-link secondary small" to="/projects">查看项目</Link>
          </div>
          {organizationState.loading ? (
            <Loading label="正在整理最近活跃项目…" />
          ) : topCategories.length ? (
            <div className="category-dashboard-list">
              {topCategories.map((category) => {
                const conversationCount = toFiniteNumber(category.conversationCount);
                const growth7d = toFiniteNumber(category.growth7d);
                const width = Math.max(3, Math.round((conversationCount / maxCategoryCount) * 100));
                return (
                  <div className="category-dashboard-row" key={category.projectId}>
                    <div className="category-dashboard-main">
                      <strong>{category.projectName}</strong>
                      <span>{category.description || "暂无描述"}</span>
                      <div className="category-share-bar">
                        <span style={{ width: `${width}%` }} />
                      </div>
                    </div>
                    <div className="category-dashboard-count">
                      <strong>{formatCount(conversationCount)}</strong>
                      <span>累计会话</span>
                    </div>
                    <div className={`category-dashboard-growth ${growth7d ? "" : "zero"}`}>
                      <strong>{formatCount(growth7d)}</strong>
                      <span>7 日活跃</span>
                    </div>
                    <span className="pill">{formatCount(category.tagCount)} 标签</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="muted">近 7 日没有项目会话活动，可在“项目”页查看全部项目。</p>
          )}
        </article>
      </section>
      <section className="two-column">
        <article className="panel">
          <div className="section-title-row">
            <div>
              <h2>近 24 小时采集</h2>
              <p className="panel-subtitle">按平台汇总，不重复展示具体 Session</p>
            </div>
            <Link className="button-link secondary small" to="/logs?scope=capture">
              采集日志
            </Link>
          </div>
          <div className="capture-health-summary">
            <span className="pill complete">完整 {captureStatus.complete ?? 0}</span>
            <span className="pill partial">不完整 {captureStatus.partial ?? 0}</span>
            <span className="pill failed">失败 {captureStatus.failed ?? 0}</span>
          </div>
          {captureProviders.length ? (
            <div className="capture-provider-list">
              {captureProviders.map((item) => (
                <div className="capture-provider-row" key={item.provider}>
                  <strong>
                    {providerLabels[item.provider as Provider] ?? item.provider}
                  </strong>
                  <div className="capture-provider-counts">
                    <span className="pill complete">完整 {item.complete ?? 0}</span>
                    <span className="pill partial">不完整 {item.partial ?? 0}</span>
                    <span className="pill failed">失败 {item.failed ?? 0}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted">近 24 小时暂无采集记录</p>
          )}
        </article>
        <article className="panel">
          <h2>最近报告</h2>
          {data.recentReports.length ? (
            data.recentReports.map((report) => (
              <Link className="report-link" key={report.id} to={`/reports/${report.id}`}>
                <strong>{report.title}</strong>
                <span>{new Date(report.createdAt).toLocaleString()}</span>
              </Link>
            ))
          ) : (
            <p className="muted">尚未生成报告</p>
          )}
        </article>
      </section>
    </>
  );
}
