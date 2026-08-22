import type {
  CaptureDeltaV1,
  CaptureMessage,
  CaptureSnapshotV1,
  CaptureTriggerReason,
  MessageRole,
} from "@ai-archive/contracts";
import type { AdapterRuntime, ExtractedMessage } from "./adapters/types";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function elementScrollContainer(element: HTMLElement): HTMLElement {
  let current: HTMLElement | null = element.parentElement;
  while (current && current !== document.body) {
    const style = getComputedStyle(current);
    if (
      /(auto|scroll)/.test(style.overflowY) &&
      current.scrollHeight > current.clientHeight + 80
    ) {
      return current;
    }
    current = current.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

function atTop(container: HTMLElement): boolean {
  return container.scrollTop <= 2;
}

function atBottom(container: HTMLElement): boolean {
  return (
    container.scrollTop + container.clientHeight >= container.scrollHeight - 4
  );
}

async function waitForGeneration(adapter: AdapterRuntime): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  let quietPasses = 0;
  while (Date.now() < deadline) {
    if (!adapter.isStreaming()) quietPasses += 1;
    else quietPasses = 0;
    if (quietPasses >= 2) return true;
    await sleep(800);
  }
  return false;
}

export interface ReachConversationTopOptions {
  maxIterations?: number;
  stablePasses?: number;
  delayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
}

export interface ReachConversationTopResult {
  container: HTMLElement;
  reached: boolean;
}

function scrollContainerForMessages(
  messages: ExtractedMessage[],
  fallback: HTMLElement,
): HTMLElement {
  const firstConnected = messages.find((message) => message.element.isConnected);
  if (!firstConnected) return fallback;
  const candidate = elementScrollContainer(firstConnected.element);
  return candidate.isConnected ? candidate : fallback;
}

function forceScrollToTop(
  container: HTMLElement,
  firstMessage: ExtractedMessage | undefined,
): void {
  if (
    firstMessage?.element.isConnected &&
    typeof firstMessage.element.scrollIntoView === "function"
  ) {
    firstMessage.element.scrollIntoView({
      block: "start",
      inline: "nearest",
      behavior: "auto",
    });
  }
  container.scrollTop = 0;
}

function topLoadEvidence(
  container: HTMLElement,
  messages: ExtractedMessage[],
): string {
  const first = messages[0];
  return [
    container.scrollHeight,
    messages.length,
    first?.externalMessageId ?? first?.key ?? "",
  ].join(":");
}

export async function reachConversationTop(
  initialContainer: HTMLElement,
  adapter: AdapterRuntime,
  options: ReachConversationTopOptions = {},
): Promise<ReachConversationTopResult> {
  const chatGptHistory = adapter.definition.provider === "chatgpt";
  const stablePasses = options.stablePasses ?? (chatGptHistory ? 12 : 2);
  const delayMs = options.delayMs ?? (chatGptHistory ? 650 : 450);
  const maxIterations = options.maxIterations ?? (chatGptHistory ? 160 : 100);
  const wait = options.wait ?? sleep;
  let container = initialContainer;
  let stableHeightPasses = 0;
  let previousEvidence = "";
  let visibleMessages = adapter.extractVisibleMessages();
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    forceScrollToTop(container, visibleMessages[0]);
    await wait(delayMs);
    visibleMessages = adapter.extractVisibleMessages();
    const currentContainer = scrollContainerForMessages(visibleMessages, container);
    if (currentContainer !== container) {
      container = currentContainer;
      stableHeightPasses = 0;
      previousEvidence = "";
      forceScrollToTop(container, visibleMessages[0]);
      continue;
    }
    const evidence = topLoadEvidence(container, visibleMessages);
    if (atTop(container) && evidence === previousEvidence) {
      stableHeightPasses += 1;
    } else {
      stableHeightPasses = 0;
    }
    previousEvidence = evidence;
    if (stableHeightPasses >= stablePasses) {
      return { container, reached: true };
    }
  }
  return { container, reached: false };
}

export function mergeVisible(
  ordered: ExtractedMessage[],
  visibleMessages: ExtractedMessage[],
): void {
  if (!visibleMessages.length) return;
  let overlap = Math.min(ordered.length, visibleMessages.length);
  while (overlap > 0) {
    const orderedStart = ordered.length - overlap;
    const matches = visibleMessages
      .slice(0, overlap)
      .every((message, index) => ordered[orderedStart + index]?.key === message.key);
    if (matches) break;
    overlap -= 1;
  }
  const seenExternalIds = new Set(
    ordered.flatMap((message) =>
      message.externalMessageId ? [message.externalMessageId] : [],
    ),
  );
  for (const message of visibleMessages.slice(overlap)) {
    if (
      message.externalMessageId &&
      seenExternalIds.has(message.externalMessageId)
    ) {
      continue;
    }
    if (message.externalMessageId) {
      seenExternalIds.add(message.externalMessageId);
    }
    ordered.push(message);
  }
}

