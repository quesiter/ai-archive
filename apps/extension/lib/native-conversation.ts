import type { CaptureMessage } from "@ai-archive/contracts";

export interface NativeConversation {
  title?: string;
  messages: CaptureMessage[];
  /** The branch is verified, but one or more bodies could not be fully read. */
  incompleteReason?: string;
  incompleteKind?: "unfinished_message" | "unsupported_content";
  /** Source generation state is informational, independent of capture coverage. */
  sourceNotice?: string;
}

export type NativeConversationParseFailure =
  | "invalid_payload"
  | "session_mismatch"
  | "invalid_mapping"
  | "broken_chain"
  | "cyclic_chain"
  | "unverified_root"
  | "invalid_message"
  | "unfinished_message"
  | "unsupported_content"
  | "empty_content"
  | "oversized_content"
  | "visible_branch_mismatch"
  | "missing_role_pair";

export interface NativeConversationReadDiagnostic {
  stage: "guard" | "auth" | "conversation" | "parse";
  code: "success" | "partial_content" | "unsupported_origin" | "no_visible_message_ids" | "cooldown"
    | "rate_limited" | "http_error" | "invalid_json" | "session_unavailable"
    | "network_error" | "timeout" | "aborted" | "parse_rejected";
  httpStatus?: number;
  retryAfterMs?: number;
  parseReason?: NativeConversationParseFailure;
  messageCount?: number;
}

export interface NativeConversationReadOptions {
  manualRetry?: boolean;
  onDiagnostic?: (diagnostic: NativeConversationReadDiagnostic) => void;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function attachmentName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 256) : undefined;
}

/** Capture the transcript and attachment references, never opaque binary data
 * or internal asset URLs. This matches the archive's text-only storage model. */
function messageBody(content: Record<string, unknown>, metadata: Record<string, unknown> | null) {
  const segments: CaptureMessage["segments"] = [];
  let unsupported = false;
  const addText = (text: string, code = false) => {
    if (!text.trim()) return;
    segments.push({ type: code ? "code" : "text", content: text.trim(),
      ...(code && typeof content.language === "string" ? { language: content.language.slice(0, 64) } : {}) });
  };
  const attachments = Array.isArray(metadata?.attachments) ? metadata.attachments : [];
  const attachmentNames = attachments.map((item) => {
    const attachment = record(item);
    return attachmentName(attachment?.name ?? attachment?.filename);
  }).filter((name): name is string => Boolean(name));
  const parts = content.parts ?? (typeof content.text === "string" ? [content.text] : null);
  if (Array.isArray(parts)) {
    let textRun: string[] = [];
    const flush = () => { addText(textRun.join("\n"), content.content_type === "code"); textRun = []; };
    for (const part of parts) {
      if (typeof part === "string") { textRun.push(part); continue; }
      flush();
      const data = record(part);
      if (data?.content_type === "text" && typeof data.text === "string") {
        addText(data.text);
      } else if (data?.content_type === "image_asset_pointer") {
        addText("[图片附件：原图未归档，请在原会话查看]");
      } else {
        // Keep neighboring text and the message's identity/order. Never
        // serialize arbitrary objects (which may hold base64 or internals).
        unsupported = true;
        addText("[此处包含尚未支持的内容，请在原会话查看]");
      }
    }
    flush();
  } else {
    unsupported = true;
    addText("[此消息的内容暂无法解析，请在原会话查看]");
  }
  for (const name of attachmentNames) addText(`[文件附件：${name}；原文件未归档]`);
  if (attachments.length > attachmentNames.length) {
    unsupported = true;
    addText("[存在无法识别名称的文件附件，请在原会话查看]");
  }
  return { segments, unsupported };
}

