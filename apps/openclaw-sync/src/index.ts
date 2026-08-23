#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { createGunzip, gzip } from "node:zlib";
import chokidar from "chokidar";
import fg from "fast-glob";
import { z } from "zod";
import type {
  CaptureDeltaV1,
  CapturePayloadV1,
  CaptureSnapshotV1,
} from "@ai-archive/contracts";
import {
  captureMessageFingerprint,
  EmptyOpenClawTranscriptError,
  parseClaudeCodeJsonl,
  parseCodexRecords,
  parseLocalJsonlDelta,
  parseOpenClawJsonl,
} from "./parser.js";
import {
  createCoalescedRunner,
  lfSeparatedLines,
  observedCaptureTime,
} from "./sync-runtime.js";

const execFileAsync = promisify(execFile);
const gzipAsync = promisify(gzip);
const configPath =
  process.env.AI_ARCHIVE_SYNC_CONFIG ??
  join(homedir(), ".config", "ai-archive", "openclaw-sync.json");
const statePath = join(dirname(configPath), "openclaw-sync-state.json");
let openClawCliMissingReported = false;
let lastSafetyFilterNotice = "";
let lastOpenClawSourceNotice = "";

const SAFE_RECENT_DAYS = 14;
const SAFE_MAX_FILES = 500;
const SAFE_MAX_FILE_MB = 50;
const SAFE_MAX_MESSAGES = 12_000;
const SAFE_DELAY_MS = 750;
const BYTES_PER_MIB = 1024 * 1024;
const MAX_DECOMPRESSED_TRANSCRIPT_BYTES = 200 * BYTES_PER_MIB;
const SYNC_AGENT_VERSION = "V2.1.0";
const TRANSCRIPT_IGNORE_PATTERNS = [
  "**/*.bak",
  "**/*.deleted",
  "**/*.tmp",
  "**/*.lock",
  "**/*.migrated",
  "**/*.codex-app-server.json",
  "**/*.codex-app-server.json.*",
];

const ConfigSchema = z.object({
  serverUrl: z
    .string()
    .url()
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
      );
    }, "Remote archive servers must use HTTPS"),
  deviceId: z.string().uuid(),
  deviceToken: z.string().min(20),
  openClawRoot: z.string().default(join(homedir(), ".openclaw")),
  codexRoots: z.array(z.string()).default([]),
  claudeCodeRoots: z.array(z.string()).default([]),
  scanSeconds: z.number().int().min(15).max(3600).default(60),
});
type SyncConfig = z.infer<typeof ConfigSchema>;

interface TranscriptSource {
  provider: "openclaw" | "codex" | "claude_code";
  path: string;
  titleBySessionId?: Record<string, string>;
}

interface LocalFileState {
  source: "openclaw" | "codex" | "claude_code";
  filePath: string;
  fileSize: number;
  modifiedAt: number;
  readOffset: number;
  lastLineHash?: string | undefined;
  fullFileHash?: string | undefined;
  sessionId?: string | undefined;
  revisionId?: string | undefined;
  branchFingerprint?: string | undefined;
  messageCount?: number | undefined;
  lastMessageId?: string | undefined;
  lastMessageTextHash?: string | undefined;
  lastSuccessfulSyncAt?: string | undefined;
  lastSkippedReason?: string | undefined;
  lastSkippedSyncAt?: string | undefined;
}

interface SyncState {
  files: Record<string, string | LocalFileState>;
  lastReconciliation?: string;
}

interface SyncRunOptions {
  includeLarge: boolean;
  delayMs: number;
  resetState: boolean;
  skipInitialScan: boolean;
  recentDays?: number;
  maxFiles?: number;
  maxFileBytes?: number;
  maxMessages?: number;
}

async function saveJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

function parseJsonText(value: string): unknown {
  return JSON.parse(value.replace(/^\uFEFF/, ""));
}

async function loadConfig(): Promise<SyncConfig> {
  return ConfigSchema.parse(parseJsonText(await readFile(configPath, "utf8")));
}

async function loadState(): Promise<SyncState> {
  try {
    return parseJsonText(await readFile(statePath, "utf8")) as SyncState;
  } catch {
    return { files: {} };
  }
}

function safeSyncOptions(): SyncRunOptions {
  return {
    includeLarge: false,
    delayMs: SAFE_DELAY_MS,
    resetState: false,
    skipInitialScan: false,
    recentDays: SAFE_RECENT_DAYS,
    maxFiles: SAFE_MAX_FILES,
    maxFileBytes: SAFE_MAX_FILE_MB * BYTES_PER_MIB,
    maxMessages: SAFE_MAX_MESSAGES,
  };
}

