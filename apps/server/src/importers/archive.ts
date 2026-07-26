import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { parse as parseHtml } from "node-html-parser";
import { unzipSync } from "fflate";
import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";

type ZipFiles = Record<string, Uint8Array>;

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

export async function parseArchive(path: string): Promise<{
  provider: "chatgpt" | "gemini";
  fileHash: string;
  filename: string;
  snapshots: CaptureSnapshotV1[];
}> {
  const buffer = await readFile(path);
  const files = unzipSync(new Uint8Array(buffer));
  const chatGpt = parseChatGpt(files);
  if (chatGpt.length) {
    return {
      provider: "chatgpt",
      fileHash: hash(buffer.toString("base64")),
      filename: basename(path),
      snapshots: chatGpt,
    };
  }
  const gemini = [...parseGeminiJson(files), ...parseGeminiHtml(files)];
  if (gemini.length) {
    return {
      provider: "gemini",
      fileHash: hash(buffer.toString("base64")),
      filename: basename(path),
      snapshots: gemini,
    };
  }
  throw new Error("Archive is not a recognized ChatGPT or Gemini export");
}
