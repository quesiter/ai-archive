// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CaptureSnapshotV1Schema } from "@ai-archive/contracts";
import { adapterDefinitions } from "../lib/adapters/definitions";
import { createAdapterRuntime } from "../lib/adapters/runtime";
import { mergeVisible, scanConversation } from "../lib/scanner";

const definition = adapterDefinitions.find((item) => item.provider === "doubao")!;
const sessionId = "38450688189709826";

// Only observed production structure is retained here; every body is a
// synthetic placeholder. Never store the user's transcript as a test fixture.
function page(streaming = false) {
  document.body.innerHTML = `<aside><div data-message-id="sidebar">Sidebar</div></aside><main>
    <div data-testid="message-list" data-conversation-id="${sessionId}" style="overflow-y:auto">
      ${[1, 2].map((turn) => `<div data-testid="send_message"><time>09:31</time><div class="flex-col">
        <div data-testid="message_content" data-message-id="user-${turn}" data-send-message-boundary>
          <div class="content bg-g-send-msg-bubble-bg"><div data-testid="message_text_content" data-streaming="false">Repeated question</div></div>
        </div></div></div>
      <div data-testid="receive_message"><div class="flex-col">
        <div data-testid="message_content" data-message-id="answer-${turn}" class="relative grid">
          <section data-testid="preamble-elapsed">
            <button disabled>Elapsed UI <span data-testid="preamble-elapsed-timer">2分21秒</span></button>
            <div class="bodySlot"><div class="group thinking-box-root"><div data-thinking-box="content"><div data-thinking-box="title">Historical reasoning ${turn}</div></div></div></div>
          </section>
          <div data-testid="message_text_content" data-streaming="${streaming && turn === 2}">Answer ${turn} part one</div>
          <div class="group thinking-box-root"><div data-thinking-box="content"><div data-thinking-box="title">Later reasoning ${turn}</div></div></div>
          <div data-testid="message_text_content" data-streaming="false">Answer ${turn} part two<pre><code class="language-ts">const turn = ${turn};</code></pre></div>
          <button>Copy</button>
        </div></div></div>`).join("")}
    </div>
    <div data-composer-body><div data-testid="message_content" data-message-id="draft"><div data-testid="message_text_content" data-streaming="true">Unsaved draft</div></div></div>
  </main>`;
  return createAdapterRuntime(definition);
}

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "innerText", {
    configurable: true, get() { return this.textContent ?? ""; },
  });
  HTMLElement.prototype.getBoundingClientRect = () => ({
    width: 100, height: 20, top: 0, left: 0, right: 100, bottom: 20,
    x: 0, y: 0, toJSON() {},
  }) as DOMRect;
});
afterEach(() => vi.useRealTimers());

