// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { adapterDefinitions } from "../lib/adapters/definitions";
import { createAdapterRuntime } from "../lib/adapters/runtime";
import type { ExtractedMessage } from "../lib/adapters/types";
import {
  lightweightConversationFingerprint,
  mergeVisible,
  messageTextFingerprint,
  scanAppendedMessages,
} from "../lib/scanner";

const fixtures = [
  ["chatgpt", "chatgpt.html", "https://chatgpt.com/c/chatgpt-session"],
  ["gemini", "gemini.html", "https://gemini.google.com/app/gemini-session"],
  ["grok", "grok.html", "https://grok.com/c/grok-session"],
  ["yuanbao", "yuanbao.html", "https://yuanbao.tencent.com/chat/yuanbao-app/yuanbao-session"],
  ["minimax_agent", "minimax.html", "https://agent.minimaxi.com/mavis?id=minimax-session"],
  ["deepseek", "deepseek.html", "https://chat.deepseek.com/a/chat/s/deepseek-session"],
  ["qianwen", "qianwen.html", "https://qianwen.com/chat/qianwen-session"],
  ["kimi", "kimi.html", "https://www.kimi.com/chat/kimi-session"],
] as const;

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true,
    get() {
      return this.textContent ?? "";
    },
  });
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      width: 100,
      height: 20,
      top: 0,
      left: 0,
      right: 100,
      bottom: 20,
      x: 0,
      y: 0,
      toJSON() {},
    }) as DOMRect;
});

