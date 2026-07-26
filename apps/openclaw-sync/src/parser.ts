import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  CaptureDeltaV1,
  CaptureMessage,
  CaptureSnapshotV1,
  CaptureTriggerReason,
  MessageRole,
  MessageSegment,
} from "@ai-archive/contracts";

const CODEX_TOOL_ARGUMENT_LIMIT = 1_200;
const CODEX_TOOL_OUTPUT_LIMIT = 600;
const CODEX_TOOL_BUDGET_BYTES = 10 * 1024 * 1024;
const TOOL_JSON_DEPTH_LIMIT = 6;
const TOOL_JSON_ARRAY_LIMIT = 40;
const TOOL_JSON_OBJECT_KEY_LIMIT = 80;
const TOOL_JSON_STRING_LIMIT = 2_000;
const OPENCLAW_ADAPTER_VERSION = "openclaw-jsonl-v2";
const CODEX_ADAPTER_VERSION = "codex-jsonl-v4";
const CLAUDE_CODE_ADAPTER_VERSION = "claude-code-jsonl-v2";
const ANSI_ESCAPE_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const UNSUPPORTED_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export class EmptyOpenClawTranscriptError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super("OpenClaw transcript contains no textual messages");
    this.name = "EmptyOpenClawTranscriptError";
    this.sessionId = sessionId;
  }
}

function omitted(label: string, detail?: string): string {
  return `[omitted ${label}${detail ? `: ${detail}` : ""}]`;
}

function sanitizeTranscriptText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_PATTERN, "")
    .replace(UNSUPPORTED_CONTROL_PATTERN, "");
}

function looksLikeEncodedBlob(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^data:image\//i.test(trimmed) ||
    /^data:application\/octet-stream/i.test(trimmed) ||
    (trimmed.length > 4_096 &&
      /^[A-Za-z0-9+/=_-]+$/.test(trimmed) &&
      !/\s/.test(trimmed))
  );
}

function trimForTool(value: string, maxLength = TOOL_JSON_STRING_LIMIT): string {
  const sanitized = sanitizeTranscriptText(value);
  if (looksLikeEncodedBlob(sanitized)) {
    return omitted("encoded or binary content", `${sanitized.length} chars`);
  }
  return sanitized.length > maxLength
    ? `${sanitized.slice(0, maxLength)}\n[truncated ${sanitized.length - maxLength} chars]`
    : sanitized;
}

function text(value: unknown): string {
  if (typeof value === "string") return trimForTool(value, 200_000).trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          const record = item as Record<string, unknown>;
          if (
            record.type === "image" ||
            record.type === "image_url" ||
            record.type === "input_image"
          ) {
            return "";
          }
          return text(
            record.text ??
              record.content ??
              record.output ??
              record.result ??
              record.parts ??
              "",
          );
        }
        return text(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return text(
      record.text ??
        record.content ??
        record.output ??
        record.result ??
        record.parts ??
        "",
    );
  }
  return "";
}

function normalizeRole(value: unknown, type: unknown): MessageRole {
  const candidate = `${typeof value === "string" ? value : ""} ${typeof type === "string" ? type : ""}`.toLowerCase();
  if (/\b(user|human|input)\b/.test(candidate)) return "user";
  if (/\b(assistant|model|agent|output)\b/.test(candidate)) return "assistant";
  if (/(^|[\s_-])(tool|function)([\s_-]|$)/.test(candidate)) return "tool";
  if (/\b(system)\b/.test(candidate)) return "system";
  return "unknown";
}

function normalizedSegmentContent(type: string, content: string): string {
  return type === "code" ? content : content.replace(/\r\n/g, "\n").trim();
}

export function captureMessageFingerprint(message: {
  externalMessageId?: string | undefined;
  role: MessageRole;
  segments: CaptureMessage["segments"];
}): string {
  return createHash("sha256")
    .update(
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
    )
    .digest("hex");
}

