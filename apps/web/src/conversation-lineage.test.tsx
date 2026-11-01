import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import {
  ConversationGroupedTitle,
  ConversationParentLink,
  ConversationSubagentLink,
  ConversationSubagents,
  type ChildConversation,
} from "./conversation-lineage.js";

const children: ChildConversation[] = [
  { id: "child-one", title: "Codex homeassistant", externalSessionId: "session-one", updatedAt: "2026-09-13T08:00:00Z", messageCount: 61, childCount: 2 },
  { id: "child-two", title: "Codex homeassistant", externalSessionId: "session-two", updatedAt: "2026-09-13T09:00:00Z", messageCount: 53, childCount: 0 },
];

describe("conversation lineage navigation", () => {
  it("opens the project conversation's unified archive and its subagents", () => {
    const html = renderToStaticMarkup(<MemoryRouter><ConversationGroupedTitle conversationId="project-parent" href="/conversations/project-parent" title="Codex · 项目主会话" childCount={3} /></MemoryRouter>);
    expect(html).toContain('href="/conversations/project-parent"');
    expect(html).toContain('href="/conversations/project-parent#subagents"');
    expect(html).toContain("3 个子代理");
    expect(html).not.toMatch(/<a\b[^>]*>(?:(?!<\/a>)[\s\S])*<a\b/);
  });

  it("links the main-list badge to the parent's subagent section", () => {
    const html = renderToStaticMarkup(<MemoryRouter><ConversationSubagentLink conversationId="parent" childCount={5} /></MemoryRouter>);
    expect(html).toContain('href="/conversations/parent#subagents"');
    expect(html).toContain("5 个子代理");
    expect(renderToStaticMarkup(<MemoryRouter><ConversationSubagentLink conversationId="leaf" childCount={0} /></MemoryRouter>)).toBe("");
  });

  it("keeps same-title child records distinguishable and individually accessible", () => {
    const html = renderToStaticMarkup(<MemoryRouter><ConversationSubagents conversations={children} formatTime={(value) => value} /></MemoryRouter>);
    expect(html).toContain('id="subagents"');
    expect(html).not.toContain('open=""');
    expect(html).toContain('href="/conversations/child-one"');
    expect(html).toContain('href="/conversations/child-two"');
    expect(html).toContain("session-one");
    expect(html).toContain("session-two");
    expect(html).toContain("61 条消息");
    expect(html).toContain("53 条消息");
    expect(html).toContain("2 个子代理");
    expect(html).not.toContain("0 个子代理");
  });

  it("opens child records when arriving from the main-list badge", () => {
    const html = renderToStaticMarkup(<MemoryRouter initialEntries={["/conversations/parent#subagents"]}><ConversationSubagents conversations={children} formatTime={(value) => value} /></MemoryRouter>);
    expect(html).toContain('open=""');
    expect(html).toContain("收起记录");
  });

  it("supports navigating a nested agent back to its immediate parent", () => {
    const html = renderToStaticMarkup(<MemoryRouter><ConversationParentLink parent={children[0]!} /><ConversationSubagents conversations={[{ ...children[1]!, id: "grandchild", title: null }]} formatTime={(value) => value} /></MemoryRouter>);
    expect(html).toContain('href="/conversations/child-one#subagents"');
    expect(html).toContain("返回父会话");
    expect(html).toContain('href="/conversations/grandchild"');
    expect(html).toContain("<strong>session-two</strong>");
  });

  it("omits lineage navigation for a standalone conversation", () => {
    expect(renderToStaticMarkup(<MemoryRouter><ConversationParentLink parent={null} /><ConversationSubagents conversations={[]} formatTime={(value) => value} /></MemoryRouter>)).toBe("");
  });
});