async function scanToBottom(
  initialContainer: HTMLElement,
  adapter: AdapterRuntime,
): Promise<{
  messages: ExtractedMessage[];
  bottomReached: boolean;
  container: HTMLElement;
}> {
  const ordered: ExtractedMessage[] = [];
  let container = initialContainer;
  let stableBottomPasses = 0;
  let previousHeight = -1;
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    const visibleMessages = adapter.extractVisibleMessages();
    const currentContainer = scrollContainerForMessages(visibleMessages, container);
    if (currentContainer !== container) {
      container = currentContainer;
      stableBottomPasses = 0;
      previousHeight = -1;
    }
    mergeVisible(ordered, visibleMessages);
    if (atBottom(container)) {
      if (container.scrollHeight === previousHeight) stableBottomPasses += 1;
      else stableBottomPasses = 0;
      previousHeight = container.scrollHeight;
      if (stableBottomPasses >= 2) {
        mergeVisible(ordered, adapter.extractVisibleMessages());
        return { messages: ordered, bottomReached: true, container };
      }
    }
    const step = Math.max(Math.floor(container.clientHeight * 0.75), 320);
    container.scrollTop = Math.min(
      container.scrollTop + step,
      container.scrollHeight - container.clientHeight,
    );
    await sleep(180);
  }
  return { messages: ordered, bottomReached: atBottom(container), container };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function normalizedSegmentContent(type: string, content: string): string {
  return type === "code" ? content : content.replace(/\r\n/g, "\n").trim();
}

export async function messageTextFingerprint(message: {
  externalMessageId?: string | undefined;
  role: MessageRole;
  segments: CaptureMessage["segments"];
}): Promise<string> {
  return sha256(
    JSON.stringify({
      externalMessageId: message.externalMessageId ?? null,
      role: message.role,
      segments: message.segments.map((segment) => ({
        type: segment.type,
        content: normalizedSegmentContent(segment.type, segment.content),
        href: segment.href ?? null,
        language: segment.language ?? null,
      })),
    }),
  );
}

export interface LightweightConversationFingerprint {
  provider: string;
  sessionId: string;
  adapterVersion: string;
  messageCount: number;
  lastMessageId?: string | undefined;
  lastMessageRole?: MessageRole | undefined;
  lastMessageTextHash?: string | undefined;
  streaming: boolean;
  /** True when the current message container is scrollable/likely virtualized. */
  virtualized?: boolean | undefined;
}

function likelyVirtualizedViewport(
  adapter: AdapterRuntime,
  messages: ExtractedMessage[],
): boolean {
  const first = messages[0];
  if (!first) return false;
  const root = adapter.getConversationRoot();
  if (!root || !root.contains(first.element)) return false;
  const container = elementScrollContainer(first.element);
  return container.scrollHeight > container.clientHeight + 80;
}

export async function lightweightConversationFingerprint(
  adapter: AdapterRuntime,
): Promise<LightweightConversationFingerprint | null> {
  const sessionId = adapter.getSessionId();
  if (!sessionId) return null;
  const messages = adapter.extractVisibleMessages();
  const last = messages.at(-1);
  return {
    provider: adapter.definition.provider,
    sessionId,
    adapterVersion: adapter.definition.version,
    messageCount: messages.length,
    ...(last?.externalMessageId ? { lastMessageId: last.externalMessageId } : {}),
    ...(last ? { lastMessageRole: last.role } : {}),
    ...(last ? { lastMessageTextHash: await messageTextFingerprint(last) } : {}),
    streaming: adapter.isStreaming(),
    virtualized: likelyVirtualizedViewport(adapter, messages),
  };
}

function fallbackTitle(messages: CaptureMessage[]): string | undefined {
  const firstQuestion = messages
    .find((message) => message.role === "user")
    ?.segments.find((segment) => segment.type === "text")
    ?.content.replace(/\s+/g, " ")
    .trim();
  if (!firstQuestion) return undefined;
  const characters = Array.from(firstQuestion);
  return characters.length > 80
    ? `${characters.slice(0, 80).join("")}…`
    : firstQuestion;
}

