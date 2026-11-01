import type {
  CaptureDeltaV1,
  CaptureMessage,
  CaptureSnapshotV1,
  CaptureTriggerReason,
  MessageRole,
} from "@ai-archive/contracts";
import type { AdapterRuntime, ExtractedMessage } from "./adapters/types";
import type { NativeConversation } from "./native-conversation";

export class CaptureInterruptedError extends Error {
  constructor() {
    super("采集已停止，页面控制权已交还给你");
    this.name = "CaptureInterruptedError";
  }
}

function checkActive(adapter: AdapterRuntime, sessionId: string | null, signal?: AbortSignal): void {
  if (signal?.aborted || adapter.getSessionId() !== sessionId) throw new CaptureInterruptedError();
}

const sleep = (milliseconds: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CaptureInterruptedError());
    const abort = () => {
      clearTimeout(timer);
      reject(new CaptureInterruptedError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });

export interface ConversationScanOptions {
  onProgress?: (progress: { message: string; messageCount: number }) => Promise<void>;
  scrollSignal?: AbortSignal;
  triggerReason?: CaptureTriggerReason;
  signal?: AbortSignal;
  readNative?: (visible: ExtractedMessage[]) => Promise<NativeConversation | null>;
}

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

function reversedScroll(container: HTMLElement): boolean {
  return getComputedStyle(container).flexDirection === "column-reverse";
}

function scrollOffset(container: HTMLElement): number {
  return reversedScroll(container)
    ? Math.max(0, container.scrollHeight - container.clientHeight) + container.scrollTop
    : container.scrollTop;
}

function setScrollOffset(container: HTMLElement, offset: number): void {
  const maximum = Math.max(0, container.scrollHeight - container.clientHeight);
  const clamped = Math.max(0, Math.min(offset, maximum));
  container.scrollTop = reversedScroll(container) ? clamped - maximum : clamped;
}

function atTop(container: HTMLElement): boolean {
  return scrollOffset(container) <= 2;
}

function atBottom(container: HTMLElement): boolean {
  return (
    scrollOffset(container) + container.clientHeight >= container.scrollHeight - 4
  );
}

function hasFirstTurnEvidence(adapter: AdapterRuntime, messages: ExtractedMessage[]): boolean {
  if (adapter.definition.provider !== "chatgpt") return true;
  const first = messages[0];
  if (!first || first.role !== "user" || !first.element.isConnected) return false;
  // Explicit turn markers can prove the beginning. The current ChatGPT UI
  // assigns fallback-turn-0 to the first loaded turn even when older history
  // failed to load; its fallback index is not an absolute history index.
  if (first.element.closest('[data-testid="conversation-turn-0"], [id="conversation-turn-0"]')) return true;
  return false;
}

export interface ReachConversationTopOptions {
  onProgress?: ConversationScanOptions["onProgress"];
  maxIterations?: number;
  stablePasses?: number;
  delayMs?: number;
  wait?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
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
  setScrollOffset(container, 0);
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
  const wait = options.wait ?? ((milliseconds: number) => sleep(milliseconds, options.signal));
  const sessionId = adapter.getSessionId();
  let container = initialContainer;
  let stableHeightPasses = 0;
  let previousEvidence = "";
  let visibleMessages = adapter.extractVisibleMessages();
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    checkActive(adapter, sessionId, options.signal);
    forceScrollToTop(container, visibleMessages[0]);
    await wait(delayMs);
    checkActive(adapter, sessionId, options.signal);
    visibleMessages = adapter.extractVisibleMessages();
    if (iteration % 5 === 0) await options.onProgress?.({
      message: `正在向上加载历史，已等待 ${Math.round((iteration + 1) * delayMs / 1000)} 秒；当前加载 ${visibleMessages.length} 条消息${hasFirstTurnEvidence(adapter, visibleMessages) ? "，已识别首轮" : "，尚未识别首轮"}`,
      messageCount: visibleMessages.length,
    });
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
      const reached = hasFirstTurnEvidence(adapter, visibleMessages);
      // A virtualized range can stay unchanged while older history is loading.
      // Keep waiting within the bounded iteration budget until the first turn
      // is proven, rather than treating a quiet truncated window as the top.
      if (reached || !chatGptHistory) return { container, reached };
    }
  }
  return { container, reached: false };
}