/** Read only the active, fully linked branch; never flatten sibling answers. */
export function parseChatGptConversation(
  value: unknown,
  sessionId: string,
  visibleMessageIds: string[],
  onRejected?: (reason: NativeConversationParseFailure) => void,
): NativeConversation | null {
  const reject = (reason: NativeConversationParseFailure): null => {
    onRejected?.(reason);
    return null;
  };
  const data = record(value);
  if (!data) return reject("invalid_payload");
  const returnedId = data.conversation_id ?? data.id;
  // Some response versions omit the ID; the reader already binds the GET to
  // this session, and the mounted message IDs must still match its branch.
  if (returnedId !== undefined && returnedId !== sessionId) return reject("session_mismatch");
  const mapping = record(data.mapping);
  if (!mapping || typeof data.current_node !== "string") return reject("invalid_mapping");
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let nodeId: string | null = data.current_node;
  while (nodeId !== null) {
    if (seen.has(nodeId) || seen.size >= 100_000) return reject("cyclic_chain");
    seen.add(nodeId);
    const node = record(mapping[nodeId]);
    if (!node) return reject("broken_chain");
    const rootWithoutParent = node.parent === undefined &&
      (node.message == null || record(record(node.message)?.author)?.role === "system");
    if (!rootWithoutParent && node.parent !== null && typeof node.parent !== "string") return reject("broken_chain");
    if (node.parent === null && node.message != null &&
        record(record(node.message)?.author)?.role !== "system") return reject("unverified_root");
    chain.push(node);
    nodeId = rootWithoutParent ? null : node.parent as string | null;
  }
  const messages: CaptureMessage[] = [];
  let incompleteMessages = 0;
  let unfinishedMessages = 0;
  const messageIds = new Set<string>();
  const orderedChain = chain.reverse();
  const finalAssistantIds = new Set<string>();
  let finalAssistantId: string | undefined;
  for (const node of orderedChain) {
    const message = record(node.message);
    const role = record(message?.author)?.role;
    if (role === "user") {
      if (finalAssistantId) finalAssistantIds.add(finalAssistantId);
      finalAssistantId = undefined;
    } else if (role === "assistant" && typeof message?.id === "string" &&
        message.channel !== "analysis" &&
        record(message.metadata)?.is_visually_hidden_from_conversation !== true &&
        (typeof message.recipient !== "string" || message.recipient === "all")) {
      finalAssistantId = message.id;
    }
  }
  if (finalAssistantId) finalAssistantIds.add(finalAssistantId);
  for (const node of orderedChain) {
    const message = record(node.message);
    if (!message) continue;
    const metadata = record(message.metadata);
    const content = record(message.content);
    const role = record(message.author)?.role;
    // Respect the same user-visible boundary as the DOM collector. Internal
    // prompts, tool calls and hidden reasoning are not conversation messages.
    if (
      (role !== "user" && role !== "assistant") ||
      metadata?.is_visually_hidden_from_conversation === true ||
      message.channel === "analysis" ||
      // A single displayed answer can have several intermediate assistant
      // nodes. Retain the final answer per user turn plus any earlier node
      // explicitly represented by a mounted message ID.
      (role === "assistant" && typeof message.id === "string" &&
        !finalAssistantIds.has(message.id) && !visibleMessageIds.includes(message.id)) ||
      // Commentary before a final answer is often a transient search/progress
      // message, not a separate bubble in the current transcript. Keep it only
      // when the DOM explicitly proves that this message is displayed.
      (role === "assistant" && message.channel === "commentary" &&
        (typeof message.id !== "string" || !visibleMessageIds.includes(message.id))) ||
      (typeof message.recipient === "string" && message.recipient !== "all") ||
      content?.content_type === "thoughts" || content?.content_type === "reasoning_recap"
    ) continue;
    if (
      !content || typeof message.id !== "string" || !message.id ||
      message.id.length > 512 || messageIds.has(message.id)
    ) return reject("invalid_message");
    const body = messageBody(content, metadata);
    if (typeof message.status === "string" && !["finished_successfully", "finished_partial"].includes(message.status)) {
      // Historical replies can remain in_progress after an interrupted request.
      // Status uncertainty concerns this body, not the linked history or dates.
      unfinishedMessages++;
      body.segments.push({ type: "text", content: "[原会话未将此消息标记为完成；已保存当前可读取的正文]" });
    }
    if (message.status === "finished_partial") {
      body.segments.push({ type: "text", content: "[此回答在原会话中已中止]" });
    }
    if (!body.segments.length) {
      body.unsupported = true;
      body.segments.push({ type: "text", content: "[此消息未返回可读取的正文，请在原会话查看]" });
    }
    if (body.unsupported) incompleteMessages++;
    if (body.segments.length > 10_000 || body.segments.some((segment) => segment.content.length > 2_000_000)) return reject("oversized_content");
    const timestamp = typeof message.create_time === "number"
      ? new Date(message.create_time * 1_000)
      : null;
    const model = metadata?.model_slug;
    messageIds.add(message.id);
    messages.push({
      externalMessageId: message.id,
      ordinal: messages.length,
      role,
      ...(typeof model === "string" && model.length <= 256 ? { model } : {}),
      ...(timestamp && Number.isFinite(timestamp.getTime()) ? { createdAt: timestamp.toISOString() } : {}),
      segments: body.segments,
    });
  }
  // A stale API response or a locally selected sibling branch is not a safe
  // replacement for what is on screen. Wait for a later change or use the DOM.
  if (!visibleMessageIds.length || visibleMessageIds.some((id) => !messageIds.has(id))) return reject("visible_branch_mismatch");
  if (!messages.length) return reject("empty_content");
  return {
    messages,
    ...(unfinishedMessages ? { sourceNotice: `${unfinishedMessages} 条原回答在源站未标记完成；已归档当前分支全部 ${messages.length} 条消息及源站返回的正文。` } : {}),
    ...(incompleteMessages ? {
      incompleteReason: `已读取当前分支全部 ${messages.length} 条消息，顺序和原始时间已保留；${[
        incompleteMessages ? `${incompleteMessages} 条含暂无法解析的内容` : "",
      ].filter(Boolean).join("；")}，请在原会话核对`,
      incompleteKind: "unsupported_content" as const,
    } : {}),
    ...(typeof data.title === "string" && data.title.trim()
      ? { title: data.title.trim().slice(0, 500) } : {}),
  };
}

