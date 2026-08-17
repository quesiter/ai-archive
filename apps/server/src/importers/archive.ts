import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parse as parseHtml } from "node-html-parser";
import { unzipSync } from "fflate";
import type { CaptureMessage, CaptureSnapshotV1, Provider } from "@ai-archive/contracts";

type ZipFiles = Record<string, Uint8Array>;

export const MAX_ARCHIVE_COMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 10_000;
export const MAX_ARCHIVE_ENTRY_BYTES = 128 * 1024 * 1024;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 512 * 1024 * 1024;

function unzipArchive(buffer: Buffer): ZipFiles {
  if (buffer.length > MAX_ARCHIVE_COMPRESSED_BYTES) {
    throw new Error("Archive exceeds the compressed size limit");
  }
  let entries = 0;
  let uncompressedBytes = 0;
  return unzipSync(new Uint8Array(buffer), {
    filter(file) {
      entries += 1;
      uncompressedBytes += file.originalSize;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        throw new Error("Archive contains too many entries");
      }
      if (file.originalSize > MAX_ARCHIVE_ENTRY_BYTES) {
        throw new Error(`Archive entry is too large: ${file.name}`);
      }
      if (uncompressedBytes > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
        throw new Error("Archive expands beyond the allowed size");
      }
      return /(?:\.json|\.html?|\.txt)$/i.test(file.name);
    },
  });
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return asText(record.text ?? record.content ?? record.parts ?? "");
  }
  return "";
}

function isoFromEpoch(value: unknown): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return new Date(value * (value < 10_000_000_000 ? 1_000 : 1)).toISOString();
}

interface ChatGptNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: {
    id?: string;
    author?: { role?: string };
    create_time?: number;
    metadata?: Record<string, unknown>;
    content?: { parts?: unknown[]; text?: string };
  } | null;
}

function chatGptMessagesForLeaf(
  mapping: Record<string, ChatGptNode>,
  leafId: string,
): CaptureMessage[] {
  const chain: ChatGptNode[] = [];
  let current: string | null | undefined = leafId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const node: ChatGptNode | undefined = mapping[current];
    if (!node) break;
    chain.push(node);
    current = node.parent;
  }
  return chain
    .reverse()
    .flatMap((node) => {
      const message = node.message;
      if (!message) return [];
      const text = asText(message.content?.parts ?? message.content?.text ?? "").trim();
      if (!text) return [];
      const rawRole = message.author?.role;
      const role = ["user", "assistant", "system", "tool"].includes(rawRole ?? "")
        ? (rawRole as CaptureMessage["role"])
        : "unknown";
      const model = message.metadata?.model_slug;
      return [
        {
          externalMessageId: message.id,
          ordinal: 0,
          role,
          ...(typeof model === "string" ? { model } : {}),
          ...(isoFromEpoch(message.create_time)
            ? { createdAt: isoFromEpoch(message.create_time)! }
            : {}),
          segments: [{ type: "text" as const, content: text }],
        },
      ];
    })
    .map((message, ordinal) => ({ ...message, ordinal }));
}

function parseChatGpt(files: ZipFiles): CaptureSnapshotV1[] {
  const entry = Object.entries(files).find(([name]) =>
    /(^|\/)conversations\.json$/i.test(name),
  );
  if (!entry) return [];
  const data = JSON.parse(decode(entry[1])) as Array<Record<string, unknown>>;
  const snapshots: CaptureSnapshotV1[] = [];
  for (const conversation of data) {
    const mapping = conversation.mapping as Record<string, ChatGptNode> | undefined;
    const sessionId = String(conversation.id ?? conversation.conversation_id ?? "");
    if (!mapping || !sessionId) continue;
    const leaves = Object.entries(mapping)
      .filter(([, node]) => !node?.children?.length)
      .map(([id]) => id);
    const uniqueBranches = new Set<string>();
    for (const leaf of leaves.length ? leaves : Object.keys(mapping).slice(-1)) {
      const messages = chatGptMessagesForLeaf(mapping, leaf);
      if (!messages.length) continue;
      const branchFingerprint = hash(
        messages.map((message) => `${message.role}:${asText(message.segments)}`).join("|"),
      );
      if (uniqueBranches.has(branchFingerprint)) continue;
      uniqueBranches.add(branchFingerprint);
      snapshots.push({
        schemaVersion: 1,
        provider: "chatgpt",
        sessionId,
        branchFingerprint,
        title: typeof conversation.title === "string" ? conversation.title : undefined,
        adapterVersion: "chatgpt-export-v1",
        capturedAt:
          isoFromEpoch(conversation.update_time ?? conversation.create_time) ??
          new Date().toISOString(),
        captureMode: "import",
        triggerReason: "historical_import",
        completeness: {
          status: "complete",
          topReached: true,
          bottomReached: true,
          stable: true,
        },
        messages,
      });
    }
  }
  return snapshots;
}