export function mergeVisible(
  ordered: ExtractedMessage[],
  visibleMessages: ExtractedMessage[],
): boolean {
  if (!visibleMessages.length) return true;
  // Virtualized history can mount a message shell before its full body. Keep
  // the latest extraction for stable IDs rather than freezing the first shell.
  const positionsById = new Map(ordered.flatMap((message, index) =>
    message.externalMessageId ? [[message.externalMessageId, index] as const] : [],
  ));
  for (const message of visibleMessages) {
    const position = message.externalMessageId ? positionsById.get(message.externalMessageId) : undefined;
    if (position !== undefined) {
      const previous = ordered[position]!;
      const textLength = (value: ExtractedMessage) => value.segments.reduce((total, segment) => total + segment.content.length, 0);
      ordered[position] = textLength(message) >= textLength(previous)
        ? message : { ...previous, element: message.element };
    }
  }
  let orderVerified = true;
  if (ordered.every((message) => message.externalMessageId) &&
      visibleMessages.every((message) => message.externalMessageId)) {
    const visibleIds = visibleMessages.map((message) => message.externalMessageId!);
    const knownPositions = visibleIds.flatMap((id) => {
      const position = positionsById.get(id);
      return position === undefined ? [] : [position];
    });
    orderVerified = positionsById.size === ordered.length &&
      new Set(visibleIds).size === visibleIds.length &&
      (knownPositions.length > 0 || ordered.length === 0) &&
      knownPositions.every((position, index) => index === 0 || position > knownPositions[index - 1]!);
    if (orderVerified) {
      // A body can mount between two messages already seen. Preserve the
      // later window's anchors instead of appending the delayed ID at the end.
      const insertions = new Map<number, ExtractedMessage[]>();
      let previousAnchor = -1;
      let pending: ExtractedMessage[] = [];
      for (const message of visibleMessages) {
        const position = positionsById.get(message.externalMessageId!);
        if (position === undefined) {
          pending.push(message);
          continue;
        }
        if (pending.length) {
          // Existing and newly observed runs between the same anchors have
          // no proven relative order. Retain both but do not certify the scan.
          if (position > previousAnchor + 1) orderVerified = false;
          insertions.set(position, pending);
          pending = [];
        }
        previousAnchor = position;
      }
      if (pending.length) {
        if (previousAnchor < ordered.length - 1) orderVerified = false;
        insertions.set(previousAnchor + 1, pending);
      }
      const merged: ExtractedMessage[] = [];
      for (let index = 0; index <= ordered.length; index += 1) {
        merged.push(...(insertions.get(index) ?? []));
        if (index < ordered.length) merged.push(ordered[index]!);
      }
      ordered.splice(0, ordered.length, ...merged);
      return orderVerified;
    }
  }
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
  return orderVerified;
}

function viewportEvidence(container: HTMLElement, messages: ExtractedMessage[]): string {
  return JSON.stringify([
    container.scrollHeight,
    messages.map((message) => [message.key, message.role, message.segments]),
  ]);
}

async function settledViewport(
  initialContainer: HTMLElement,
  adapter: AdapterRuntime,
  signal?: AbortSignal,
): Promise<{ container: HTMLElement; messages: ExtractedMessage[]; stable: boolean }> {
  const sessionId = adapter.getSessionId();
  let container = initialContainer;
  let messages = adapter.extractVisibleMessages();
  let evidence = viewportEvidence(container, messages);
  let quietPasses = 0;
  const startedAt = Date.now();
  // A constant virtual scroll height is not evidence that the next window has
  // rendered. Historical bodies regularly mount later than a single 180ms step.
  while (Date.now() - startedAt < 5_000) {
    await sleep(180, signal);
    checkActive(adapter, sessionId, signal);
    messages = adapter.extractVisibleMessages();
    const currentContainer = scrollContainerForMessages(messages, container);
    const nextEvidence = viewportEvidence(currentContainer, messages);
    quietPasses = currentContainer === container && nextEvidence === evidence
      ? quietPasses + 1 : 0;
    container = currentContainer;
    evidence = nextEvidence;
    const minimumWait = atBottom(container) ? 1_800 : 900;
    if (messages.length && quietPasses >= 3 && Date.now() - startedAt >= minimumWait) {
      return { container, messages, stable: true };
    }
  }
  return { container, messages, stable: false };
}