describe("Doubao observed production message structure", () => {
  it("selects stable content nodes below speaker wrappers for two repeated-text turns", () => {
    const runtime = page();
    expect(runtime.getConversationRoot()?.getAttribute("data-testid")).toBe("message-list");
    expect(runtime.getSessionId(new URL(`https://www.doubao.com/chat/${sessionId}`))).toBe(sessionId);
    const messages = runtime.extractVisibleMessages();
    expect(messages.map((message) => message.externalMessageId)).toEqual(["user-1", "answer-1", "user-2", "answer-2"]);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(messages.every((message) => message.element.getAttribute("data-testid") === "message_content")).toBe(true);
    expect(messages[0]?.segments).toEqual([{ type: "text", content: "Repeated question" }]);
    expect(messages[2]?.segments).toEqual(messages[0]?.segments);
    expect(messages[1]?.segments).toEqual([
      { type: "text", content: "Answer 1 part one\n\nAnswer 1 part two" },
      { type: "reasoning", content: "Historical reasoning 1" },
      { type: "reasoning", content: "Later reasoning 1" },
      { type: "code", content: "const turn = 1;", language: "ts" },
    ]);
    expect(JSON.stringify(messages.map(({ element: _element, ...message }) => message)))
      .not.toMatch(/Sidebar|Unsaved draft|09:31|Elapsed UI|2分21秒|Copy/);
  });

  it("retains reasoning inside a collapsed preamble while excluding its elapsed header", () => {
    const runtime = page();
    document.querySelectorAll<HTMLElement>(".bodySlot").forEach((slot) => { slot.style.display = "none"; });
    const messages = runtime.extractVisibleMessages();
    expect(messages[1]?.segments).toContainEqual({ type: "reasoning", content: "Historical reasoning 1" });
    expect(messages[1]?.segments.some((segment) => /Elapsed UI|2分21秒/.test(segment.content))).toBe(false);
    expect(runtime.isStreaming()).toBe(false);
  });

  it("recovers a unique child ID when falling back to the outer speaker wrapper", () => {
    page();
    const runtime = createAdapterRuntime({ ...definition,
      messageSelectors: ["[data-testid='send_message'], [data-testid='receive_message']"],
    });
    expect(runtime.extractVisibleMessages().map((message) => message.externalMessageId))
      .toEqual(["user-1", "answer-1", "user-2", "answer-2"]);
    const wrapper = document.querySelector<HTMLElement>("[data-testid='send_message']")!;
    wrapper.insertAdjacentHTML("beforeend", '<div data-message-id="ambiguous-child">Other content</div>');
    expect(runtime.getExternalMessageId(wrapper)).toBeUndefined();
  });

  it("keeps stable IDs across text updates and repeated mounted windows without duplicating turns", () => {
    const runtime = page();
    const ordered = runtime.extractVisibleMessages();
    const body = document.querySelector('[data-message-id="answer-2"] [data-testid="message_text_content"]')!;
    body.textContent += " streamed continuation";
    expect(mergeVisible(ordered, runtime.extractVisibleMessages())).toBe(true);
    expect(ordered.map((message) => message.externalMessageId)).toEqual(["user-1", "answer-1", "user-2", "answer-2"]);
    expect(ordered[3]?.segments.find((segment) => segment.type === "text")?.content).toContain("streamed continuation");
  });

  it("marks a quiet but actively streaming body partial, then completes after streaming stops", async () => {
    vi.useFakeTimers();
    const runtime = page(true);
    runtime.getCanonicalUrl = () => `https://www.doubao.com/chat/${sessionId}`;
    Object.defineProperties(document.documentElement, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });
    expect(runtime.isStreaming()).toBe(true);
    const streamingCapture = scanConversation(runtime, { triggerReason: "new_session" });
    await vi.runAllTimersAsync();
    const partial = await streamingCapture;
    expect(CaptureSnapshotV1Schema.safeParse(partial).success).toBe(true);
    expect(partial.messages).toHaveLength(4);
    expect(partial.completeness).toMatchObject({ status: "partial", topReached: true, bottomReached: true, stable: false });
    document.querySelector('[data-message-id="answer-2"] [data-streaming="true"]')!.setAttribute("data-streaming", "false");
    // Persistent thinking panels and a streaming composer are not generation.
    expect(runtime.isStreaming()).toBe(false);
    const completedCapture = scanConversation(runtime, { triggerReason: "new_session" });
    await vi.runAllTimersAsync();
    const complete = await completedCapture;
    expect(complete.completeness).toMatchObject({ status: "complete", topReached: true, bottomReached: true, stable: true });
    expect(complete.messages.map((message) => message.externalMessageId))
      .toEqual(["user-1", "answer-1", "user-2", "answer-2"]);
  });

  it("scans the observed message-list scroll range without duplicating stable turns", async () => {
    vi.useFakeTimers();
    const runtime = page();
    const scroller = runtime.getConversationRoot()!;
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 840 },
      scrollHeight: { configurable: true, value: 1_720 },
      scrollTop: { configurable: true, value: 880, writable: true },
    });
    runtime.getCanonicalUrl = () => `https://www.doubao.com/chat/${sessionId}`;
    const pending = scanConversation(runtime, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    const capture = await pending;
    expect(capture.completeness).toMatchObject({ status: "complete", topReached: true, bottomReached: true, stable: true });
    expect(capture.messages.map((message) => message.externalMessageId))
      .toEqual(["user-1", "answer-1", "user-2", "answer-2"]);
    expect(scroller.scrollTop).toBe(880);
  });
});