function walkObjects(value: unknown, visitor: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visitor);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  visitor(record);
  for (const child of Object.values(record)) walkObjects(child, visitor);
}

function parseGeminiJson(files: ZipFiles): CaptureSnapshotV1[] {
  const grouped = new Map<string, CaptureMessage[]>();
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.json$/i.test(name) || !/gemini|my activity/i.test(name)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(decode(bytes));
    } catch {
      continue;
    }
    walkObjects(parsed, (record) => {
      const prompt = asText(
        record.prompt ?? record.user_query ?? record.userQuery ?? record.question,
      ).trim();
      const response = asText(
        record.response ?? record.model_response ?? record.modelResponse ?? record.answer,
      ).trim();
      if (!prompt && !response) return;
      const sessionId = String(
        record.conversation_id ?? record.conversationId ?? record.session_id ??
          `gemini-${hash(`${prompt}|${response}`).slice(0, 24)}`,
      );
      const list = grouped.get(sessionId) ?? [];
      if (prompt) {
        list.push({
          ordinal: list.length,
          role: "user",
          segments: [{ type: "text", content: prompt }],
        });
      }
      if (response) {
        list.push({
          ordinal: list.length,
          role: "assistant",
          segments: [{ type: "text", content: response }],
        });
      }
      grouped.set(sessionId, list);
    });
  }
  return Array.from(grouped, ([sessionId, messages]) => {
    const roles = new Set(messages.map((message) => message.role));
    const hasFullTurn = roles.has("user") && roles.has("assistant");
    return {
      schemaVersion: 1 as const,
      provider: "gemini" as const,
      sessionId,
      branchFingerprint: hash(JSON.stringify(messages)),
      adapterVersion: "gemini-takeout-v1",
      capturedAt: new Date().toISOString(),
      captureMode: "import" as const,
      triggerReason: "historical_import" as const,
      completeness: {
        status: hasFullTurn ? ("complete" as const) : ("partial" as const),
        topReached: true,
        bottomReached: true,
        stable: true,
        ...(!hasFullTurn
          ? { reason: "Takeout item did not include both the prompt and response" }
          : {}),
      },
      messages,
    };
  });
}

function parseGeminiHtml(files: ZipFiles): CaptureSnapshotV1[] {
  const snapshots: CaptureSnapshotV1[] = [];
  for (const [name, bytes] of Object.entries(files)) {
    if (!/\.html?$/i.test(name) || !/gemini|myactivity|my activity/i.test(name)) continue;
    const root = parseHtml(decode(bytes));
    const entries = root.querySelectorAll(".outer-cell, .mdl-grid, article");
    for (const [index, entry] of entries.entries()) {
      const text = entry.text.trim().replace(/\s+/g, " ");
      if (text.length < 2) continue;
      const sessionId = `gemini-takeout-${hash(`${name}:${index}:${text}`).slice(0, 24)}`;
      snapshots.push({
        schemaVersion: 1,
        provider: "gemini",
        sessionId,
        branchFingerprint: hash(text),
        title: "Gemini Takeout activity",
        adapterVersion: "gemini-takeout-html-v1",
        capturedAt: new Date().toISOString(),
        captureMode: "import",
        triggerReason: "historical_import",
        completeness: {
          status: "partial",
          topReached: true,
          bottomReached: true,
          stable: true,
          reason: "Takeout HTML does not prove a complete prompt/response turn",
        },
        messages: [
          {
            ordinal: 0,
            role: "user",
            segments: [{ type: "text", content: text }],
          },
        ],
      });
    }
  }
  return snapshots;
}

