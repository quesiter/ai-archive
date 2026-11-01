// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adapterDefinitions } from "../lib/adapters/definitions";
import { createAdapterRuntime } from "../lib/adapters/runtime";
import { CaptureInterruptedError, mergeVisible, reachConversationTop, scanConversation } from "../lib/scanner";
import { parseChatGptConversation } from "../lib/native-conversation";

function virtualizedPage(options: { windowSize?: number; missingMiddle?: boolean } = {}) {
  const fixture = page();
  const { container, adapter, writeScroll } = fixture;
  container.innerHTML = Array.from({ length: 12 }, (_, index) => `<article data-testid="conversation-turn-${index}">Message ${index}</article>`).join("");
  const elements = [...container.querySelectorAll("article")];
  const windowSize = options.windowSize ?? 4;
  let top = 600;
  let mountedStart = 6;
  let pending: ReturnType<typeof setTimeout> | undefined;
  Object.defineProperties(container, {
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        writeScroll(value);
        if (value === top) return;
        top = value;
        clearTimeout(pending);
        pending = setTimeout(() => {
          mountedStart = options.missingMiddle
            ? top < 400 ? 0 : 10
            : Math.min(Math.floor(top / 100), 12 - windowSize);
        }, 600);
      },
    },
  });
  adapter.extractVisibleMessages = () => elements.slice(mountedStart, mountedStart + windowSize).map((element, index) => {
    const ordinal = mountedStart + index;
    return {
      element, ordinal, key: `m${ordinal}`, externalMessageId: `m${ordinal}`,
      role: ordinal % 2 ? "assistant" as const : "user" as const,
      segments: [{ type: "text" as const, content: element.textContent! }],
    };
  });
  return fixture;
}

