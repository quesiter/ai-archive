import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEvidenceResponse } from "./api-types.js";
import { ConversationEvidence } from "./conversation-evidence.js";

const fixture = vi.hoisted(() => ({
  data: null as ConversationEvidenceResponse | null,
  load: null as (() => Promise<unknown>) | null,
  request: vi.fn(),
}));
vi.mock("./api.js", async importOriginal => ({
  ...await importOriginal<typeof import("./api.js")>(), api: fixture.request,
}));
vi.mock("./shared-ui.js", async importOriginal => ({
  ...await importOriginal<typeof import("./shared-ui.js")>(),
  useLoad: (loader: () => Promise<unknown>) => {
    fixture.load = loader;
    return { data: fixture.data, error: "", loading: false, reload: vi.fn() };
  },
}));

function render(targetOrdinal?: number, searchQuery = "") {
  return renderToStaticMarkup(<ConversationEvidence conversationId="conversation"
    targetOrdinal={targetOrdinal} searchQuery={searchQuery} primaryMessageOrdinals={[10]}
    renderSegment={(segment, key) => <p key={key}>{segment.content}</p>} speakerLabel={() => "AI"} />);
}

beforeEach(() => { fixture.data = null; fixture.load = null; fixture.request.mockReset(); });

describe("lazy archive evidence", () => {
  it("does not fetch historical bodies until expanded", async () => {
    render();
    expect(await fixture.load!()).toBeNull();
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("opens and fetches only the evidence window containing a search hit", async () => {
    render(1537, "historical needle");
    await fixture.load!();
    const url = new URL(fixture.request.mock.calls[0]![0] as string, "https://archive.test");
    expect(url.pathname).toBe("/api/v1/conversations/conversation/evidence");
    expect(Object.fromEntries(url.searchParams)).toEqual({ limit: "50", offset: "0", messageOrdinal: "1537", q: "historical needle" });
  });

  it("keeps warning totals and unique anchors when observations share a message", () => {
    fixture.data = {
      items: [
        { kind: "resolved", message: { id: "one", ordinal: 10, role: "assistant", segments: [{ type: "text", content: "historical needle" }] } },
        { kind: "variant", message: { id: "two", ordinal: 10, role: "assistant", segments: [{ type: "text", content: "other variant" }] } },
        { kind: "inactive", message: { id: "three", ordinal: 11, role: "user", segments: [{ type: "text", content: "earlier question" }] } },
      ],
      pagination: { total: 350, offset: 0, limit: 50, hasMore: true }, warnings: [], warningCount: 100,
    };
    const html = render(10, "historical needle");
    expect(html).toContain("仍有 100 项采集疑点");
    expect(html).not.toContain('id="message-10"');
    expect((html.match(/id="message-11"/g) ?? []).length).toBe(1);
    expect((html.match(/data-search-match="true"/g) ?? []).length).toBe(1);
  });
});