class NativeConversationReadError extends Error {
  constructor(
    readonly code: "http_error" | "invalid_json" | "session_unavailable" | "parse_rejected",
    readonly httpStatus?: number,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}

/** Same-origin, read-only requests, using this tab's login session only. */
export function createNativeConversationReader() {
  const retries = new Map<string, { retryAt: number; rateLimitedUntil: number; failures: number }>();
  return async (
    provider: string,
    sessionId: string,
    visibleMessageIds: string[],
    signal?: AbortSignal,
    options: NativeConversationReadOptions = {},
  ): Promise<NativeConversation | null> => {
    // Diagnostics contain only fixed codes and numbers. Never forward response
    // bodies, exception messages, conversation IDs or session credentials.
    const report = (diagnostic: NativeConversationReadDiagnostic) => {
      try { options.onDiagnostic?.(diagnostic); } catch { /* Observability must not interrupt capture. */ }
    };
    if (
      provider !== "chatgpt" ||
      !["chatgpt.com", "chat.openai.com"].includes(location.hostname) ||
      location.protocol !== "https:"
    ) {
      report({ stage: "guard", code: "unsupported_origin" });
      return null;
    }
    if (!visibleMessageIds.length) {
      report({ stage: "guard", code: "no_visible_message_ids" });
      return null;
    }
    const origin = location.origin;
    const retryKey = `${origin}:${sessionId}`;
    const retry = retries.get(retryKey);
    if (retry && Date.now() < retry.rateLimitedUntil) {
      report({ stage: "guard", code: "rate_limited", retryAfterMs: retry.rateLimitedUntil - Date.now() });
      return null;
    }
    if (retry && !options.manualRetry && Date.now() < retry.retryAt) {
      report({ stage: "guard", code: "cooldown", retryAfterMs: retry.retryAt - Date.now() });
      return null;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 8_000);
    let stage: NativeConversationReadDiagnostic["stage"] = "auth";
    let parseReason: NativeConversationParseFailure | undefined;
    const get = async (path: string, token?: string) => {
      const response = await fetch(new URL(path, origin), {
        method: "GET",
        credentials: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      if (!response.ok) {
        let retryAfterMs = 0;
        const retryAfter = response.headers.get("Retry-After");
        if (response.status === 429 && retryAfter) {
          const seconds = Number(retryAfter);
          retryAfterMs = Number.isFinite(seconds)
            ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
        }
        throw new NativeConversationReadError("http_error", response.status, retryAfterMs);
      }
      try {
        return await response.json() as unknown;
      } catch {
        throw new NativeConversationReadError("invalid_json");
      }
    };
    try {
      const session = record(await get("/api/auth/session"));
      if (typeof session?.accessToken !== "string" || !session.accessToken) {
        throw new NativeConversationReadError("session_unavailable");
      }
      stage = "conversation";
      const data = await get(`/backend-api/conversation/${encodeURIComponent(sessionId)}`, session.accessToken);
      stage = "parse";
      const parsed = parseChatGptConversation(data, sessionId, visibleMessageIds, (reason) => { parseReason = reason; });
      if (!parsed) throw new NativeConversationReadError("parse_rejected");
      retries.delete(retryKey);
      report(parsed.incompleteReason
        ? { stage, code: "partial_content", parseReason: parsed.incompleteKind ?? "unsupported_content", messageCount: parsed.messages.length }
        : { stage, code: "success" });
      return parsed;
    } catch (error) {
      if (signal?.aborted) {
        report({ stage, code: "aborted" });
      } else {
        const failures = (retry?.failures ?? 0) + 1;
        const requestError = error instanceof NativeConversationReadError ? error : undefined;
        const requestedDelay = requestError?.retryAfterMs ?? 0;
        const retryAfterMs = Math.max(
          Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)),
          Number.isFinite(requestedDelay) ? Math.min(3_600_000, requestedDelay) : 0,
        );
        const retryAt = Date.now() + retryAfterMs;
        const rateLimited = requestError?.httpStatus === 429;
        retries.set(retryKey, { retryAt, rateLimitedUntil: rateLimited ? retryAt : 0, failures });
        report({
          stage,
          code: controller.signal.aborted ? "timeout"
            : rateLimited ? "rate_limited" : requestError?.code ?? "network_error",
          retryAfterMs,
          ...(requestError?.httpStatus !== undefined ? { httpStatus: requestError.httpStatus } : {}),
          ...(parseReason ? { parseReason } : {}),
        });
      }
      return null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}
