import { createHash } from "node:crypto";
import { basename, dirname } from "node:path";
import type { CaptureMessage, CaptureSnapshotV1, MessageSegment } from "@ai-archive/contracts";

export const GROK_BUILD_ADAPTER_VERSION = "grok-build-acp-v1";

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
const string = (value: unknown): string => typeof value === "string" ? value : "";
const clean = (value: string): string => value
  .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

export class EmptyGrokBuildTranscriptError extends Error {
  constructor(readonly sessionId: string) {
    super("Grok Build transcript contains no textual user messages");
    this.name = "EmptyGrokBuildTranscriptError";
  }
}

function timestamp(value: unknown): string | undefined {
  const date = typeof value === "number" || typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function contentText(value: unknown): string {
  const content = object(value);
  return content.type === "text" ? clean(string(content.text)) : "";
}

function appendSegment(message: CaptureMessage, type: MessageSegment["type"], value: string) {
  if (!value) return;
  const last = message.segments.at(-1);
  if (last?.type === type && last.content.length + value.length <= 1_800_000) last.content += value;
  else for (let index = 0; index < value.length; index += 1_800_000) {
    message.segments.push({ type, content: value.slice(index, index + 1_800_000) });
  }
}

/** Read the ACP display journal, rather than chat_history.jsonl: compaction
 * rewrites the latter and includes opaque encrypted reasoning/model context.
 * CLI, stdio/ACP clients and Grok Build Desktop share this same journal.
 * Source: xai-org/grok-build, session/storage/{mod,replay}.rs.
 */
export function parseGrokBuildUpdates(input: {
  path: string;
  content: string;
  summary?: unknown;
  capturedAt?: Date;
}): CaptureSnapshotV1 {
  const summary = object(input.summary);
  const sessionId = string(object(summary.info).id) || basename(dirname(input.path));
  if (!sessionId || sessionId.length > 1_024) throw new Error("Invalid Grok Build session ID");
  const messages: CaptureMessage[] = [];
  const prompts: number[] = [];
  const seenEvents = new Set<string>();
  const tools = new Map<string, CaptureMessage>();
  const toolStates = new Map<string, { title: string; status: string; result: string }>();
  const malformed: number[] = [];
  let unsupported = false;
  let assistant: CaptureMessage | undefined;
  let assistantStream = "";
  let user: CaptureMessage | undefined;
  let userPromptIndex: number | undefined;
  let identity = 0;

  const add = (role: CaptureMessage["role"], sourceId: string, createdAt: string | undefined, model?: string) => {
    const message: CaptureMessage = {
      externalMessageId: `grok-build:${sourceId || `record-${identity++}`}`.slice(0, 512),
      ordinal: messages.length, role, segments: [],
      ...(createdAt ? { createdAt } : {}), ...(model ? { model: model.slice(0, 256) } : {}),
    };
    messages.push(message);
    return message;
  };

  for (const [lineIndex, rawLine] of input.content.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;
    let record: RecordValue;
    try { record = object(JSON.parse(rawLine)); } catch { malformed.push(lineIndex + 1); continue; }
    if (record.method !== "session/update" && record.method !== "_x.ai/session/update") continue;
    const params = object(record.params);
    // Forks copy the journal verbatim, so historical sessionId can differ
    // from summary.info.id. The directory/summary identify the archived session.
    const update = object(params.update);
    const meta = object(params._meta);
    const eventId = string(meta.eventId);
    if (eventId) {
      if (seenEvents.has(eventId)) continue;
      seenEvents.add(eventId);
    }
    const kind = update.sessionUpdate;
    const createdAt = timestamp(meta.agentTimestampMs ?? record.timestamp);
    if (record.method === "_x.ai/session/update") {
      if (kind === "rewind_marker") {
        const target = update.target_prompt_index;
        if (typeof target !== "number" || !Number.isInteger(target) || target < 0 || target > prompts.length) {
          unsupported = true;
          continue;
        }
        if (target < prompts.length) messages.splice(prompts[target]!);
        prompts.splice(target);
        tools.clear();
        toolStates.clear();
        assistant = undefined;
        user = undefined;
        userPromptIndex = undefined;
      }
      continue;
    }

    if (kind === "user_message_chunk") {
      const promptIndex = object(update._meta).promptIndex;
      const samePrompt = user && typeof promptIndex === "number" && promptIndex === userPromptIndex;
      if (!samePrompt) {
        prompts.push(messages.length);
        user = add("user", eventId || `user-${lineIndex}`, createdAt);
        userPromptIndex = typeof promptIndex === "number" ? promptIndex : undefined;
      }
      const value = contentText(update.content);
      if (value) appendSegment(user!, "text", value);
      else if (object(update.content).type !== "text") unsupported = true;
      assistant = undefined;
      continue;
    }
    user = undefined;
    if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
      const value = contentText(update.content);
      if (!value) {
        if (object(update.content).type !== "text") unsupported = true;
        continue;
      }
      const stream = `${string(meta.promptId)}:${meta.streamStartMs ?? ""}`;
      if (!assistant || (stream !== ":" && stream !== assistantStream)) {
        assistant = add("assistant", eventId || `assistant-${lineIndex}`, createdAt,
          string(object(update._meta).modelId) || string(summary.current_model_id));
        assistantStream = stream;
      }
      appendSegment(assistant, kind === "agent_thought_chunk" ? "reasoning" : "text", value);
    } else if (kind === "tool_call" || kind === "tool_call_update") {
      const toolId = string(update.toolCallId);
      if (!toolId) { unsupported = true; continue; }
      let tool = tools.get(toolId);
      if (!tool) {
        tool = add("tool", `tool:${toolId}`, createdAt);
        tools.set(toolId, tool);
      }
      const previous = toolStates.get(toolId);
      const title = clean(string(update.title) || previous?.title || string(update.kind) || "Tool call").slice(0, 1_200);
      const status = string(update.status) || previous?.status || "";
      const contents = Array.isArray(update.content) ? update.content : [];
      const result = contents.map((item) => {
        const part = object(item);
        // ACP ToolCallContent wraps a ContentBlock in `content`.
        return contentText(part.content ?? part);
      }).filter(Boolean).join("\n").slice(0, 600) || previous?.result || "";
      toolStates.set(toolId, { title, status, result });
      tool.segments = [{ type: "tool_status", content: `${title}${status ? ` (${status})` : ""}${result ? `\n${result}` : ""}` }];
      if (kind === "tool_call") assistant = undefined;
    }
  }

  const normalized = messages.filter((message) => message.segments.some((segment) => segment.content.trim()))
    .map((message, ordinal) => ({ ...message, ordinal }));
  if (!normalized.some((message) => message.role === "user")) throw new EmptyGrokBuildTranscriptError(sessionId);
  const reasons = [
    ...(malformed.length ? [`Malformed Grok Build JSONL at lines ${malformed.slice(0, 10).join(", ")}`] : []),
    ...(unsupported ? ["Some Grok Build events contain unsupported content or rewind metadata"] : []),
  ];
  const title = string(summary.generated_title) || string(summary.session_summary) ||
    normalized.find((message) => message.role === "user")?.segments.find((segment) => segment.type === "text")?.content;
  return {
    schemaVersion: 1, provider: "grok_build", sessionId,
    branchFingerprint: createHash("sha256").update(`grok-build:${sessionId}`).digest("hex"),
    ...(title ? { title: title.slice(0, 2_048) } : {}),
    adapterVersion: GROK_BUILD_ADAPTER_VERSION,
    capturedAt: (input.capturedAt ?? new Date()).toISOString(),
    captureMode: "import", triggerReason: "historical_import",
    completeness: {
      status: reasons.length ? "partial" : "complete", topReached: !malformed.length,
      bottomReached: !malformed.length, stable: !malformed.length,
      ...(reasons.length ? { reason: reasons.join("; ").slice(0, 1_000) } : {}),
    },
    messages: normalized,
  };
}
