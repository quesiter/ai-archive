import { createHash } from "node:crypto";
import { and, desc, eq, isNotNull, isNull, lt, sql } from "drizzle-orm";
import {
  CaptureDeltaV1Schema,
  CapturePayloadV1Schema,
  CaptureSnapshotV1Schema,
  type CaptureDeltaV1,
  type CaptureMessage,
  type CaptureMode,
  type CapturePayloadV1,
  type CaptureSnapshotV1,
  type CaptureTriggerReason,
  type TokenUsage,
} from "@ai-archive/contracts";
import { db } from "../db.js";
import {
  captureRuns,
  conversationSearchChunks,
  conversationRevisions,
  conversations,
  messageSegments,
  messages,
} from "../schema.js";
import { chunkSearchContent } from "./search-chunks.js";
import { sanitizeDatabaseText, truncateDatabaseText } from "./text-safety.js";
import { loadCaptureRevisionMessages } from "./revision-storage.js";
import {
  type CompiledCustomRedactionRule,
  loadEnabledCustomRedactionRules,
  redactSensitiveTextForStorage,
  redactSensitiveTextSequenceForStorage,
  redactSensitiveUrlForStorage,
} from "./redaction.js";

export class IncrementalBaseMismatchError extends Error {
  readonly code = "incremental_base_mismatch";
  readonly requiresFullCapture = true;

  constructor(message = "Incremental capture base does not match the latest revision") {
    super(message);
    this.name = "IncrementalBaseMismatchError";
  }
}

function normalizedSegmentContent(type: string, content: string): string {
  const normalized = sanitizeDatabaseText(content).replace(/\r\n/g, "\n");
  return type === "code" ? normalized : normalized.trim();
}

