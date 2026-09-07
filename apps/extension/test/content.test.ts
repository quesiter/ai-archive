// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { CapturePayloadV1 } from "@ai-archive/contracts";
import type { ExtensionMessage } from "../lib/messages";
import { adapterDefinitions } from "../lib/adapters/definitions";
import { createAdapterRuntime } from "../lib/adapters/runtime";
import { messageTextFingerprint } from "../lib/scanner";

vi.mock("wxt/utils/define-content-script", () => ({ defineContentScript: (value: unknown) => value }));
const native = vi.hoisted(() => ({ read: vi.fn(async () => null) }));
vi.mock("../lib/native-conversation", () => ({ createNativeConversationReader: () => native.read }));
import content from "../entrypoints/content";

let cleanup: (() => void) | undefined;
let stored: Record<string, unknown>;
let payloads: CapturePayloadV1[];
let runtimeListener: (message: ExtensionMessage) => unknown;
let sendMessage: ReturnType<typeof vi.fn>;
let writeScroll: ReturnType<typeof vi.fn>;

const key = "captureState:chatgpt:session";

function mountMessages(first = "u1", last = "a1") {
  document.querySelector("main")!.innerHTML = `
    <article data-message-author-role="user" data-message-id="${first}">Question</article>
    <article data-message-author-role="assistant" data-message-id="${last}">Answer</article>`;
}

function start() {
  content.main({ onInvalidated: (fn: () => void) => { cleanup = fn; } } as NonNullable<Parameters<typeof content.main>[0]>);
}

async function tick(milliseconds = 6_000) {
  for (let remaining = milliseconds; remaining > 0; remaining -= 250) {
    await vi.advanceTimersByTimeAsync(Math.min(remaining, 250));
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  // Keep real SHA-256 results without racing native worker callbacks against fake time.
  vi.spyOn(crypto.subtle, "digest").mockImplementation(async (_algorithm, data) => {
    const bytes = data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    return Uint8Array.from(createHash("sha256").update(bytes).digest()).buffer;
  });
  vi.stubGlobal("location", new URL("https://chatgpt.com/c/session"));
  native.read.mockClear();
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
    return { sent: 1, remaining: 0, lastResult: {
      revisionId: `revision-${payloads.length}`,
      messageCount: delta ? payload.baseMessageCount + payload.appendedMessages.length : payload.messages.length,
      completeness: delta ? "complete" : payload.completeness.status,
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
    runtime: { sendMessage, onMessage: { addListener: (fn: typeof runtimeListener) => { runtimeListener = fn; } } },
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
      provider: "chatgpt", sessionId: "session", adapterVersion: "1.2.2",
      messageCount: 24, lastMessageId: "archived-tail", lastMessageTextHash: "archived-hash",
      lastMessageRole: "assistant", completeness: "complete", branchFingerprint: "trusted-branch", revisionId: "trusted-revision",
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
      provider: "chatgpt", sessionId: "session", adapterVersion: "1.2.2",
      messageCount: 24, lastMessageId: "a1", lastMessageTextHash: await messageTextFingerprint(tail),
      lastMessageRole: "assistant", completeness: "complete", branchFingerprint: "trusted-branch", revisionId: "trusted-revision",
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
    expect(payloads[1]).toMatchObject({ captureMode: "append", baseMessageCount: 24 });
    expect(stored[key]).toMatchObject({ messageCount: 26, lastMessageId: "a2" });
    expect(writeScroll).not.toHaveBeenCalled();
  });

  it("keeps forced server repairs passive and drops rejected baselines", async () => {
    stored[key] = {
      provider: "chatgpt", sessionId: "session", adapterVersion: "1.2.2",
      messageCount: 24, completeness: "complete", branchFingerprint: "rejected-base",
    };
    start();
    await runtimeListener({ type: "forceFullCapture", reason: "incremental_base_mismatch" });
    await tick();
    expect(payloads.at(-1)).toMatchObject({ triggerReason: "incremental_base_mismatch", completeness: { status: "partial" } });
    expect(stored[key]).toMatchObject({ completeness: "partial", messageCount: 2 });
    expect(writeScroll).not.toHaveBeenCalled();
  });

  it("keeps a manual request pending through generation and stops it on user input", async () => {
    document.body.insertAdjacentHTML("beforeend", '<button data-testid="stop-button">Stop</button>');
    start();
    await runtimeListener({ type: "manualCapture" });
    await tick(500);
    expect(writeScroll).not.toHaveBeenCalled();
    document.querySelector("button")!.remove();
    await tick(3_000);
    expect(writeScroll).toHaveBeenCalledWith(0);
    document.querySelector("main")!.scrollTop = 455;
    const count = writeScroll.mock.calls.length;
    window.dispatchEvent(new Event("wheel"));
    await tick(20_000);
    expect(writeScroll).toHaveBeenCalledTimes(count);
    expect(document.querySelector("main")!.scrollTop).toBe(455);
    expect(payloads.every((payload) => payload.triggerReason !== "manual_retry")).toBe(true);
  });
});
