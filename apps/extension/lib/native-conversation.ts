import type { CaptureMessage } from "@ai-archive/contracts";

export interface NativeConversation {
  title?: string;
  messages: CaptureMessage[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Read only the active, fully linked branch; never flatten sibling answers. */
export function parseChatGptConversation(
  value: unknown,
  sessionId: string,
  visibleMessageIds: string[],
): NativeConversation | null {
  const data = record(value);
  if (!data) return null;
  const returnedId = data.conversation_id ?? data.id;
  // Some response versions omit the ID; the reader already binds the GET to
  // this session, and the mounted message IDs must still match its branch.
  if (returnedId !== undefined && returnedId !== sessionId) return null;
  const mapping = record(data.mapping);
  if (!mapping || typeof data.current_node !== "string") return null;
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let nodeId: string | null = data.current_node;
  while (nodeId !== null) {
    if (seen.has(nodeId) || seen.size >= 100_000) return null;
    seen.add(nodeId);
    const node = record(mapping[nodeId]);
    if (!node) return null;
    const rootWithoutParent = node.parent === undefined &&
      (node.message == null || record(record(node.message)?.author)?.role === "system");
    if (!rootWithoutParent && node.parent !== null && typeof node.parent !== "string") return null;
    chain.push(node);
    nodeId = rootWithoutParent ? null : node.parent as string | null;
  }
  const messages: CaptureMessage[] = [];
  const messageIds = new Set<string>();
  for (const node of chain.reverse()) {
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
      (typeof message.recipient === "string" && message.recipient !== "all") ||
      content?.content_type === "thoughts" || content?.content_type === "reasoning_recap"
    ) continue;
    if (
      !content || typeof message.id !== "string" || !message.id ||
      message.id.length > 512 || messageIds.has(message.id) ||
      (typeof message.status === "string" && message.status !== "finished_successfully")
    ) return null;
    const parts = content.parts ?? (typeof content.text === "string" ? [content.text] : null);
    // Unknown/multimedia payloads must fall back to the DOM, rather than being
    // silently omitted from a snapshot labelled complete.
    if (!Array.isArray(parts) || !parts.every((part) => typeof part === "string")) return null;
    const text = parts.join("\n").trim();
    if (!text || text.length > 2_000_000) return null;
    const timestamp = typeof message.create_time === "number"
      ? new Date(message.create_time * 1_000)
      : null;
    const model = metadata?.model_slug;
    const language = content.language;
    messageIds.add(message.id);
    messages.push({
      externalMessageId: message.id,
      ordinal: messages.length,
      role,
      ...(typeof model === "string" && model.length <= 256 ? { model } : {}),
      ...(timestamp && Number.isFinite(timestamp.getTime()) ? { createdAt: timestamp.toISOString() } : {}),
      segments: [{
        type: content.content_type === "code" ? "code" : "text",
        content: text,
        ...(content.content_type === "code" && typeof language === "string"
          ? { language: language.slice(0, 64) } : {}),
      }],
    });
  }
  // A stale API response or a locally selected sibling branch is not a safe
  // replacement for what is on screen. Wait for a later change or use the DOM.
  if (!visibleMessageIds.length || visibleMessageIds.some((id) => !messageIds.has(id))) return null;
  if (!messages.some((message) => message.role === "user") ||
      !messages.some((message) => message.role === "assistant")) return null;
  return {
    messages,
    ...(typeof data.title === "string" && data.title.trim()
      ? { title: data.title.trim().slice(0, 500) } : {}),
  };
}

/** Same-origin, read-only requests, using this tab's login session only. */
export function createNativeConversationReader() {
  let retryAt = 0;
  let failures = 0;
  return async (
    provider: string,
    sessionId: string,
    visibleMessageIds: string[],
    signal?: AbortSignal,
  ): Promise<NativeConversation | null> => {
    if (
      provider !== "chatgpt" ||
      !["chatgpt.com", "chat.openai.com"].includes(location.hostname) ||
      location.protocol !== "https:" || Date.now() < retryAt ||
      !visibleMessageIds.length
    ) return null;
    const origin = location.origin;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, 8_000);
    let retryAfterMs = 0;
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
        const retryAfter = response.headers.get("Retry-After");
        if (response.status === 429 && retryAfter) {
          const seconds = Number(retryAfter);
          retryAfterMs = Number.isFinite(seconds)
            ? seconds * 1_000 : Date.parse(retryAfter) - Date.now();
        }
        throw new Error("Native conversation read unavailable");
      }
      return response.json() as Promise<unknown>;
    };
    try {
      const session = record(await get("/api/auth/session"));
      if (typeof session?.accessToken !== "string" || !session.accessToken) {
        throw new Error("Native conversation session unavailable");
      }
      const data = await get(`/backend-api/conversation/${encodeURIComponent(sessionId)}`, session.accessToken);
      const parsed = parseChatGptConversation(data, sessionId, visibleMessageIds);
      if (!parsed) throw new Error("Native conversation branch not ready");
      failures = 0;
      retryAt = 0;
      return parsed;
    } catch {
      if (!signal?.aborted) {
        failures += 1;
        retryAt = Date.now() + Math.max(
          Math.min(300_000, 30_000 * 2 ** Math.min(failures - 1, 4)),
          Number.isFinite(retryAfterMs) ? Math.min(3_600_000, retryAfterMs) : 0,
        );
      }
      return null;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  };
}