export function messageFingerprint(message: CaptureMessage): string {
  const canonical = JSON.stringify({
    externalMessageId: message.externalMessageId ?? null,
    role: message.role,
    segments: message.segments.map((segment) => ({
      type: segment.type,
      content: normalizedSegmentContent(segment.type, segment.content),
      href: segment.href ?? null,
      language: segment.language ?? null,
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

export function snapshotHash(snapshot: CaptureSnapshotV1): string {
  const canonical = JSON.stringify({
    provider: snapshot.provider,
    sessionId: snapshot.sessionId,
    branchFingerprint: snapshot.branchFingerprint,
    completeness: snapshot.completeness,
    messages: [...snapshot.messages]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((message) => ({
        ordinal: message.ordinal,
        role: message.role,
        segments: message.segments.map((segment) => ({
          type: segment.type,
          content: normalizedSegmentContent(segment.type, segment.content),
          href: segment.href ?? null,
          language: segment.language ?? null,
        })),
      })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

/** Stable revision identity: content identity plus the captured title/URL. */
export function revisionIdentityHash(snapshot: CaptureSnapshotV1): string {
  return createHash("sha256").update(JSON.stringify({
    snapshotHash: snapshotHash(snapshot),
    title: snapshot.title ?? null,
    canonicalUrl: snapshot.canonicalUrl ?? null,
  })).digest("hex");
}

export function captureIdempotencyReplayMode(input: {
  previousSnapshotHash: string | null;
  previousPayloadIdentityHash: string | null;
  currentSnapshotHash: string;
  currentRevisionIdentityHash: string;
}): "replay" | "legacy_bypass" | "conflict" {
  if (input.previousPayloadIdentityHash) {
    return input.previousPayloadIdentityHash === input.currentRevisionIdentityHash
      ? "replay"
      : "conflict";
  }
  return input.previousSnapshotHash === input.currentSnapshotHash
    ? "replay"
    : "legacy_bypass";
}

/**
 * Hashes the exact reconstructable archive facts. This is deliberately
 * separate from snapshotHash, whose stable identity semantics ignore mutable
 * capture metadata for deduplication.
 */
export function contentIntegrityHash(snapshot: CaptureSnapshotV1): string {
  const canonical = JSON.stringify({
    schemaVersion: snapshot.schemaVersion,
    provider: snapshot.provider,
    sessionId: snapshot.sessionId,
    branchFingerprint: snapshot.branchFingerprint,
    title: snapshot.title ?? null,
    canonicalUrl: snapshot.canonicalUrl ?? null,
    adapterVersion: snapshot.adapterVersion,
    capturedAt: new Date(snapshot.capturedAt).toISOString(),
    captureMode: snapshot.captureMode,
    triggerReason: snapshot.triggerReason ?? null,
    baseRevisionId: snapshot.baseRevisionId ?? null,
    baseMessageCount: snapshot.baseMessageCount ?? null,
    completeness: {
      status: snapshot.completeness.status,
      topReached: snapshot.completeness.topReached,
      bottomReached: snapshot.completeness.bottomReached,
      stable: snapshot.completeness.stable,
      reason: snapshot.completeness.reason ?? null,
    },
    messages: [...snapshot.messages]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map((message) => ({
        ordinal: message.ordinal,
        externalMessageId: message.externalMessageId ?? null,
        role: message.role,
        model: message.model ?? null,
        createdAt: message.createdAt
          ? new Date(message.createdAt).toISOString()
          : null,
        segments: message.segments.map((segment) => ({
          type: segment.type,
          content: normalizedSegmentContent(segment.type, segment.content),
          href: segment.href ?? null,
          language: segment.language ?? null,
        })),
      })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function storedTokenUsage(
  revision: Pick<
    typeof conversationRevisions.$inferSelect,
    | "reportedInputTokens"
    | "reportedCachedInputTokens"
    | "reportedCacheWriteInputTokens"
    | "reportedOutputTokens"
    | "reportedReasoningOutputTokens"
    | "reportedTotalTokens"
  >,
): TokenUsage | null {
  if (
    revision.reportedTotalTokens === null ||
    revision.reportedTotalTokens === undefined
  ) {
    return null;
  }
  return {
    scope: "cumulative",
    inputTokens: revision.reportedInputTokens ?? 0,
    cachedInputTokens: revision.reportedCachedInputTokens ?? 0,
    cacheWriteInputTokens: revision.reportedCacheWriteInputTokens ?? 0,
    outputTokens: revision.reportedOutputTokens ?? 0,
    reasoningOutputTokens: revision.reportedReasoningOutputTokens ?? 0,
    totalTokens: revision.reportedTotalTokens,
  };
}

export function cumulativeTokenUsage(input: {
  base: TokenUsage | null;
  next?: TokenUsage | undefined;
}): TokenUsage | undefined {
  if (!input.next) return input.base ?? undefined;
  if (input.next.scope === "cumulative") {
    return { ...input.next, scope: "cumulative" };
  }
  const base = input.base;
  return {
    scope: "cumulative",
    inputTokens: (base?.inputTokens ?? 0) + input.next.inputTokens,
    cachedInputTokens:
      (base?.cachedInputTokens ?? 0) + input.next.cachedInputTokens,
    cacheWriteInputTokens:
      (base?.cacheWriteInputTokens ?? 0) + input.next.cacheWriteInputTokens,
    outputTokens: (base?.outputTokens ?? 0) + input.next.outputTokens,
    reasoningOutputTokens:
      (base?.reasoningOutputTokens ?? 0) + input.next.reasoningOutputTokens,
    totalTokens: (base?.totalTokens ?? 0) + input.next.totalTokens,
  };
}

function tokenUsageValues(usage: TokenUsage) {
  return {
    reportedInputTokens: usage.inputTokens,
    reportedCachedInputTokens: usage.cachedInputTokens,
    reportedCacheWriteInputTokens: usage.cacheWriteInputTokens,
    reportedOutputTokens: usage.outputTokens,
    reportedReasoningOutputTokens: usage.reasoningOutputTokens,
    reportedTotalTokens: usage.totalTokens,
  };
}

async function updateStoredTokenUsage(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  revisionId: string,
  usage?: TokenUsage | undefined,
): Promise<void> {
  if (!usage) return;
  await tx
    .update(conversationRevisions)
    .set({
      reportedInputTokens: sql`greatest(coalesce(${conversationRevisions.reportedInputTokens}, 0), ${usage.inputTokens})`,
      reportedCachedInputTokens: sql`greatest(coalesce(${conversationRevisions.reportedCachedInputTokens}, 0), ${usage.cachedInputTokens})`,
      reportedCacheWriteInputTokens: sql`greatest(coalesce(${conversationRevisions.reportedCacheWriteInputTokens}, 0), ${usage.cacheWriteInputTokens})`,
      reportedOutputTokens: sql`greatest(coalesce(${conversationRevisions.reportedOutputTokens}, 0), ${usage.outputTokens})`,
      reportedReasoningOutputTokens: sql`greatest(coalesce(${conversationRevisions.reportedReasoningOutputTokens}, 0), ${usage.reasoningOutputTokens})`,
      reportedTotalTokens: sql`greatest(coalesce(${conversationRevisions.reportedTotalTokens}, 0), ${usage.totalTokens})`,
    })
    .where(eq(conversationRevisions.id, revisionId));
}

export const REVISION_SEARCH_TEXT_LIMIT = 2_048;
export const REVISION_SEARCH_TEXT_MESSAGE_LIMIT = 480;
export const MESSAGE_SEGMENT_CONTENT_LIMIT = 200_000;
export const TOOL_SEGMENT_CONTENT_LIMIT = 8_000;
export const REASONING_SEGMENT_CONTENT_LIMIT = 20_000;
const MESSAGE_INSERT_BATCH_SIZE = 500;
const SEGMENT_INSERT_BATCH_SIZE = 500;

export function storedMessageTextStats(messages: readonly CaptureMessage[]) {
  let textUnits = 0;
  let reasoningTextUnits = 0;
  let toolTextUnits = 0;
  for (const message of messages) {
    for (const segment of message.segments) {
      const units = Array.from(segment.content).length;
      textUnits += units;
      if (segment.type === "reasoning") reasoningTextUnits += units;
      if (segment.type === "tool_status" || message.role === "tool") {
        toolTextUnits += units;
      }
    }
  }
  return { textUnits, reasoningTextUnits, toolTextUnits };
}

function* chunks<T>(items: readonly T[], size: number): Iterable<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}

function truncateForSearchText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= 0) return "";
  const marker = `\n[...${value.length - limit} characters omitted from search text...]\n`;
  const available = limit - marker.length;
  if (available <= 0) return value.slice(0, limit);
  const headLength = Math.ceil(available * 0.7);
  const tailLength = available - headLength;
  return `${value.slice(0, headLength)}${marker}${value.slice(value.length - tailLength)}`;
}

function normalizedSearchText(value: string): string {
  return sanitizeDatabaseText(value)
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
}

function searchableMessageText(message: CaptureMessage): string {
  if (message.role === "tool") return "";
  return normalizedSearchText(
    message.segments
      .filter((segment) => segment.type !== "tool_status" && segment.type !== "reasoning")
      .map((segment) =>
        segment.href ? `${segment.content} (${segment.href})` : segment.content,
      )
      .filter(Boolean)
      .join("\n"),
  );
}

export function buildRevisionSearchText(messages: CaptureMessage[]): string {
  const chunks: string[] = [];
  let remaining = REVISION_SEARCH_TEXT_LIMIT;
  let truncatedMessages = 0;
  let omittedMessages = 0;
  let toolMessagesNotIndexed = 0;

  const orderedMessages = [...messages].sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 0; index < orderedMessages.length; index += 1) {
    const message = orderedMessages[index];
    if (!message) continue;
    if (message.role === "tool") {
      toolMessagesNotIndexed += 1;
      continue;
    }
    const rawText = searchableMessageText(message);
    if (!rawText) continue;

    const messageText = truncateForSearchText(rawText, REVISION_SEARCH_TEXT_MESSAGE_LIMIT);
    if (messageText.length < rawText.length) truncatedMessages += 1;

    const chunk = `[${message.ordinal}:${message.role}]\n${messageText}`;
    const separator = chunks.length ? "\n\n" : "";
    const needed = separator.length + chunk.length;
    if (needed > remaining) {
      if (remaining > separator.length) {
        chunks.push(
          separator + truncateForSearchText(chunk, remaining - separator.length),
        );
      }
      omittedMessages = orderedMessages.length - index - 1;
      break;
    }
    chunks.push(separator + chunk);
    remaining -= needed;
  }

  const body = chunks.join("");
  const notices = [
    truncatedMessages ? `${truncatedMessages} messages truncated` : "",
    omittedMessages ? `${omittedMessages} messages omitted` : "",
    toolMessagesNotIndexed ? `${toolMessagesNotIndexed} tool messages not indexed` : "",
  ].filter(Boolean);
  if (!notices.length) return body;

  const notice = `\n[search index bounded: ${notices.join("; ")}]`;
  if (body.length + notice.length <= REVISION_SEARCH_TEXT_LIMIT) return body + notice;
  return `${body.slice(0, Math.max(0, REVISION_SEARCH_TEXT_LIMIT - notice.length))}${notice}`;
}

export function databaseSafeSegmentContent(segment: CaptureMessage["segments"][number]): string {
  const normalized = redactSensitiveTextForStorage(
    sanitizeDatabaseText(segment.content),
  ).text.replace(/\r\n/g, "\n");
  const limit =
    segment.type === "tool_status"
      ? TOOL_SEGMENT_CONTENT_LIMIT
      : segment.type === "reasoning"
        ? REASONING_SEGMENT_CONTENT_LIMIT
        : MESSAGE_SEGMENT_CONTENT_LIMIT;
  return truncateDatabaseText(normalized, limit, `${segment.type} segment`);
}

/**
 * Produces the exact message representation that can be reconstructed from the
 * database. Revision hashes must use this form, otherwise an intentionally
 * truncated oversized segment would later look like archive corruption.
 */
export function normalizeCaptureMessagesForStorage(
  input: readonly CaptureMessage[],
): CaptureMessage[] {
  return input.map((message) => ({
    ...message,
    segments: message.segments.map((segment) => ({
      ...segment,
      content: databaseSafeSegmentContent(segment),
    })),
  }));
}

function sanitizeCaptureMessageForStorage(
  message: CaptureMessage,
  customRules: readonly CompiledCustomRedactionRule[],
): CaptureMessage {
  const redactedContents = redactSensitiveTextSequenceForStorage(
    message.segments.map((segment) => segment.content),
    customRules,
  ).texts;
  return {
    ...message,
    segments: message.segments.map((segment, index) => ({
      ...segment,
      content: redactedContents[index] ?? "",
      ...(segment.href
        ? { href: redactSensitiveUrlForStorage(segment.href, customRules).text }
        : {}),
    })),
  };
}

export function sanitizeCapturePayloadForStorage(
  payload: CapturePayloadV1,
  customRules: readonly CompiledCustomRedactionRule[] = [],
): CapturePayloadV1 {
  const common = {
    ...payload,
    ...(payload.title
      ? { title: redactSensitiveTextForStorage(payload.title, customRules).text }
      : {}),
    ...(payload.canonicalUrl
      ? {
          canonicalUrl: redactSensitiveUrlForStorage(
            payload.canonicalUrl,
            customRules,
          ).text,
        }
      : {}),
  };
  if ("appendedMessages" in payload) {
    const delta = payload;
    return {
      ...common,
      appendedMessages: delta.appendedMessages.map((message) =>
        sanitizeCaptureMessageForStorage(message, customRules),
      ),
    } as CaptureDeltaV1;
  }
  const snapshot = payload as CaptureSnapshotV1;
  return {
    ...common,
    completeness: {
      ...snapshot.completeness,
      ...(snapshot.completeness.reason
        ? {
            reason: redactSensitiveTextForStorage(
              snapshot.completeness.reason,
              customRules,
            ).text,
          }
        : {}),
    },
    messages: snapshot.messages.map((message) =>
      sanitizeCaptureMessageForStorage(message, customRules),
    ),
  } as CaptureSnapshotV1;
}

async function latestBranchRevision(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  conversationId: string,
  branchFingerprint: string,
) {
  const [revision] = await tx
    .select()
    .from(conversationRevisions)
    .where(
      and(
        eq(conversationRevisions.conversationId, conversationId),
        eq(conversationRevisions.branchFingerprint, branchFingerprint),
      ),
    )
    .orderBy(
      desc(sql`(${conversationRevisions.completeness} = 'complete')`),
      desc(conversationRevisions.capturedAt),
      desc(conversationRevisions.createdAt),
    )
    .limit(1);
  return revision ?? null;
}

async function upsertConversationForSnapshot(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  snapshot: CaptureSnapshotV1,
) {
  const [conversation] = await tx
    .insert(conversations)
    .values({
      provider: snapshot.provider,
      externalSessionId: snapshot.sessionId,
      title: snapshot.title ?? null,
      canonicalUrl: snapshot.canonicalUrl ?? null,
      updatedAt: new Date(snapshot.capturedAt),
    })
    .onConflictDoUpdate({
      target: [conversations.provider, conversations.externalSessionId],
      set: {
        title: snapshot.title ?? sql`${conversations.title}`,
        canonicalUrl: snapshot.canonicalUrl ?? sql`${conversations.canonicalUrl}`,
        updatedAt: sql`greatest(${conversations.updatedAt}, excluded.updated_at)`,
        deletedAt: null,
      },
    })
    .returning({ id: conversations.id });
  if (!conversation) throw new Error("Failed to upsert conversation");
  return conversation;
}

async function insertCaptureRun(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    deviceId: string | null;
    provider: CaptureSnapshotV1["provider"];
    sessionId: string;
    idempotencyKey?: string | undefined;
    snapshotHash?: string | null;
    payloadIdentityHash?: string | null;
    adapterVersion?: string | null;
    messageCount?: number | null;
    status: "complete" | "partial" | "failed";
    capturedAt: string | Date;
    captureMode: CaptureMode;
    triggerReason?: CaptureTriggerReason | undefined;
    baseRevisionId?: string | null;
    baseMessageCount?: number | null;
    error?: string | null;
  },
): Promise<void> {
  await tx
    .insert(captureRuns)
    .values({
      deviceId: input.deviceId,
      provider: input.provider,
      externalSessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey ?? null,
      snapshotHash: input.snapshotHash ?? null,
      payloadIdentityHash: input.payloadIdentityHash ?? null,
      adapterVersion: input.adapterVersion ?? null,
      messageCount: input.messageCount ?? null,
      captureMode: input.captureMode,
      triggerReason: input.triggerReason ?? null,
      baseRevisionId: input.baseRevisionId ?? null,
      baseMessageCount: input.baseMessageCount ?? null,
      status: input.status,
      error: input.error ? truncateDatabaseText(input.error, 10_000, "capture error") : null,
      capturedAt: input.capturedAt instanceof Date ? input.capturedAt : new Date(input.capturedAt),
    })
    .onConflictDoNothing();
}

async function insertRevision(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    conversationId: string;
    snapshot: CaptureSnapshotV1;
    storedMessages: CaptureMessage[];
    storageKind: "snapshot" | "delta";
    hash: string;
    identityHash: string;
    deviceId: string | null;
  },
) {
  // Delta revisions index only the newly stored body. Searching a conversation
  // already spans all revisions, so copying the inherited prefix here wastes
  // space and can crowd the newest text out of the bounded search document.
  const searchText = buildRevisionSearchText(input.storedMessages);
  const textStats = storedMessageTextStats(input.storedMessages);
  const [revision] = await tx
    .insert(conversationRevisions)
    .values({
      conversationId: input.conversationId,
      branchFingerprint: input.snapshot.branchFingerprint,
      snapshotHash: input.hash,
      revisionIdentityHash: input.identityHash,
      contentIntegrityHash: contentIntegrityHash(input.snapshot),
      completeness: input.snapshot.completeness.status,
      topReached: input.snapshot.completeness.topReached,
      bottomReached: input.snapshot.completeness.bottomReached,
      stable: input.snapshot.completeness.stable,
      completenessReason: input.snapshot.completeness.reason ?? null,
      captureMode: input.snapshot.captureMode,
      triggerReason: input.snapshot.triggerReason ?? null,
      baseRevisionId: input.snapshot.baseRevisionId ?? null,
      baseMessageCount: input.snapshot.baseMessageCount ?? null,
      storageKind: input.storageKind,
      adapterVersion: input.snapshot.adapterVersion,
      capturedTitle: input.snapshot.title ?? null,
      capturedCanonicalUrl: input.snapshot.canonicalUrl ?? null,
      metadataCaptured: true,
      sourceDeviceId: input.deviceId,
      capturedAt: new Date(input.snapshot.capturedAt),
      messageCount: input.snapshot.messages.length,
      searchText,
      archivedTextUnits: textStats.textUnits,
      reasoningTextUnits: textStats.reasoningTextUnits,
      toolTextUnits: textStats.toolTextUnits,
      ...(input.snapshot.tokenUsage
        ? tokenUsageValues(input.snapshot.tokenUsage)
        : {}),
    })
    .onConflictDoNothing({
      target: [
        conversationRevisions.conversationId,
        conversationRevisions.revisionIdentityHash,
      ],
    })
    .returning({ id: conversationRevisions.id });
  if (!revision) {
    const [existing] = await tx
      .select({ id: conversationRevisions.id })
      .from(conversationRevisions)
      .where(
        and(
          eq(conversationRevisions.conversationId, input.conversationId),
          eq(conversationRevisions.revisionIdentityHash, input.identityHash),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("Failed to create conversation revision");
    return { id: existing.id, unchanged: true };
  }

  const sortedMessages = [...input.storedMessages].sort(
    (left, right) => left.ordinal - right.ordinal,
  );

  for (const messageBatch of chunks(sortedMessages, MESSAGE_INSERT_BATCH_SIZE)) {
    const insertedMessages = await tx
      .insert(messages)
      .values(
        messageBatch.map((message) => ({
          revisionId: revision.id,
          externalMessageId: message.externalMessageId ?? null,
          ordinal: message.ordinal,
          role: message.role,
          model: message.model ?? null,
          sourceCreatedAt: message.createdAt ? new Date(message.createdAt) : null,
        })),
      )
      .returning({ id: messages.id, ordinal: messages.ordinal });
    if (insertedMessages.length !== messageBatch.length) {
      throw new Error("Failed to create all messages");
    }

    const messageIdsByOrdinal = new Map(
      insertedMessages.map((message) => [message.ordinal, message.id]),
    );
    const segmentRows = messageBatch.flatMap((message) => {
      const messageId = messageIdsByOrdinal.get(message.ordinal);
      if (!messageId) throw new Error("Failed to map inserted message");
      return message.segments.map((segment, ordinal) => ({
        messageId,
        ordinal,
        type: segment.type,
        content: databaseSafeSegmentContent(segment),
        href: segment.href ?? null,
        language: segment.language ?? null,
      }));
    });

    for (const segmentBatch of chunks(segmentRows, SEGMENT_INSERT_BATCH_SIZE)) {
      await tx.insert(messageSegments).values(segmentBatch);
    }
    const searchChunkRows = messageBatch.flatMap((message) => {
      const messageId = messageIdsByOrdinal.get(message.ordinal);
      if (!messageId) throw new Error("Failed to map search chunk message");
      const content = message.segments
        .map((segment) => databaseSafeSegmentContent(segment))
        .join("\n");
      return chunkSearchContent(content).map((chunk, chunkIndex) => ({
        revisionId: revision.id,
        messageId,
        chunkIndex,
        content: chunk,
      }));
    });
    for (const searchChunkBatch of chunks(searchChunkRows, SEGMENT_INSERT_BATCH_SIZE)) {
      await tx.insert(conversationSearchChunks).values(searchChunkBatch);
    }
  }
  return { id: revision.id, unchanged: false };
}

function assertNoDuplicateAppends(
  baseMessages: CaptureMessage[],
  appendedMessages: CaptureMessage[],
): void {
  const existingIds = new Set(
    baseMessages.flatMap((message) =>
      message.externalMessageId ? [message.externalMessageId] : [],
    ),
  );
  const appendedIds = new Set<string>();
  for (const message of appendedMessages) {
    if (message.externalMessageId) {
      if (existingIds.has(message.externalMessageId) || appendedIds.has(message.externalMessageId)) {
        throw new IncrementalBaseMismatchError("Incremental capture contains duplicate message IDs");
      }
      appendedIds.add(message.externalMessageId);
    }
  }
}

export function validateDeltaBase(input: {
  delta: CaptureDeltaV1;
  baseRevision: typeof conversationRevisions.$inferSelect;
  baseMessages: CaptureMessage[];
}): void {
  if (input.baseRevision.completeness !== "complete") {
    throw new IncrementalBaseMismatchError("Partial revisions cannot be used as an incremental base");
  }
  if (input.baseRevision.branchFingerprint !== input.delta.branchFingerprint) {
    throw new IncrementalBaseMismatchError("Incremental branch fingerprint does not match the base");
  }
  if (input.delta.baseRevisionId && input.delta.baseRevisionId !== input.baseRevision.id) {
    throw new IncrementalBaseMismatchError("Incremental base revision is no longer current");
  }
  if (input.baseRevision.messageCount !== input.delta.baseMessageCount) {
    throw new IncrementalBaseMismatchError("Incremental base message count does not match");
  }
  const last = input.baseMessages.at(-1);
  if (!last) throw new IncrementalBaseMismatchError("Incremental base has no messages");
  if (
    input.delta.baseLastMessageId &&
    input.delta.baseLastMessageId !== last.externalMessageId
  ) {
    throw new IncrementalBaseMismatchError("Incremental base last message ID does not match");
  }
  if (
    !input.delta.baseLastMessageId &&
    !input.delta.baseRevisionId &&
    input.delta.baseLastMessageTextHash &&
    input.delta.baseLastMessageTextHash !== messageFingerprint(last)
  ) {
    throw new IncrementalBaseMismatchError("Incremental base last message text hash does not match");
  }
  const expectedOrdinals = input.delta.appendedMessages.map(
    (message, index) => input.delta.baseMessageCount + index,
  );
  if (
    input.delta.appendedMessages.some(
      (message, index) => message.ordinal !== expectedOrdinals[index],
    )
  ) {
    throw new IncrementalBaseMismatchError("Incremental message ordinals are not contiguous");
  }
  assertNoDuplicateAppends(input.baseMessages, input.delta.appendedMessages);
}

export function mergedSnapshotFromDelta(input: {
  delta: CaptureDeltaV1;
  baseRevision: typeof conversationRevisions.$inferSelect;
  baseMessages: CaptureMessage[];
}): CaptureSnapshotV1 {
  const tokenUsage = cumulativeTokenUsage({
    base: storedTokenUsage(input.baseRevision),
    next: input.delta.tokenUsage,
  });
  return CaptureSnapshotV1Schema.parse({
    schemaVersion: 1,
    provider: input.delta.provider,
    sessionId: input.delta.sessionId,
    branchFingerprint: input.delta.branchFingerprint,
    ...(input.delta.title || input.baseRevision.capturedTitle
      ? { title: input.delta.title ?? input.baseRevision.capturedTitle ?? undefined }
      : {}),
    ...(input.delta.canonicalUrl || input.baseRevision.capturedCanonicalUrl
      ? {
          canonicalUrl:
            input.delta.canonicalUrl ?? input.baseRevision.capturedCanonicalUrl ?? undefined,
        }
      : {}),
    adapterVersion: input.delta.adapterVersion,
    capturedAt: input.delta.capturedAt,
    captureMode: "append",
    triggerReason: input.delta.triggerReason,
    ...(tokenUsage ? { tokenUsage } : {}),
    baseRevisionId: input.baseRevision.id,
    baseMessageCount: input.delta.baseMessageCount,
    baseLastMessageId: input.delta.baseLastMessageId,
    baseLastMessageTextHash: input.delta.baseLastMessageTextHash,
    completeness: {
      status: "complete",
      topReached: true,
      bottomReached: true,
      stable: true,
    },
    messages: [...input.baseMessages, ...input.delta.appendedMessages],
  });
}

export function revisionStorageBody(
  payload: CapturePayloadV1,
  snapshot: CaptureSnapshotV1,
): {
  storedMessages: CaptureMessage[];
  storageKind: "snapshot" | "delta";
} {
  return "appendedMessages" in payload
    ? { storedMessages: payload.appendedMessages, storageKind: "delta" }
    : { storedMessages: snapshot.messages, storageKind: "snapshot" };
}

async function snapshotFromPayload(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  payload: CapturePayloadV1,
): Promise<{
  snapshot: CaptureSnapshotV1;
  storedMessages: CaptureMessage[];
  storageKind: "snapshot" | "delta";
}> {
  if ("appendedMessages" in payload) {
    const delta = payload;
    const [conversation] = await tx
      .select({ id: conversations.id })
      .from(conversations)
      .where(
        and(
          eq(conversations.provider, delta.provider),
          eq(conversations.externalSessionId, delta.sessionId),
        ),
      )
      .limit(1);
    if (!conversation) throw new IncrementalBaseMismatchError("Conversation does not exist");
    const baseRevision = await latestBranchRevision(
      tx,
      conversation.id,
      delta.branchFingerprint,
    );
    if (!baseRevision) throw new IncrementalBaseMismatchError("No base revision exists");
    const baseMessages = await loadCaptureRevisionMessages(baseRevision.id, tx);
    validateDeltaBase({ delta, baseRevision, baseMessages });
    const snapshot = mergedSnapshotFromDelta({ delta, baseRevision, baseMessages });
    return { snapshot, ...revisionStorageBody(delta, snapshot) };
  }
  const snapshot = CaptureSnapshotV1Schema.parse(payload);
  return { snapshot, ...revisionStorageBody(payload, snapshot) };
}

export async function ingestCapture(
  rawPayload: unknown,
  deviceId: string | null,
  idempotencyKey?: string,
): Promise<{
  conversationId: string;
  revisionId: string;
  unchanged: boolean;
  completeness: "complete" | "partial";
  messageCount: number;
  captureMode: CaptureMode;
  triggerReason: CaptureTriggerReason | null;
}> {
  const parsedPayload = CapturePayloadV1Schema.parse(rawPayload);
  const payload = sanitizeCapturePayloadForStorage(
    parsedPayload,
    await loadEnabledCustomRedactionRules(),
  );

  return db.transaction(async (tx) => {
    const provider = payload.provider;
    const sessionId = payload.sessionId;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`conversation:${provider}:${sessionId}`}, 0))`,
    );

    const resolved = await snapshotFromPayload(tx, payload);
    const snapshot = {
      ...resolved.snapshot,
      messages: normalizeCaptureMessagesForStorage(resolved.snapshot.messages),
    };
    const storedMessages = normalizeCaptureMessagesForStorage(resolved.storedMessages);
    const { storageKind } = resolved;
    const hash = snapshotHash(snapshot);
    const identityHash = revisionIdentityHash(snapshot);

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${snapshot.provider}:${snapshot.sessionId}:${snapshot.branchFingerprint}`}, 0))`,
    );

    if (deviceId && idempotencyKey) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${deviceId}:${idempotencyKey}`}, 0))`,
      );
      const [previousRun] = await tx
        .select({
          snapshotHash: captureRuns.snapshotHash,
          payloadIdentityHash: captureRuns.payloadIdentityHash,
        })
        .from(captureRuns)
        .where(
          and(
            eq(captureRuns.deviceId, deviceId),
            eq(captureRuns.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (previousRun) {
        const replayMode = captureIdempotencyReplayMode({
          previousSnapshotHash: previousRun.snapshotHash,
          previousPayloadIdentityHash: previousRun.payloadIdentityHash,
          currentSnapshotHash: hash,
          currentRevisionIdentityHash: identityHash,
        });
        if (replayMode === "conflict") {
          throw new Error("Idempotency-Key was already used for another capture payload");
        }
        if (replayMode === "legacy_bypass") {
          // Pre-V2.3 agents derived the key from source-file bytes, while the
          // server-side normalized snapshot hash can change after redaction or
          // storage-normalization upgrades. Treat that unverifiable legacy key
          // as absent for this request; revision identity still deduplicates the
          // archive and current capture records retain strict payload identity.
          idempotencyKey = undefined;
        } else {
        const [previousConversation] = await tx
          .select({ id: conversations.id })
          .from(conversations)
          .where(
            and(
              eq(conversations.provider, snapshot.provider),
              eq(conversations.externalSessionId, snapshot.sessionId),
            ),
          )
          .limit(1);
        let [previousRevision] = previousConversation
          ? await tx
              .select({ id: conversationRevisions.id })
              .from(conversationRevisions)
              .where(
                and(
                  eq(conversationRevisions.conversationId, previousConversation.id),
                  previousRun.payloadIdentityHash
                    ? eq(conversationRevisions.revisionIdentityHash, identityHash)
                    : and(
                        eq(conversationRevisions.snapshotHash, hash),
                        isNull(conversationRevisions.revisionIdentityHash),
                      ),
                ),
              )
              .limit(1)
          : [];
        if (!previousRevision && previousConversation && !previousRun.payloadIdentityHash) {
          [previousRevision] = await tx
            .select({ id: conversationRevisions.id })
            .from(conversationRevisions)
            .where(and(
              eq(conversationRevisions.conversationId, previousConversation.id),
              eq(conversationRevisions.snapshotHash, hash),
            ))
            .limit(1);
        }
        if (!previousConversation || !previousRevision) {
          throw new Error("Idempotency record is inconsistent with the archived capture");
        }
        await tx
          .update(conversations)
          .set({
            title: snapshot.title ?? sql`${conversations.title}`,
            canonicalUrl: snapshot.canonicalUrl ?? sql`${conversations.canonicalUrl}`,
            updatedAt: sql`greatest(${conversations.updatedAt}, ${snapshot.capturedAt}::timestamptz)`,
            deletedAt: null,
          })
          .where(eq(conversations.id, previousConversation.id));
        await updateStoredTokenUsage(
          tx,
          previousRevision.id,
          snapshot.tokenUsage,
        );
        return {
          conversationId: previousConversation.id,
          revisionId: previousRevision.id,
          unchanged: true,
          completeness: snapshot.completeness.status,
          messageCount: snapshot.messages.length,
          captureMode: snapshot.captureMode,
          triggerReason: snapshot.triggerReason ?? null,
        };
        }
      }
    }

    const conversation = await upsertConversationForSnapshot(tx, snapshot);
    const [existing] = await tx
      .select({ id: conversationRevisions.id })
      .from(conversationRevisions)
      .where(
        and(
          eq(conversationRevisions.conversationId, conversation.id),
          eq(conversationRevisions.revisionIdentityHash, identityHash),
        ),
      )
      .limit(1);

    if (existing) {
      await updateStoredTokenUsage(tx, existing.id, snapshot.tokenUsage);
      await insertCaptureRun(tx, {
        deviceId,
        provider: snapshot.provider,
        sessionId: snapshot.sessionId,
        idempotencyKey,
        snapshotHash: hash,
        payloadIdentityHash: identityHash,
        adapterVersion: snapshot.adapterVersion,
        messageCount: snapshot.messages.length,
        status: snapshot.completeness.status,
        capturedAt: snapshot.capturedAt,
        captureMode: snapshot.captureMode,
        triggerReason: snapshot.triggerReason,
        baseRevisionId: snapshot.baseRevisionId ?? null,
        baseMessageCount: snapshot.baseMessageCount ?? null,
      });
      return {
        conversationId: conversation.id,
        revisionId: existing.id,
        unchanged: true,
        completeness: snapshot.completeness.status,
        messageCount: snapshot.messages.length,
        captureMode: snapshot.captureMode,
        triggerReason: snapshot.triggerReason ?? null,
      };
    }

    const revision = await insertRevision(tx, {
      conversationId: conversation.id,
      snapshot,
      storedMessages,
      storageKind,
      hash,
      identityHash,
      deviceId,
    });
    await updateStoredTokenUsage(tx, revision.id, snapshot.tokenUsage);
    await insertCaptureRun(tx, {
      deviceId,
      provider: snapshot.provider,
      sessionId: snapshot.sessionId,
      idempotencyKey,
      snapshotHash: hash,
      payloadIdentityHash: identityHash,
      adapterVersion: snapshot.adapterVersion,
      messageCount: snapshot.messages.length,
      status: snapshot.completeness.status,
      capturedAt: snapshot.capturedAt,
      captureMode: snapshot.captureMode,
      triggerReason: snapshot.triggerReason,
      baseRevisionId: snapshot.baseRevisionId ?? null,
      baseMessageCount: snapshot.baseMessageCount ?? null,
    });

    return {
      conversationId: conversation.id,
      revisionId: revision.id,
      unchanged: revision.unchanged,
      completeness: snapshot.completeness.status,
      messageCount: snapshot.messages.length,
      captureMode: snapshot.captureMode,
      triggerReason: snapshot.triggerReason ?? null,
    };
  });
}

export async function recordCaptureFailure(input: {
  deviceId: string | null;
  provider: CaptureSnapshotV1["provider"];
  sessionId: string;
  capturedAt: Date;
  error: string;
  captureMode?: CaptureMode;
  triggerReason?: CaptureTriggerReason;
  adapterVersion?: string;
  messageCount?: number;
}): Promise<void> {
  await db.insert(captureRuns).values({
    deviceId: input.deviceId,
    provider: input.provider,
    externalSessionId: input.sessionId,
    idempotencyKey: null,
    captureMode: input.captureMode ?? "full",
    triggerReason: input.triggerReason ?? null,
    adapterVersion: input.adapterVersion ?? null,
    messageCount: input.messageCount ?? null,
    status: "failed",
    error: truncateDatabaseText(
      redactSensitiveTextForStorage(input.error).text,
      10_000,
      "capture error",
    ),
    capturedAt: input.capturedAt,
  }).onConflictDoNothing();
}

export async function latestRevisionId(
  conversationId: string,
): Promise<string | null> {
  const [revision] = await db
    .select({ id: conversationRevisions.id })
    .from(conversationRevisions)
    .where(eq(conversationRevisions.conversationId, conversationId))
    .orderBy(
      desc(sql`(${conversationRevisions.completeness} = 'complete')`),
      desc(conversationRevisions.capturedAt),
      desc(conversationRevisions.createdAt),
    )
    .limit(1);
  return revision?.id ?? null;
}

export async function hardDeleteConversation(id: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({
        id: conversations.id,
        provider: conversations.provider,
        externalSessionId: conversations.externalSessionId,
      })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);
    if (!conversation) return false;

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`conversation:${conversation.provider}:${conversation.externalSessionId}`}, 0))`,
    );

    await tx
      .delete(captureRuns)
      .where(
        and(
          eq(captureRuns.provider, conversation.provider),
          eq(captureRuns.externalSessionId, conversation.externalSessionId),
        ),
      );

    const rows = await tx
      .delete(conversations)
      .where(eq(conversations.id, id))
      .returning({ id: conversations.id });
    return rows.length > 0;
  });
}

export async function softDeleteConversation(id: string): Promise<boolean> {
  const rows = await db
    .update(conversations)
    .set({ deletedAt: new Date() })
    .where(and(eq(conversations.id, id), isNull(conversations.deletedAt)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

export async function restoreConversation(id: string): Promise<boolean> {
  const rows = await db
    .update(conversations)
    .set({ deletedAt: null })
    .where(and(eq(conversations.id, id), isNotNull(conversations.deletedAt)))
    .returning({ id: conversations.id });
  return rows.length > 0;
}

export async function purgeDeletedConversations(retentionDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000);
  const rows = await db
    .select({ id: conversations.id })
    .from(conversations)
    .where(and(isNotNull(conversations.deletedAt), lt(conversations.deletedAt, cutoff)));
  let purged = 0;
  for (const row of rows) {
    if (await hardDeleteConversation(row.id)) purged += 1;
  }
  return purged;
}