function fullSyncOptions(): SyncRunOptions {
  return {
    includeLarge: true,
    delayMs: SAFE_DELAY_MS,
    resetState: false,
    skipInitialScan: false,
  };
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function optionValue(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value?.startsWith(prefix)) return value.slice(prefix.length);
    if (value === `--${name}`) return args[index + 1];
  }
  return undefined;
}

function positiveNumberOption(args: string[], name: string): number | undefined {
  const rawValue = optionValue(args, name);
  if (rawValue === undefined) return undefined;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return value;
}

function parseSyncOptions(args: string[], defaults = safeSyncOptions()): SyncRunOptions {
  const full = hasFlag(args, "full") || hasFlag(args, "all");
  let options = full ? fullSyncOptions() : { ...defaults };

  const recentDays = positiveNumberOption(args, "recent-days");
  if (recentDays !== undefined) {
    if (recentDays === 0) {
      const { recentDays: _recentDays, ...rest } = options;
      options = rest;
    } else {
      options = { ...options, recentDays };
    }
  }

  const maxFiles = positiveNumberOption(args, "max-files");
  if (maxFiles !== undefined) {
    if (maxFiles === 0) {
      const { maxFiles: _maxFiles, ...rest } = options;
      options = rest;
    } else {
      options = { ...options, maxFiles: Math.floor(maxFiles) };
    }
  }

  const maxFileMb = positiveNumberOption(args, "max-file-mb");
  if (maxFileMb !== undefined) {
    if (maxFileMb === 0) {
      const { maxFileBytes: _maxFileBytes, ...rest } = options;
      options = rest;
    } else {
      options = { ...options, maxFileBytes: Math.floor(maxFileMb * BYTES_PER_MIB) };
    }
  }

  const maxMessages = positiveNumberOption(args, "max-messages");
  if (maxMessages !== undefined) {
    if (maxMessages === 0) {
      const { maxMessages: _maxMessages, ...rest } = options;
      options = rest;
    } else {
      options = { ...options, maxMessages: Math.floor(maxMessages) };
    }
  }

  const delayMs = positiveNumberOption(args, "delay-ms");
  if (delayMs !== undefined) options = { ...options, delayMs: Math.floor(delayMs) };

  return {
    ...options,
    includeLarge: options.includeLarge || hasFlag(args, "include-large"),
    resetState: options.resetState || hasFlag(args, "reset-state"),
    skipInitialScan: options.skipInitialScan || hasFlag(args, "skip-initial-scan"),
  };
}

