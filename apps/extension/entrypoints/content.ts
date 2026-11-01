import { defineContentScript } from "wxt/utils/define-content-script";
import { adapterForLocation } from "../lib/adapters/runtime";
import { decideCaptureAction } from "../lib/capture-decision";
import { fullCaptureResult, type CaptureReceipt } from "../lib/capture-result";
import { createNativeConversationReader, type NativeConversation } from "../lib/native-conversation";
import type { CaptureUiState, ExtensionMessage, ExtensionSettings } from "../lib/messages";
import type { BatchCaptureResult } from "../lib/batch-capture";
import { batchDiagnosticIssue, readBatchPageIssue, type BatchPageIssue } from "../lib/batch-page-state";
import {
  lightweightConversationFingerprint,
  messageTextFingerprint,
  scanAppendedMessages,
  scanConversation,
  interruptedConversationSnapshot,
  mergeVisible,
  CaptureInterruptedError,
  type ConversationScanOptions,
  type LightweightConversationFingerprint,
} from "../lib/scanner";
import type {
  CaptureDeltaV1,
  CapturePayloadV1,
  CaptureTriggerReason,
} from "@ai-archive/contracts";

const matches = [
  "https://chatgpt.com/*",
  "https://chat.openai.com/*",
  "https://gemini.google.com/*",
  "https://grok.com/*",
  "https://www.doubao.com/*",
  "https://doubao.com/*",
  "https://yuanbao.tencent.com/*",
  "https://agent.minimax.io/*",
  "https://agent.minimaxi.com/*",
  "https://chat.deepseek.com/*",
  "https://qianwen.com/*",
  "https://www.qianwen.com/*",
  "https://www.kimi.com/*",
  "https://kimi.com/*",
];

const statusLabels: Record<CaptureUiState["status"], string> = {
  idle: "待机",
  checking: "检查变化",
  waiting: "等待生成",
  skipped: "内容未变化",
  scanning: "正在采集",
  queued: "等待上传",
  syncing: "正在同步",
  complete: "已归档",
  partial: "部分归档",
  failed: "采集失败",
};

const providerLabels: Record<string, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  grok: "Grok",
  doubao: "豆包",
  yuanbao: "腾讯元宝",
  minimax_agent: "MiniMax Agent",
  deepseek: "DeepSeek",
  qianwen: "千问",
  kimi: "Kimi",
};

const EFFECTIVE_CHANGE_DEBOUNCE_MS = 4_000;
const STREAMING_RECHECK_MS = 2_000;
const SESSION_POLL_MS = 3_000;

interface LocalConversationState extends LightweightConversationFingerprint {
  branchFingerprint: string;
  revisionId?: string;
  lastSnapshotHash?: string;
  lastSuccessfulCaptureAt?: string;
  lastFullScanAt?: string;
  lastChangeDetectedAt?: string;
  completeness?: "complete" | "partial";
  baselineContentHash?: string;
  lastObservedSignature?: string;
}

interface FloatingIndicator {
  update(state: CaptureUiState): void;
  setPaused(value: boolean): void;
  destroy(): void;
}

function stateStorageKey(provider: string, sessionId: string): string {
  return `captureState:${provider}:${sessionId}`;
}

function lightSignature(fingerprint: LightweightConversationFingerprint): string {
  return [
    fingerprint.provider,
    fingerprint.sessionId,
    fingerprint.messageCount,
    fingerprint.lastMessageId ?? "",
    fingerprint.lastMessageRole ?? "",
    fingerprint.lastMessageTextHash ?? "",
    fingerprint.streaming ? "streaming" : "stable",
    fingerprint.virtualized ? "virtualized" : "static",
    fingerprint.adapterVersion,
  ].join("|");
}

function isDeltaPayload(payload: CapturePayloadV1): payload is CaptureDeltaV1 {
  return payload.captureMode === "append" && "appendedMessages" in payload;
}

async function loadConversationState(
  provider: string,
  sessionId: string,
): Promise<LocalConversationState | null> {
  const result = await browser.storage.local.get(stateStorageKey(provider, sessionId));
  return (result[stateStorageKey(provider, sessionId)] as LocalConversationState | undefined) ?? null;
}

async function saveConversationState(state: LocalConversationState): Promise<void> {
  await browser.storage.local.set({
    [stateStorageKey(state.provider, state.sessionId)]: state,
  });
}