const CHAT_MEMO_MESSAGE_MARKER = /^(User|AI)\s*:\s*\[([^\]\r\n]+)\]\s*\r?$/gm;

function chatMemoProvider(value: string | undefined): Provider | undefined {
  const normalized = (value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (normalized === "chatgpt" || normalized === "openai") return "chatgpt";
  if (normalized === "gemini" || normalized === "googlegemini") return "gemini";
  if (normalized === "腾讯元宝" || normalized === "元宝" || normalized === "tencentyuanbao") {
    return "yuanbao";
  }
  if (normalized === "豆包" || normalized === "doubao") return "doubao";
  if (normalized === "deepseek") return "deepseek";
  if (normalized === "千问" || normalized === "通义千问" || normalized === "qwen") {
    return "qianwen";
  }
  if (normalized === "kimi") return "kimi";
  if (normalized === "grok") return "grok";
  if (normalized === "minimax" || normalized === "minimaxagent") return "minimax_agent";
  if (normalized === "openclaw") return "openclaw";
  return undefined;
}

function chatMemoDate(value: string | undefined): string | undefined {
  const source = value?.trim();
  if (!source) return undefined;
  const candidates = [source, source.replace(" ", "T")];
  for (const candidate of candidates) {
    const withZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(candidate)
      ? candidate
      : `${candidate}+08:00`;
    const date = new Date(withZone);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return undefined;
}

function chatMemoHeader(text: string, key: string): string | undefined {
  const match = text.match(new RegExp(`^${key}:\\s*(.*?)\\s*$`, "mi"));
  const value = match?.[1]?.trim();
  return value || undefined;
}

function chatMemoFilenameTitle(name: string): string | undefined {
  const base = basename(name).replace(/\.txt$/i, "");
  const title = base
    .replace(/^[^_]+_\d{14}_?/i, "")
    .replace(/_/g, " ")
    .trim();
  return title || undefined;
}

function chatMemoSessionId(
  canonicalUrl: string | undefined,
  provider: Provider,
  fallback: string,
): string {
  if (canonicalUrl) {
    try {
      const url = new URL(canonicalUrl);
      const segments = url.pathname.split("/").filter(Boolean);
      const marker = provider === "chatgpt" ? "c" : provider === "gemini" ? "app" : undefined;
      const markerIndex = marker
        ? segments.findIndex((segment) => segment.toLowerCase() === marker)
        : -1;
      // Several Chinese platforms use /chat/<account>/<session>, so their
      // stable session ID is the final path component rather than the value
      // immediately after /chat.
      const marked = markerIndex >= 0 ? segments[markerIndex + 1] : undefined;
      const candidate = marked || segments.at(-1);
      if (candidate && !["chat", "app", "conversation"].includes(candidate.toLowerCase())) {
        return decodeURIComponent(candidate).slice(0, 1_024);
      }
    } catch {
      // Fall back to a stable local ID when Chat Memo contains a malformed URL.
    }
  }
  return `chat-memo:${provider}:${hash(fallback).slice(0, 40)}`;
}

function chatMemoTitle(
  headerTitle: string | undefined,
  filenameTitle: string | undefined,
  firstUserText: string | undefined,
): string | undefined {
  const normalizedHeader = headerTitle?.replace(/\s+/g, " ").trim();
  const generic = !normalizedHeader || /^(新对话|你说|网页搜索|new chat|untitled)$/i.test(normalizedHeader);
  const candidate = generic ? filenameTitle || firstUserText : normalizedHeader;
  const normalized = candidate?.replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, 2_048) : undefined;
}

function parseChatMemoEntry(name: string, text: string): CaptureSnapshotV1 | null {
  const firstMarker = text.search(/^(User|AI)\s*:\s*\[/m);
  const headerText = firstMarker >= 0 ? text.slice(0, firstMarker) : text;
  const provider = chatMemoProvider(chatMemoHeader(headerText, "Platform"));
  if (!provider) return null;

  const canonicalUrl = chatMemoHeader(headerText, "URL");
  const createdAt = chatMemoDate(chatMemoHeader(headerText, "Created"));
  const declaredMessages = Number(chatMemoHeader(headerText, "Messages"));
  const markers = [...text.matchAll(CHAT_MEMO_MESSAGE_MARKER)];
  const messages: CaptureMessage[] = [];
  for (const [ordinal, marker] of markers.entries()) {
    const role = marker[1] === "User" ? "user" : "assistant";
    const bodyStart = (marker.index ?? 0) + marker[0].length;
    const bodyEnd = markers[ordinal + 1]?.index ?? text.length;
    const content = text.slice(bodyStart, bodyEnd).replace(/^\r?\n/, "").trim();
    if (!content) continue;
    const timestamp = chatMemoDate(marker[2]);
    messages.push({
      ordinal: messages.length,
      role,
      ...(timestamp ? { createdAt: timestamp } : {}),
      segments: [{ type: "text", content }],
    });
  }
  if (!messages.length) return null;

  const filenameTitle = chatMemoFilenameTitle(name);
  const title = chatMemoTitle(
    chatMemoHeader(headerText, "Title"),
    filenameTitle,
    messages.find((message) => message.role === "user")?.segments[0]?.content,
  );
  const sessionId = chatMemoSessionId(canonicalUrl, provider, `${name}:${messages[0]?.segments[0]?.content ?? ""}`);
  const branchFingerprint = hash(
    JSON.stringify(
      messages.map((message) => ({
        ordinal: message.ordinal,
        role: message.role,
        segments: message.segments,
      })),
    ),
  );
  const complete = Number.isInteger(declaredMessages) && declaredMessages > 0 && declaredMessages === markers.length && markers.length === messages.length;
  return {
    schemaVersion: 1,
    provider,
    sessionId,
    branchFingerprint,
    ...(title ? { title } : {}),
    ...(canonicalUrl && /^https?:\/\//i.test(canonicalUrl) ? { canonicalUrl } : {}),
    adapterVersion: "chat-memo-text-v1",
    capturedAt: createdAt ?? messages.at(-1)?.createdAt ?? new Date().toISOString(),
    captureMode: "import",
    triggerReason: "historical_import",
    completeness: complete
      ? { status: "complete", topReached: true, bottomReached: true, stable: true }
      : {
          status: "partial",
          topReached: markers.length > 0,
          bottomReached: markers.length > 0,
          stable: true,
          reason: "Chat Memo export message count or message markers are incomplete",
        },
    messages,
  };
}

export async function parseArchive(path: string): Promise<{
  provider: Provider | undefined;
  providers: Provider[];
  fileHash: string;
  filename: string;
  snapshots: CaptureSnapshotV1[];
}> {
  const buffer = await readFile(path);
  const files = unzipArchive(buffer);
  const chatGpt = parseChatGpt(files);
  if (chatGpt.length) {
    return {
      provider: "chatgpt",
      providers: ["chatgpt"],
      fileHash: hash(buffer.toString("base64")),
      filename: basename(path),
      snapshots: chatGpt,
    };
  }
  const gemini = [...parseGeminiJson(files), ...parseGeminiHtml(files)];
  if (gemini.length) {
    return {
      provider: "gemini",
      providers: ["gemini"],
      fileHash: hash(buffer.toString("base64")),
      filename: basename(path),
      snapshots: gemini,
    };
  }
  const chatMemo = Object.entries(files)
    .filter(([name]) => /\.txt$/i.test(name))
    .map(([name, bytes]) => parseChatMemoEntry(name, decode(bytes)))
    .filter((snapshot): snapshot is CaptureSnapshotV1 => Boolean(snapshot));
  if (chatMemo.length) {
    const providers = [...new Set(chatMemo.map((snapshot) => snapshot.provider))];
    return {
      provider: providers.length === 1 ? providers[0] : undefined,
      providers,
      fileHash: hash(buffer.toString("base64")),
      filename: basename(path),
      snapshots: chatMemo,
    };
  }
  throw new Error("Archive is not a recognized ChatGPT, Gemini, or Chat Memo export");
}