function formatLimitSummary(options: SyncRunOptions): string {
  if (options.includeLarge) return "full mode: no safety size/message limits";
  const parts = [
    options.recentDays !== undefined ? `recent ${options.recentDays}d` : "all dates",
    options.maxFiles !== undefined ? `max ${options.maxFiles} files` : "unlimited files",
    options.maxFileBytes !== undefined
      ? `max ${Math.round(options.maxFileBytes / BYTES_PER_MIB)} MiB/file`
      : "unlimited file size",
    options.maxMessages !== undefined
      ? `max ${options.maxMessages} messages/session`
      : "unlimited messages",
    options.delayMs ? `${options.delayMs}ms delay` : "no delay",
  ];
  return `safe mode: ${parts.join(", ")}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function gzipJson(value: unknown): Promise<ArrayBuffer> {
  const compressed = await gzipAsync(Buffer.from(JSON.stringify(value)));
  return compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  ) as ArrayBuffer;
}

async function readTranscript(path: string): Promise<string> {
  if (!/\.gz$/i.test(path)) return readFile(path, "utf8");
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const decompressor = createReadStream(path).pipe(createGunzip());
  for await (const chunk of decompressor) {
    const buffer = Buffer.from(chunk as Buffer);
    totalBytes += buffer.length;
    if (totalBytes > MAX_DECOMPRESSED_TRANSCRIPT_BYTES) {
      decompressor.destroy();
      throw new Error(
        `Decompressed transcript exceeds ${MAX_DECOMPRESSED_TRANSCRIPT_BYTES / BYTES_PER_MIB} MiB`,
      );
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, totalBytes).toString("utf8");
}

async function readTranscriptTail(path: string, start: number): Promise<string> {
  if (start < 0 || !Number.isSafeInteger(start)) {
    throw new Error("Transcript read offset is invalid");
  }
  const chunks: string[] = [];
  const reader = createReadStream(path, { encoding: "utf8", start });
  for await (const chunk of reader) chunks.push(String(chunk));
  return chunks.join("");
}

async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function stateHash(value: string | LocalFileState | undefined): string | undefined {
  return typeof value === "string" ? value : value?.fullFileHash;
}

function stateOffset(value: string | LocalFileState | undefined): number {
  return typeof value === "object" && value ? value.readOffset : 0;
}

function isLocalFileState(value: string | LocalFileState | undefined): value is LocalFileState {
  return typeof value === "object" && value !== null;
}

function hasIncrementalBase(
  value: string | LocalFileState | undefined,
): value is LocalFileState & {
  sessionId: string;
  branchFingerprint: string;
  messageCount: number;
} {
  return (
    isLocalFileState(value) &&
    Boolean(value.sessionId) &&
    Boolean(value.branchFingerprint) &&
    typeof value.messageCount === "number" &&
    Boolean(value.lastMessageId || value.lastMessageTextHash)
  );
}

function tailHasCompleteLastRecord(content: string): boolean {
  const last = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!last) return true;
  try {
    JSON.parse(last);
    return true;
  } catch {
    return false;
  }
}

async function parseCodexJsonlFile(source: TranscriptSource, capturedAt: Date) {
  const records: Array<Record<string, unknown>> = [];
  let pendingMalformedLine: number | null = null;
  let lineNumber = 0;
  const input = createReadStream(source.path, { encoding: "utf8" });
  for await (const line of lfSeparatedLines(input)) {
    lineNumber += 1;
    if (!line.trim()) continue;
    if (pendingMalformedLine !== null) {
      throw new Error(`Malformed Codex JSONL at line ${pendingMalformedLine}`);
    }
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object") {
        const record = parsed as Record<string, unknown>;
        if (
          record.type === "session_meta" ||
          record.type === "response_item" ||
          (record.type === "event_msg" &&
            record.payload &&
            typeof record.payload === "object" &&
            (record.payload as Record<string, unknown>).type === "token_count")
        ) {
          records.push(record);
        }
      }
    } catch {
      pendingMalformedLine = lineNumber;
    }
  }
  return parseCodexRecords({
    path: source.path,
    records,
    trailingPartial: pendingMalformedLine !== null,
    capturedAt,
    ...(source.titleBySessionId ? { titleBySessionId: source.titleBySessionId } : {}),
  });
}

interface CaptureUploadResult {
  conversationId?: string;
  revisionId?: string;
  messageCount?: number;
  completeness?: "complete" | "partial";
  captureMode?: "full" | "append" | "import";
}

class IncrementalBaseMismatch extends Error {
  constructor(message = "Incremental base mismatch") {
    super(message);
    this.name = "IncrementalBaseMismatch";
  }
}

function formatError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.stack ?? error.message;
}

function textFromHtmlResponse(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/data:image\/[^;"'\s]+;base64,[A-Za-z0-9+/=\s]+/gi, "[embedded image omitted]")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function nonJsonResponseSummary(rawBody: string): string | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;
  const title = trimmed.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const heading = trimmed.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const candidate = textFromHtmlResponse(title ?? heading ?? trimmed);
  if (!candidate) return `non-JSON response (${rawBody.length} bytes)`;
  const excerpt = candidate.slice(0, 500);
  return `non-JSON response: ${excerpt}${candidate.length > excerpt.length ? "..." : ""}`;
}

function formatUploadError(input: {
  status: number;
  body: Record<string, unknown>;
  fallback: string;
}): string {
  const details = [
    `Upload failed with status ${input.status}`,
    typeof input.body.error === "string" ? `error: ${input.body.error}` : null,
    typeof input.body.message === "string" ? `message: ${input.body.message}` : null,
    Array.isArray(input.body.issues)
      ? `issues: ${JSON.stringify(input.body.issues.slice(0, 10))}`
      : null,
    input.fallback && !Object.keys(input.body).length
      ? nonJsonResponseSummary(input.fallback)
      : null,
  ].filter(Boolean);
  return details.join("\n");
}

async function sendCapture(
  payload: CapturePayloadV1,
  config: SyncConfig,
  idempotencyKey: string,
): Promise<CaptureUploadResult> {
  const response = await fetch(`${config.serverUrl.replace(/\/$/, "")}/api/v1/captures`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.deviceToken}`,
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Idempotency-Key": idempotencyKey,
    },
    body: await gzipJson(payload),
  });
  const rawBody = await response.text();
  const body = (() => {
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  })() as {
    error?: string;
    requiresFullCapture?: boolean;
  } & CaptureUploadResult;
  if (!response.ok) {
    if (response.status === 409 && body.requiresFullCapture) {
      throw new IncrementalBaseMismatch(body.error);
    }
    throw new Error(
      formatUploadError({
        status: response.status,
        body: body as Record<string, unknown>,
        fallback: rawBody,
      }),
    );
  }
  return body;
}

