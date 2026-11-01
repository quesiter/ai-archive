import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";

export type RelatedConversation = {
  id: string;
  title: string | null;
  externalSessionId: string;
};

export type ChildConversation = RelatedConversation & {
  updatedAt: string;
  messageCount: number;
  childCount: number;
};

export function ConversationSubagentLink({
  conversationId,
  childCount,
}: {
  conversationId: string;
  childCount: number;
}) {
  if (!(childCount > 0)) return null;
  return (
    <Link className="conversation-subagent-link" to={`/conversations/${conversationId}#subagents`}>
      {childCount} 个子代理 <span aria-hidden="true">↗</span>
    </Link>
  );
}

export function ConversationGroupedTitle({
  conversationId,
  href,
  title,
  childCount,
}: {
  conversationId: string;
  href: string;
  title: string;
  childCount: number;
}) {
  return (
    <div className="conversation-title-row conversation-grouped-title">
      <Link className="conversation-main-link" to={href}><strong>{title}</strong></Link>
      <ConversationSubagentLink conversationId={conversationId} childCount={childCount} />
    </div>
  );
}

export function ConversationParentLink({ parent }: { parent?: RelatedConversation | null }) {
  if (!parent) return null;
  return (
    <nav className="conversation-parent-nav" aria-label="父子会话导航">
      <Link to={`/conversations/${parent.id}#subagents`}>
        <span aria-hidden="true">←</span>
        <span>返回父会话</span>
        <strong>{parent.title || parent.externalSessionId}</strong>
      </Link>
      <span className="pill">子代理记录</span>
    </nav>
  );
}

export function ConversationSubagents({
  conversations,
  formatTime,
}: {
  conversations: ChildConversation[];
  formatTime: (value: string) => string;
}) {
  const location = useLocation();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [open, setOpen] = useState(location.hash === "#subagents");

  useEffect(() => {
    if (location.hash !== "#subagents" || !conversations.length) return;
    setOpen(true);
    const frame = requestAnimationFrame(() => {
      detailsRef.current?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [location.key, location.hash, conversations.length]);

  if (!conversations.length) return null;
  return (
    <details
      className="panel conversation-subagents"
      id="subagents"
      ref={detailsRef}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="subagents-heading">子代理 <span className="pill">{conversations.length}</span></span>
        <span className="subagents-summary-hint">{open ? "收起记录" : "展开记录"}</span>
      </summary>
      <p className="panel-subtitle">这些子代理由当前会话发起，点击可查看各自的完整记录。</p>
      <ul className="subagent-list">
        {conversations.map((conversation) => (
          <li key={conversation.id}>
            <Link className="subagent-record" to={`/conversations/${conversation.id}`}>
              <div className="subagent-record-title">
                <strong>{conversation.title || conversation.externalSessionId}</strong>
                <code>{conversation.externalSessionId}</code>
              </div>
              <div className="subagent-record-meta">
                <span>{conversation.messageCount} 条消息</span>
                {conversation.childCount > 0 && <span>{conversation.childCount} 个子代理</span>}
                <time dateTime={conversation.updatedAt}>更新于 {formatTime(conversation.updatedAt)}</time>
              </div>
              <span className="subagent-record-action">查看记录 <span aria-hidden="true">→</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
