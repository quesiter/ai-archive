import type { Tag } from "../api-types.js";
import { FormEvent, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, jsonBody } from "../api.js";
import { useLoad, Loading, ErrorBanner, PageHeader } from "../shared-ui.js";

export function tagCloudWeight(count: unknown, maximum: number): number {
  const value = Math.max(0, Number(count ?? 0));
  if (maximum <= 0) return 0;
  return Math.sqrt(value) / Math.sqrt(maximum);
}

export function normalizedTagLabel(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

export function Tags() {
  const state = useLoad(() => api<Tag[]>("/api/v1/tags"), []);
  const [query, setQuery] = useState("");
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"success" | "error">("success");
  const [selectedTagId, setSelectedTagId] = useState("");
  const [mergeTargetTagId, setMergeTargetTagId] = useState("");
  const allTags = state.data ?? [];
  const normalizedQuery = normalizedTagLabel(query);
  const tags = allTags
    .filter((tag) =>
      normalizedTagLabel(tag.name).includes(normalizedQuery),
    )
    .sort(
      (left, right) =>
        Number(right.conversationCount ?? 0) - Number(left.conversationCount ?? 0) ||
        String(left.name ?? "").localeCompare(String(right.name ?? ""), "zh-CN"),
    );
  const selectedTag = tags.find((tag) => String(tag.id) === selectedTagId) ?? null;
  const mergeTargets = allTags.filter((tag) => String(tag.id) !== selectedTagId);
  const maximumConversationCount = Math.max(
    0,
    ...tags.map((tag) => Number(tag.conversationCount ?? 0)),
  );
  const usedTagCount = allTags.filter((tag) => Number(tag.conversationCount ?? 0) > 0).length;
  const totalAssignments = allTags.reduce(
    (sum, tag) => sum + Number(tag.conversationCount ?? 0),
    0,
  );

  useEffect(() => {
    if (!tags.length) {
      setSelectedTagId("");
      return;
    }
    if (!tags.some((tag) => String(tag.id) === selectedTagId)) {
      setSelectedTagId(String(tags[0]?.id ?? ""));
    }
  }, [query, state.data, selectedTagId]);

  useEffect(() => {
    if (!mergeTargets.some((tag) => String(tag.id) === mergeTargetTagId)) {
      setMergeTargetTagId(String(mergeTargets[0]?.id ?? ""));
    }
  }, [mergeTargetTagId, selectedTagId, state.data]);

  async function createTag(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    try {
      const created = await api<Tag>("/api/v1/tags", {
        method: "POST",
        ...jsonBody({ name: form.get("name") }),
      });
      formElement.reset();
      setSelectedTagId(String(created.id ?? ""));
      state.reload();
      setMessage("标签已创建");
      setMessageTone("success");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    }
  }

  async function renameTag(tag: Tag) {
    const name = window.prompt("新标签名称", String(tag.name ?? ""));
    if (!name?.trim()) return;
    try {
      await api(`/api/v1/tags/${tag.id}`, {
        method: "PATCH",
        ...jsonBody({ name: name.trim() }),
      });
      state.reload();
      setMessage("标签已重命名");
      setMessageTone("success");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    }
  }

  async function mergeTag(tag: Tag) {
    const target = allTags.find(
      (item) => String(item.id) === mergeTargetTagId,
    );
    if (!target || target.id === tag.id) {
      setMessage("没有找到可用的目标标签");
      setMessageTone("error");
      return;
    }
    try {
      await api(`/api/v1/tags/${tag.id}/merge`, {
        method: "POST",
        ...jsonBody({ targetTagId: target.id }),
      });
      setSelectedTagId(String(target.id));
      state.reload();
      setMessage(`已合并到 ${target.name}`);
      setMessageTone("success");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    }
  }

  async function deleteTag(tag: Tag) {
    if (!window.confirm(`删除标签“${tag.name}”？只会删除标签关联，不会删除会话。`)) return;
    try {
      await api(`/api/v1/tags/${tag.id}`, { method: "DELETE" });
      setSelectedTagId("");
      state.reload();
      setMessage("标签已删除，会话内容未受影响");
      setMessageTone("success");
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
      setMessageTone("error");
    }
  }

  return (
    <>
      <PageHeader
        title="标签"
        subtitle="用词云看见高频主题，点击标签后可查看会话或集中管理。"
        actions={<span className="pill">{allTags.length} 个标签</span>}
      />
      <section className="tag-metrics">
        <article className="metric">
          <span>标签总数</span>
          <strong>{allTags.length}</strong>
          <small>当前标签库</small>
        </article>
        <article className="metric">
          <span>已使用标签</span>
          <strong>{usedTagCount}</strong>
          <small>{allTags.length - usedTagCount} 个尚未关联会话</small>
        </article>
        <article className="metric">
          <span>标签关联</span>
          <strong>{totalAssignments}</strong>
          <small>同一会话可关联多个标签</small>
        </article>
      </section>
      <section className="panel tag-workspace">
        <div className="tag-workspace-header">
          <div>
            <h2>主题词云</h2>
            <p className="panel-subtitle">字号按关联会话数计算；搜索结果会即时收拢。</p>
          </div>
          <form className="tag-create-form" onSubmit={createTag}>
            <input name="name" aria-label="新标签名称" placeholder="新标签" required />
            <button>创建</button>
          </form>
        </div>
        <div className="tag-search-row">
          <input
            aria-label="搜索标签"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标签…"
          />
          <span>{normalizedQuery ? `找到 ${tags.length} 个` : `展示全部 ${tags.length} 个`}</span>
        </div>
        {message && <div className={`alert ${messageTone}`}>{message}</div>}
        {state.loading ? <Loading label="加载标签中…" /> : state.error ? <ErrorBanner message={state.error} /> : tags.length ? (
          <div className="tag-cloud" aria-label="标签词云">
            {tags.map((tag) => {
              const count = Number(tag.conversationCount ?? 0);
              const weight = tagCloudWeight(count, maximumConversationCount);
              return (
                <button
                  className={`tag-cloud-item ${String(tag.id) === selectedTagId ? "selected" : ""}`}
                  key={tag.id}
                  style={{ fontSize: `${(0.86 + weight * 1.25).toFixed(2)}rem` }}
                  aria-pressed={String(tag.id) === selectedTagId}
                  aria-label={`${tag.name}，${count} 个会话`}
                  onClick={() => setSelectedTagId(String(tag.id))}
                >
                  <strong>{tag.name}</strong>
                  <small>{count}</small>
                </button>
              );
            })}
          </div>
        ) : (
          <div className="tag-cloud-empty">
            <strong>{allTags.length ? "没有匹配的标签" : "还没有标签"}</strong>
            <span>{allTags.length ? "换个关键词试试。" : "可以在上方创建第一个标签。"}</span>
          </div>
        )}
      </section>
      {selectedTag && (
        <section className="panel tag-selection-panel">
          <div className="tag-selection-copy">
            <span>当前标签</span>
            <strong>{selectedTag.name}</strong>
            <small>{selectedTag.conversationCount ?? 0} 个关联会话</small>
          </div>
          <div className="button-group">
            <Link className="button-link" to={`/conversations?tagIds=${selectedTag.id}`}>查看相关会话</Link>
            <button className="secondary" onClick={() => void renameTag(selectedTag)}>重命名</button>
            <select
              aria-label="标签合并目标"
              value={mergeTargetTagId}
              onChange={(event) => setMergeTargetTagId(event.target.value)}
            >
              {mergeTargets.map((tag) => (
                <option key={tag.id} value={String(tag.id)}>{String(tag.name)}</option>
              ))}
            </select>
            <button className="secondary" disabled={!mergeTargetTagId} onClick={() => void mergeTag(selectedTag)}>合并到所选标签</button>
            <button className="danger" onClick={() => void deleteTag(selectedTag)}>删除</button>
          </div>
        </section>
      )}
      <p className="tag-safety-note">删除标签只会解除标签关联，不会删除任何会话。</p>
    </>
  );
}