function stateFromSnapshot(input: {
  source: TranscriptSource;
  metadata: Awaited<ReturnType<typeof lstat>>;
  snapshot: CaptureSnapshotV1;
  result: CaptureUploadResult;
  fullFileHash?: string | undefined;
}): LocalFileState {
  const lastMessage = input.snapshot.messages.at(-1);
  return {
    source: input.source.provider,
    filePath: input.source.path,
    fileSize: Number(input.metadata.size),
    modifiedAt: Number(input.metadata.mtimeMs),
    readOffset: Number(input.metadata.size),
    ...(input.fullFileHash ? { fullFileHash: input.fullFileHash } : {}),
    sessionId: input.snapshot.sessionId,
    ...(input.result.revisionId ? { revisionId: input.result.revisionId } : {}),
    branchFingerprint: input.snapshot.branchFingerprint,
    messageCount: input.result.messageCount ?? input.snapshot.messages.length,
    ...(lastMessage?.externalMessageId ? { lastMessageId: lastMessage.externalMessageId } : {}),
    ...(lastMessage ? { lastMessageTextHash: captureMessageFingerprint(lastMessage) } : {}),
    lastSuccessfulSyncAt: new Date().toISOString(),
  };
}

function stateFromDelta(input: {
  source: TranscriptSource;
  metadata: Awaited<ReturnType<typeof lstat>>;
  previous: LocalFileState;
  delta: CaptureDeltaV1;
  result: CaptureUploadResult;
  tailHash: string;
}): LocalFileState {
  const lastMessage = input.delta.appendedMessages.at(-1);
  return {
    ...input.previous,
    source: input.source.provider,
    filePath: input.source.path,
    fileSize: Number(input.metadata.size),
    modifiedAt: Number(input.metadata.mtimeMs),
    readOffset: Number(input.metadata.size),
    lastLineHash: input.tailHash,
    fullFileHash: undefined,
    sessionId: input.delta.sessionId,
    revisionId: input.result.revisionId ?? input.previous.revisionId,
    branchFingerprint: input.delta.branchFingerprint,
    messageCount:
      input.result.messageCount ??
      input.delta.baseMessageCount + input.delta.appendedMessages.length,
    lastMessageId: lastMessage?.externalMessageId ?? input.previous.lastMessageId,
    lastMessageTextHash: lastMessage
      ? captureMessageFingerprint(lastMessage)
      : input.previous.lastMessageTextHash,
    lastSuccessfulSyncAt: new Date().toISOString(),
  };
}