function isoDate(value: unknown): string | undefined {
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  if (typeof value === "number") {
    const date = new Date(value < 10_000_000_000 ? value * 1_000 : value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function messageFromRecord(
  record: Record<string, unknown>,
  ordinal: number,
): CaptureMessage | null {
  const nested =
    record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : record;
  const role = normalizeRole(
    nested.role ??
      (nested.author && typeof nested.author === "object"
        ? (nested.author as Record<string, unknown>).role
        : undefined),
    record.type ?? nested.type,
  );
  const segments: MessageSegment[] = [];
  const main = text(nested.content ?? nested.text ?? nested.message);
  const reasoning = text(nested.reasoning ?? nested.reasoning_content ?? record.reasoning);
  const toolName = text(nested.toolName ?? nested.tool_name ?? record.toolName);
  const toolInput = text(nested.toolInput ?? nested.tool_input ?? record.toolInput);
  const toolResult = text(nested.toolResult ?? nested.tool_result ?? record.toolResult);
  if (main) segments.push({ type: "text", content: main });
  if (reasoning) segments.push({ type: "reasoning", content: reasoning });
  if (toolName || toolInput || toolResult) {
    segments.push({
      type: "tool_status",
      content: [toolName && `tool: ${toolName}`, toolInput, toolResult]
        .filter(Boolean)
        .join("\n"),
    });
  }
  if (!segments.length) return null;
  const externalId = nested.id ?? record.id ?? record.messageId;
  const model = nested.model ?? record.model;
  const createdAt = isoDate(
    nested.createdAt ?? nested.created_at ?? nested.timestamp ?? record.timestamp,
  );
  return {
    ordinal,
    role,
    ...(typeof externalId === "string" ? { externalMessageId: externalId } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(createdAt ? { createdAt } : {}),
    segments,
  };
}

export function parseOpenClawJsonl(input: {
  path: string;
  content: string;
  capturedAt?: Date;
}): CaptureSnapshotV1 {
  const records: Array<Record<string, unknown>> = [];
  const lines = input.content.split(/\r?\n/);
  const lastNonEmptyLine = lines.reduce(
    (last, line, index) => (line.trim() ? index : last),
    -1,
  );
  let trailingPartial = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") records.push(parsed as Record<string, unknown>);
    } catch {
      if (index === lastNonEmptyLine) {
        trailingPartial = true;
        continue;
      }
      throw new Error(`Malformed OpenClaw JSONL at line ${index + 1}`);
    }
  }
  const header = records[0] ?? {};
  const nestedSession =
    header.session && typeof header.session === "object"
      ? (header.session as Record<string, unknown>)
      : undefined;
  const sessionId = String(
    header.sessionId ??
      header.session_id ??
      header.id ??
      nestedSession?.id ??
      nestedSession?.sessionId ??
      basename(input.path).replace(/\.jsonl(?:\..+)?$/i, ""),
  );
  const messages = records
    .map((record, ordinal) => messageFromRecord(record, ordinal))
    .filter((message): message is CaptureMessage => Boolean(message))
    .map((message, ordinal) => ({ ...message, ordinal }));
  if (!messages.length) throw new EmptyOpenClawTranscriptError(sessionId);
  const fingerprint = createHash("sha256")
    .update(
      messages
        .map((message) => `${message.role}:${JSON.stringify(message.segments)}`)
        .join("\n"),
    )
    .digest("hex");
  return {
    schemaVersion: 1,
    provider: "openclaw",
    sessionId,
    branchFingerprint: fingerprint,
    title:
      typeof header.title === "string"
        ? header.title
        : `OpenClaw ${sessionId.slice(0, 12)}`,
    adapterVersion: OPENCLAW_ADAPTER_VERSION,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    captureMode: "import",
    triggerReason: "local_file_rewritten",
    completeness: {
      status: trailingPartial ? "partial" : "complete",
      topReached: true,
      bottomReached: true,
      stable: !trailingPartial,
      ...(trailingPartial ? { reason: "Transcript ended with a partial JSONL record" } : {}),
    },
    messages,
  };
}

function jsonlRecords(content: string): {
  records: Array<Record<string, unknown>>;
  trailingPartial: boolean;
} {
  const records: Array<Record<string, unknown>> = [];
  const lines = content.split(/\r?\n/);
  const lastNonEmptyLine = lines.reduce(
    (last, line, index) => (line.trim() ? index : last),
    -1,
  );
  let trailingPartial = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") records.push(parsed as Record<string, unknown>);
    } catch {
      if (index === lastNonEmptyLine) {
        trailingPartial = true;
        continue;
      }
      throw new Error(`Malformed JSONL at line ${index + 1}`);
    }
  }
  return { records, trailingPartial };
}

