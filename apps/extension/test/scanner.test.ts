// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adapterDefinitions } from "../lib/adapters/definitions";
import { createAdapterRuntime } from "../lib/adapters/runtime";
import { CaptureInterruptedError, scanConversation } from "../lib/scanner";

function page(provider = "chatgpt") {
  document.body.innerHTML = `<main style="overflow-y:auto"><article>Question</article><article>Answer</article></main><textarea>draft message</textarea>`;
  const container = document.querySelector("main")!;
  let top = 600;
  const writeScroll = vi.fn((value: number) => { top = value; });
  Object.defineProperties(container, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_200 },
    scrollTop: { configurable: true, get: () => top, set: writeScroll },
  });
  const scrollIntoView = vi.fn();
  const elements = [...document.querySelectorAll("article")];
  elements.forEach((element) => { element.scrollIntoView = scrollIntoView; });
  const adapter = createAdapterRuntime(adapterDefinitions.find((item) => item.provider === provider)!);
  adapter.getSessionId = () => "session";
  adapter.getCanonicalUrl = () => "https://chatgpt.com/c/session";
  adapter.getTitle = () => "Conversation";
  adapter.extractVisibleMessages = () => elements.map((element, ordinal) => ({
    element, ordinal, key: `m${ordinal}`, externalMessageId: `m${ordinal}`,
    role: ordinal === 0 ? "user" as const : "assistant" as const,
    segments: [{ type: "text" as const, content: element.textContent! }],
  }));
  return { container, adapter, writeScroll, scrollIntoView };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("capture must not take over the conversation viewport", () => {
  it.each([undefined, "new_session", "new_messages", "stream_finished", "branch_changed", "adapter_upgraded", "incremental_base_mismatch"] as const)(
    "never writes scroll position for automatic reason %s, even after a long idle",
    async (triggerReason) => {
      const { container, adapter, writeScroll, scrollIntoView } = page();
      const input = document.querySelector("textarea")!;
      input.focus();
      input.setSelectionRange(3, 8);
      await vi.advanceTimersByTimeAsync(120_000);
      const capture = scanConversation(adapter, triggerReason ? { triggerReason } : {});
      await vi.runAllTimersAsync();
      const snapshot = await capture;
      expect(writeScroll).not.toHaveBeenCalled();
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(container.scrollTop).toBe(600);
      expect(document.activeElement).toBe(input);
      expect([input.selectionStart, input.selectionEnd, input.value]).toEqual([3, 8, "draft message"]);
      expect(snapshot.messages).toHaveLength(2);
      expect(snapshot.completeness).toMatchObject({ status: "partial", topReached: false, bottomReached: false });
      expect(snapshot.completeness.reason).toContain("手动完整采集");
    },
  );

  it("can save complete native history without moving a virtualized page", async () => {
    const { adapter, writeScroll, scrollIntoView } = page();
    const capture = scanConversation(adapter, {
      triggerReason: "new_session",
      readNative: async () => ({
        title: "Native history",
        messages: Array.from({ length: 24 }, (_, ordinal) => ({
          ordinal, role: ordinal % 2 ? "assistant" : "user",
          externalMessageId: `native-${ordinal}`,
          segments: [{ type: "text", content: `Message ${ordinal}` }],
        })),
      }),
    });
    await vi.runAllTimersAsync();
    const snapshot = await capture;
    expect(snapshot.messages).toHaveLength(24);
    expect(snapshot.completeness.status).toBe("complete");
    expect(snapshot.title).toBe("Native history");
    expect(writeScroll).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("also remains passive when the native reader is unavailable", async () => {
    const { adapter, writeScroll } = page();
    const capture = scanConversation(adapter, { triggerReason: "incremental_base_mismatch", readNative: async () => null });
    await vi.runAllTimersAsync();
    expect((await capture).completeness.status).toBe("partial");
    expect(writeScroll).not.toHaveBeenCalled();
  });

  it("allows explicit manual history loading and restores the position on success", async () => {
    const { adapter, container, writeScroll } = page("gemini");
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    expect((await capture).completeness.status).toBe("complete");
    expect(writeScroll).toHaveBeenCalledWith(0);
    expect(container.scrollTop).toBe(600);
  });

  it.each(["abort", "route"])("stops a manual scan after %s without restoring over the user's position", async (reason) => {
    const { adapter, container, writeScroll } = page();
    const controller = new AbortController();
    const capture = scanConversation(adapter, { triggerReason: "manual_retry", signal: controller.signal });
    const rejected = expect(capture).rejects.toBeInstanceOf(CaptureInterruptedError);
    await vi.advanceTimersByTimeAsync(900);
    expect(writeScroll).toHaveBeenCalledWith(0);
    container.scrollTop = 470;
    const writes = writeScroll.mock.calls.length;
    if (reason === "abort") controller.abort();
    else adapter.getSessionId = () => "another-session";
    await vi.runAllTimersAsync();
    await rejected;
    expect(writeScroll).toHaveBeenCalledTimes(writes);
    expect(container.scrollTop).toBe(470);
  });
});