async function upload(
  source: TranscriptSource,
  config: SyncConfig,
  state: SyncState,
  options: SyncRunOptions,
): Promise<void> {
  const metadata = await lstat(source.path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Transcript path must be a regular file, not a symbolic link");
  }
  const previous = state.files[source.path];
  if (
    typeof previous === "object" &&
    previous.fileSize === metadata.size &&
    previous.modifiedAt === metadata.mtimeMs &&
    (!previous.lastSkippedReason || !options.includeLarge)
  ) {
    return;
  }
  if (
    hasIncrementalBase(previous) &&
    source.provider === previous.source &&
    !/\.gz$/i.test(source.path) &&
    metadata.size > previous.readOffset &&
    metadata.size >= previous.fileSize
  ) {
    const tail = await readTranscriptTail(source.path, previous.readOffset);
    if (!tailHasCompleteLastRecord(tail)) return;
    const tailHash = createHash("sha256").update(tail).digest("hex");
    const delta = parseLocalJsonlDelta({
      provider: source.provider,
      path: source.path,
      content: tail,
      capturedAt: observedCaptureTime({
        provider: source.provider,
        fileModifiedAt: metadata.mtime,
        hasPreviousSync: true,
      }),
      triggerReason: "local_file_appended",
      base: {
        revisionId: previous.revisionId,
        sessionId: previous.sessionId,
        branchFingerprint: previous.branchFingerprint,
        messageCount: previous.messageCount,
        lastMessageId: previous.lastMessageId,
        lastMessageTextHash: previous.lastMessageTextHash,
      },
    });
    if (delta) {
      const projectedMessageCount = delta.baseMessageCount + delta.appendedMessages.length;
      if (
        !options.includeLarge &&
        options.maxMessages !== undefined &&
        projectedMessageCount > options.maxMessages
      ) {
        const reason = `message count ${projectedMessageCount} exceeds safe max ${options.maxMessages}`;
        state.files[source.path] = {
          ...previous,
          source: source.provider,
          filePath: source.path,
          fileSize: Number(metadata.size),
          modifiedAt: Number(metadata.mtimeMs),
          readOffset: Number(metadata.size),
          messageCount: projectedMessageCount,
          lastSkippedReason: reason,
          lastSkippedSyncAt: new Date().toISOString(),
        };
        await saveJson(statePath, state);
        console.warn(
          `skipped ${delta.provider}:${delta.sessionId}: ${reason}; use full-rebuild or --include-large to force`,
        );
        return;
      }
      try {
        const result = await sendCapture(
          delta,
          config,
          `${delta.provider}:${delta.adapterVersion}:append:${previous.readOffset}:${metadata.size}:${tailHash}`,
        );
        state.files[source.path] = stateFromDelta({
          source,
          metadata,
          previous,
          delta,
          result,
          tailHash,
        });
        await saveJson(statePath, state);
        console.log(
          `synced ${delta.provider}:${delta.sessionId} (+${delta.appendedMessages.length} messages)`,
        );
        return;
      } catch (error) {
        if (!(error instanceof IncrementalBaseMismatch)) throw error;
      }
    } else {
      state.files[source.path] = {
        ...previous,
        source: source.provider,
        filePath: source.path,
        fileSize: metadata.size,
        modifiedAt: metadata.mtimeMs,
        readOffset: metadata.size,
        lastLineHash: tailHash,
      };
      await saveJson(statePath, state);
      return;
    }
  }
  const content =
    source.provider === "codex"
      ? ""
      : await readTranscript(source.path);
  const hash =
    source.provider === "codex"
      ? await fileHash(source.path)
      : createHash("sha256").update(content).digest("hex");
  if (stateHash(previous) === hash) {
    state.files[source.path] = {
      ...(typeof previous === "object" ? previous : {}),
      source: source.provider,
      filePath: source.path,
      fileSize: metadata.size,
      modifiedAt: metadata.mtimeMs,
      readOffset: metadata.size,
      fullFileHash: hash,
    };
    await saveJson(statePath, state);
    return;
  }
  const triggerReason =
    stateOffset(previous) > 0 && metadata.size > stateOffset(previous)
      ? "local_file_appended"
      : "local_file_rewritten";
  const capturedAt = observedCaptureTime({
    provider: source.provider,
    fileModifiedAt: metadata.mtime,
    hasPreviousSync: typeof previous === "object",
  });
  let snapshot: CaptureSnapshotV1;
  try {
    snapshot =
      source.provider === "codex"
        ? await parseCodexJsonlFile(source, capturedAt)
        : source.provider === "claude_code"
          ? parseClaudeCodeJsonl({
              path: source.path,
              content,
              capturedAt,
            })
          : parseOpenClawJsonl({
              path: source.path,
              content,
              capturedAt,
            });
  } catch (error) {
    if (!(error instanceof EmptyOpenClawTranscriptError)) throw error;
    const reason = "no textual messages";
    state.files[source.path] = {
      source: source.provider,
      filePath: source.path,
      fileSize: Number(metadata.size),
      modifiedAt: Number(metadata.mtimeMs),
      readOffset: Number(metadata.size),
      fullFileHash: hash,
      sessionId: error.sessionId,
      lastSkippedReason: reason,
      lastSkippedSyncAt: new Date().toISOString(),
    };
    await saveJson(statePath, state);
    console.warn(`skipped openclaw:${error.sessionId}: ${reason}`);
    return;
  }
  snapshot.captureMode = "import";
  snapshot.triggerReason = triggerReason;
  if (
    !options.includeLarge &&
    options.maxMessages !== undefined &&
    snapshot.messages.length > options.maxMessages
  ) {
    const reason = `message count ${snapshot.messages.length} exceeds safe max ${options.maxMessages}`;
    state.files[source.path] = {
      source: source.provider,
      filePath: source.path,
      fileSize: Number(metadata.size),
      modifiedAt: Number(metadata.mtimeMs),
      readOffset: Number(metadata.size),
      sessionId: snapshot.sessionId,
      branchFingerprint: snapshot.branchFingerprint,
      messageCount: snapshot.messages.length,
      lastSkippedReason: reason,
      lastSkippedSyncAt: new Date().toISOString(),
    };
    await saveJson(statePath, state);
    console.warn(
      `skipped ${snapshot.provider}:${snapshot.sessionId} (${snapshot.messages.length} messages): ${reason}; use full-rebuild or --include-large to force`,
    );
    return;
  }
  const result = await sendCapture(
    snapshot,
    config,
    `${snapshot.provider}:${snapshot.adapterVersion}:${hash}`,
  );
  state.files[source.path] = stateFromSnapshot({
    source,
    metadata,
    snapshot,
    result,
    fullFileHash: hash,
  });
  await saveJson(statePath, state);
  console.log(`synced ${snapshot.provider}:${snapshot.sessionId} (${snapshot.messages.length} messages)`);
}