export async function scanConversation(
  adapter: AdapterRuntime,
  options: {
    triggerReason?: CaptureTriggerReason;
  } = {},
): Promise<CaptureSnapshotV1> {
  const sessionId = adapter.getSessionId();
  if (!sessionId) throw new Error("当前页面还没有稳定的对话 Session ID");
  const generationStable = await waitForGeneration(adapter);
  const initialMessages = adapter.extractVisibleMessages();
  if (initialMessages.length < 1) throw new Error("未识别到对话消息");
  const initialContainer = elementScrollContainer(initialMessages[0]!.element);
  const originalTop = initialContainer.scrollTop;
  const originalHeight = initialContainer.scrollHeight;
  const topResult = await reachConversationTop(initialContainer, adapter);
  const scanned = await scanToBottom(topResult.container, adapter);
  const finalStable = generationStable && !adapter.isStreaming();
  const restoreRatio = originalHeight > initialContainer.clientHeight
    ? originalTop / (originalHeight - initialContainer.clientHeight)
    : 0;
  scanned.container.scrollTop = Math.max(
    0,
    restoreRatio * Math.max(
      0,
      scanned.container.scrollHeight - scanned.container.clientHeight,
    ),
  );

  const messages: CaptureMessage[] = scanned.messages.map(
    ({ key: _key, element: _element, ...message }, ordinal) => ({
      ...message,
      ordinal,
    }),
  );
  const roles = new Set(messages.map((message) => message.role));
  const rolesValid = roles.has("user") && roles.has("assistant");
  const complete = topResult.reached && scanned.bottomReached && finalStable && rolesValid;
  const fingerprintInput = messages
    .map((message) =>
      `${message.role}:${message.segments
        .map((segment) => `${segment.type}:${segment.content}:${segment.href ?? ""}`)
        .join("|")}`,
    )
    .join("\n");
  const title = adapter.getTitle() ?? fallbackTitle(messages);
  return {
    schemaVersion: 1,
    provider: adapter.definition.provider,
    sessionId,
    branchFingerprint: await sha256(fingerprintInput),
    ...(title ? { title } : {}),
    canonicalUrl: adapter.getCanonicalUrl(),
    adapterVersion: adapter.definition.version,
    capturedAt: new Date().toISOString(),
    captureMode: "full",
    ...(options.triggerReason ? { triggerReason: options.triggerReason } : {}),
    completeness: {
      status: complete ? "complete" : "partial",
      topReached: topResult.reached,
      bottomReached: scanned.bottomReached,
      stable: finalStable,
      ...(!complete
        ? {
            reason: !topResult.reached
              ? "未能确认首轮"
              : !scanned.bottomReached
                ? "未能确认末轮"
                : !finalStable
                  ? "回答仍在生成或内容不稳定"
                  : "未可靠识别用户与助手消息",
          }
        : {}),
    },
    messages,
  };
}

export async function scanAppendedMessages(
  adapter: AdapterRuntime,
  base: {
    revisionId?: string | undefined;
    messageCount: number;
    branchFingerprint: string;
    lastMessageId?: string | undefined;
    lastMessageTextHash?: string | undefined;
  },
  options: {
    triggerReason?: CaptureTriggerReason;
  } = {},
): Promise<CaptureDeltaV1 | null> {
  const sessionId = adapter.getSessionId();
  if (!sessionId) throw new Error("当前页面还没有稳定的对话 Session ID");
  if (adapter.isStreaming()) return null;
  const visible = adapter.extractVisibleMessages();
  let baseIndex = -1;
  for (const [index, message] of visible.entries()) {
    if (base.lastMessageId && message.externalMessageId === base.lastMessageId) {
      baseIndex = index;
      break;
    }
    if (!base.lastMessageId && base.lastMessageTextHash) {
      const hash = await messageTextFingerprint(message);
      if (hash === base.lastMessageTextHash) {
        baseIndex = index;
        break;
      }
    }
  }
  if (baseIndex < 0) return null;
  const baseVisible = visible[baseIndex];
  if (!baseVisible) return null;
  if (
    base.lastMessageId &&
    baseVisible.externalMessageId &&
    baseVisible.externalMessageId !== base.lastMessageId
  ) {
    return null;
  }
  if (
    base.lastMessageTextHash &&
    (await messageTextFingerprint(baseVisible)) !== base.lastMessageTextHash
  ) {
    return null;
  }
  const appended = visible.slice(baseIndex + 1);
  if (!appended.length) return null;
  const appendedMessages: CaptureMessage[] = appended.map(
    ({ key: _key, element: _element, ...message }, index) => ({
      ...message,
      ordinal: base.messageCount + index,
    }),
  );
  return {
    schemaVersion: 1,
    captureMode: "append",
    provider: adapter.definition.provider,
    sessionId,
    branchFingerprint: base.branchFingerprint,
    ...(adapter.getTitle() ? { title: adapter.getTitle() } : {}),
    canonicalUrl: adapter.getCanonicalUrl(),
    adapterVersion: adapter.definition.version,
    capturedAt: new Date().toISOString(),
    triggerReason: options.triggerReason ?? "new_messages",
    ...(base.revisionId ? { baseRevisionId: base.revisionId } : {}),
    baseMessageCount: base.messageCount,
    ...(base.lastMessageId ? { baseLastMessageId: base.lastMessageId } : {}),
    ...(base.lastMessageTextHash
      ? { baseLastMessageTextHash: base.lastMessageTextHash }
      : {}),
    appendedMessages,
  };
}