function createFloatingIndicator(actions: {
  onRetry: () => void;
  onPause: () => Promise<void>;
}): FloatingIndicator {
  document.getElementById("ai-archive-floating-indicator")?.remove();
  const host = document.createElement("div");
  host.id = "ai-archive-floating-indicator";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .shell { position: fixed; right: 0; top: 92px; z-index: 2147483647; width: 52px;
        font-family: Inter, "SF Pro Display", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
        color: #17343b; pointer-events: none; }
      .toggle, .panel { pointer-events: auto; }
      .toggle { width: 46px; height: 48px; border: 1px solid rgba(31,113,106,.14); border-right: 0;
        border-radius: 15px 0 0 15px; background: rgba(250,255,254,.96); color: #0a806e;
        box-shadow: 0 9px 26px rgba(20,83,76,.18); cursor: pointer; display: grid; place-items: center;
        position: relative; font-weight: 900; transform: translateX(7px); transition: transform .16s ease; }
      .toggle:hover, .toggle:focus-visible { transform: translateX(0); }
      .dot { position: absolute; right: -2px; top: -2px; width: 11px; height: 11px; border-radius: 50%;
        background: #81928e; border: 2px solid #f8fffd; }
      .dot.checking, .dot.waiting, .dot.scanning, .dot.syncing, .dot.queued { background: #4c79b8; }
      .dot.complete { background: #28a17e; }
      .dot.partial, .dot.skipped { background: #d48b17; }
      .dot.failed { background: #be4646; }
      .panel { position: absolute; right: 54px; top: 0; width: 282px; padding: 14px;
        border: 1px solid rgba(34,105,100,.13); border-radius: 8px; background: rgba(250,255,254,.96);
        box-shadow: 0 18px 48px rgba(20,69,65,.2); backdrop-filter: blur(18px); }
      .panel[hidden] { display: none; }
      .title { display:flex; align-items:center; justify-content:space-between; gap: 8px; font-size: 12px; font-weight: 820; }
      .provider { max-width: 184px; padding: 3px 7px; border-radius: 6px; background: rgba(222,246,240,.82);
        color:#177564; font-size:10px; font-weight:700; overflow-wrap:anywhere; line-height:1.25; }
      .status { display:flex; align-items:center; gap:7px; margin-top:12px; font-size:12px; font-weight:780; }
      .message { margin:8px 0 12px; color:#60787d; font-size:11px; line-height:1.5; overflow-wrap:anywhere; }
      .meta { display:grid; grid-template-columns: 74px 1fr; gap: 5px 8px; margin: 0 0 12px; font-size:10.5px; color:#60787d; }
      .meta span:nth-child(2n) { color:#17343b; overflow-wrap:anywhere; }
      .actions { display:flex; gap:7px; }
      button.action { border:0; border-radius:7px; padding:7px 10px; background:#0a8f7c; color:#fff;
        font-family:inherit; font-size:10.5px; font-weight:750; cursor:pointer; }
      button.action.secondary { background:#e6f4f1; color:#147461; }
      button.action:disabled { opacity:.45; cursor:not-allowed; }
      @media (max-width: 520px) { .shell { top: 74px; } .panel { right: 50px; width: min(282px, calc(100vw - 64px)); } }
    </style>
    <div class="shell">
      <section class="panel" role="status" hidden>
        <div class="title"><span>知言归藏</span><span class="provider"></span></div>
        <div class="status"><span class="status-text">待机</span></div>
        <div class="message">打开会话后自动检查变化。</div>
        <div class="meta">
          <span>采集触发</span><span class="reason">-</span>
          <span class="incomplete-label" hidden>未完整原因</span><span class="incomplete-reason" hidden></span>
          <span>模式</span><span class="mode">-</span>
          <span>消息数</span><span class="count">-</span>
          <span>上次同步</span><span class="last">-</span>
        </div>
        <div class="actions"><button class="action retry" type="button" title="补全历史消息，会滚动页面">完整采集（会滚动）</button><button class="action secondary pause" type="button">暂停本站</button></div>
      </section>
      <button class="toggle" type="button" aria-label="查看知言归藏采集状态" aria-expanded="false"><span>知</span><span class="dot"></span></button>
    </div>`;

  const panel = shadow.querySelector<HTMLElement>(".panel")!;
  const toggle = shadow.querySelector<HTMLButtonElement>(".toggle")!;
  const dot = shadow.querySelector<HTMLElement>(".dot")!;
  const statusText = shadow.querySelector<HTMLElement>(".status-text")!;
  const provider = shadow.querySelector<HTMLElement>(".provider")!;
  const message = shadow.querySelector<HTMLElement>(".message")!;
  const reason = shadow.querySelector<HTMLElement>(".reason")!;
  const incompleteLabel = shadow.querySelector<HTMLElement>(".incomplete-label")!;
  const incompleteReason = shadow.querySelector<HTMLElement>(".incomplete-reason")!;
  const mode = shadow.querySelector<HTMLElement>(".mode")!;
  const count = shadow.querySelector<HTMLElement>(".count")!;
  const last = shadow.querySelector<HTMLElement>(".last")!;
  const retry = shadow.querySelector<HTMLButtonElement>(".retry")!;
  const pause = shadow.querySelector<HTMLButtonElement>(".pause")!;
  let lastState: CaptureUiState = {
    status: "idle",
    message: "打开会话后自动检查变化。",
    updatedAt: new Date().toISOString(),
  };
  let paused = false;

  function render(): void {
    const stateClass = lastState.status;
    toggle.className = `toggle ${stateClass}${paused ? " paused" : ""}`;
    dot.className = `dot ${stateClass}`;
    statusText.textContent = paused ? "本站已暂停" : statusLabels[lastState.status];
    provider.textContent = lastState.provider
      ? `${providerLabels[lastState.provider] ?? lastState.provider}${lastState.sessionId ? ` · ${lastState.sessionId}` : ""}`
      : "自动采集";
    message.textContent = paused
      ? "恢复本站后继续自动检查会话变化。"
      : (lastState.message ?? "打开会话后自动检查变化。").slice(0, 180);
    reason.textContent = lastState.triggerReason ?? "-";
    incompleteLabel.hidden = incompleteReason.hidden = lastState.status !== "partial";
    incompleteReason.textContent = lastState.incompleteReason || "此次采集未记录具体原因，请重新完整采集以获取诊断。";
    mode.textContent =
      lastState.captureMode === "append"
        ? "增量"
        : lastState.captureMode === "full"
          ? "快照"
          : "-";
    count.textContent = typeof lastState.messageCount === "number" ? String(lastState.messageCount) : "-";
    last.textContent = lastState.updatedAt ? new Date(lastState.updatedAt).toLocaleString() : "-";
    pause.textContent = paused ? "恢复本站" : "暂停本站";
    retry.disabled = paused;
    toggle.title = paused ? "本站已暂停" : `知言归藏：${statusLabels[lastState.status]}`;
  }

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    toggle.setAttribute("aria-expanded", String(!panel.hidden));
  });
  retry.addEventListener("click", () => {
    actions.onRetry();
  });
  pause.addEventListener("click", () => void actions.onPause());
  document.documentElement.append(host);
  render();

  return {
    update(state) {
      lastState = state;
      render();
    },
    setPaused(value) {
      paused = value;
      render();
    },
    destroy() {
      host.remove();
    },
  };
}

export default defineContentScript({
  matches,
  runAt: "document_idle",
  main(ctx) {
    let scanning = false;
    // `evaluate` performs several asynchronous storage/DOM checks before it
    // reaches the actual scan. MutationObserver callbacks can arrive during
    // those awaits, so `scanning` alone is too late to prevent re-entry.
    let evaluationInFlight = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let scheduledDueAt = 0;
    let lastUrl = location.href;
    let lastSessionKey = "";
    let indicator: FloatingIndicator | undefined;
    let lastPublishedState: CaptureUiState | undefined;
    let observer: MutationObserver | undefined;
    let observedRoot: HTMLElement | null = null;
    let previousStreaming = false;
    let pendingReason: CaptureTriggerReason | null = null;
    let pendingDelay: number | undefined;
    let pendingForceFull = false;
    let suppressObserverMutations = false;
    let invalidated = false;
    const nativeReader = createNativeConversationReader();
    let nativeRead: Promise<NativeConversation | null> | undefined;
    let batchPage = /^#ai-archive-batch=[0-9a-f-]{36}$/i.test(location.hash);
    let batchOperation: { operationId: string; itemId: string; running: boolean; result?: BatchCaptureResult } | undefined;
    let batchAttention: BatchPageIssue | undefined;
    const batchOwner = batchPage ? location.hash.slice("#ai-archive-batch=".length) : undefined;
    const originalBatchUrl = batchPage ? new URL(location.href) : undefined;
    function ownsOriginalBatchDocument(operationId = batchOwner) {
      if (!originalBatchUrl || !operationId || operationId !== batchOwner) return false;
      const current = new URL(location.href);
      return current.origin === originalBatchUrl.origin && current.pathname === originalBatchUrl.pathname &&
        current.search === originalBatchUrl.search &&
        (current.hash === "" || current.hash === `#ai-archive-batch=${operationId}`);
    }
    let batchPageIssue: BatchPageIssue | undefined;
    function currentBatchIssue() {
      const issue = readBatchPageIssue(document);
      if (issue && (issue.outcome === "attention" || !batchPageIssue)) batchPageIssue = issue;
      if (!issue && batchPageIssue && !batchOperation?.running && ownsOriginalBatchDocument()) {
        const adapter = adapterForLocation();
        const mountedSession = adapter?.getConversationRoot()?.getAttribute("data-conversation-id");
        if (adapter?.definition.provider === "chatgpt" &&
            (!mountedSession || mountedSession === adapter.getSessionId()) &&
            adapter.extractVisibleMessages().length > 0) {
          // Clear only page-local stale evidence. A completed operation result,
          // server pause and the durable safety cooldown remain unchanged.
          batchPageIssue = undefined;
        }
      }
      if (batchPageIssue?.outcome === "attention" && batchOperation?.running) {
        batchAttention = batchPageIssue;
        captureController?.abort();
        scrollController?.abort();
      }
      return batchPageIssue;
    }
    const batchIssueObserver = batchPage ? new MutationObserver(() => { currentBatchIssue(); }) : undefined;
    batchIssueObserver?.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    let captureController: AbortController | undefined;
    let scrollController: AbortController | undefined;
    let manualCaptureActive = false;

    function contextWasInvalidated(error: unknown): boolean {
      return /extension context invalidated/i.test(error instanceof Error ? error.message : String(error));
    }

    function contextActive(): boolean {
      if (invalidated) return false;
      try {
        if (ctx.isInvalid) {
          stop();
          return false;
        }
      } catch (error) {
        if (!contextWasInvalidated(error)) throw error;
        stop();
        return false;
      }
      return true;
    }

    function runDetached(task: () => Promise<unknown>): void {
      void Promise.resolve().then(() => contextActive() ? task() : undefined).catch((error) => {
        if (contextWasInvalidated(error)) stop();
        else if (!invalidated) console.error("知言归藏后台任务失败", error);
      });
    }

    const reasonPriority: Record<CaptureTriggerReason, number> = {
      manual_retry: 100,
      new_session: 95,
      branch_changed: 94,
      adapter_upgraded: 93,
      incremental_base_mismatch: 99,
      stream_finished: 80,
      new_messages: 70,
      historical_import: 60,
      local_file_rewritten: 60,
      local_file_appended: 60,
    };

    function mergeReason(
      left: CaptureTriggerReason | null,
      right: CaptureTriggerReason,
    ): CaptureTriggerReason {
      if (!left || reasonPriority[right] >= reasonPriority[left]) return right;
      return left;
    }

    function queuePending(
      reason: CaptureTriggerReason,
      delay: number,
      forceFull: boolean,
    ): void {
      pendingReason = mergeReason(pendingReason, reason);
      pendingDelay = pendingDelay === undefined
        ? delay
        : Math.min(pendingDelay, delay);
      pendingForceFull ||= forceFull;
    }

    function consumePending(): {
      reason: CaptureTriggerReason | null;
      delay: number;
      forceFull: boolean;
    } {
      const next = {
        reason: pendingReason,
        delay: pendingDelay ?? EFFECTIVE_CHANGE_DEBOUNCE_MS,
        forceFull: pendingForceFull,
      };
      pendingReason = null;
      pendingDelay = undefined;
      pendingForceFull = false;
      return next;
    }

    async function isPaused(): Promise<boolean> {
      const settings = (await browser.storage.local.get("pausedHosts")) as ExtensionSettings;
      return Boolean(settings.pausedHosts?.[location.hostname]);
    }

    async function togglePaused(): Promise<void> {
      const settings = (await browser.storage.local.get("pausedHosts")) as ExtensionSettings;
      const pausedHosts = { ...(settings.pausedHosts ?? {}) };
      pausedHosts[location.hostname] = !pausedHosts[location.hostname];
      if (pausedHosts[location.hostname]) captureController?.abort();
      await browser.storage.local.set({ pausedHosts });
      indicator?.setPaused(Boolean(pausedHosts[location.hostname]));
    }

    async function shouldShowFloatingIndicator(): Promise<boolean> {
      const settings = (await browser.storage.local.get(
        "showFloatingIndicator",
      )) as ExtensionSettings;
      return settings.showFloatingIndicator !== false;
    }

    async function refreshFloatingIndicator(): Promise<void> {
      if (invalidated) return;
      const show = await shouldShowFloatingIndicator();
      if (invalidated) return;
      if (show) {
        if (!indicator) {
          indicator = createFloatingIndicator({
            onRetry: () => schedule("manual_retry", 0, { forceFull: true }),
            onPause: async () => { runDetached(togglePaused); },
          });
        }
        if (lastPublishedState) indicator.update(lastPublishedState);
        const paused = await isPaused();
        if (!invalidated) indicator?.setPaused(paused);
        return;
      }
      indicator?.destroy();
      indicator = undefined;
    }

    function recordUserActivity(): void {
      if (manualCaptureActive) scrollController?.abort();
    }

    async function publishState(state: Omit<CaptureUiState, "updatedAt">): Promise<void> {
      if (invalidated) return;
      const fields = ["status", "provider", "sessionId", "triggerReason", "captureMode", "messageCount", "outboxCount", "message"] as const;
      if (lastPublishedState && fields.every((field) => lastPublishedState?.[field] === state[field])) return;
      const fullState = { ...state, updatedAt: new Date().toISOString() };
      lastPublishedState = fullState;
      if (state.triggerReason === "manual_retry" && ["complete", "partial", "failed", "queued"].includes(state.status)) {
        await browser.storage.local.set({ lastManualCapture: fullState });
      }
      indicator?.update(fullState);
      const message: ExtensionMessage = { type: "captureState", state: fullState };
      try {
        await browser.runtime.sendMessage(message);
      } catch (error) {
        if (contextWasInvalidated(error)) stop();
      }
    }

    function detachObserver(): void {
      observer?.disconnect();
      observer = undefined;
      observedRoot = null;
    }

    function attachObserver(): void {
      if (suppressObserverMutations || invalidated) return;
      const adapter = adapterForLocation();
      const root = adapter?.getConversationRoot() ?? document.body;
      if (root === observedRoot && observer) return;
      detachObserver();
      observedRoot = root;
      const nextObserver = new MutationObserver((mutations) => {
        // Full capture scrolls through virtualized lists. Those DOM changes
        // are implementation details of this scan, not new user messages.
        if (
          suppressObserverMutations ||
          invalidated ||
          observer !== nextObserver
        ) return;
        const meaningful = mutations.some((mutation) => {
          const target =
            mutation.target instanceof HTMLElement
              ? mutation.target
              : mutation.target.parentElement;
          if (!target) return false;
          if (target.closest("#ai-archive-floating-indicator")) return false;
          if (target.closest("input, textarea, [contenteditable='true'], [role='textbox']")) return false;
          if (!observedRoot?.contains(target)) return false;
          return true;
        });
        if (meaningful) schedule("new_messages");
      });
      observer = nextObserver;
      nextObserver.observe(root, { childList: true, subtree: true, characterData: true });
    }

    const activityListener = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("#ai-archive-floating-indicator")) return;
      // ChatGPT restores composer focus while mounting history. Focus alone
      // does not mean the user has taken control of a manual scan.
      if (event.type === "focusin") return;
      if (event instanceof KeyboardEvent && (
        ["Shift", "Control", "Alt", "Meta", "CapsLock", "NumLock", "ScrollLock", "PrintScreen"].includes(event.key) ||
        event.metaKey || (event.ctrlKey && ["c", "C"].includes(event.key))
      )) return;
      // History mounting can dispatch synthetic input events. They do not
      // indicate that the person has taken over the page.
      if (event.type === "input" && !event.isTrusted) return;
      recordUserActivity();
    };
    const activityEvents: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "wheel",
      "touchstart",
      "focusin",
      "input",
    ];
    for (const eventName of activityEvents) {
      window.addEventListener(eventName, activityListener, { capture: true });
    }

    function schedule(
      reason: CaptureTriggerReason,
      delay = EFFECTIVE_CHANGE_DEBOUNCE_MS,
      options: { forceFull?: boolean } = {},
    ): void {
      if (invalidated || batchPage) return;
      queuePending(reason, delay, Boolean(options.forceFull));
      // Do not start another timer while an asynchronous evaluation/scan is
      // active. Its finally block will schedule the coalesced pending reason.
      if (evaluationInFlight) return;

      const dueAt = Date.now() + Math.max(0, delay);
      // Keep a trailing debounce, but never keep extending it indefinitely
      // while a provider continuously remounts a virtualized message list.
      if (debounceTimer && dueAt >= scheduledDueAt) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      scheduledDueAt = dueAt;
      debounceTimer = setTimeout(() => {
        if (!contextActive()) return;
        debounceTimer = undefined;
        scheduledDueAt = 0;
        const next = consumePending();
        if (!next.reason) return;
        if (evaluationInFlight) {
          queuePending(next.reason, next.delay, next.forceFull);
          return;
        }
        void evaluate(next.reason, { forceFull: next.forceFull });
      }, Math.max(0, dueAt - Date.now()));
    }

    function publishSkipped(light: LightweightConversationFingerprint): void {
      // Routine checks should not flash "unchanged", reset a successful save
      // indicator or write Chrome storage on every unrelated DOM mutation.
      if (
        lastPublishedState?.provider === light.provider &&
        lastPublishedState.sessionId === light.sessionId &&
        ["idle", "complete", "partial", "queued", "failed"].includes(lastPublishedState.status)
      ) return;
      void publishState({
        status: "idle",
        provider: light.provider,
        sessionId: light.sessionId,
        triggerReason: "new_messages",
        messageCount: light.messageCount,
        message: "自动保存已开启，页面位置保持不变。",
      });
    }

    async function enqueuePayload(payload: CapturePayloadV1) {
      const message: ExtensionMessage = { type: "enqueueCapture", payload,
        ...(batchOperation?.running ? { batch: { operationId: batchOperation.operationId, itemId: batchOperation.itemId } } : {}) };
      return browser.runtime.sendMessage(message) as Promise<
        | {
            sent?: number;
            captureId?: string;
            remaining?: number;
            requiresFullCapture?: boolean;
            lastResult?: CaptureReceipt;
          }
        | undefined
      >;
    }

    async function updateStateFromPayload(
      payload: CapturePayloadV1,
      light: LightweightConversationFingerprint,
      result?: CaptureReceipt,
    ): Promise<void> {
      const payloadMessageCount = isDeltaPayload(payload)
        ? payload.baseMessageCount + payload.appendedMessages.length
        : payload.messages.length;
      const completeness =
        result?.completeness ??
        (isDeltaPayload(payload) ? "complete" : payload.completeness.status);
      const lastMessage =
        isDeltaPayload(payload)
          ? payload.appendedMessages.at(-1)
          : payload.messages.at(-1);
      const observedSignature = lightSignature(light);
      if (completeness === "partial") {
        const previous = await loadConversationState(payload.provider, payload.sessionId);
        if (previous?.completeness === "complete" && previous.baselineContentHash && payload.triggerReason !== "incremental_base_mismatch") {
          // A viewport-only save is useful evidence, but must not replace the
          // trusted archive baseline used to append the next complete answer.
          await saveConversationState({ ...previous, lastObservedSignature: observedSignature });
          return;
        }
      }
      await saveConversationState({
        provider: payload.provider,
        sessionId: payload.sessionId,
        branchFingerprint: payload.branchFingerprint,
        adapterVersion: payload.adapterVersion,
        // The lightweight pass only sees the currently mounted viewport. Use
        // the payload count as the local baseline, otherwise a virtualized
        // ChatGPT window looks like a shortened branch on the next check.
        messageCount: result?.messageCount ?? payloadMessageCount,
        ...(result?.revisionId ? { revisionId: result.revisionId } : {}),
        ...(result?.completeness === "complete" && result.baselineContentHash &&
            (isDeltaPayload(payload) || payload.completeness.status === "complete") &&
            (result.messageCount ?? payloadMessageCount) === payloadMessageCount
          ? { baselineContentHash: result.baselineContentHash } : {}),
        ...(lastMessage?.externalMessageId ? { lastMessageId: lastMessage.externalMessageId } : {}),
        ...(lastMessage ? { lastMessageRole: lastMessage.role } : {}),
        ...(lastMessage ? { lastMessageTextHash: await messageTextFingerprint(lastMessage) } : {}),
        streaming: false,
        ...(light.virtualized !== undefined ? { virtualized: light.virtualized } : {}),
        lastSuccessfulCaptureAt: new Date().toISOString(),
        ...(!isDeltaPayload(payload) && payload.captureMode === "full"
          ? { lastFullScanAt: new Date().toISOString() }
          : {}),
        lastChangeDetectedAt: new Date().toISOString(),
        completeness,
        lastObservedSignature: observedSignature,
      });
    }

    async function withObserverSuppressed<T>(operation: () => Promise<T>): Promise<T> {
      const wasSuppressed = suppressObserverMutations;
      suppressObserverMutations = true;
      detachObserver();
      try {
        return await operation();
      } finally {
        suppressObserverMutations = wasSuppressed;
        if (!suppressObserverMutations && !invalidated) attachObserver();
      }
    }

    async function runFullCapture(
      adapter: NonNullable<ReturnType<typeof adapterForLocation>>,
      light: LightweightConversationFingerprint,
      reason: CaptureTriggerReason,
    ) {
      await publishState({
        status: "scanning",
        provider: light.provider,
        sessionId: light.sessionId,
        triggerReason: reason,
        captureMode: "full",
        messageCount: light.messageCount,
        message: reason === "manual_retry"
          ? "正在补全历史消息；操作页面会停止自动滚动，已加载消息仍会保存"
          : "正在归档已加载消息，保持页面位置不变",
      });
      const initialMessages = adapter.extractVisibleMessages();
      let interrupted = false;
      let snapshot;
      try {
        const options = scanOptions(adapter, reason);
        const reportProgress = options.onProgress;
        options.onProgress = async (progress) => {
          // Preserve the history already read if scrolling is interrupted.
          // The interrupted result remains partial, regardless of ordering.
          mergeVisible(initialMessages, adapter.extractVisibleMessages());
          await reportProgress?.(progress);
        };
        snapshot = await scanConversation(adapter, options);
      } catch (error) {
        if (!(error instanceof CaptureInterruptedError) || reason !== "manual_retry" ||
            invalidated || captureController?.signal.aborted || adapter.getSessionId() !== light.sessionId) throw error;
        interrupted = true;
        snapshot = await interruptedConversationSnapshot(adapter, light.sessionId, initialMessages);
      }
      if ((!interrupted && captureController?.signal.aborted) || adapter.getSessionId() !== light.sessionId) {
        throw new CaptureInterruptedError();
      }
      const result = await enqueuePayload(snapshot);
      await updateStateFromPayload(snapshot, light, result?.lastResult);
      await publishState({
        ...fullCaptureResult(snapshot, result?.lastResult),
        provider: snapshot.provider,
        sessionId: snapshot.sessionId,
        triggerReason: reason,
        captureMode: "full",
      });
      return result?.captureId;
    }

    function scanOptions(
      adapter: NonNullable<ReturnType<typeof adapterForLocation>>,
      reason: CaptureTriggerReason,
    ): ConversationScanOptions {
      return {
        triggerReason: reason,
        ...(captureController ? { signal: captureController.signal } : {}),
        onProgress: async (progress) => {
          await publishState({ status: "scanning", provider: adapter.definition.provider,
            sessionId: adapter.getSessionId() ?? "", triggerReason: reason,
            captureMode: "full", ...progress });
        },
        ...(scrollController ? { scrollSignal: scrollController.signal } : {}),
        readNative: (visible) => nativeRead ??= nativeReader(
          adapter.definition.provider,
          adapter.getSessionId() ?? "",
          visible.flatMap((message) => message.externalMessageId ? [message.externalMessageId] : []),
          captureController?.signal,
          {
            manualRetry: reason === "manual_retry",
            onDiagnostic: (diagnostic) => {
              if (batchOperation?.running) {
                const page = currentBatchIssue();
                const request = batchDiagnosticIssue(diagnostic);
                batchAttention = page?.outcome === "attention" ? page
                  : request?.outcome === "attention" ? request : page ?? request ?? batchAttention;
                if (batchAttention?.outcome === "attention") {
                  captureController?.abort();
                  scrollController?.abort();
                }
              }
              // Bounded reason codes only: no login token, message text, or raw response.
              runDetached(() => browser.storage.local.set({ nativeReadDiagnostic: {
                ...diagnostic, updatedAt: new Date().toISOString(),
              } }));
            },
          },
        ).then(value => { if (batchAttention) throw new Error(batchAttention.message); return value; }),
      };
    }

    async function runAppendCapture(
      adapter: NonNullable<ReturnType<typeof adapterForLocation>>,
      state: LocalConversationState,
      light: LightweightConversationFingerprint,
      reason: CaptureTriggerReason,
    ): Promise<boolean> {
      if (state.completeness !== "complete" || !state.baselineContentHash) return false;
      await publishState({
        status: "checking",
        provider: light.provider,
        sessionId: light.sessionId,
        triggerReason: reason,
        captureMode: "append",
        messageCount: light.messageCount,
        message: "检测到新消息，准备增量同步",
      });
      const delta = await scanAppendedMessages(adapter, {
        revisionId: state.revisionId,
        baselineContentHash: state.baselineContentHash,
        messageCount: state.messageCount,
        branchFingerprint: state.branchFingerprint,
        lastMessageId: state.lastMessageId,
        lastMessageTextHash: state.lastMessageTextHash,
      }, scanOptions(adapter, reason));
      if (!delta) return false;
      await publishState({
        status: "scanning",
        provider: light.provider,
        sessionId: light.sessionId,
        triggerReason: reason,
        captureMode: "append",
        messageCount: delta.baseMessageCount + delta.appendedMessages.length,
        message: `正在增量同步 ${delta.appendedMessages.length} 条新增消息`,
      });
      if (captureController?.signal.aborted || adapter.getSessionId() !== light.sessionId) {
        throw new CaptureInterruptedError();
      }
      const result = await enqueuePayload(delta);
      if (result?.requiresFullCapture) {
        schedule("incremental_base_mismatch", 200, { forceFull: true });
        return true;
      }
      await updateStateFromPayload(delta, light, result?.lastResult);
      await publishState({
        ...fullCaptureResult(delta, result?.lastResult),
        provider: delta.provider,
        sessionId: delta.sessionId,
        triggerReason: reason,
        captureMode: "append",
      });
      return true;
    }

    async function evaluate(
      reason: CaptureTriggerReason,
      options: { forceFull?: boolean } = {},
    ): Promise<void> {
      if (evaluationInFlight) {
        queuePending(reason, 0, Boolean(options.forceFull));
        return;
      }

      // Set the lock before the first await. Storage reads and fingerprint
      // hashing can yield to several MutationObserver callbacks.
      evaluationInFlight = true;
      scanning = true;
      captureController = new AbortController();
      scrollController = new AbortController();
      manualCaptureActive = reason === "manual_retry";
      nativeRead = undefined;
      let activeLight: LightweightConversationFingerprint | null = null;
      let preserveStreaming = false;
      let discardPending = false;

      try {
        if (await isPaused()) {
          discardPending = true;
          if (reason === "manual_retry") {
            await publishState({ status: "idle", triggerReason: reason, message: "本站已暂停，请先点击“恢复本站”再采集。" });
          }
          return;
        }
        const adapter = adapterForLocation();
        if (!adapter) {
          discardPending = true;
          if (reason === "manual_retry") {
            await publishState({ status: "failed", triggerReason: reason, message: "当前页面不在支持的 AI 网站中。" });
          }
          return;
        }
        if (reason === "manual_retry") {
          await publishState({ status: "checking", provider: adapter.definition.provider, triggerReason: reason, message: "正在检查当前对话…" });
        }
        attachObserver();
        const light = await lightweightConversationFingerprint(adapter);
        if (!light || light.messageCount === 0) {
          discardPending = true;
          if (reason === "manual_retry") {
            await publishState({
              status: "failed", provider: adapter.definition.provider, triggerReason: reason,
              message: adapter.getSessionId()
                ? "没有识别到对话消息，请等待消息加载后重试；若页面已有消息，请反馈此提示。"
                : "没有识别到会话编号，请先打开一条已有的对话再采集。",
            });
          }
          return;
        }
        activeLight = light;
        const signature = lightSignature(light);
        const state = await loadConversationState(light.provider, light.sessionId);
        previousStreaming = previousStreaming || Boolean(state?.streaming);

      if (light.streaming && reason !== "manual_retry") {
        previousStreaming = true;
        preserveStreaming = true;
        await publishState({
          status: "waiting",
          provider: light.provider,
          sessionId: light.sessionId,
          triggerReason: reason,
          messageCount: light.messageCount,
          message: "等待 AI 生成完成",
        });
        schedule("stream_finished", STREAMING_RECHECK_MS, options);
        return;
      }

      if (!options.forceFull && state?.lastObservedSignature === signature) {
        publishSkipped(light);
        return;
      }

      const decision = decideCaptureAction({
        light,
        state,
        requestedReason: reason,
        forceFullReason: options.forceFull ? reason : null,
        previousStreaming,
      });

      if (decision.action === "skip") {
        publishSkipped(light);
        return;
      }

      if (decision.action === "full") {
        await withObserverSuppressed(async () => {
          await runFullCapture(adapter, light, decision.triggerReason);
          // One delayed lightweight check catches a message that finished
          // mounting while the full scan was running, without immediately
          // launching another full DOM walk.
          schedule("new_messages", 1_000);
        });
        return;
      }
      if (decision.action === "append" && state) {
        await withObserverSuppressed(async () => {
          const appendOk = await runAppendCapture(
            adapter,
            state,
            light,
            decision.triggerReason,
          );
          if (!appendOk) {
            // A virtualized page can unmount the archived tail. Preserve the
            // loaded messages in a passive snapshot; only manual capture may
            // scroll to fill any missing history.
            await runFullCapture(adapter, light, "branch_changed");
          }
          schedule("new_messages", 1_000);
        });
        return;
      }
      publishSkipped(light);
      } catch (error) {
        if (contextWasInvalidated(error)) stop();
        if (invalidated) return;
        await publishState({
          status: error instanceof CaptureInterruptedError ? "idle" : "failed",
          ...(activeLight
            ? {
                provider: activeLight.provider,
                sessionId: activeLight.sessionId,
                messageCount: activeLight.messageCount,
              }
            : {}),
          triggerReason: reason,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        if (!preserveStreaming) previousStreaming = false;
        scanning = false;
        manualCaptureActive = false;
        captureController = undefined;
        scrollController = undefined;
        nativeRead = undefined;
        evaluationInFlight = false;
        if (discardPending) {
          consumePending();
        } else if (!invalidated) {
          const next = consumePending();
          if (next.reason) {
            schedule(next.reason, next.delay, { forceFull: next.forceFull });
          }
        }
      }
    }

    function currentSessionKey(): string {
      const adapter = adapterForLocation();
      const sessionId = adapter?.getSessionId();
      if (!adapter || !sessionId) return "";
      return [adapter.definition.provider, sessionId].join(":");
    }

    runDetached(refreshFloatingIndicator);
    attachObserver();
    lastSessionKey = currentSessionKey();
    schedule("new_session", 2_000);

    const routeTimer = setInterval(() => {
      if (!contextActive()) return;
      if (location.href !== lastUrl) {
        const retainedBatchDocument = ownsOriginalBatchDocument();
        if (!retainedBatchDocument) captureController?.abort();
        batchPage = retainedBatchDocument;
        lastUrl = location.href;
        lastSessionKey = currentSessionKey();
        attachObserver();
        schedule("new_session", 3_000);
      }
    }, SESSION_POLL_MS);

    const sessionTimer = setInterval(() => {
      if (!contextActive()) return;
      const sessionKey = currentSessionKey();
      if (!sessionKey) {
        lastSessionKey = "";
        return;
      }
      if (sessionKey !== lastSessionKey) {
        captureController?.abort();
        lastSessionKey = sessionKey;
        schedule("new_session", 3_000);
      }
    }, SESSION_POLL_MS);

    const storageListener = (
      changes: Record<string, unknown>,
      areaName: string,
    ) => {
      if (
        areaName === "local" &&
        ("showFloatingIndicator" in changes || "pausedHosts" in changes)
      ) {
        runDetached(refreshFloatingIndicator);
        if ("pausedHosts" in changes) {
          runDetached(async () => { if (await isPaused()) captureController?.abort(); });
        }
      }
    };
    const messageListener = (raw: unknown) => {
      if (!contextActive()) return undefined;
      const message = raw as ExtensionMessage;
      if (message.type === "getBatchCaptureState") {
        return Promise.resolve({ ...(batchOperation?.operationId === message.operationId ? batchOperation : { running: false }),
          batchOwner, pageIssue: currentBatchIssue() });
      }
      if (message.type === "cancelBatchCapture") {
        if (batchOperation?.operationId === message.operationId) captureController?.abort();
        return Promise.resolve({ ok: true });
      }
      if (message.type === "startBatchCapture") {
        if (!ownsOriginalBatchDocument(message.operationId)) return Promise.resolve({ error: "不是专用补采标签页" });
        if (batchOperation?.operationId === message.operationId) return Promise.resolve({ ok: true });
        if (evaluationInFlight) return Promise.resolve({ busy: true });
        const adapter = adapterForLocation();
        if (!adapter || adapter.definition.provider !== "chatgpt" || adapter.getSessionId() !== message.sessionId) return Promise.resolve({ error: "当前会话与补采任务不匹配" });
        batchOperation = { operationId: message.operationId, itemId: message.itemId, running: true };
        evaluationInFlight = true;
        scanning = true;
        manualCaptureActive = true;
        captureController = new AbortController();
        scrollController = new AbortController();
        nativeRead = undefined;
        batchAttention = undefined;
        runDetached(async () => {
          try {
            if (await isPaused()) {
              batchAttention = { outcome: "attention", message: "本站采集已暂停，请恢复本站后继续补采队列" };
              throw new Error(batchAttention.message);
            }
            const light = await lightweightConversationFingerprint(adapter);
            if (!light?.messageCount) throw new Error("没有识别到会话内容，已跳过本条");
            const captureId = await withObserverSuppressed(() => runFullCapture(adapter, light, "manual_retry"));
            batchOperation!.result = captureId ? { captureId } : { outcome: "attention", message: "采集结果尚未加入上传队列，请重试" };
          } catch (error) {
            const pageIssue = currentBatchIssue();
            batchOperation!.result = (batchAttention?.outcome === "attention" ? batchAttention : pageIssue ?? batchAttention) ?? {
              outcome: "failed", message: (error instanceof Error ? error.message : "本条采集失败，继续下一条").slice(0,500) };
          } finally {
            batchOperation!.running = false;
            evaluationInFlight = false;
            scanning = false;
            manualCaptureActive = false;
            captureController = undefined;
            scrollController = undefined;
            nativeRead = undefined;
            const next = consumePending();
            if (!batchPage && next.reason && !invalidated) schedule(next.reason, next.delay, { forceFull: next.forceFull });
          }
        });
        return Promise.resolve({ ok: true });
      }
      if (message.type === "manualCapture") {
        schedule("manual_retry", 0, { forceFull: true });
        return Promise.resolve({ ok: true });
      }
      if (message.type === "forceFullCapture") {
        schedule("incremental_base_mismatch", 0, { forceFull: true });
        return Promise.resolve({ ok: true });
      }
      if (message.type === "getContentState") {
        const adapter = adapterForLocation();
        return Promise.resolve({
          supported: Boolean(adapter),
          adapterVersion: adapter?.definition.version,
          provider: adapter?.definition.provider,
          title: adapter?.getTitle(),
          sessionId: adapter?.getSessionId(),
          scanning,
          messageCount: adapter?.extractVisibleMessages().length ?? 0,
        });
      }
      return undefined;
    };

    function stop(): void {
      if (invalidated) return;
      invalidated = true;
      captureController?.abort();
      batchIssueObserver?.disconnect();
      detachObserver();
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, activityListener, { capture: true } as AddEventListenerOptions);
      }
      clearInterval(routeTimer);
      clearInterval(sessionTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      scheduledDueAt = 0;
      consumePending();
      try {
        browser.storage.onChanged.removeListener(storageListener);
        browser.runtime.onMessage.removeListener(messageListener);
      } catch (error) {
        if (!contextWasInvalidated(error)) console.error("知言归藏清理失败", error);
      }
      indicator?.destroy();
      indicator = undefined;
    }
    ctx.onInvalidated(stop);
    try {
      if (!contextActive()) return;
      browser.storage.onChanged.addListener(storageListener);
      browser.runtime.onMessage.addListener(messageListener);
    } catch (error) {
      stop();
      if (!contextWasInvalidated(error)) throw error;
    }
  },
});