function tolerantJsonlRecords(content: string): {
  records: Array<Record<string, unknown>>;
  trailingPartial: boolean;
} {
  const records: Array<Record<string, unknown>> = [];
  const lines = content.split(/\r?\n/);
  const lastNonEmptyLine = lines.reduce(
    (last, line, index) => (line.trim() ? index : last),
    -1,
  );
  let trailingPartial = false;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") records.push(parsed as Record<string, unknown>);
    } catch {
      if (index === lastNonEmptyLine) trailingPartial = true;
    }
  }
  return { records, trailingPartial };
}

function contentItemsText(value: unknown): string {
  if (!Array.isArray(value)) return text(value);
  return value
    .map((item) => {
      if (!item || typeof item !== "object") return text(item);
      const record = item as Record<string, unknown>;
      if (record.type === "input_image" || record.type === "image") return "";
      return text(record.text ?? record.content ?? record.output ?? record.result ?? "");
    })
    .filter(Boolean)
    .join("\n");
}

function codexRole(value: unknown): MessageRole | null {
  if (value === "user") return "user";
  if (value === "assistant") return "assistant";
  if (value === "system") return "system";
  if (value === "tool") return "tool";
  return null;
}

function sanitizeToolJson(
  value: unknown,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return trimForTool(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return omitted("circular reference");
  if (depth >= TOOL_JSON_DEPTH_LIMIT) return omitted("deep object");
  seen.add(value);

  if (Array.isArray(value)) {
    return [
      ...value.slice(0, TOOL_JSON_ARRAY_LIMIT).map((item) =>
        sanitizeToolJson(item, depth + 1, seen),
      ),
      ...(value.length > TOOL_JSON_ARRAY_LIMIT
        ? [omitted("array items", `${value.length - TOOL_JSON_ARRAY_LIMIT} more`)]
        : []),
    ];
  }

  const result: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, item] of entries.slice(0, TOOL_JSON_OBJECT_KEY_LIMIT)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "_meta" ||
      lowerKey.includes("metadata_passthrough") ||
      lowerKey.includes("screenshot") ||
      lowerKey.includes("base64") ||
      lowerKey.includes("blob")
    ) {
      result[key] = omitted(key);
      continue;
    }
    result[key] = sanitizeToolJson(item, depth + 1, seen);
  }
  if (entries.length > TOOL_JSON_OBJECT_KEY_LIMIT) {
    result.__omittedKeys = entries.length - TOOL_JSON_OBJECT_KEY_LIMIT;
  }
  return result;
}

function conciseJson(value: unknown, maxLength = CODEX_TOOL_OUTPUT_LIMIT): string {
  const content =
    typeof value === "string"
      ? trimForTool(value)
      : JSON.stringify(sanitizeToolJson(value), null, 2) ?? "";
  return content.length > maxLength
    ? `${content.slice(0, maxLength)}\n[truncated ${content.length - maxLength} chars]`
    : content;
}

function fitCodexMessages(messages: CaptureMessage[]): CaptureMessage[] {
  const output: CaptureMessage[] = [];
  let toolBytes = 0;
  let omittedToolMessages = 0;

  const flushOmitted = () => {
    if (!omittedToolMessages) return;
    output.push({
      ordinal: output.length,
      role: "tool",
      segments: [
        {
          type: "tool_status",
          content: omitted(
            "Codex tool messages to keep the import payload small",
            `${omittedToolMessages} messages`,
          ),
        },
      ],
    });
    omittedToolMessages = 0;
  };

  for (const message of messages) {
    if (message.role !== "tool") {
      flushOmitted();
      output.push(message);
      continue;
    }

    const size = Buffer.byteLength(JSON.stringify(message));
    if (toolBytes + size <= CODEX_TOOL_BUDGET_BYTES) {
      flushOmitted();
      output.push(message);
      toolBytes += size;
    } else {
      omittedToolMessages += 1;
    }
  }
  flushOmitted();

  return output.map((message, ordinal) => ({ ...message, ordinal }));
}

