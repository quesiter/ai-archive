// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { CapturePayloadV1 } from "@ai-archive/contracts";
import type { ExtensionMessage } from "../lib/messages";
import type { NativeConversation } from "../lib/native-conversation";
import { adapterDefinitions } from "../lib/adapters/definitions";
import { createAdapterRuntime } from "../lib/adapters/runtime";
import { messageTextFingerprint } from "../lib/scanner";

vi.mock("wxt/utils/define-content-script", () => ({ defineContentScript: (value: unknown) => value }));
const native = vi.hoisted(() => ({ read: vi.fn(async (..._args: unknown[]): Promise<NativeConversation | null> => null) }));
vi.mock("../lib/native-conversation", () => ({ createNativeConversationReader: () => native.read }));
import content from "../entrypoints/content";

let cleanup: (() => void) | undefined;
let stored: Record<string, unknown>;
let payloads: CapturePayloadV1[];
let runtimeListener: (message: ExtensionMessage) => unknown;
let sendMessage: ReturnType<typeof vi.fn>;
let writeScroll: ReturnType<typeof vi.fn>;
let contextInvalid = false;

const key = "captureState:chatgpt:session";

it.each([403, 429])("stops batch capture on HTTP %s without falling back to scrolling", async httpStatus => {
  const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  vi.stubGlobal("location", new URL(`https://chatgpt.com/c/session#ai-archive-batch=${operationId}`));
  let requestSignal: AbortSignal | undefined;
  native.read.mockImplementation(async (...args: unknown[]) => {
    requestSignal = args[3] as AbortSignal;
    const options = args[4] as { onDiagnostic: (value: unknown) => void };
    options.onDiagnostic({ stage: "conversation", code: "http_error", httpStatus });
    return null;
  });
  start();
  await runtimeListener({ type: "startBatchCapture", operationId, itemId: "item", sessionId: "session" });
  await tick();
  const result = await runtimeListener({ type: "getBatchCaptureState", operationId }) as { result?: { outcome?: string } };
  expect(result.result?.outcome).toBe("attention");
  expect(requestSignal?.aborted).toBe(true);
  expect(payloads).toHaveLength(0);
});

function mountMessages(first = "u1", last = "a1") {
  document.querySelector("main")!.innerHTML = `
    <article data-message-author-role="user" data-message-id="${first}">Question</article>
    <article data-message-author-role="assistant" data-message-id="${last}">Answer</article>`;
}

function start() {
  content.main({ get isInvalid() { return contextInvalid; }, onInvalidated: (fn: () => void) => { cleanup = fn; } } as NonNullable<Parameters<typeof content.main>[0]>);
}

