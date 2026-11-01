// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createNativeConversationReader,
  parseChatGptConversation,
  type NativeConversationReadDiagnostic,
} from "../lib/native-conversation";

function conversation() {
  return {
    conversation_id: "session", title: "Conversation", current_node: "a2",
    mapping: {
      root: { parent: null, message: { id: "system", author: { role: "system" }, content: { parts: ["INTERNAL"] } } },
      u1: { parent: "root", message: { id: "u1", author: { role: "user" }, content: { parts: ["Question"] } } },
      a1: { parent: "u1", message: { id: "a1", author: { role: "assistant" }, content: { parts: ["Earlier answer"] } } },
      u2: { parent: "a1", message: { id: "u2", author: { role: "user" }, content: { parts: ["Follow-up"] } } },
      a2: { parent: "u2", message: { id: "a2", author: { role: "assistant" }, content: { parts: ["**Answer**\n```js\nlet a = 1;\n```"] } } },
      sibling: { parent: "u2", message: { id: "sibling", author: { role: "assistant" }, content: { parts: ["Wrong branch"] } } },
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("ChatGPT native branch parser", () => {
  it("excludes unmounted progress commentary while preserving explicitly visible commentary", () => {
    const data = {
      conversation_id: "session", current_node: "answer",
      mapping: {
        root: { parent: null, message: null },
        user: { parent: "root", message: { id: "question", author: { role: "user" }, content: { parts: ["Question"] } } },
        progress: { parent: "user", message: { id: "progress", channel: "commentary", author: { role: "assistant" }, content: { parts: ["Searching sources"] } } },
        progress2: { parent: "progress", message: { id: "progress2", channel: "commentary", author: { role: "assistant" }, content: { parts: ["Checking results"] } } },
        answer: { parent: "progress2", message: { id: "answer", channel: "final", author: { role: "assistant" }, content: { parts: ["Final answer"] } } },
      },
    };
    expect(parseChatGptConversation(data, "session", ["answer"])?.messages.map((message) => message.externalMessageId)).toEqual(["question", "answer"]);
    expect(parseChatGptConversation(data, "session", ["progress", "answer"])?.messages.map((message) => message.externalMessageId)).toEqual(["question", "progress", "answer"]);
    Object.assign(data.mapping.progress.message, { channel: undefined });
    Object.assign(data.mapping.progress2.message, { channel: undefined });
    expect(parseChatGptConversation(data, "session", ["answer"])?.messages.map((message) => message.externalMessageId)).toEqual(["question", "answer"]);
  });

  it("recovers older unmounted messages and preserves Markdown in the active branch", () => {
    const parsed = parseChatGptConversation(conversation(), "session", ["u2", "a2"]);
    expect(parsed?.messages.map((message) => message.externalMessageId)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(parsed?.messages.map((message) => message.ordinal)).toEqual([0, 1, 2, 3]);
    expect(JSON.stringify(parsed)).not.toContain("INTERNAL");
    expect(JSON.stringify(parsed)).not.toContain("Wrong branch");
    expect(parsed?.messages.at(-1)?.segments[0]?.content).toContain("```js");
  });

  it("rejects stale data, locally selected sibling branches and unrelated sessions", () => {
    expect(parseChatGptConversation(conversation(), "session", ["u2", "new-answer"])).toBeNull();
    expect(parseChatGptConversation(conversation(), "session", ["sibling"])).toBeNull();
    expect(parseChatGptConversation(conversation(), "other-session", ["a2"])).toBeNull();
    expect(parseChatGptConversation(conversation(), "session", [])).toBeNull();
  });

  it("rejects broken chains and cycles instead of claiming complete history", () => {
    const broken = conversation();
    broken.mapping.a1.parent = "missing";
    expect(parseChatGptConversation(broken, "session", ["a2"])).toBeNull();
    broken.mapping.a1.parent = "a2";
    expect(parseChatGptConversation(broken, "session", ["a2"])).toBeNull();
  });

  it("rejects a truncated parent chain whose apparent root is a later user message", () => {
    const truncated = conversation();
    Object.assign(truncated.mapping.u2, { parent: null });
    const rejected = vi.fn();
    expect(parseChatGptConversation(truncated, "session", ["a2"], rejected)).toBeNull();
    expect(rejected).toHaveBeenCalledWith("unverified_root");
    Object.assign(truncated.mapping.u2, { parent: "root" });
    expect(parseChatGptConversation(truncated, "session", ["a2"])?.messages).toHaveLength(2);
  });

  it("keeps image references and saves unfinished bodies without dropping the history", () => {
    const media = conversation();
    Object.assign(media.mapping.u1.message.content, { parts: [{ content_type: "image_asset_pointer" }] });
    const parsed = parseChatGptConversation(media, "session", ["a2"]);
    expect(parsed?.messages).toHaveLength(4);
    expect(parsed?.messages[0]?.segments[0]?.content).toContain("图片附件");
    expect(parsed?.incompleteReason).toBeUndefined();
    const streaming = conversation();
    Object.assign(streaming.mapping.a2.message, { status: "in_progress" });
    const unfinished = parseChatGptConversation(streaming, "session", ["a2"]);
    expect(unfinished?.messages).toHaveLength(4);
    expect(unfinished?.messages.at(-1)?.segments[0]?.content).toContain("**Answer**");
    expect(unfinished?.incompleteReason).toBeUndefined();
    expect(unfinished?.sourceNotice).toContain("1 条原回答在源站未标记完成");
  });

  it.each(["in_progress", "failed", "cancelled", "future_status"])("retains dates and the complete branch around historical %s statuses", status => {
    const data = conversation();
    Object.assign(data.mapping.a1.message, { status, create_time: 1789393080 });
    const parsed = parseChatGptConversation(data, "session", ["a2"]);
    expect(parsed?.messages.map(message => message.externalMessageId)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(parsed?.messages[1]?.createdAt).toMatch(/^2026-09-/);
    expect(parsed?.incompleteReason).toBeUndefined();
    expect(parsed?.sourceNotice).toContain("1 条原回答在源站未标记完成");
    expect(parsed?.messages[1]?.segments[0]?.content).toBe("Earlier answer");
  });

  it("preserves completed code and interrupted answers without dropping mixed text and images", () => {
    const supported = conversation();
    Object.assign(supported.mapping.a2.message, { status: "finished_successfully" });
    Object.assign(supported.mapping.a2.message.content, { content_type: "code", language: "javascript", parts: undefined, text: "const value = 1;" });
    expect(parseChatGptConversation(supported, "session", ["a2"])?.messages.at(-1)?.segments).toEqual([
      { type: "code", content: "const value = 1;", language: "javascript" },
    ]);
    Object.assign(supported.mapping.a2.message, { status: "finished_partial" });
    expect(parseChatGptConversation(supported, "session", ["a2"])?.messages.at(-1)?.segments.at(-1)?.content).toContain("已中止");
    Object.assign(supported.mapping.a2.message, { status: "finished_successfully" });
    Object.assign(supported.mapping.a2.message.content, { parts: ["Visible text", { content_type: "image_asset_pointer" }] });
    const result = parseChatGptConversation(supported, "session", ["a2"]);
    expect(result?.messages.at(-1)?.segments.map((segment) => segment.content)).toEqual(["Visible text", "[图片附件：原图未归档，请在原会话查看]"]);
  });

  it("rejects wrong branches but preserves the position of an unreadable message", () => {
    const reject = vi.fn();
    expect(parseChatGptConversation(conversation(), "session", ["sibling"], reject)).toBeNull();
    expect(reject).toHaveBeenLastCalledWith("visible_branch_mismatch");
    const empty = conversation();
    empty.mapping.u1.message.content.parts = [" "];
    const parsed = parseChatGptConversation(empty, "session", ["a2"], reject);
    expect(parsed?.messages).toHaveLength(4);
    expect(parsed?.incompleteReason).toContain("1 条");
  });

  it("preserves file-only turns, mixed image/text order and September source timestamps", () => {
    const data = conversation();
    Object.assign(data.mapping.u1.message, {
      create_time: 1789393080,
      metadata: { attachments: [{ id: "private-file-id", name: "北京行程.xlsx", mimeType: "application/xlsx" }] },
      content: { content_type: "text", parts: [""] },
    });
    Object.assign(data.mapping.u2.message, { content: { content_type: "multimodal_text", parts: [
      "看这张图", { content_type: "image_asset_pointer", asset_pointer: "sediment://private-id", secret: "do-not-store" }, "纠正细节",
    ] } });
    const parsed = parseChatGptConversation(data, "session", ["u2", "a2"]);
    expect(parsed?.messages.map((message) => message.externalMessageId)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(parsed?.messages[0]?.createdAt).toBe(new Date(1789393080 * 1000).toISOString());
    expect(parsed?.messages[0]?.createdAt).toMatch(/^2026-09-/);
    expect(parsed?.messages[0]?.segments[0]?.content).toContain("北京行程.xlsx");
    expect(parsed?.messages[2]?.segments.map((segment) => segment.content)).toEqual([
      "看这张图", "[图片附件：原图未归档，请在原会话查看]", "纠正细节",
    ]);
    expect(parsed?.incompleteReason).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toMatch(/sediment:|private-id|private-file-id|do-not-store/);
  });

  it("keeps readable history around unknown content and never labels it complete", () => {
    const data = conversation();
    Object.assign(data.mapping.u1.message.content, { parts: ["Before", { content_type: "future_media", data: "SECRET" }, "After"] });
    const parsed = parseChatGptConversation(data, "session", ["a2"]);
    expect(parsed?.messages).toHaveLength(4);
    expect(parsed?.incompleteReason).toContain("全部 4 条");
    expect(parsed?.messages[0]?.segments.map((segment) => segment.content)).toEqual([
      "Before", "[此处包含尚未支持的内容，请在原会话查看]", "After",
    ]);
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
    expect(parseChatGptConversation(data, "session", ["sibling"])).toBeNull();
  });
});

describe("native reader request boundaries and backoff", () => {
  function setup() {
    vi.stubGlobal("location", new URL("https://chatgpt.com/c/session"));
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal("fetch", fetch);
    return { fetch, read: createNativeConversationReader() };
  }

  it("uses only same-origin GETs, keeping the login token in the request scope", async () => {
    const { fetch, read } = setup();
    fetch.mockResolvedValueOnce(Response.json({ accessToken: "test-token" }))
      .mockResolvedValueOnce(Response.json(conversation()));
    expect((await read("chatgpt", "session", ["a2"]))?.messages).toHaveLength(4);
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://chatgpt.com/api/auth/session", "https://chatgpt.com/backend-api/conversation/session",
    ]);
    expect(fetch.mock.calls.every(([, options]) => options?.method === "GET" && options.credentials === "same-origin" && options.redirect === "error")).toBe(true);
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ Authorization: "Bearer test-token" });
  });

  it.each([401, 403, 500])("backs off after HTTP %s without a tight retry loop", async (status) => {
    vi.useFakeTimers();
    const { fetch, read } = setup();
    fetch.mockResolvedValue(new Response("", { status }));
    expect(await read("chatgpt", "session", ["a2"])).toBeNull();
    for (let i = 0; i < 5; i++) expect(await read("chatgpt", "session", ["a2"])).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    await read("chatgpt", "session", ["a2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("honours the rate limit Retry-After header", async () => {
    vi.useFakeTimers();
    const { fetch, read } = setup();
    fetch.mockResolvedValue(new Response("", { status: 429, headers: { "Retry-After": "120" } }));
    await read("chatgpt", "session", ["a2"]);
    await vi.advanceTimersByTimeAsync(60_000);
    await read("chatgpt", "session", ["a2"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    await read("chatgpt", "session", ["a2"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps an unavailable conversation from disabling native reads in a different session", async () => {
    const { fetch, read } = setup();
    fetch.mockResolvedValueOnce(new Response("", { status: 500 }))
      .mockResolvedValueOnce(Response.json({ accessToken: "test-token" }))
      .mockResolvedValueOnce(Response.json({ ...conversation(), conversation_id: "other-session" }));
    expect(await read("chatgpt", "session", ["a2"])).toBeNull();
    expect((await read("chatgpt", "other-session", ["a2"]))?.messages).toHaveLength(4);
    expect(await read("chatgpt", "session", ["a2"])).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("allows a manual retry to recover immediately from a transient parser failure", async () => {
    const { fetch, read } = setup();
    const pending = conversation();
    pending.mapping.a2.parent = "missing-parent";
    fetch.mockResolvedValueOnce(Response.json({ accessToken: "test-token" }))
      .mockResolvedValueOnce(Response.json(pending))
      .mockResolvedValueOnce(Response.json({ accessToken: "test-token" }))
      .mockResolvedValueOnce(Response.json(conversation()));
    const diagnostics: NativeConversationReadDiagnostic[] = [];
    const onDiagnostic = (diagnostic: NativeConversationReadDiagnostic) => diagnostics.push(diagnostic);
    expect(await read("chatgpt", "session", ["a2"], undefined, { onDiagnostic })).toBeNull();
    expect(diagnostics[0]).toEqual({ stage: "parse", code: "parse_rejected", parseReason: "broken_chain", retryAfterMs: 30_000 });
    expect(await read("chatgpt", "session", ["a2"], undefined, { onDiagnostic })).toBeNull();
    expect(diagnostics.at(-1)?.code).toBe("cooldown");
    expect((await read("chatgpt", "session", ["a2"], undefined, { manualRetry: true, onDiagnostic }))?.messages).toHaveLength(4);
    expect(diagnostics.at(-1)).toEqual({ stage: "parse", code: "success" });
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("returns the whole history on unfinished status without rejecting or cooling down the reader", async () => {
    const { fetch, read } = setup();
    const pending = conversation();
    Object.assign(pending.mapping.a1.message, { status: "in_progress" });
    fetch.mockResolvedValueOnce(Response.json({ accessToken: "test-token" }))
      .mockResolvedValueOnce(Response.json(pending));
    const onDiagnostic = vi.fn();
    expect((await read("chatgpt", "session", ["a2"], undefined, { onDiagnostic }))?.messages).toHaveLength(4);
    expect(onDiagnostic).toHaveBeenLastCalledWith({ stage: "parse", code: "success" });
  });

  it.each([undefined, "120"])("does not bypass HTTP 429 on a manual retry (Retry-After: %s)", async (retryAfter) => {
    vi.useFakeTimers();
    const { fetch, read } = setup();
    fetch.mockResolvedValue(new Response("", { status: 429, headers: retryAfter ? { "Retry-After": retryAfter } : {} }));
    const onDiagnostic = vi.fn();
    const options = { manualRetry: true, onDiagnostic };
    await read("chatgpt", "session", ["a2"], undefined, options);
    await read("chatgpt", "session", ["a2"], undefined, options);
    expect(fetch).toHaveBeenCalledTimes(1);
    const retryAfterMs = retryAfter ? 120_000 : 30_000;
    expect(onDiagnostic).toHaveBeenLastCalledWith({ stage: "guard", code: "rate_limited", retryAfterMs });
    await vi.advanceTimersByTimeAsync(retryAfterMs);
    await read("chatgpt", "session", ["a2"], undefined, options);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("reports only constrained diagnostics for auth, JSON and conversation request failures", async () => {
    const { fetch, read } = setup();
    const onDiagnostic = vi.fn();
    const options = { manualRetry: true, onDiagnostic };
    fetch.mockRejectedValueOnce(new Error("private response body and credentials"));
    await read("chatgpt", "session", ["a2"], undefined, options);
    expect(onDiagnostic).toHaveBeenLastCalledWith({ stage: "auth", code: "network_error", retryAfterMs: 30_000 });
    fetch.mockResolvedValueOnce(Response.json({ error: "private login details" }));
    await read("chatgpt", "session", ["a2"], undefined, options);
    expect(onDiagnostic).toHaveBeenLastCalledWith({ stage: "auth", code: "session_unavailable", retryAfterMs: 60_000 });
    fetch.mockResolvedValueOnce(new Response("private non-JSON response"));
    await read("chatgpt", "session", ["a2"], undefined, options);
    expect(onDiagnostic).toHaveBeenLastCalledWith({ stage: "auth", code: "invalid_json", retryAfterMs: 120_000 });
    fetch.mockResolvedValueOnce(Response.json({ accessToken: "test-token" }))
      .mockResolvedValueOnce(new Response("private conversation response", { status: 403 }));
    await read("chatgpt", "session", ["a2"], undefined, options);
    expect(onDiagnostic).toHaveBeenLastCalledWith({ stage: "conversation", code: "http_error", httpStatus: 403, retryAfterMs: 240_000 });
    expect(JSON.stringify(onDiagnostic.mock.calls)).not.toMatch(/private|credentials|test-token|\/session/);
  });

  it("does not let a diagnostic listener stop a successful native capture", async () => {
    const { fetch, read } = setup();
    fetch.mockResolvedValueOnce(Response.json({ accessToken: "test-token" }))
      .mockResolvedValueOnce(Response.json(conversation()));
    expect((await read("chatgpt", "session", ["a2"], undefined, { onDiagnostic: () => { throw new Error("listener failed"); } }))?.messages).toHaveLength(4);
  });

  it("does not make requests for other hosts or providers", async () => {
    const { fetch, read } = setup();
    await read("gemini", "session", ["a2"]);
    vi.stubGlobal("location", new URL("https://example.com/c/session"));
    await read("chatgpt", "session", ["a2"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts slow requests after eight seconds", async () => {
    vi.useFakeTimers();
    const { fetch, read } = setup();
    fetch.mockImplementation((_, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const onDiagnostic = vi.fn();
    const result = read("chatgpt", "session", ["a2"], undefined, { onDiagnostic });
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await result).toBeNull();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(onDiagnostic).toHaveBeenLastCalledWith({ stage: "auth", code: "timeout", retryAfterMs: 30_000 });
  });

  it("does not turn a user cancellation into a cooldown for their next capture", async () => {
    const { fetch, read } = setup();
    fetch.mockImplementationOnce((_, options) => new Promise((_, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    const controller = new AbortController();
    const onDiagnostic = vi.fn();
    const pending = read("chatgpt", "session", ["a2"], controller.signal, { onDiagnostic });
    controller.abort();
    expect(await pending).toBeNull();
    expect(onDiagnostic).toHaveBeenLastCalledWith({ stage: "auth", code: "aborted" });
    fetch.mockResolvedValueOnce(Response.json({ accessToken: "test-token" }))
      .mockResolvedValueOnce(Response.json(conversation()));
    expect((await read("chatgpt", "session", ["a2"]))?.messages).toHaveLength(4);
  });
});
