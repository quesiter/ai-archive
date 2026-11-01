import type { ActivityResponse } from "../api-types.js";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";
import { useLoad, Loading, ErrorBanner, Pagination, PageHeader, statusLabel, statusClass, formatTaskTime } from "../shared-ui.js";

export function ActivityPage() {
  const [offset, setOffset] = useState(0);
  const state = useLoad(
    () => api<ActivityResponse>(`/api/v1/activity?limit=30&offset=${offset}`),
    [offset],
  );
  return <>
    <PageHeader title="活动" subtitle="后台任务、报告、导入和采集异常的统一时间线" actions={<button className="secondary small" onClick={() => state.reload()}>刷新</button>} />
    {state.loading ? <Loading /> : state.error ? <ErrorBanner message={state.error} /> : <section className="panel">
      <div className="metric-grid">
        <article className="metric"><span>运行中</span><strong>{state.data?.summary?.active ?? 0}</strong></article>
        <article className="metric"><span>失败</span><strong>{state.data?.summary?.failed ?? 0}</strong></article>
        <article className="metric"><span>警告</span><strong>{state.data?.summary?.warnings ?? 0}</strong></article>
      </div>
      <div className="activity-list">
        {(state.data?.items ?? []).map((item) => <Link className="activity-row" key={`${item.type}-${item.id}`} to={item.href || "/logs"}>
          <div className="activity-main"><strong>{item.title}</strong><span>{item.message || formatTaskTime(item.updatedAt)}</span></div>
          <div className="activity-meter"><div className="progress-bar"><span style={{width:`${Number(item.progress ?? 0)}%`}} /></div><small>{item.error || formatTaskTime(item.updatedAt)}</small></div>
          <span className={`pill ${statusClass(item.status)}`}>{statusLabel(item.status)}</span>
        </Link>)}
      </div>
      <Pagination loading={state.loading} pagination={state.data?.pagination} onOffsetChange={setOffset} />
    </section>}
  </>;
}