async function tick(milliseconds = 6_000) {
  for (let remaining = milliseconds; remaining > 0; remaining -= 250) {
    await vi.advanceTimersByTimeAsync(Math.min(remaining, 250));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  contextInvalid = false;
  // Keep real SHA-256 results without racing native worker callbacks against fake time.
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (_algorithm, data) => {
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
  });
  vi.stubGlobal("location", new URL("https://chatgpt.com/c/session"));
  native.read.mockReset();
  native.read.mockResolvedValue(null);
  Object.defineProperty(HTMLElement.prototype, "innerText", { configurable: true, get() { return this.textContent ?? ""; } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 100, height: 20 } as DOMRect);
  document.body.innerHTML = '<main data-conversation-id="session" style="overflow-y:auto"></main>';
  mountMessages();
  let top = 600;
  writeScroll = vi.fn((value: number) => { top = value; });
  Object.defineProperties(document.querySelector("main"), {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1_200 },
    scrollTop: { configurable: true, get: () => top, set: writeScroll },
  });
  stored = { showFloatingIndicator: false };
  payloads = [];
  sendMessage = vi.fn(async (message: ExtensionMessage) => {
    if (message.type !== "enqueueCapture") return undefined;
    payloads.push(message.payload);
    const payload = message.payload;
    const delta = "appendedMessages" in payload;
    return { sent: 1, remaining: 0, captureId: `capture:${payloads.length}`, lastResult: {
      revisionId: `revision-${payloads.length}`,
      messageCount: delta ? payload.baseMessageCount + payload.appendedMessages.length : payload.messages.length,
      completeness: delta ? "complete" : payload.completeness.status,
      baselineContentHash: "a".repeat(64),
    } };
  });
  vi.stubGlobal("browser", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: stored[key] })),
        set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(stored, value); }),
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: { sendMessage, onMessage: { addListener: vi.fn((fn: typeof runtimeListener) => { runtimeListener = fn; }), removeListener: vi.fn() } },
  });
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("automatic capture lifecycle", () => {
  it("allows its original document to start after a same-session batch hash normalization", async () => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.stubGlobal("location", new URL(`https://chatgpt.com/c/session#ai-archive-batch=${operationId}`));
    start();
    vi.stubGlobal("location", new URL("https://chatgpt.com/c/session"));
    await tick(1_000);
    expect(await runtimeListener({ type: "startBatchCapture", operationId, itemId: "item", sessionId: "session" })).toEqual({ ok: true });
  });
  it.each(["请重新登录", "Too many requests", "Unable to load conversation"])("does not retain a vanished transient notice after the same conversation has loaded: %s", async notice => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.stubGlobal("location", new URL(`https://chatgpt.com/c/session#ai-archive-batch=${operationId}`));
    start();
    const alert = document.createElement("div"); alert.setAttribute("role", "alert"); alert.textContent = notice;
    document.body.append(alert);
    expect(await runtimeListener({ type: "getBatchCaptureState", operationId })).toMatchObject({ pageIssue: { outcome: "attention" } });
    alert.remove();
    await Promise.resolve();
    expect(await runtimeListener({ type: "getBatchCaptureState", operationId })).not.toHaveProperty("pageIssue", expect.anything());
  });
  it("does not clear a source warning merely because a different conversation is still mounted", async () => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.stubGlobal("location", new URL(`https://chatgpt.com/c/session#ai-archive-batch=${operationId}`));
    start();
    document.body.insertAdjacentHTML("beforeend", '<div role="alert">请重新登录</div>');
    await runtimeListener({ type: "getBatchCaptureState", operationId });
    document.querySelector('[role="alert"]')!.remove();
    document.querySelector("main")!.setAttribute("data-conversation-id", "different-session");
    await Promise.resolve();
    expect(await runtimeListener({ type: "getBatchCaptureState", operationId })).toMatchObject({ pageIssue: { outcome: "attention" } });
  });
  it("keeps an in-flight batch capture alive when only the router-owned hash disappears", async () => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.stubGlobal("location", new URL(`https://chatgpt.com/c/session#ai-archive-batch=${operationId}`));
    let resolveNative!: (value: NativeConversation) => void;
    native.read.mockImplementationOnce(() => new Promise(resolve => { resolveNative = resolve; }));
    start();
    await runtimeListener({ type: "startBatchCapture", operationId, itemId: "item", sessionId: "session" });
    await tick(1_000);
    const signal = native.read.mock.calls[0]![3] as AbortSignal;
    vi.stubGlobal("location", new URL("https://chatgpt.com/c/session"));
    await tick(1_000);
    expect(signal.aborted).toBe(false);
    resolveNative({ messages: [
      { ordinal: 0, externalMessageId: "u1", role: "user", segments: [{ type: "text", content: "Question" }] },
      { ordinal: 1, externalMessageId: "a1", role: "assistant", segments: [{ type: "text", content: "Answer" }] },
    ] });
    await tick(2_000);
    expect(await runtimeListener({ type: "getBatchCaptureState", operationId })).toMatchObject({ result: { captureId: "capture:1" } });
  });
  it("reserves the batch page for one explicit operation and exposes its receipt after completion", async () => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.stubGlobal("location", new URL(`https://chatgpt.com/c/session#ai-archive-batch=${operationId}`));
    native.read.mockResolvedValue({ messages: [
      { ordinal: 0, externalMessageId: "u1", role: "user", segments: [{ type: "text", content: "Question" }] },
      { ordinal: 1, externalMessageId: "a1", role: "assistant", segments: [{ type: "text", content: "Answer" }] },
    ] });
    start(); await tick(6_000); expect(payloads).toHaveLength(0);
    expect(await runtimeListener({ type: "startBatchCapture", operationId, itemId: "item", sessionId: "wrong" })).toHaveProperty("error");
    await runtimeListener({ type: "startBatchCapture", operationId, itemId: "item", sessionId: "session" });
    await runtimeListener({ type: "startBatchCapture", operationId, itemId: "item", sessionId: "session" });
    await tick(6_000);
    expect(payloads).toHaveLength(1);
    expect(sendMessage.mock.calls.find(([message]) => message.type === "enqueueCapture")?.[0]).toMatchObject({ batch: { operationId, itemId: "item" } });
    expect(await runtimeListener({ type: "getBatchCaptureState", operationId })).toMatchObject({ running: false, result: { captureId: "capture:1" } });
  });
  it("stops a batch on source rate limiting without silently running a DOM fallback", async () => {
    const operationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    vi.stubGlobal("location", new URL(`https://chatgpt.com/c/session#ai-archive-batch=${operationId}`));
    native.read.mockImplementation(async (...args) => {
      (args[4] as { onDiagnostic: (value: unknown) => void }).onDiagnostic({ stage: "conversation", code: "rate_limited", httpStatus: 429 });
      return null;
    });
    start(); await runtimeListener({ type: "startBatchCapture", operationId, itemId: "item", sessionId: "session" });
    await tick(6_000);
    expect(payloads).toHaveLength(0);
    expect(await runtimeListener({ type: "getBatchCaptureState", operationId })).toMatchObject({ running: false, result: { outcome: "attention", message: expect.stringContaining("限流") } });
  });
  it("uploads passive automatic captures during continuous user activity without moving the page", async () => {
    start();
    for (let index = 0; index < 7; index++) {
      window.dispatchEvent(new Event("wheel"));
      window.dispatchEvent(new Event("keydown"));
      await tick(1_000);
    }
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ triggerReason: "new_session" });
    expect(writeScroll).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.some(([message]) => message.type === "captureState" && message.state.message?.includes("暂缓"))).toBe(false);
  });

  it("stops scrolling on activity while allowing an in-flight native read to finish and upload", async () => {
    let resolveNative!: (value: NativeConversation) => void;
    native.read.mockImplementationOnce(() => new Promise((resolve) => { resolveNative = resolve; }));
    start();
    await runtimeListener({ type: "manualCapture" });
    await tick(1_500);
    window.dispatchEvent(new Event("wheel"));
    const signal = native.read.mock.calls[0]?.[3] as AbortSignal;
    expect(signal.aborted).toBe(false);
    resolveNative({ messages: [
      { ordinal: 0, externalMessageId: "u1", role: "user", segments: [{ type: "text", content: "Question" }] },
      { ordinal: 1, externalMessageId: "a1", role: "assistant", segments: [{ type: "text", content: "Answer" }] },
    ] });
    await tick(1_000);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ completeness: { status: "complete" } });
    expect(writeScroll).not.toHaveBeenCalled();
  });

  it("cleans up when listener registration throws during startup", async () => {
    vi.mocked(browser.runtime.onMessage.addListener).mockImplementation(() => { throw new Error("Extension context invalidated."); });
    expect(start).not.toThrow();
    await tick(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("detects context invalidation from polling even without an abort notification", async () => {
    start();
    await tick(500);
    contextInvalid = true;
    await tick(10_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(browser.runtime.onMessage.removeListener).toHaveBeenCalledWith(runtimeListener);
  });

  it.each(["throw", "reject"])("stops polling when extension storage APIs %s context invalidation", async (failure) => {
    const get = vi.mocked(browser.storage.local.get);
    if (failure === "throw") get.mockImplementation(() => { throw new Error("Extension context invalidated."); });
    else get.mockRejectedValue(new Error("Extension context invalidated."));
    start();
    await tick(10_000);
    const calls = get.mock.calls.length;
    await tick(10_000);
    expect(get.mock.calls).toHaveLength(calls);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(document.getElementById("ai-archive-floating-indicator")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not recreate floating UI when an in-flight settings read completes after invalidation", async () => {
    let resolveSettings!: (value: Record<string, unknown>) => void;
    vi.mocked(browser.storage.local.get).mockImplementationOnce(() => new Promise((resolve) => { resolveSettings = resolve; }));
    start();
    await Promise.resolve();
    cleanup?.();
    resolveSettings({ showFloatingIndicator: true });
    await tick(500);
    expect(document.getElementById("ai-archive-floating-indicator")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports missing messages after a manual click instead of silently doing nothing", async () => {
    document.querySelector("main")!.replaceChildren();
    start();
    await runtimeListener({ type: "manualCapture" });
    await tick(500);
    const statuses = sendMessage.mock.calls.map(([message]) => message as ExtensionMessage)
      .filter((message) => message.type === "captureState").map((message) => message.state);
    expect(statuses.at(-1)).toMatchObject({ status: "failed", triggerReason: "manual_retry" });
    expect(statuses.at(-1)?.message).toContain("没有识别到对话消息");
    expect(payloads).toHaveLength(0);
  });

  it("explains why a manual request on a new chat cannot start", async () => {
    vi.stubGlobal("location", new URL("https://chatgpt.com/"));
    document.querySelector("main")!.removeAttribute("data-conversation-id");
    start();
    await runtimeListener({ type: "manualCapture" });
    await tick(500);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "captureState", state: expect.objectContaining({ status: "failed", message: expect.stringContaining("没有识别到会话编号") }),
    }));
    expect(payloads).toHaveLength(0);
  });

  it("explains a paused manual request without capturing", async () => {
    stored.pausedHosts = { "chatgpt.com": true };
    start();
    await runtimeListener({ type: "manualCapture" });
    await tick(500);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: "captureState", state: expect.objectContaining({ message: expect.stringContaining("本站已暂停") }),
    }));
    expect(payloads).toHaveLength(0);
  });

  it("keeps the floating panel open so manual capture errors remain visible", async () => {
    stored.showFloatingIndicator = true;
    document.querySelector("main")!.replaceChildren();
    const attach = vi.spyOn(Element.prototype, "attachShadow");
    start();
    await tick(100);
    const shadow = attach.mock.results[0]!.value as ShadowRoot;
    shadow.querySelector<HTMLButtonElement>(".toggle")!.click();
    shadow.querySelector<HTMLButtonElement>(".retry")!.click();
    await tick(500);
    expect(shadow.querySelector<HTMLElement>(".panel")!.hidden).toBe(false);
    expect(shadow.querySelector(".message")!.textContent).toContain("没有识别到对话消息");
  });

  it("does not turn accumulated archive counts or a partial source receipt into an append baseline", async () => {
    sendMessage.mockImplementation(async (message: ExtensionMessage) => {
      if (message.type !== "enqueueCapture") return undefined;
      payloads.push(message.payload);
      return { lastResult: { revisionId: "archive-40", messageCount: "appendedMessages" in message.payload ? 4 : message.payload.messages.length,
        completeness: "partial", archiveMessageCount: 40, archiveCompleteness: "complete", baselineContentHash: "a".repeat(64) } };
    });
    start();
    await tick();
    expect(stored[key]).toMatchObject({ messageCount: 2, completeness: "partial", lastMessageId: "a1" });
    expect((stored[key] as { baselineContentHash?: string }).baselineContentHash).toBeUndefined();
    document.querySelector("main")!.insertAdjacentHTML("beforeend", '<article data-message-author-role="user" data-message-id="u2">Follow-up</article><article data-message-author-role="assistant" data-message-id="a2">New answer</article>');
    await tick();
    expect(payloads).toHaveLength(2);
    expect(payloads.every((payload) => payload.captureMode === "full")).toBe(true);
    const statuses = sendMessage.mock.calls.map(([message]) => message as ExtensionMessage)
      .filter((message) => message.type === "captureState").map((message) => message.state);
    expect(statuses.at(-1)).toMatchObject({ status: "complete", messageCount: 4, archiveMessageCount: 40, archiveCompleteness: "complete" });
    expect(statuses.at(-1)?.message).toBe("本次保存 4 条消息，累计归档 40 条（完整）");
    expect(stored[key]).toMatchObject({ messageCount: 4, completeness: "partial", lastMessageId: "a2" });
    expect((stored[key] as { baselineContentHash?: string }).baselineContentHash).toBeUndefined();
    expect(payloads.every((payload) => "messages" in payload && payload.completeness.status === "partial")).toBe(true);
  });

  it("falls back to full capture for a complete legacy state without a server baseline hash", async () => {
    stored[key] = { provider: "chatgpt", sessionId: "session", adapterVersion: adapterDefinitions[0]!.version,
      messageCount: 24, lastMessageId: "archived-tail", lastMessageTextHash: "archived-hash", lastMessageRole: "assistant",
      completeness: "complete", branchFingerprint: "legacy-branch", revisionId: "legacy-revision" };
    start();
    await tick();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.captureMode).toBe("full");
    expect((stored[key] as { baselineContentHash?: string }).baselineContentHash).toBeUndefined();
  });

  it("saves a new session once and ignores unrelated remounts without scrolling or status flashing", async () => {
    start();
    await tick();
    expect(payloads).toHaveLength(1);
    const statusCount = sendMessage.mock.calls.length;
    for (let i = 0; i < 3; i++) {
      mountMessages();
      await tick();
    }
    await tick(60_000);
    expect(payloads).toHaveLength(1);
    expect(native.read).toHaveBeenCalledTimes(1);
    expect(writeScroll).not.toHaveBeenCalled();
    expect(sendMessage.mock.calls.length).toBe(statusCount);
  });

  it("preserves a complete archive baseline when its tail is unmounted", async () => {
    stored[key] = {
      provider: "chatgpt", sessionId: "session", adapterVersion: adapterDefinitions[0]!.version,
      messageCount: 24, lastMessageId: "archived-tail", lastMessageTextHash: "archived-hash",
      lastMessageRole: "assistant", completeness: "complete", branchFingerprint: "trusted-branch", revisionId: "trusted-revision",
      baselineContentHash: "b".repeat(64),
    };
    start();
    await tick();
    expect(payloads).toHaveLength(1);
    expect(stored[key]).toMatchObject({ messageCount: 24, completeness: "complete", revisionId: "trusted-revision", branchFingerprint: "trusted-branch" });
    mountMessages();
    await tick();
    expect(payloads).toHaveLength(1);
    expect(writeScroll).not.toHaveBeenCalled();
    expect(native.read).toHaveBeenCalledTimes(1); // Shared by append and snapshot fallback.
  });

  it("still appends a new answer after a viewport-only save", async () => {
    const adapter = createAdapterRuntime(adapterDefinitions[0]!);
    const tail = adapter.extractVisibleMessages()[1]!;
    stored[key] = {
      provider: "chatgpt", sessionId: "session", adapterVersion: adapterDefinitions[0]!.version,
      messageCount: 24, lastMessageId: "a1", lastMessageTextHash: await messageTextFingerprint(tail),
      lastMessageRole: "assistant", completeness: "complete", branchFingerprint: "trusted-branch", revisionId: "trusted-revision",
      baselineContentHash: "b".repeat(64),
    };
    mountMessages("older-user", "older-answer");
    start();
    await tick();
    mountMessages();
    document.querySelector("main")!.insertAdjacentHTML("beforeend", `
      <article data-message-author-role="user" data-message-id="u2">Follow-up</article>
      <article data-message-author-role="assistant" data-message-id="a2">New answer</article>`);
    await tick();
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ captureMode: "append", baseMessageCount: 24, baseContentHash: "b".repeat(64) });
    expect(stored[key]).toMatchObject({ messageCount: 26, lastMessageId: "a2" });
    expect(writeScroll).not.toHaveBeenCalled();
  });

  it("keeps forced server repairs passive and drops rejected baselines", async () => {
    stored[key] = {
      provider: "chatgpt", sessionId: "session", adapterVersion: adapterDefinitions[0]!.version,
      messageCount: 24, completeness: "complete", branchFingerprint: "rejected-base",
    };
    start();
    await runtimeListener({ type: "forceFullCapture", reason: "incremental_base_mismatch" });
    await tick();
    expect(payloads.at(-1)).toMatchObject({ triggerReason: "incremental_base_mismatch", completeness: { status: "partial" } });
    expect(stored[key]).toMatchObject({ completeness: "partial", messageCount: 2 });
    expect(writeScroll).not.toHaveBeenCalled();
  });

  it("starts manual capture during generation and stops scrolling on user input", async () => {
    document.body.insertAdjacentHTML("beforeend", '<button data-testid="stop-button">Stop</button>');
    start();
    await runtimeListener({ type: "manualCapture" });
    await tick(500);
    expect(writeScroll).not.toHaveBeenCalled();
    await tick(3_000);
    expect(writeScroll).toHaveBeenCalledWith(0);
    document.querySelector("main")!.scrollTop = 455;
    const count = writeScroll.mock.calls.length;
    window.dispatchEvent(new Event("wheel"));
    await tick(20_000);
    expect(writeScroll).toHaveBeenCalledTimes(count);
    expect(document.querySelector("main")!.scrollTop).toBe(455);
    const saved = payloads.find((payload) => payload.triggerReason === "manual_retry");
    expect(saved).toMatchObject({ completeness: { status: "partial" } });
    expect(saved && "messages" in saved ? saved.messages.map((message) => message.externalMessageId) : []).toEqual(["u1", "a1"]);
  });

  it("reports a complete manual native capture while the source is still generating", async () => {
    document.body.insertAdjacentHTML("beforeend", '<button data-testid="stop-button">Stop</button>');
    native.read.mockResolvedValue({ messages: [
      { ordinal: 0, externalMessageId: "u1", role: "user", segments: [{ type: "text", content: "Question" }] },
      { ordinal: 1, externalMessageId: "a1", role: "assistant", segments: [{ type: "text", content: "Current answer" }] },
    ] });
    start();
    await runtimeListener({ type: "manualCapture" });
    await tick(500);
    const saved = payloads.find(payload => payload.triggerReason === "manual_retry");
    expect(saved).toMatchObject({ completeness: { status: "complete" }, sourceKind: "chatgpt_current_branch" });
    expect(writeScroll).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="stop-button"]')).not.toBeNull();
  });

  it("passes explicit manual retries to the native reader", async () => {
    start();
    await tick();
    expect(native.read.mock.calls[0]?.[4]).toMatchObject({ manualRetry: false });
    await runtimeListener({ type: "manualCapture" });
    await tick(2_000);
    expect(native.read.mock.calls.at(-1)?.[4]).toMatchObject({ manualRetry: true });
  });

  it.each([false, true])("preserves ten identified messages on interruption without crossing sessions (changed=%s)", async (changed) => {
    document.querySelector("main")!.innerHTML = Array.from({ length: 10 }, (_, index) =>
      `<article data-message-author-role="${index % 2 ? "assistant" : "user"}" data-message-id="message-${index}">Message ${index}</article>`,
    ).join("");
    let resolveNative!: (value: null) => void;
    native.read.mockImplementationOnce(() => new Promise((resolve) => { resolveNative = resolve; }));
    start();
    await runtimeListener({ type: "manualCapture" });
    await tick(1_500);
    window.dispatchEvent(new Event("wheel"));
    if (changed) {
      vi.stubGlobal("location", new URL("https://chatgpt.com/c/different-session"));
      mountMessages("other-user", "other-answer");
    }
    resolveNative(null);
    await tick(500);
    const saved = payloads.filter((payload) => payload.triggerReason === "manual_retry");
    if (changed) expect(saved).toHaveLength(0);
    else {
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ sessionId: "session", completeness: { status: "partial" } });
      expect(saved[0] && "messages" in saved[0] ? saved[0].messages : []).toHaveLength(10);
    }
  });

  it("keeps manual capture running when ChatGPT restores composer focus or floating UI is clicked", async () => {
    let resolveNative!: (value: NativeConversation) => void;
    native.read.mockImplementationOnce(() => new Promise((resolve) => { resolveNative = resolve; }));
    document.body.insertAdjacentHTML("beforeend", '<div role="textbox" tabindex="0"></div><div id="ai-archive-floating-indicator"><button>Show status</button></div>');
    start();
    await runtimeListener({ type: "manualCapture" });
    await tick(1_500);
    document.querySelector('[role="textbox"]')!.dispatchEvent(new Event("focusin", { bubbles: true }));
    document.querySelector('[role="textbox"]')!.dispatchEvent(new Event("input", { bubbles: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Shift" }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Meta", metaKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", shiftKey: true, metaKey: true }));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));
    document.querySelector("#ai-archive-floating-indicator button")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    resolveNative({ messages: [
      { ordinal: 0, externalMessageId: "u1", role: "user", segments: [{ type: "text", content: "Question" }] },
      { ordinal: 1, externalMessageId: "a1", role: "assistant", segments: [{ type: "text", content: "Answer" }] },
    ] });
    await tick(2_000);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({ triggerReason: "manual_retry", completeness: { status: "complete" } });
  });

  it("shows partial when the server rejects a collector's completeness claim", async () => {
    native.read.mockResolvedValue({ messages: [
      { ordinal: 0, externalMessageId: "u1", role: "user", segments: [{ type: "text", content: "Question" }] },
      { ordinal: 1, externalMessageId: "a1", role: "assistant", segments: [{ type: "text", content: "Answer" }] },
    ] });
    sendMessage.mockImplementation(async (message: ExtensionMessage) => {
      if (message.type !== "enqueueCapture") return undefined;
      payloads.push(message.payload);
      return { lastResult: { revisionId: "partial-revision", messageCount: 2, completeness: "partial" } };
    });
    start();
    await tick();
    expect(payloads[0]).toMatchObject({ completeness: { status: "complete" } });
    const statuses = sendMessage.mock.calls.map(([message]) => message as ExtensionMessage)
      .filter((message) => message.type === "captureState").map((message) => message.state);
    expect(statuses.at(-1)).toMatchObject({ status: "partial" });
    expect(statuses.at(-1)?.message).toContain("累计归档含历史差异，需要核对");
    expect(statuses.at(-1)?.message).not.toContain("历史片段缺失");
    expect(stored[key]).toMatchObject({ completeness: "partial" });
    expect((stored[key] as { baselineContentHash?: string }).baselineContentHash).toBeUndefined();
  });
});