async function codexTitleIndex(root: string): Promise<Record<string, string>> {
  try {
    const lines = (await readFile(join(root, "session_index.jsonl"), "utf8")).split(/\r?\n/);
    return Object.fromEntries(
      lines.flatMap((line) => {
        if (!line.trim()) return [];
        try {
          const record = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
          return typeof record.id === "string" && typeof record.thread_name === "string"
            ? [[record.id, record.thread_name]]
            : [];
        } catch {
          return [];
        }
      }),
    );
  } catch {
    return {};
  }
}

async function filterTranscriptFiles(
  sources: TranscriptSource[],
  options: SyncRunOptions,
): Promise<TranscriptSource[]> {
  const cutoffMs =
    options.recentDays !== undefined
      ? Date.now() - options.recentDays * 24 * 60 * 60 * 1000
      : null;
  let olderSkipped = 0;
  let largeSkipped = 0;
  let missingSkipped = 0;
  const rows: Array<{ source: TranscriptSource; modifiedAt: number; fileSize: number }> = [];

  for (const source of sources) {
    try {
      const metadata = await lstat(source.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        missingSkipped += 1;
        continue;
      }
      const modifiedAt = Number(metadata.mtimeMs);
      const fileSize = Number(metadata.size);
      if (cutoffMs !== null && modifiedAt < cutoffMs) {
        olderSkipped += 1;
        continue;
      }
      if (
        !options.includeLarge &&
        options.maxFileBytes !== undefined &&
        fileSize > options.maxFileBytes
      ) {
        largeSkipped += 1;
        continue;
      }
      rows.push({ source, modifiedAt, fileSize });
    } catch {
      missingSkipped += 1;
    }
  }

  rows.sort((left, right) => right.modifiedAt - left.modifiedAt);
  const maxFiles = options.includeLarge ? undefined : options.maxFiles;
  const countSkipped =
    maxFiles !== undefined && rows.length > maxFiles ? rows.length - maxFiles : 0;
  const selectedRows =
    maxFiles !== undefined && rows.length > maxFiles ? rows.slice(0, maxFiles) : rows;

  const notices = [
    olderSkipped ? `${olderSkipped} older` : "",
    largeSkipped ? `${largeSkipped} over-size` : "",
    countSkipped ? `${countSkipped} over-count` : "",
    missingSkipped ? `${missingSkipped} missing` : "",
  ].filter(Boolean);
  const notice = notices.length
    ? `Sync safety filter: selected ${selectedRows.length}/${sources.length}; skipped ${notices.join(", ")}.`
    : `Sync safety filter: selected ${selectedRows.length}/${sources.length}.`;
  if (notice !== lastSafetyFilterNotice) {
    console.log(notice);
    lastSafetyFilterNotice = notice;
  }

  return selectedRows.map((row) => row.source);
}

function isOpenClawTrajectoryPath(path: string): boolean {
  return /\.trajectory\.jsonl(?:\..+)?$/i.test(basename(path));
}

function openClawSourceKey(path: string): string {
  return join(
    dirname(path),
    basename(path)
      .replace(/\.gz$/i, "")
      .replace(/\.trajectory\.jsonl(?:\..+)?$/i, ".jsonl")
      .replace(/\.jsonl(?:\..+)?$/i, ".jsonl"),
  ).toLowerCase();
}

function preferOpenClawTranscriptSources(sources: TranscriptSource[]): TranscriptSource[] {
  const transcriptKeys = new Set(
    sources
      .filter((source) => !isOpenClawTrajectoryPath(source.path))
      .map((source) => openClawSourceKey(source.path)),
  );
  let skippedTrajectorySiblings = 0;
  const selected = sources.filter((source) => {
    if (
      isOpenClawTrajectoryPath(source.path) &&
      transcriptKeys.has(openClawSourceKey(source.path))
    ) {
      skippedTrajectorySiblings += 1;
      return false;
    }
    return true;
  });
  const notice = skippedTrajectorySiblings
    ? `OpenClaw source filter: skipped ${skippedTrajectorySiblings} trajectory sibling files because transcript files are present.`
    : "OpenClaw source filter: no duplicate trajectory siblings found.";
  if (notice !== lastOpenClawSourceNotice) {
    console.log(notice);
    lastOpenClawSourceNotice = notice;
  }
  return selected;
}

