import { defineContentScript } from "wxt/utils/define-content-script";
import { adapterForLocation } from "../lib/adapters/runtime";
import {
  remainingIdleDelay,
  shouldDeferAutoCapture,
} from "../lib/auto-capture";
import { decideCaptureAction } from "../lib/capture-decision";
import type { CaptureUiState, ExtensionMessage, ExtensionSettings } from "../lib/messages";
import {
  lightweightConversationFingerprint,
  messageTextFingerprint,
  scanAppendedMessages,
  scanConversation,
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
  yuanbao: "腾讯元宝",
  minimax_agent: "MiniMax Agent",
  deepseek: "DeepSeek",
  qianwen: "千问",
  kimi: "Kimi",
};

const EFFECTIVE_CHANGE_DEBOUNCE_MS = 4_000;
const STREAMING_RECHECK_MS = 2_000;
const SESSION_POLL_MS = 3_000;
const SKIPPED_STATUS_MS = 1_400;
const AUTO_CAPTURE_DEFERRED_MESSAGE = "检测到你正在操作页面，自动采集已暂缓";

interface LocalConversationState extends LightweightConversationFingerprint {
  branchFingerprint: string;
  revisionId?: string;
  lastSnapshotHash?: string;
  lastSuccessfulCaptureAt?: string;
  lastFullScanAt?: string;
  lastChangeDetectedAt?: string;
  completeness?: "complete" | "partial";
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
      .toggle.scanning, .toggle.syncing, .toggle.checking, .toggle.waiting { animation: tab-breathe 1.5s ease-in-out infinite; }
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
      .message { margin:8px 0 12px; color:#60787d; font-size:11px; line-height:1.5; max-height:48px; overflow:hidden; }
      .meta { display:grid; grid-template-columns: 74px 1fr; gap: 5px 8px; margin: 0 0 12px; font-size:10.5px; color:#60787d; }
      .meta span:nth-child(2n) { color:#17343b; overflow-wrap:anywhere; }
      .actions { display:flex; gap:7px; }
      button.action { border:0; border-radius:7px; padding:7px 10px; background:#0a8f7c; color:#fff;
        font-family:inherit; font-size:10.5px; font-weight:750; cursor:pointer; }
      button.action.secondary { background:#e6f4f1; color:#147461; }
      button.action:disabled { opacity:.45; cursor:not-allowed; }
      @keyframes tab-breathe { 0%,100% { filter:saturate(1); } 50% { filter:saturate(1.35); } }
      @media (max-width: 520px) { .shell { top: 74px; } .panel { right: 50px; width: min(282px, calc(100vw - 64px)); } }
    </style>
    <div class="shell">
      <section class="panel" role="status" hidden>
        <div class="title"><span>知言归藏</span><span class="provider"></span></div>
        <div class="status"><span class="status-text">待机</span></div>
        <div class="message">打开会话后自动检查变化。</div>
        <div class="meta">
          <span>原因</span><span class="reason">-</span>
          <span>模式</span><span class="mode">-</span>
          <span>消息数</span><span class="count">-</span>
          <span>上次同步</span><span class="last">-</span>
        </div>
        <div class="actions"><button class="action retry" type="button">重新采集</button><button class="action secondary pause" type="button">暂停本站</button></div>
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
    mode.textContent =
      lastState.captureMode === "append"
        ? "增量"
        : lastState.captureMode === "full"
          ? "完整"
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
    panel.hidden = true;
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
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastUrl = location.href;
    let lastSessionKey = "";
    let indicator: FloatingIndicator | undefined;
    let lastPublishedState: CaptureUiState | undefined;
    let observer: MutationObserver | undefined;
    let observedRoot: HTMLElement | null = null;
    let previousLightSignature = "";
    let previousStreaming = false;
    let pendingReason: CaptureTriggerReason | null = null;
    let pendingDelay: number | undefined;
    let pendingForceFull = false;
    let lastUserActivityAt = 0;
    let autoCaptureDeferred = false;
    let suppressObserverMutations = false;
    let invalidated = false;
    let completedCaptureBaseline: {
      sessionKey: string;
      messageCount: number;
      capturedAt: number;
    } | null = null;

    const reasonPriority: Record<CaptureTriggerReason, number> = {
      manual_retry: 100,
      new_session: 95,
      branch_changed: 94,
      adapter_upgraded: 93,
      incremental_base_mismatch: 92,
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

    function captureSessionKey(provider: string, sessionId: string): string {
      return `${provider}:${sessionId}`;
    }

    function rememberCompletedCapture(
      provider: string,
      sessionId: string,
      messageCount: number,
    ): void {
      completedCaptureBaseline = {
        sessionKey: captureSessionKey(provider, sessionId),
        messageCount,
        capturedAt: Date.now(),
      };
    }

    async function isPaused(): Promise<boolean> {
      const settings = (await browser.storage.local.get("pausedHosts")) as ExtensionSettings;
      return Boolean(settings.pausedHosts?.[location.hostname]);
    }

    async function togglePaused(): Promise<void> {
      const settings = (await browser.storage.local.get("pausedHosts")) as ExtensionSettings;
      const pausedHosts = { ...(settings.pausedHosts ?? {}) };
      pausedHosts[location.hostname] = !pausedHosts[location.hostname];
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
      if (await shouldShowFloatingIndicator()) {
        if (!indicator) {
          indicator = createFloatingIndicator({
            onRetry: () => schedule("manual_retry", 0, { forceFull: true }),
            onPause: togglePaused,
          });
        }
        if (lastPublishedState) indicator.update(lastPublishedState);
        indicator.setPaused(await isPaused());
        return;
      }
      indicator?.destroy();
      indicator = undefined;
    }

    function recordUserActivity(): void {
      lastUserActivityAt = Date.now();
      autoCaptureDeferred = false;
    }

    function autoCaptureIdleDelay(): number {
      return remainingIdleDelay(lastUserActivityAt);
    }

    async function publishState(state: Omit<CaptureUiState, "updatedAt">): Promise<void> {
      const fullState = { ...state, updatedAt: new Date().toISOString() };
      lastPublishedState = fullState;
      indicator?.update(fullState);
      const message: ExtensionMessage = { type: "captureState", state: fullState };
      await browser.runtime.sendMessage(message).catch(() => undefined);
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
          if (!observedRoot?.contains(target)) return false;
          return true;
        });
        if (meaningful) schedule("new_messages");
      });
      observer = nextObserver;
      nextObserver.observe(root, { childList: true, subtree: true, characterData: true });
    }

    const activityListener = () => {
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
      if (invalidated) return;
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
      void publishState({
        status: "skipped",
        provider: light.provider,
        sessionId: light.sessionId,
        triggerReason: "new_messages",
        messageCount: light.messageCount,
        message: "内容未变化，已跳过",
      });
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        void publishState({
          status: "idle",
          provider: light.provider,
          sessionId: light.sessionId,
          messageCount: light.messageCount,
          message: "待机，只会在检测到有效变化后采集。",
        });
      }, SKIPPED_STATUS_MS);
    }

    async function enqueuePayload(payload: CapturePayloadV1) {
      const message: ExtensionMessage = { type: "enqueueCapture", payload };
      return browser.runtime.sendMessage(message) as Promise<
        | {
            sent?: number;
            remaining?: number;
            requiresFullCapture?: boolean;
            lastResult?: {
              revisionId?: string;
              messageCount?: number;
              completeness?: "complete" | "partial";
            };
          }
        | undefined
      >;
    }

    async function updateStateFromPayload(
      payload: CapturePayloadV1,
      light: LightweightConversationFingerprint,
      result?: { revisionId?: string; messageCount?: number; completeness?: "complete" | "partial" },
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
      });
      if (completeness === "complete") {
        rememberCompletedCapture(payload.provider, payload.sessionId, payloadMessageCount);
      }
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
    ): Promise<void> {
      await publishState({
        status: "scanning",
        provider: light.provider,
        sessionId: light.sessionId,
        triggerReason: reason,
        captureMode: "full",
        messageCount: light.messageCount,
        message: reason === "new_session"
          ? "正在回溯会话开头并加载历史消息"
          : "正在执行完整校验扫描",
      });
      const snapshot = await scanConversation(adapter, { triggerReason: reason });
      const result = await enqueuePayload(snapshot);
      await updateStateFromPayload(snapshot, light, result?.lastResult);
      await publishState({
        status: snapshot.completeness.status,
        provider: snapshot.provider,
        sessionId: snapshot.sessionId,
        triggerReason: reason,
        captureMode: "full",
        messageCount: snapshot.messages.length,
        message: `${snapshot.messages.length} 条消息已完整归档`,
      });
    }

    async function runAppendCapture(
      adapter: NonNullable<ReturnType<typeof adapterForLocation>>,
      state: LocalConversationState,
      light: LightweightConversationFingerprint,
      reason: CaptureTriggerReason,
    ): Promise<boolean> {
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
        messageCount: state.messageCount,
        branchFingerprint: state.branchFingerprint,
        lastMessageId: state.lastMessageId,
        lastMessageTextHash: state.lastMessageTextHash,
      }, { triggerReason: reason });
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
      const result = await enqueuePayload(delta);
      if (result?.requiresFullCapture) {
        schedule("incremental_base_mismatch", 200, { forceFull: true });
        return true;
      }
      await updateStateFromPayload(delta, {
        ...light,
        messageCount: delta.baseMessageCount + delta.appendedMessages.length,
        lastMessageId: delta.appendedMessages.at(-1)?.externalMessageId,
        lastMessageRole: delta.appendedMessages.at(-1)?.role,
        lastMessageTextHash: delta.appendedMessages.at(-1)
          ? await messageTextFingerprint(delta.appendedMessages.at(-1)!)
          : light.lastMessageTextHash,
      }, result?.lastResult);
      await publishState({
        status: "complete",
        provider: delta.provider,
        sessionId: delta.sessionId,
        triggerReason: reason,
        captureMode: "append",
        messageCount: delta.baseMessageCount + delta.appendedMessages.length,
        message: `增量同步完成，新增 ${delta.appendedMessages.length} 条消息`,
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
      let activeLight: LightweightConversationFingerprint | null = null;
      let preserveStreaming = false;
      let discardPending = false;

      try {
        if (await isPaused()) {
          discardPending = true;
          return;
        }
        const adapter = adapterForLocation();
        if (!adapter) {
          discardPending = true;
          return;
        }
        attachObserver();
        const light = await lightweightConversationFingerprint(adapter);
        if (!light) {
          discardPending = true;
          return;
        }
        activeLight = light;
        const signature = lightSignature(light);
        const state = await loadConversationState(light.provider, light.sessionId);
        previousStreaming = previousStreaming || Boolean(state?.streaming);

        const idleDelay = autoCaptureIdleDelay();
        if (
          shouldDeferAutoCapture({
            reason,
            forceFull: options.forceFull,
            lastUserActivityAt,
          }) &&
          idleDelay > 0
        ) {
          if (!autoCaptureDeferred) {
            autoCaptureDeferred = true;
            await publishState({
              status: "idle",
              provider: light.provider,
              sessionId: light.sessionId,
              triggerReason: reason,
              captureMode: state?.completeness === "complete" ? "append" : "full",
              messageCount: light.messageCount,
              message: AUTO_CAPTURE_DEFERRED_MESSAGE,
            });
          }
          schedule(
            reason,
            Math.max(idleDelay, 1_000),
            options.forceFull ? { forceFull: true } : {},
          );
          return;
        }
        autoCaptureDeferred = false;

      if (light.streaming) {
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
        schedule("stream_finished", STREAMING_RECHECK_MS);
        return;
      }

      const baseline = completedCaptureBaseline;
      const sameCapture = baseline?.sessionKey === captureSessionKey(
        light.provider,
        light.sessionId,
      );
      const recentViewportRemount =
        !options.forceFull &&
        !previousStreaming &&
        reason === "new_messages" &&
        state?.completeness === "complete" &&
        sameCapture &&
        baseline !== null &&
        light.messageCount < baseline.messageCount &&
        (light.virtualized === true || Date.now() - baseline.capturedAt < 20_000);
      if (recentViewportRemount) {
        previousLightSignature = signature;
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

      if (
        decision.action === "skip" ||
        (!state && previousLightSignature === signature && reason !== "new_session")
      ) {
        previousLightSignature = signature;
        publishSkipped(light);
        return;
      }

      previousLightSignature = signature;
      if (decision.action === "full") {
        await withObserverSuppressed(async () => {
          await runFullCapture(adapter, light, decision.triggerReason);
          const settled = await lightweightConversationFingerprint(adapter);
          if (settled && !settled.streaming) {
            previousLightSignature = lightSignature(settled);
          }
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
            // A missing incremental baseline is not proof that the archive is
            // unchanged. Virtualized providers can unmount the archived tail,
            // so fall back to the authoritative full walk instead of silently
            // skipping potentially new messages.
            await runFullCapture(adapter, light, "branch_changed");
          }
          const settled = await lightweightConversationFingerprint(adapter);
          if (settled && !settled.streaming) {
            previousLightSignature = lightSignature(settled);
          }
          schedule("new_messages", 1_000);
        });
        return;
      }
      publishSkipped(light);
      } catch (error) {
        await publishState({
          status: "failed",
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

    void refreshFloatingIndicator();
    attachObserver();
    schedule("new_session", 2_000);

    const routeTimer = setInterval(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        attachObserver();
        schedule("new_session", 3_000);
      }
    }, SESSION_POLL_MS);

    const sessionTimer = setInterval(() => {
      const sessionKey = currentSessionKey();
      if (!sessionKey) {
        lastSessionKey = "";
        return;
      }
      if (sessionKey !== lastSessionKey) {
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
        void refreshFloatingIndicator();
      }
    };
    browser.storage.onChanged.addListener(storageListener);

    browser.runtime.onMessage.addListener((raw: unknown) => {
      const message = raw as ExtensionMessage;
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
          provider: adapter?.definition.provider,
          title: adapter?.getTitle(),
          sessionId: adapter?.getSessionId(),
          scanning,
        });
      }
      return undefined;
    });

    ctx.onInvalidated(() => {
      invalidated = true;
      detachObserver();
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, activityListener, { capture: true } as AddEventListenerOptions);
      }
      clearInterval(routeTimer);
      clearInterval(sessionTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      scheduledDueAt = 0;
      consumePending();
      if (idleTimer) clearTimeout(idleTimer);
      browser.storage.onChanged.removeListener(storageListener);
      indicator?.destroy();
    });
  },
});
