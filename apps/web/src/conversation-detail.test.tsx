import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { ConversationDetailResponse } from "./api-types.js";
import { ConversationDetail } from "./pages/conversation-detail.js";

const fixture = vi.hoisted(() => ({ detail: null as ConversationDetailResponse | null }));
vi.mock("./shared-ui.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./shared-ui.js")>();
  return { ...actual, useLoad: (_loader: unknown, dependencies: unknown[] = []) => ({
    data: dependencies.length === 2 ? fixture.detail : dependencies.length === 0 ? [] : null,
    error: "", loading: false, reload: vi.fn(),
  }) };
});

function detail(): ConversationDetailResponse {
  return {
    conversation: { id: "conversation", provider: "codex", externalSessionId: "source", title: "Long archive", updatedAt: "2026-11-01T00:00:00Z" },
    projectAssignment: null, tags: [],
    selectedRevision: {
      id: "revision", messageCount: 2500, completeness: "complete", capturedAt: "2026-11-01T00:00:00Z", captureMode: "full", adapterVersion: "test",
    },
    messages: Array.from({ length: 50 }, (_, index) => ({ id: String(index), ordinal: 100 + index, role: "assistant", segments: [{ type: "text", content: `Window message ${index}` }] })),
    messagePagination: { total: 2500, offset: 100, limit: 50, hasMore: true },
  };
}

function render() {
  return renderToStaticMarkup(<MemoryRouter initialEntries={["/conversations/conversation?messageOffset=100"]}>
    <Routes><Route path="/conversations/:id" element={<ConversationDetail />} /></Routes>
  </MemoryRouter>);
}

describe("paged archive presentation", () => {
  it("shows the full archive count while rendering only the loaded page", () => {
    fixture.detail = detail();
    const html = render();
    expect((html.match(/<article id="message-/g) ?? []).length).toBe(50);
    expect(html).toContain("累计消息</span><strong>2500 条");
    expect(html).toContain("第 101-150 条，共 2500 条");
    expect(html).toContain('id="message-149"');
    expect(html).not.toContain('id="message-150"');
    expect(html).toContain("展开后分批读取");
  });

  it("keeps tool messages addressable when their process body is folded", () => {
    fixture.detail = detail();
    fixture.detail.messages[0]!.role = "tool";
    const html = render();
    expect(html).toContain('<details id="message-100" class="tool-details hidden-process"');
  });
});