async function transcriptFiles(
  config: SyncConfig,
  options: SyncRunOptions,
): Promise<TranscriptSource[]> {
  const openclawFiles = await fg("agents/*/sessions/*.jsonl{,.*}", {
    cwd: config.openClawRoot,
    absolute: true,
    onlyFiles: true,
    followSymbolicLinks: false,
    ignore: TRANSCRIPT_IGNORE_PATTERNS,
  }).catch(() => []);
  const sources: TranscriptSource[] = preferOpenClawTranscriptSources(
    openclawFiles.map((path) => ({
      provider: "openclaw",
      path,
    })),
  );
  for (const root of config.codexRoots) {
    const titleBySessionId = await codexTitleIndex(root);
    const files = await fg(["sessions/**/*.jsonl", "archived_sessions/*.jsonl"], {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: TRANSCRIPT_IGNORE_PATTERNS,
    }).catch(() => []);
    sources.push(
      ...files.map((path) => ({ provider: "codex" as const, path, titleBySessionId })),
    );
  }
  for (const root of config.claudeCodeRoots) {
    const files = await fg(["**/*.jsonl", "**/*.jsonl.*"], {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: [
        ...TRANSCRIPT_IGNORE_PATTERNS,
        "**/*key*",
        "**/*token*",
        "**/*cookie*",
        "**/*credential*",
      ],
    }).catch(() => []);
    sources.push(...files.map((path) => ({ provider: "claude_code" as const, path })));
  }
  return filterTranscriptFiles(sources, options);
}