function codexMessageFromPayload(
  payload: Record<string, unknown>,
  ordinal: number,
  timestamp: unknown,
): CaptureMessage | null {
  const type = payload.type;
  if (type === "message") {
    const role = codexRole(payload.role);
    if (!role) return null;
    const content = contentItemsText(payload.content).trim();
    if (!content) return null;
    return {
      ordinal,
      role,
      ...(isoDate(timestamp) ? { createdAt: isoDate(timestamp)! } : {}),
      segments: [{ type: "text", content }],
    };
  }

  if (type === "function_call" || type === "custom_tool_call") {
    const name = text(payload.name || type);
    const input = conciseJson(
      payload.arguments ?? payload.input ?? "",
      CODEX_TOOL_ARGUMENT_LIMIT,
    );
    const content = [name && `tool: ${name}`, input].filter(Boolean).join("\n");
    if (!content.trim()) return null;
    return {
      ordinal,
      role: "tool",
      ...(isoDate(timestamp) ? { createdAt: isoDate(timestamp)! } : {}),
      segments: [{ type: "tool_status", content }],
    };
  }

  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const output = conciseJson(payload.output ?? payload.result ?? "", CODEX_TOOL_OUTPUT_LIMIT);
    if (!output.trim()) return null;
    return {
      ordinal,
      role: "tool",
      ...(isoDate(timestamp) ? { createdAt: isoDate(timestamp)! } : {}),
      segments: [{ type: "tool_status", content: output }],
    };
  }

  return null;
}

export function parseCodexRecords(input: {
  path: string;
  records: Array<Record<string, unknown>>;
  trailingPartial?: boolean;
  capturedAt?: Date;
  titleBySessionId?: Record<string, string>;
}): CaptureSnapshotV1 {
  const metaRecord = input.records.find((record) => record.type === "session_meta");
  const meta =
    metaRecord?.payload && typeof metaRecord.payload === "object"
      ? (metaRecord.payload as Record<string, unknown>)
      : undefined;
  const sessionId = String(
    meta?.id ?? basename(input.path).replace(/\.jsonl(?:\..+)?$/i, ""),
  );
  const cwd = typeof meta?.cwd === "string" ? meta.cwd : "";
  const title =
    input.titleBySessionId?.[sessionId] ??
    (cwd ? `Codex ${basename(cwd)}` : `Codex ${sessionId.slice(0, 12)}`);
  const messages = fitCodexMessages(input.records
    .flatMap((record, sourceOrdinal) => {
      if (record.type !== "response_item") return [];
      const payload =
        record.payload && typeof record.payload === "object"
          ? (record.payload as Record<string, unknown>)
          : record;
      const message = codexMessageFromPayload(payload, sourceOrdinal, record.timestamp);
      return message ? [message] : [];
    })
    .map((message, ordinal) => ({ ...message, ordinal })));
  const roleSet = new Set(messages.map((message) => message.role));
  if (!messages.length || !roleSet.has("user")) {
    throw new Error("Codex transcript contains no textual user messages");
  }
  const fingerprint = createHash("sha256")
    .update(
      messages
        .map((message) => `${message.role}:${JSON.stringify(message.segments)}`)
        .join("\n"),
    )
    .digest("hex");
  return {
    schemaVersion: 1,
    provider: "codex",
    sessionId,
    branchFingerprint: fingerprint,
    title,
    adapterVersion: CODEX_ADAPTER_VERSION,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    captureMode: "import",
    triggerReason: "local_file_rewritten",
    completeness: {
      status: input.trailingPartial ? "partial" : "complete",
      topReached: true,
      bottomReached: true,
      stable: !input.trailingPartial,
      ...(input.trailingPartial ? { reason: "Transcript ended with a partial JSONL record" } : {}),
    },
    messages,
  };
}

export function parseCodexJsonl(input: {
  path: string;
  content: string;
  capturedAt?: Date;
  titleBySessionId?: Record<string, string>;
}): CaptureSnapshotV1 {
  const { records, trailingPartial } = jsonlRecords(input.content);
  return parseCodexRecords({ ...input, records, trailingPartial });
}

