// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeConversationReader, parseChatGptConversation } from "../lib/native-conversation";

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

  it("falls back for unhandled media and messages still streaming", () => {
    const media = conversation();
    Object.assign(media.mapping.u1.message.content, { parts: [{ content_type: "image_asset_pointer" }] });
    expect(parseChatGptConversation(media, "session", ["a2"])).toBeNull();
    const streaming = conversation();
    Object.assign(streaming.mapping.a2.message, { status: "in_progress" });
    expect(parseChatGptConversation(streaming, "session", ["a2"])).toBeNull();
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
    const result = read("chatgpt", "session", ["a2"]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await result).toBeNull();
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });
});