function windowsOverlap(previous: ExtractedMessage[], current: ExtractedMessage[]): boolean {
  const keys = new Set(previous.map((message) => message.externalMessageId ?? message.key));
  return current.some((message) => keys.has(message.externalMessageId ?? message.key));
}

async function scanToBottom(
  initialContainer: HTMLElement,
  adapter: AdapterRuntime,
  signal?: AbortSignal,
  onProgress?: ConversationScanOptions["onProgress"],
): Promise<{
  messages: ExtractedMessage[];
  bottomReached: boolean;
  container: HTMLElement;
  coverageVerified: boolean;
  contentStable: boolean;
  firstTurnVerified: boolean;
}> {
  const ordered: ExtractedMessage[] = [];
  const sessionId = adapter.getSessionId();
  let container = initialContainer;
  let coverageVerified = true;
  let contentStable = true;
  const firstTurnKeys = new Set<string>();
  const firstTurnVerified = () => adapter.definition.provider !== "chatgpt" ||
    Boolean(ordered[0] && firstTurnKeys.has(ordered[0].key));
  let previousWindow: ExtractedMessage[] = [];
  let previousTop = scrollOffset(container);
  let step = Math.max(Math.floor(container.clientHeight * 0.5), 32);
  let connectedPasses = 0;
  const deadline = Date.now() + 360_000;
  for (let iteration = 0; iteration < 2_000 && Date.now() < deadline; iteration += 1) {
    checkActive(adapter, sessionId, signal);
    const viewport = await settledViewport(container, adapter, signal);
    if (viewport.container !== container) {
      container = viewport.container;
      previousTop = scrollOffset(container);
    }
    const visibleMessages = viewport.messages;
    if (hasFirstTurnEvidence(adapter, visibleMessages) && visibleMessages[0]) {
      firstTurnKeys.add(visibleMessages[0].key);
    }
    contentStable &&= viewport.stable;
    if (!viewport.stable) {
      mergeVisible(ordered, visibleMessages);
      return { messages: ordered, bottomReached: false, container, coverageVerified, contentStable, firstTurnVerified: firstTurnVerified() };
    }
    if (previousWindow.length && !windowsOverlap(previousWindow, visibleMessages)) {
      connectedPasses = 0;
      const distance = scrollOffset(container) - previousTop;
      if (distance > 32) {
        // Recover skipped windows before accepting a disconnected batch.
        step = Math.max(Math.floor(distance / 2), 32);
        setScrollOffset(container, previousTop + step);
        continue;
      }
      coverageVerified = false;
    }
    coverageVerified = mergeVisible(ordered, visibleMessages) && coverageVerified;
    await onProgress?.({ message: `正在逐段读取会话，已读取 ${ordered.length} 条消息${atBottom(container) ? "，正在确认末轮" : ""}`, messageCount: ordered.length });
    if (atBottom(container) && viewport.stable) {
      return { messages: ordered, bottomReached: true, container, coverageVerified, contentStable, firstTurnVerified: firstTurnVerified() };
    }
    if (previousWindow.length && windowsOverlap(previousWindow, visibleMessages)) {
      connectedPasses += 1;
      if (connectedPasses >= 3) {
        // A short dense section must not leave the rest of a long conversation
        // crawling at the recovery step until the overall deadline expires.
        step = Math.min(step * 2, Math.max(Math.floor(container.clientHeight * 0.5), 32));
        connectedPasses = 0;
      }
    }
    previousWindow = visibleMessages;
    previousTop = scrollOffset(container);
    setScrollOffset(container, Math.min(
      scrollOffset(container) + step,
      Math.max(0, container.scrollHeight - container.clientHeight),
    ));
  }
  return { messages: ordered, bottomReached: false, container, coverageVerified, contentStable, firstTurnVerified: firstTurnVerified() };
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

export async function interruptedConversationSnapshot(
  adapter: AdapterRuntime,
  sessionId: string,
  initialMessages: ExtractedMessage[],
): Promise<CaptureSnapshotV1> {
  if (adapter.getSessionId() !== sessionId) throw new CaptureInterruptedError();
  const ordered = [...initialMessages];
  mergeVisible(ordered, adapter.extractVisibleMessages());
  const messages = ordered.map(({ key: _key, element: _element, ...message }, ordinal) => ({ ...message, ordinal }));
  const branchFingerprint = await sha256(messages.map((message) =>
    `${message.role}:${message.segments.map((segment) => `${segment.type}:${segment.content}:${segment.href ?? ""}`).join("|")}`,
  ).join("\n"));
  if (adapter.getSessionId() !== sessionId) throw new CaptureInterruptedError();
  const title = adapter.getTitle() ?? fallbackTitle(messages);
  return {
    schemaVersion: 1, provider: adapter.definition.provider, sessionId,
    branchFingerprint, ...(title ? { title } : {}), canonicalUrl: adapter.getCanonicalUrl(),
    adapterVersion: adapter.definition.version, capturedAt: new Date().toISOString(),
    captureMode: "full", triggerReason: "manual_retry",
    completeness: {
      status: "partial", topReached: false, bottomReached: false, stable: false,
      reason: "完整采集已中止，已保存读取到的消息；历史覆盖尚未确认",
    },
    messages,
  };
}

export async function scanConversation(
  adapter: AdapterRuntime,
  options: ConversationScanOptions = {},
): Promise<CaptureSnapshotV1> {
  const sessionId = adapter.getSessionId();
  if (!sessionId) throw new Error("当前页面还没有稳定的对话 Session ID");
  checkActive(adapter, sessionId, options.signal);
  let initialMessages = adapter.extractVisibleMessages();
  if (initialMessages.length < 1) throw new Error("未识别到对话消息");
  await options.onProgress?.({ message: "正在读取完整历史接口，最多等待 8 秒", messageCount: initialMessages.length });
  const native = await options.readNative?.(initialMessages);
  checkActive(adapter, sessionId, options.signal);
  let initialContainer = elementScrollContainer(initialMessages[0]!.element);
  let contentStable = true;
  // A native response is one coherent snapshot even if the answer continues
  // afterwards. DOM history still needs to finish mounting before extraction.
  if (!native && options.scrollSignal?.aborted) contentStable = false;
  else if (!native) {
    await options.onProgress?.({ message: "正在确认页面内容已加载", messageCount: initialMessages.length });
    const viewport = await settledViewport(initialContainer, adapter, options.signal);
    initialMessages = viewport.messages;
    initialContainer = viewport.container;
    contentStable = viewport.stable;
  }
  // A full payload does not authorize moving the page. New sessions, branch
  // changes and server-requested repairs must all remain passive, including
  // when the user is idle or the archived append baseline is no longer mounted.
  const allowScroll = options.triggerReason === "manual_retry" && !options.scrollSignal?.aborted;
  const hasLayout = initialContainer.clientHeight > 0;
  let topReached = Boolean(native) || hasLayout && atTop(initialContainer) && hasFirstTurnEvidence(adapter, initialMessages);
  let bottomReached = Boolean(native) || hasLayout && atBottom(initialContainer);
  let coverageVerified = true;
  let messages: CaptureMessage[] = native?.messages ?? initialMessages.map(
    ({ key: _key, element: _element, ...message }, ordinal) => ({ ...message, ordinal }),
  );
  if (allowScroll && !native && hasLayout) {
    const scrollingSignal = options.scrollSignal
      ? AbortSignal.any([options.scrollSignal, ...(options.signal ? [options.signal] : [])])
      : options.signal;
    const originalTop = scrollOffset(initialContainer);
    const originalHeight = initialContainer.scrollHeight;
    const topResult = await reachConversationTop(initialContainer, adapter, {
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ...(scrollingSignal ? { signal: scrollingSignal } : {}),
    });
    const scanned = await scanToBottom(topResult.container, adapter, scrollingSignal, options.onProgress);
    checkActive(adapter, sessionId, options.signal);
    topReached = topResult.reached && scanned.firstTurnVerified && topResult.container.clientHeight > 0;
    bottomReached = scanned.bottomReached && scanned.container.clientHeight > 0;
    coverageVerified = scanned.coverageVerified;
    contentStable = scanned.contentStable;
    messages = scanned.messages.map(
      ({ key: _key, element: _element, ...message }, ordinal) => ({ ...message, ordinal }),
    );
    const restoreRatio = originalHeight > initialContainer.clientHeight
      ? originalTop / (originalHeight - initialContainer.clientHeight)
      : 0;
    setScrollOffset(scanned.container, Math.max(
      0,
      restoreRatio * Math.max(
        0,
        scanned.container.scrollHeight - scanned.container.clientHeight,
      ),
    ));
  }
  const finalStable = contentStable && !(adapter.definition.provider === "doubao" && adapter.isStreaming());

  const rolesValid = messages.length > 0;
  const complete = topReached && bottomReached && finalStable && rolesValid && coverageVerified && !native?.incompleteReason;
  const fingerprintInput = messages
    .map((message) =>
      `${message.role}:${message.segments
        .map((segment) => `${segment.type}:${segment.content}:${segment.href ?? ""}`)
        .join("|")}`,
    )
    .join("\n");
  const title = native?.title ?? adapter.getTitle() ?? fallbackTitle(messages);
  const branchFingerprint = await sha256(fingerprintInput);
  checkActive(adapter, sessionId, options.signal);
  return {
    schemaVersion: 1,
    provider: adapter.definition.provider,
    sessionId,
    branchFingerprint,
    ...(title ? { title } : {}),
    canonicalUrl: adapter.getCanonicalUrl(),
    ...(native && finalStable ? { sourceKind: "chatgpt_current_branch" as const } : {}),
    adapterVersion: adapter.definition.version,
    capturedAt: new Date().toISOString(),
    captureMode: "full",
    ...(options.triggerReason ? { triggerReason: options.triggerReason } : {}),
    completeness: {
      status: complete ? "complete" : "partial",
      topReached,
      bottomReached,
      stable: finalStable,
      ...(complete && native?.sourceNotice ? { reason: native.sourceNotice } : {}),
      ...(!complete
        ? {
            reason: native?.incompleteReason ?? (options.triggerReason === "manual_retry" && options.scrollSignal?.aborted && (!topReached || !bottomReached)
              ? "已停止自动滚动，已保存当前加载的消息；历史覆盖尚未确认"
              : !allowScroll && (!topReached || !bottomReached)
              ? "自动采集仅保存已加载消息；如需补全历史，请手动完整采集（会滚动页面）"
              : !topReached
              ? "未能确认首轮"
              : !bottomReached
                ? "未能确认末轮"
                : !coverageVerified
                  ? "虚拟列表消息之间存在未能补齐的缺口或无法确认的顺序"
                : !finalStable
                  ? "页面内容尚未稳定加载"
                  : "未识别到可采集的消息"),
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
    baselineContentHash?: string | undefined;
    messageCount: number;
    branchFingerprint: string;
    lastMessageId?: string | undefined;
    lastMessageTextHash?: string | undefined;
  },
  options: ConversationScanOptions = {},
): Promise<CaptureDeltaV1 | null> {
  if (!base.baselineContentHash) return null;
  const sessionId = adapter.getSessionId();
  if (!sessionId) throw new Error("当前页面还没有稳定的对话 Session ID");
  if (adapter.isStreaming()) return null;
  const mounted = adapter.extractVisibleMessages();
  const native = await options.readNative?.(mounted);
  checkActive(adapter, sessionId, options.signal);
  if (native?.incompleteReason) return null;
  if (adapter.isStreaming()) return null;
  const visible: CaptureMessage[] = native?.messages ?? mounted.map(
    ({ key: _key, element: _element, ...message }) => message,
  );
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
    (message, index) => ({
      ...message,
      ordinal: base.messageCount + index,
    }),
  );
  checkActive(adapter, sessionId, options.signal);
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
    baseContentHash: base.baselineContentHash,
    baseMessageCount: base.messageCount,
    ...(base.lastMessageId ? { baseLastMessageId: base.lastMessageId } : {}),
    ...(base.lastMessageTextHash
      ? { baseLastMessageTextHash: base.lastMessageTextHash }
      : {}),
    appendedMessages,
  };
}