function page(provider = "chatgpt") {
  document.body.innerHTML = `<main style="overflow-y:auto"><article data-testid="conversation-turn-0">Question</article><article data-testid="conversation-turn-1">Answer</article></main><textarea>draft message</textarea>`;
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
  it.each(["attachment", "unknown", "unfinished"])("captures all 52 native messages without scrolling (%s)", async (kind) => {
    const { adapter, writeScroll } = page();
    const mapping: Record<string, unknown> = { root: { parent: null, message: null } };
    for (let index = 0; index < 52; index++) mapping[`m${index}`] = {
      parent: index ? `m${index - 1}` : "root",
      message: { id: `m${index}`, author: { role: index % 2 ? "assistant" : "user" },
        create_time: 1789393080 + index, status: kind === "unfinished" && index === 1 ? "in_progress" : "finished_successfully",
        content: { content_type: "multimodal_text", parts: index === 0
          ? ["First September question", { content_type: kind === "unknown" ? "future_media" : "image_asset_pointer" }]
          : [`Message ${index}`] } },
    };
    const native = parseChatGptConversation({ conversation_id: "session", current_node: "m51", mapping }, "session", ["m50", "m51"]);
    expect(native).not.toBeNull();
    const capture = scanConversation(adapter, { triggerReason: "manual_retry", readNative: async () => native });
    await vi.runAllTimersAsync();
    const result = await capture;
    expect(result.messages.map((message) => message.externalMessageId)).toEqual(Array.from({ length: 52 }, (_, index) => `m${index}`));
    expect(result.messages[0]?.createdAt).toMatch(/^2026-09-/);
    expect(result.completeness).toMatchObject({ status: kind === "unknown" ? "partial" : "complete", topReached: true, bottomReached: true, stable: true });
    expect(result.sourceKind).toBe("chatgpt_current_branch");
    if (kind !== "attachment") expect(result.completeness.reason).toContain("全部 52 条");
    expect(writeScroll).not.toHaveBeenCalled();
  });

  it.each(["generating", "question-only"])("captures the complete available native branch without waiting for a finished exchange (%s)", async kind => {
    const { adapter, writeScroll } = page();
    adapter.isStreaming = () => true;
    const mapping = {
      root: { parent: null, message: null },
      m0: { parent: "root", message: { id: "m0", author: { role: "user" }, content: { parts: ["Question"] } } },
      m1: { parent: "m0", message: { id: "m1", status: "in_progress", author: { role: "assistant" }, content: { parts: ["Text so far"] } } },
    };
    const current = kind === "question-only" ? "m0" : "m1";
    const native = parseChatGptConversation({ conversation_id: "session", current_node: current, mapping }, "session", [current]);
    expect(native).not.toBeNull();
    const start = Date.now();
    const result = await scanConversation(adapter, { triggerReason: "manual_retry", readNative: async () => native });
    expect(Date.now()).toBe(start);
    expect(result.completeness.status).toBe("complete");
    expect(result.sourceKind).toBe("chatgpt_current_branch");
    expect(result.messages).toHaveLength(kind === "question-only" ? 1 : 2);
    expect(writeScroll).not.toHaveBeenCalled();
  });

  it.each(["id", "div testid"])("recognizes the first turn with %s markers", async (marker) => {
    const { adapter, container } = page();
    const first = adapter.extractVisibleMessages()[0]!.element;
    first.removeAttribute("data-testid");
    if (marker === "id") first.id = "conversation-turn-0";
    else if (marker === "div testid") {
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-testid", "conversation-turn-0");
      first.before(wrapper);
      wrapper.append(first);
    } else first.setAttribute("data-content-search-unit-key", "fallback-turn-0:0:user");
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    expect((await capture).completeness.status).toBe("complete");
    expect(container.scrollTop).toBe(600);
  });

  it("waits beyond a quiet truncated window for delayed first-turn evidence", async () => {
    const { adapter, container } = page();
    const first = adapter.extractVisibleMessages()[0]!.element;
    first.setAttribute("data-testid", "conversation-turn-16");
    setTimeout(() => first.setAttribute("data-testid", "conversation-turn-0"), 15_000);
    const result = reachConversationTop(container, adapter);
    await vi.runAllTimersAsync();
    expect((await result).reached).toBe(true);
  });

  it.each(["id", "content search key"])("keeps a later %s turn partial and respects the top-loading budget", async (marker) => {
    const { adapter, container } = page();
    const first = adapter.extractVisibleMessages()[0]!.element;
    first.removeAttribute("data-testid");
    if (marker === "id") first.id = "conversation-turn-16";
    else first.setAttribute("data-content-search-unit-key", "fallback-turn-16:0:user");
    const wait = vi.fn(async () => undefined);
    const result = await reachConversationTop(container, adapter, { maxIterations: 20, wait });
    expect(result.reached).toBe(false);
    expect(wait).toHaveBeenCalledTimes(20);
  });

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

  it("waits for delayed virtualized windows and captures the whole ordered history", async () => {
    const { adapter, container } = virtualizedPage();
    const capture = scanConversation(adapter, { triggerReason: "manual_retry", readNative: async () => null });
    await vi.runAllTimersAsync();
    const snapshot = await capture;
    expect(snapshot.messages.map((message) => message.externalMessageId)).toEqual(Array.from({ length: 12 }, (_, index) => `m${index}`));
    expect(snapshot.completeness.status).toBe("complete");
    expect(container.scrollTop).toBe(600);
  });

  it("scans negative scroll positions in ChatGPT's reversed transcript and recognizes new first-turn markers", async () => {
    const { adapter, container } = virtualizedPage();
    container.style.display = "flex";
    container.style.flexDirection = "column-reverse";
    const descriptor = Object.getOwnPropertyDescriptor(container, "scrollTop")!;
    const rawWrites = vi.fn();
    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      get: () => descriptor.get!.call(container) - (container.scrollHeight - container.clientHeight),
      set: (value: number) => {
        rawWrites(value);
        descriptor.set!.call(container, value + container.scrollHeight - container.clientHeight);
      },
    });
    [...container.querySelectorAll("article")].forEach((element, index) => {
      element.removeAttribute("data-testid");
      element.setAttribute("data-chatgpt-search-unit-key", `fallback-turn-${Math.floor(index / 2)}:${index % 2 ? 2 : 0}:${index % 2 ? "assistant" : "user"}`);
    });
    expect(container.scrollTop).toBe(-200);
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    const snapshot = await capture;
    expect(snapshot.messages.map((message) => message.externalMessageId)).toEqual(Array.from({ length: 12 }, (_, index) => `m${index}`));
    expect(snapshot.completeness).toMatchObject({ status: "partial", topReached: false, bottomReached: true });
    expect(rawWrites).toHaveBeenCalledWith(-800);
    expect(rawWrites).toHaveBeenCalledWith(0);
    expect(container.scrollTop).toBe(-200);
  });

  it("backtracks to overlapping windows instead of jumping over hidden messages", async () => {
    const { adapter, writeScroll } = virtualizedPage({ windowSize: 2 });
    // Two mounted messages require a smaller step than half the viewport.
    Object.defineProperty(document.querySelector("main")!, "scrollHeight", { configurable: true, value: 1_400 });
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    const snapshot = await capture;
    expect(snapshot.messages.map((message) => message.externalMessageId)).toEqual(Array.from({ length: 12 }, (_, index) => `m${index}`));
    expect(writeScroll.mock.calls.some(([value], index, calls) => index > 0 && value > 0 && value < calls[index - 1]![0])).toBe(true);
    expect(snapshot.completeness.status).toBe("complete");
  });

  it("marks an unrecoverable middle gap partial even after reaching both scroll boundaries", async () => {
    const { adapter } = virtualizedPage({ windowSize: 2, missingMiddle: true });
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    const snapshot = await capture;
    expect(snapshot.completeness).toMatchObject({ status: "partial", topReached: true, bottomReached: true });
    expect(snapshot.completeness.reason).toContain("缺口");
  });

  it("refreshes a same-ID shell with its later full body without losing it on a shorter remount", () => {
    const { adapter } = page();
    const original = adapter.extractVisibleMessages()[1]!;
    const messages = [original];
    const full = { ...original, segments: [{ type: "text" as const, content: "Answer with the complete ten-day itinerary" }] };
    mergeVisible(messages, [full]);
    mergeVisible(messages, [original]);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.segments).toEqual(full.segments);
  });

  it("inserts a late-mounted middle message between its stable-ID anchors", async () => {
    const { adapter, container } = virtualizedPage();
    const all = adapter.extractVisibleMessages();
    all[0]!.element.setAttribute("data-testid", "conversation-turn-0");
    adapter.extractVisibleMessages = () => container.scrollTop === 0
      ? [all[0]!, all[2]!] : all;
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    const snapshot = await capture;
    expect(snapshot.messages.map((message) => message.externalMessageId)).toEqual(all.map((message) => message.externalMessageId));
    expect(snapshot.completeness.status).toBe("complete");
  });

  it.each([
    { name: "reversed known IDs", first: [0, 1, 2], next: [2, 1, 3] },
    { name: "duplicate IDs in a window", first: [0, 1], next: [1, 1, 2, 3] },
    { name: "ambiguous runs between shared anchors", first: [0, 1, 3], next: [0, 2, 3] },
    { name: "ambiguous new tail after an interior anchor", first: [0, 1], next: [0, 2, 3] },
  ])("does not certify $name even when windows overlap and reach both boundaries", async ({ first, next }) => {
    const { adapter, container } = virtualizedPage();
    const all = adapter.extractVisibleMessages();
    all[0]!.element.setAttribute("data-testid", "conversation-turn-0");
    adapter.extractVisibleMessages = () => (container.scrollTop === 0 ? first : next).map((index) => all[index]!);
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    const snapshot = await capture;
    expect(snapshot.completeness).toMatchObject({ status: "partial", topReached: true, bottomReached: true, stable: true });
    expect(snapshot.completeness.reason).toContain("顺序");
  });

  it.each([undefined, "conversation-turn-16"])("preserves a stable middle window without certifying the first turn (%s)", async (testId) => {
    const { adapter } = page();
    const first = adapter.extractVisibleMessages()[0]!.element;
    if (testId) first.setAttribute("data-testid", testId);
    else first.removeAttribute("data-testid");
    const capture = scanConversation(adapter, { triggerReason: "manual_retry", readNative: async () => null });
    await vi.runAllTimersAsync();
    const snapshot = await capture;
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.completeness).toMatchObject({ status: "partial", topReached: false, bottomReached: true, stable: true });
    expect(snapshot.completeness.reason).toContain("首轮");
  });

  it("recovers the normal step after a dense section so a long stable conversation finishes", async () => {
    const { adapter, container, writeScroll } = page("gemini");
    container.innerHTML = Array.from({ length: 320 }, (_, index) => `<article>Message ${index}</article>`).join("");
    const elements = [...container.querySelectorAll("article")];
    Object.defineProperty(container, "scrollHeight", { configurable: true, value: 30_000 });
    adapter.extractVisibleMessages = () => {
      const top = container.scrollTop;
      const start = top < 500 ? Math.floor(top / 50) : 10 + Math.floor((top - 500) / 100);
      return elements.slice(start, start + (top < 500 ? 2 : 4)).map((element, index) => ({
        element, ordinal: start + index, key: `m${start + index}`, externalMessageId: `m${start + index}`,
        role: (start + index) % 2 ? "assistant" as const : "user" as const,
        segments: [{ type: "text" as const, content: element.textContent! }],
      }));
    };
    const started = Date.now();
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    const snapshot = await capture;
    expect(snapshot.completeness.status).toBe("complete");
    expect(snapshot.messages.map((message) => message.externalMessageId)).toEqual(Array.from({ length: 305 }, (_, index) => `m${index}`));
    expect(writeScroll).toHaveBeenCalledWith(50);
    expect(writeScroll).toHaveBeenCalledWith(29_600);
    expect(Date.now() - started).toBeLessThan(360_000);
  });

  it("does not certify complete when historical text keeps changing without a streaming indicator", async () => {
    const { adapter } = page();
    const extract = adapter.extractVisibleMessages.bind(adapter);
    let sample = 0;
    adapter.extractVisibleMessages = () => extract().map((message) => ({
      ...message,
      segments: [{ type: "text", content: `${message.key}: changing render ${sample++}` }],
    }));
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    expect((await capture).completeness).toMatchObject({ status: "partial", stable: false });
  });

  it("does not certify or scroll a hidden conversation without layout", async () => {
    const { adapter, container, writeScroll } = page();
    Object.defineProperty(container, "clientHeight", { configurable: true, value: 0 });
    const capture = scanConversation(adapter, { triggerReason: "manual_retry" });
    await vi.runAllTimersAsync();
    expect((await capture).completeness.status).toBe("partial");
    expect(writeScroll).not.toHaveBeenCalled();
  });

  it("aborts during a delayed virtual window without publishing or restoring a false complete scan", async () => {
    const { adapter, container, writeScroll } = virtualizedPage();
    const controller = new AbortController();
    const capture = scanConversation(adapter, { triggerReason: "manual_retry", signal: controller.signal });
    const rejected = expect(capture).rejects.toBeInstanceOf(CaptureInterruptedError);
    await vi.advanceTimersByTimeAsync(10_400);
    expect(container.scrollTop).toBeGreaterThan(0);
    controller.abort();
    container.scrollTop = 455;
    const writes = writeScroll.mock.calls.length;
    await vi.runAllTimersAsync();
    await rejected;
    expect(writeScroll).toHaveBeenCalledTimes(writes);
    expect(container.scrollTop).toBe(455);
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
