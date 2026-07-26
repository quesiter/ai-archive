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

async function reachTop(
  container: HTMLElement,
  adapter: AdapterRuntime,
): Promise<boolean> {
  let stableHeightPasses = 0;
  let previousHeight = -1;
  for (let iteration = 0; iteration < 100; iteration += 1) {
    container.scrollTop = 0;
    await sleep(450);
    adapter.extractVisibleMessages();
    if (atTop(container) && container.scrollHeight === previousHeight) {
      stableHeightPasses += 1;
    } else {
      stableHeightPasses = 0;
    }
    previousHeight = container.scrollHeight;
    if (stableHeightPasses >= 2) return true;
  }
  return false;
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
  container: HTMLElement,
  adapter: AdapterRuntime,
): Promise<{ messages: ExtractedMessage[]; bottomReached: boolean }> {
  const ordered: ExtractedMessage[] = [];
  let stableBottomPasses = 0;
  let previousHeight = -1;
  for (let iteration = 0; iteration < 2_000; iteration += 1) {
    mergeVisible(ordered, adapter.extractVisibleMessages());
    if (atBottom(container)) {
      if (container.scrollHeight === previousHeight) stableBottomPasses += 1;
      else stableBottomPasses = 0;
      previousHeight = container.scrollHeight;
      if (stableBottomPasses >= 2) {
        mergeVisible(ordered, adapter.extractVisibleMessages());
        return { messages: ordered, bottomReached: true };
      }
    }
    const step = Math.max(Math.floor(container.clientHeight * 0.75), 320);
    container.scrollTop = Math.min(
      container.scrollTop + step,
      container.scrollHeight - container.clientHeight,
    );
    await sleep(180);
  }
  return { messages: ordered, bottomReached: atBottom(container) };
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
  const container = elementScrollContainer(initialMessages[0]!.element);
  const originalTop = container.scrollTop;
  const originalHeight = container.scrollHeight;
  const topReached = await reachTop(container, adapter);
  const scanned = await scanToBottom(container, adapter);
  const finalStable = generationStable && !adapter.isStreaming();
  const restoreRatio = originalHeight > container.clientHeight
    ? originalTop / (originalHeight - container.clientHeight)
    : 0;
  container.scrollTop = Math.max(
    0,
    restoreRatio * Math.max(0, container.scrollHeight - container.clientHeight),
  );

  const messages: CaptureMessage[] = scanned.messages.map(
    ({ key: _key, element: _element, ...message }, ordinal) => ({
      ...message,
      ordinal,
    }),
  );
  const roles = new Set(messages.map((message) => message.role));
  const rolesValid = roles.has("user") && roles.has("assistant");
  const complete = topReached && scanned.bottomReached && finalStable && rolesValid;
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
      topReached,
      bottomReached: scanned.bottomReached,
      stable: finalStable,
      ...(!complete
        ? {
            reason: !topReached
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
  if (visible.length <= base.messageCount) return null;
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