describe.each(fixtures)("%s adapter contract", (provider, fixture, url) => {
  it("extracts a sanitized full turn and its Session ID", () => {
    document.body.innerHTML = readFileSync(
      resolve(process.cwd(), "test", "fixtures", fixture),
      "utf8",
    );
    const definition = adapterDefinitions.find((item) => item.provider === provider)!;
    const runtime = createAdapterRuntime(definition);
    const messages = runtime.extractVisibleMessages();

    expect(runtime.getSessionId(new URL(url))).toContain("session");
    expect(messages).toHaveLength(provider === "minimax_agent" ? 3 : 2);
    expect(messages.map((message) => message.role)).toEqual(
      provider === "minimax_agent"
        ? ["user", "assistant", "assistant"]
        : ["user", "assistant"],
    );
    expect(messages.every((message) => message.segments.length > 0)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain("cookie");
  });
});

describe("segment and virtual-list behavior", () => {
  it("ignores ChatGPT's skip-to-content link and reads the Session sidebar title", () => {
    document.title = "ChatGPT";
    document.body.innerHTML = `
      <a href="#main">跳至内容</a>
      <aside><a href="/c/chatgpt-title-session">补充协议建议</a></aside>
      <main id="main" data-conversation-id="chatgpt-title-session">
        <article data-message-author-role="user">Question</article>
        <article data-message-author-role="assistant">Answer</article>
      </main>`;
    const definition = adapterDefinitions.find((item) => item.provider === "chatgpt")!;
    const runtime = createAdapterRuntime(definition);

    expect(runtime.getTitle()).toBe("补充协议建议");
  });

  it("reads the current Gemini Session title instead of its generic page title", () => {
    document.title = "与 Gemini 对话";
    document.body.innerHTML = readFileSync(
      resolve(process.cwd(), "test", "fixtures", "gemini.html"),
      "utf8",
    );
    const definition = adapterDefinitions.find((item) => item.provider === "gemini")!;
    const runtime = createAdapterRuntime(definition);
    expect(runtime.getTitle()).toBe("狐狸的私人医生");
  });

  it("supports Grok's current message bubbles and surrounding response IDs", () => {
    document.body.innerHTML = readFileSync(
      resolve(process.cwd(), "test", "fixtures", "grok.html"),
      "utf8",
    );
    const definition = adapterDefinitions.find((item) => item.provider === "grok")!;
    const messages = createAdapterRuntime(definition).extractVisibleMessages();
    expect(messages.map((message) => message.externalMessageId)).toEqual([
      "grok-user-1",
      "grok-assistant-1",
    ]);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", content: "Grok 回答正文" }),
        expect.objectContaining({ type: "reasoning", content: "正在分析可见信息" }),
      ]),
    );
  });

  it("supports MiniMax's minimaxi.com message items and id query Session", () => {
    document.body.innerHTML = readFileSync(
      resolve(process.cwd(), "test", "fixtures", "minimax.html"),
      "utf8",
    );
    const definition = adapterDefinitions.find(
      (item) => item.provider === "minimax_agent",
    )!;
    const runtime = createAdapterRuntime(definition);
    const messages = runtime.extractVisibleMessages();

    expect(
      runtime.getSessionId(
        new URL("https://agent.minimaxi.com/mavis?id=413615166702952"),
      ),
    ).toBe("413615166702952");
    expect(messages.map((message) => message.externalMessageId)).toEqual([
      "413614514607192",
      "msg-assistant-1::activity-0",
      "msg-assistant-1::body-1",
    ]);
    expect(messages[1]?.segments).toEqual([
      expect.objectContaining({ type: "tool_status" }),
    ]);
  });

  it("uses both Yuanbao chat path segments as the Session ID", () => {
    document.body.innerHTML = "";
    const definition = adapterDefinitions.find((item) => item.provider === "yuanbao")!;
    const runtime = createAdapterRuntime(definition);

    expect(
      runtime.getSessionId(new URL("https://yuanbao.tencent.com/chat/naQivTmsDa")),
    ).toBeNull();
    expect(
      runtime.getSessionId(
        new URL("https://yuanbao.tencent.com/chat/naQivTmsDa/0OpYUPArOka"),
      ),
    ).toBe("naQivTmsDa/0OpYUPArOka");
    expect(
      runtime.getSessionId(
        new URL("https://yuanbao.tencent.com/chat/naQivTmsDa/0OgHsK2fJYW"),
      ),
    ).toBe("naQivTmsDa/0OgHsK2fJYW");
  });

  it("does not let Yuanbao related-question blocks override the assistant role", () => {
    document.body.innerHTML = `
      <main>
        <section class="message-item user-message">uefi</section>
        <section class="message-item">
          <div class="answer">UEFI is the firmware interface.</div>
          <div class="related-question">What is BIOS?</div>
        </section>
      </main>`;
    const definition = adapterDefinitions.find((item) => item.provider === "yuanbao")!;
    const messages = createAdapterRuntime(definition).extractVisibleMessages();

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("recognizes www.qianwen.com chat URLs with query strings", () => {
    document.body.innerHTML = "";
    const definition = adapterDefinitions.find((item) => item.provider === "qianwen")!;
    const runtime = createAdapterRuntime(definition);

    expect(
      runtime.getSessionId(
        new URL(
          "https://www.qianwen.com/chat/63305538ba904a5b9ac04f4086119210?source=tongyigw",
        ),
      ),
    ).toBe("63305538ba904a5b9ac04f4086119210");
  });

  it("chooses Qianwen message containers that include both the user bubble and AI answer", () => {
    document.body.innerHTML = `
      <main>
        <section class="chat-message question">Recommend flexible side jobs.</section>
        <section class="chat-message answer" data-message-id="assistant-only-id">
          <div>Here are several options.</div>
        </section>
      </main>`;
    const definition = adapterDefinitions.find((item) => item.provider === "qianwen")!;
    const messages = createAdapterRuntime(definition).extractVisibleMessages();

    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages.map((message) => message.segments[0]?.content)).toEqual([
      "Recommend flexible side jobs.",
      "Here are several options.",
    ]);
  });

  it("keeps visible reasoning, tool state, code, and citations as typed text", () => {
    document.body.innerHTML = readFileSync(
      resolve(process.cwd(), "test", "fixtures", "deepseek.html"),
      "utf8",
    );
    const definition = adapterDefinitions.find((item) => item.provider === "deepseek")!;
    const segments = createAdapterRuntime(definition).extractVisibleMessages()[1]!.segments;
    expect(segments.map((segment) => segment.type)).toEqual(
      expect.arrayContaining(["text", "reasoning", "tool_status", "code", "citation"]),
    );
  });

  it("uses viewport overlap instead of dropping repeated identical messages", () => {
    const element = document.createElement("article");
    const message = (key: string): ExtractedMessage => ({
      key,
      element,
      ordinal: 0,
      role: "user",
      segments: [{ type: "text", content: key }],
    });
    const ordered = [message("same")];
    mergeVisible(ordered, [message("same"), message("same")]);
    mergeVisible(ordered, [message("same"), message("next")]);
    expect(ordered.map((item) => item.key)).toEqual(["same", "same", "next"]);
  });

  it("drops a virtual-list remount when the platform message ID is unchanged", () => {
    const element = document.createElement("article");
    const message = (externalMessageId: string): ExtractedMessage => ({
      key: externalMessageId,
      externalMessageId,
      element,
      ordinal: 0,
      role: "assistant",
      segments: [{ type: "text", content: externalMessageId }],
    });
    const ordered = [message("message-1")];
    mergeVisible(ordered, [message("message-2"), message("message-1")]);
    expect(ordered.map((item) => item.externalMessageId)).toEqual([
      "message-1",
      "message-2",
    ]);
  });

  it("removes provider speaker chrome from the archived message text", () => {
    document.body.innerHTML = `
      <main>
        <user-query>你说\n真正的问题</user-query>
        <model-response>Gemini 说\n真正的回答</model-response>
      </main>`;
    const definition = adapterDefinitions.find((item) => item.provider === "gemini")!;
    const messages = createAdapterRuntime(definition).extractVisibleMessages();
    expect(messages.map((message) => message.segments[0]?.content)).toEqual([
      "真正的问题",
      "真正的回答",
    ]);
  });

  it("keeps model and page-provided message time when available", () => {
    document.body.innerHTML = `
      <main>
        <article data-message-author-role="user" data-message-id="u">Question</article>
        <article data-message-author-role="assistant" data-model="model-x" data-created-at="2026-07-19T10:20:30Z">Answer</article>
      </main>`;
    const definition = adapterDefinitions.find((item) => item.provider === "chatgpt")!;
    const messages = createAdapterRuntime(definition).extractVisibleMessages();
    expect(messages[1]?.model).toBe("model-x");
    expect(messages[1]?.createdAt).toBe("2026-07-19T10:20:30.000Z");
  });

  it("builds a lightweight fingerprint without counting the extension floating UI", async () => {
    document.body.innerHTML = `
      <main data-conversation-id="chatgpt-light-session">
        <article data-message-author-role="user" data-message-id="u1">Question</article>
        <article data-message-author-role="assistant" data-message-id="a1">Answer</article>
        <div id="ai-archive-floating-indicator">
          <article data-message-author-role="assistant" data-message-id="noise">Syncing</article>
        </div>
      </main>`;
    const definition = adapterDefinitions.find((item) => item.provider === "chatgpt")!;
    const runtime = createAdapterRuntime(definition);
    const first = await lightweightConversationFingerprint(runtime);
    document.querySelector("#ai-archive-floating-indicator")!.textContent = "Complete";
    const second = await lightweightConversationFingerprint(runtime);

    expect(first?.messageCount).toBe(2);
    expect(second).toEqual(first);
  });

  it("marks lightweight fingerprints as streaming while a stop button is visible", async () => {
    document.body.innerHTML = `
      <main data-conversation-id="chatgpt-streaming-session">
        <article data-message-author-role="user" data-message-id="u1">Question</article>
        <article data-message-author-role="assistant" data-message-id="a1">Answer</article>
      </main>
      <button data-testid="stop-button">Stop</button>`;
    const definition = adapterDefinitions.find((item) => item.provider === "chatgpt")!;
    const runtime = createAdapterRuntime(definition);

    expect((await lightweightConversationFingerprint(runtime))?.streaming).toBe(true);
  });

  it("creates an append delta for messages after the archived base message", async () => {
    document.body.innerHTML = `
      <main data-conversation-id="chatgpt-append-session">
        <article data-message-author-role="user" data-message-id="u1">Question</article>
        <article data-message-author-role="assistant" data-message-id="a1">Answer</article>
        <article data-message-author-role="user" data-message-id="u2">Follow up</article>
        <article data-message-author-role="assistant" data-message-id="a2">Second answer</article>
      </main>`;
    const definition = adapterDefinitions.find((item) => item.provider === "chatgpt")!;
    const runtime = createAdapterRuntime(definition);
    const baseLast = runtime.extractVisibleMessages()[1]!;
    const delta = await scanAppendedMessages(runtime, {
      revisionId: "11111111-1111-1111-1111-111111111111",
      messageCount: 2,
      branchFingerprint: "branch-fingerprint-chatgpt",
      lastMessageId: "a1",
      lastMessageTextHash: await messageTextFingerprint(baseLast),
    });

    expect(delta?.captureMode).toBe("append");
    expect(delta?.baseMessageCount).toBe(2);
    expect(delta?.appendedMessages.map((message) => message.ordinal)).toEqual([2, 3]);
    expect(delta?.appendedMessages.map((message) => message.externalMessageId)).toEqual([
      "u2",
      "a2",
    ]);
  });
});