async function reconcileOpenClawCli(state: SyncState): Promise<void> {
  try {
    const { stdout } = await execFileAsync("openclaw", [
      "sessions",
      "--all-agents",
      "--limit",
      "all",
      "--json",
    ]);
    JSON.parse(stdout);
    state.lastReconciliation = new Date().toISOString();
    await saveJson(statePath, state);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      if (!openClawCliMissingReported) {
        console.warn("OpenClaw CLI not found; local OpenClaw reconciliation is skipped.");
        openClawCliMissingReported = true;
      }
      return;
    }
    console.warn(
      `OpenClaw CLI reconciliation skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function run(args: string[]): Promise<void> {
  const config = await loadConfig();
  const state = await loadState();
  const options = parseSyncOptions(args);
  await logVersionHandshake(config.serverUrl);
  console.log(formatLimitSummary(options));
  const scan = createCoalescedRunner(async () => {
    for (const source of await transcriptFiles(config, options)) {
      await upload(source, config, state, options).catch((error) =>
        console.error(`sync failed for ${source.provider}:${source.path}:\n${formatError(error)}`),
      );
      if (options.delayMs > 0) await delay(options.delayMs);
    }
    await reconcileOpenClawCli(state);
  });
  if (options.skipInitialScan) {
    console.log("Initial and periodic scans skipped; only future filesystem changes will be watched.");
  } else {
    await scan();
  }
  const watchPaths = [
    join(config.openClawRoot, "agents/*/sessions/*.jsonl{,.*}"),
    ...config.codexRoots.flatMap((root) => [
      join(root, "sessions/**/*.jsonl"),
      join(root, "archived_sessions/*.jsonl"),
      join(root, "session_index.jsonl"),
    ]),
    ...config.claudeCodeRoots.flatMap((root) => [
      join(root, "**/*.jsonl"),
      join(root, "**/*.jsonl.*"),
    ]),
  ];
  const watcher = chokidar.watch(
    watchPaths,
    { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 1_000, pollInterval: 200 } },
  );
  watcher.on("add", () => void scan());
  watcher.on("change", () => void scan());
  const timer = options.skipInitialScan
    ? null
    : setInterval(() => void scan(), config.scanSeconds * 1_000);
  const shutdown = async () => {
    if (timer) clearInterval(timer);
    await watcher.close();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  console.log(
    `OpenClaw/Codex sync watching ${[
    config.openClawRoot,
    ...config.codexRoots,
    ...config.claudeCodeRoots,
    ].join(", ")}`,
  );
}

async function rebuild(args: string[]): Promise<void> {
  const config = await loadConfig();
  const options = parseSyncOptions(args);
  const state: SyncState = options.resetState ? { files: {} } : await loadState();
  const files = await transcriptFiles(config, options);
  let failed = 0;
  await logVersionHandshake(config.serverUrl);
  console.log(formatLimitSummary(options));
  if (options.resetState) console.warn("State reset requested; all selected files will be evaluated again.");
  for (const source of files) {
    try {
      await upload(source, config, state, options);
    } catch (error) {
      failed += 1;
      console.error(`sync failed for ${source.provider}:${source.path}:\n${formatError(error)}`);
    }
    if (options.delayMs > 0) await delay(options.delayMs);
  }
  await reconcileOpenClawCli(state);
  console.log(
    `Rebuild completed from ${files.length} eligible transcript files${failed ? ` (${failed} failed)` : ""}`,
  );
}

function normalizedServerUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && ["localhost", "127.0.0.1", "::1"].includes(url.hostname))
  ) {
    throw new Error("Remote archive servers must use HTTPS");
  }
  return url.origin;
}

async function logVersionHandshake(serverUrl: string): Promise<void> {
  console.log(`Local sync agent version: ${SYNC_AGENT_VERSION}`);
  try {
    const response = await fetch(`${serverUrl}/healthz`, {
      headers: { Accept: "application/json" },
    });
    const payload = (await response.json().catch(() => null)) as {
      version?: unknown;
    } | null;
    const version =
      payload && typeof payload.version === "string" ? payload.version : "unknown";
    console.log(`Archive server version: ${version} (${response.status})`);
  } catch (error) {
    console.warn(
      `Archive server version check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function pair(args: string[]): Promise<void> {
  const optionValues = (name: string) =>
    args.flatMap((value, index) =>
      value === `--${name}` && args[index + 1] ? [args[index + 1]!] : [],
    );
  const values = Object.fromEntries(
    args.flatMap((value, index) =>
      value.startsWith("--") && args[index + 1]
        ? [[value.slice(2), args[index + 1]!]]
        : [],
    ),
  );
  const serverUrl = values.server;
  const code = values.code;
  const openClawRoot = values["openclaw-root"] ?? join(homedir(), ".openclaw");
  const codexRoots = [
    ...optionValues("codex-root"),
    ...(args.includes("--with-codex") ? [join(homedir(), ".codex")] : []),
  ];
  const claudeCodeRoots = [
    ...optionValues("claude-code-root"),
    ...(args.includes("--with-claude-code")
      ? [join(homedir(), ".claude"), join(homedir(), ".config", "claude")]
      : []),
  ];
  if (!serverUrl || !code) {
    throw new Error(
      "Usage: pair --server https://archive.example.com --code ABCD1234 [--openclaw-root /path/to/.openclaw] [--with-codex | --codex-root /path/to/.codex]",
    );
  }
  const normalizedUrl = normalizedServerUrl(serverUrl);
  await logVersionHandshake(normalizedUrl);
  const response = await fetch(`${normalizedUrl}/api/v1/devices/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, kind: "openclaw_sync" }),
  });
  const payload = (await response.json()) as {
    deviceId?: string;
    token?: string;
    error?: string;
  };
  if (!response.ok || !payload.deviceId || !payload.token) {
    throw new Error(payload.error ?? "Pairing failed");
  }
  await saveJson(configPath, {
    serverUrl: normalizedUrl,
    deviceId: payload.deviceId,
    deviceToken: payload.token,
    openClawRoot,
    codexRoots,
    claudeCodeRoots,
    scanSeconds: 60,
  });
  console.log(`Paired device ${payload.deviceId}; config written to ${configPath}`);
}

function printUsage(): void {
  console.log(`知言归藏本地同步 ${SYNC_AGENT_VERSION}

Usage:
  ai-archive-openclaw-sync pair --server https://archive.example.com --code ABCD1234 [--openclaw-root /path/to/.openclaw] [--with-codex | --codex-root /path/to/.codex]
  ai-archive-openclaw-sync run [--recent-days 14] [--skip-initial-scan]
  ai-archive-openclaw-sync rebuild [--recent-days 14] [--max-files 500]
  ai-archive-openclaw-sync rebuild --recent-days 0 --max-files 0
  ai-archive-openclaw-sync full-rebuild
`);
}

async function main(): Promise<void> {
  const [, , command = "run", ...args] = process.argv;
  if (command === "help" || command === "--help" || command === "-h") {
    printUsage();
  } else if (command === "version" || command === "--version" || command === "-v") {
    console.log(SYNC_AGENT_VERSION);
  } else if (command === "pair") {
    await pair(args);
  } else if (command === "run") {
    await run(args);
  } else if (command === "rebuild") {
    await rebuild(args);
  } else if (command === "full-rebuild") {
    await rebuild(["--full", "--reset-state", ...args]);
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