export function parseClaudeCodeJsonl(input: {
  path: string;
  content: string;
  capturedAt?: Date;
}): CaptureSnapshotV1 {
  const { records, trailingPartial } = tolerantJsonlRecords(input.content);
  const header = records.find((record) =>
    record.sessionId || record.session_id || record.conversationId || record.uuid || record.id,
  ) ?? {};
  const sessionId = String(
    header.sessionId ??
      header.session_id ??
      header.conversationId ??
      header.conversation_id ??
      header.uuid ??
      header.id ??
      basename(input.path).replace(/\.jsonl(?:\..+)?$/i, ""),
  );
  const messages = records
    .map((record, ordinal) => messageFromRecord(record, ordinal))
    .filter((message): message is CaptureMessage => Boolean(message))
    .map((message, ordinal) => ({ ...message, ordinal }));
  if (!messages.length) {
    throw new Error("Claude Code transcript contains no textual messages");
  }
  const fingerprint = createHash("sha256")
    .update(
      messages
        .map((message) => `${message.role}:${JSON.stringify(message.segments)}`)
        .join("\n"),
    )
    .digest("hex");
  const title =
    typeof header.title === "string"
      ? header.title
      : `Claude Code ${sessionId.slice(0, 12)}`;
  return {
    schemaVersion: 1,
    provider: "claude_code",
    sessionId,
    branchFingerprint: fingerprint,
    title,
    adapterVersion: CLAUDE_CODE_ADAPTER_VERSION,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    captureMode: "import",
    triggerReason: "local_file_rewritten",
    completeness: {
      status: trailingPartial ? "partial" : "complete",
      topReached: true,
      bottomReached: true,
      stable: !trailingPartial,
      ...(trailingPartial ? { reason: "Transcript ended with a partial JSONL record" } : {}),
    },
    messages,
  };
}

export function parseLocalJsonlDelta(input: {
  provider: "openclaw" | "codex" | "claude_code";
  path: string;
  content: string;
  capturedAt?: Date;
  triggerReason?: CaptureTriggerReason;
  base: {
    revisionId?: string | undefined;
    sessionId: string;
    branchFingerprint: string;
    messageCount: number;
    lastMessageId?: string | undefined;
    lastMessageTextHash?: string | undefined;
  };
}): CaptureDeltaV1 | null {
  const parsed = input.provider === "claude_code"
    ? tolerantJsonlRecords(input.content)
    : jsonlRecords(input.content);
  if (parsed.trailingPartial) return null;

  const messages = parsed.records
    .flatMap((record, sourceOrdinal) => {
      if (input.provider === "codex") {
        if (record.type !== "response_item") return [];
        const payload =
          record.payload && typeof record.payload === "object"
            ? (record.payload as Record<string, unknown>)
            : record;
        const message = codexMessageFromPayload(payload, sourceOrdinal, record.timestamp);
        return message ? [message] : [];
      }
      const message = messageFromRecord(record, sourceOrdinal);
      return message ? [message] : [];
    })
    .map((message, index) => ({
      ...message,
      ordinal: input.base.messageCount + index,
    }));

  if (!messages.length) return null;
  return {
    schemaVersion: 1,
    captureMode: "append",
    provider: input.provider,
    sessionId: input.base.sessionId,
    branchFingerprint: input.base.branchFingerprint,
    adapterVersion:
      input.provider === "codex"
        ? CODEX_ADAPTER_VERSION
        : input.provider === "claude_code"
          ? CLAUDE_CODE_ADAPTER_VERSION
          : OPENCLAW_ADAPTER_VERSION,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    triggerReason: input.triggerReason ?? "local_file_appended",
    ...(input.base.revisionId ? { baseRevisionId: input.base.revisionId } : {}),
    baseMessageCount: input.base.messageCount,
    ...(input.base.lastMessageId ? { baseLastMessageId: input.base.lastMessageId } : {}),
    ...(input.base.lastMessageTextHash
      ? { baseLastMessageTextHash: input.base.lastMessageTextHash }
      : {}),
    appendedMessages: messages,
  };
}
