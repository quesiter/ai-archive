import { MarkdownContent } from "../markdown-content.js";
import { Link } from "react-router-dom";
import { WEB_VERSION, useLoad, Loading, ErrorBanner, PageHeader } from "../shared-ui.js";

export function ChangelogPage() {
  const state = useLoad(() => import("../release-notes.js").then((module) => module.releaseNotes));
  return (
    <>
      <PageHeader
        title="更新记录"
        subtitle="依据发布记录与 Git 提交历史整理，按发布时间倒序展示。"
        actions={<Link className="button-link secondary small" to="/">返回总览</Link>}
      />
      <section className="release-overview panel">
        <div>
          <span>当前版本</span>
          <strong>{WEB_VERSION}</strong>
        </div>
        <p>后续发布继续采用语义化版本：V2.1.3、V2.2.0……</p>
      </section>
      {state.loading && <Loading label="加载更新记录…" />}
      {state.error && <><ErrorBanner message={`加载更新记录失败：${state.error}`} /><button className="secondary small" onClick={state.reload}>重试</button></>}
      <div className="release-timeline">
        {state.data?.map((note, index) => (
          <article className="release-entry panel" key={`${note.date}-${note.version}`}>
            <div className="release-marker" aria-hidden="true" />
            <header>
              <div className="release-meta">
                <span className={`pill ${index === 0 ? "complete" : ""}`}>{note.version}</span>
                <time dateTime={note.date}>{note.date}</time>
              </div>
              {note.title && <h2>{note.title}</h2>}
            </header>
            <div className="release-body"><MarkdownContent>{note.body}</MarkdownContent></div>
          </article>
        ))}
      </div>
    </>
  );
}
