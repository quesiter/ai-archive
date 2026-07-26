import { defineContentScript } from "wxt/utils/define-content-script";
import { adapterForLocation } from "../lib/adapters/runtime";
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
const SESSION_POLL_MS = 1_000;
const SKIPPED_STATUS_MS = 1_400;

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
        <div class="title"><span>AI 会话归档</span><span class="provider"></span></div>
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
      <button class="toggle" type="button" aria-label="查看 AI 会话归档状态" aria-expanded="false"><span>A</span><span class="dot"></span></button>
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
    toggle.title = paused ? "本站已暂停" : `AI 会话归档：${statusLabels[lastState.status]}`;
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
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastUrl = location.href;
    let lastSessionKey = "";
    let indicator: FloatingIndicator | undefined;
    let lastPublishedState: CaptureUiState | undefined;
    let observer: MutationObserver | undefined;
    let observedRoot: HTMLElement | null = null;
    let previousLightSignature = "";
    let previousStreaming = false;
    let queuedForceFullReason: CaptureTriggerReason | null = null;

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
            onRetry: () => void evaluate("manual_retry", { forceFull: true }),
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

    async function publishState(state: Omit<CaptureUiState, "updatedAt">): Promise<void> {
      const fullState = { ...state, updatedAt: new Date().toISOString() };
      lastPublishedState = fullState;
      indicator?.update(fullState);
      const message: ExtensionMessage = { type: "captureState", state: fullState };
      await browser.runtime.sendMessage(message).catch(() => undefined);
    }

    function attachObserver(): void {
      const adapter = adapterForLocation();
      const root = adapter?.getConversationRoot() ?? document.body;
      if (root === observedRoot && observer) return;
      observer?.disconnect();
      observedRoot = root;
      observer = new MutationObserver((mutations) => {
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
      observer.observe(root, { childList: true, subtree: true, characterData: true });
    }

    function schedule(reason: CaptureTriggerReason, delay = EFFECTIVE_CHANGE_DEBOUNCE_MS): void {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => void evaluate(reason), delay);
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
      const lastMessage =
        isDeltaPayload(payload)
          ? payload.appendedMessages.at(-1)
          : payload.messages.at(-1);
      await saveConversationState({
        provider: payload.provider,
        sessionId: payload.sessionId,
        branchFingerprint: payload.branchFingerprint,
        adapterVersion: payload.adapterVersion,
        messageCount: result?.messageCount ?? light.messageCount,
        ...(result?.revisionId ? { revisionId: result.revisionId } : {}),
        ...(lastMessage?.externalMessageId ? { lastMessageId: lastMessage.externalMessageId } : {}),
        ...(lastMessage ? { lastMessageRole: lastMessage.role } : {}),
        ...(lastMessage ? { lastMessageTextHash: await messageTextFingerprint(lastMessage) } : {}),
        streaming: false,
        lastSuccessfulCaptureAt: new Date().toISOString(),
        ...(!isDeltaPayload(payload) && payload.captureMode === "full"
          ? { lastFullScanAt: new Date().toISOString() }
          : {}),
        lastChangeDetectedAt: new Date().toISOString(),
        completeness:
          result?.completeness ??
          (isDeltaPayload(payload) ? "complete" : payload.completeness.status),
      });
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
        message: reason === "new_session" ? "正在执行首次完整归档" : "正在执行完整校验扫描",
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
        queuedForceFullReason = "incremental_base_mismatch";
        schedule("incremental_base_mismatch", 200);
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
      if (scanning) return;
      if (await isPaused()) return;
      const adapter = adapterForLocation();
      if (!adapter) return;
      attachObserver();
      const light = await lightweightConversationFingerprint(adapter);
      if (!light) return;
      const signature = lightSignature(light);
      const state = await loadConversationState(light.provider, light.sessionId);
      previousStreaming = previousStreaming || Boolean(state?.streaming);

      if (light.streaming) {
        previousStreaming = true;
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

      const forceFullReason = queuedForceFullReason ?? (options.forceFull ? reason : null);
      queuedForceFullReason = null;
      const decision = decideCaptureAction({
        light,
        state,
        requestedReason: reason,
        forceFullReason,
        previousStreaming,
      });

      if (
        decision.action === "skip" ||
        (!state && previousLightSignature === signature && reason !== "new_session")
      ) {
        previousLightSignature = signature;
        previousStreaming = false;
        publishSkipped(light);
        return;
      }

      scanning = true;
      previousLightSignature = signature;
      try {
        if (decision.action === "full") {
          await runFullCapture(adapter, light, decision.triggerReason);
          return;
        }
        if (decision.action === "append" && state) {
          const appendOk = await runAppendCapture(
            adapter,
            state,
            light,
            decision.triggerReason,
          );
          if (!appendOk) {
            await runFullCapture(adapter, light, "branch_changed");
          }
          return;
        }
        publishSkipped(light);
      } catch (error) {
        await publishState({
          status: "failed",
          provider: light.provider,
          sessionId: light.sessionId,
          triggerReason: reason,
          messageCount: light.messageCount,
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        previousStreaming = false;
        scanning = false;
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
        schedule("new_session", 750);
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
        schedule("new_session", 750);
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
        void evaluate("manual_retry", { forceFull: true });
        return Promise.resolve({ ok: true });
      }
      if (message.type === "forceFullCapture") {
        void evaluate("incremental_base_mismatch", { forceFull: true });
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
      observer?.disconnect();
      clearInterval(routeTimer);
      clearInterval(sessionTimer);
      if (debounceTimer) clearTimeout(debounceTimer);
      if (idleTimer) clearTimeout(idleTimer);
      browser.storage.onChanged.removeListener(storageListener);
      indicator?.destroy();
    });
  },
});
