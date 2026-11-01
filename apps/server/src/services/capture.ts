import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
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
  devices,
  messageSegments,
  messages,
} from "../schema.js";
import { chunkSearchContent } from "./search-chunks.js";
import { sanitizeDatabaseText, truncateDatabaseText } from "./text-safety.js";
import { loadCaptureRevisionMessages, loadCaptureRevisionMessagesBatch } from "./revision-storage.js";
import { persistConversationParent } from "./conversation-lineage.js";
import { mergeConversationMessages } from "./conversation-merge.js";
import { planLocalCodexRepair } from "./local-source-repair.js";
import { projectSourceReview, sourceReviewBodyHash } from "./source-review.js";
import { extractCjkTerms, storeConversationSearchTerms } from "./search-documents.js";
import { buildArchiveReadModel, persistArchiveReferences } from "./archive-read-models.js";
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

export class BatchCaptureExpiredError extends Error {
  constructor() { super("补采任务已结束或原归档已删除，本次后台上传未写入"); }
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type RevisionRow = typeof conversationRevisions.$inferSelect;
type MergeEvidence = RevisionRow["mergeEvidence"];
type MessageStorageMetadata = typeof messages.$inferSelect & { fingerprint?: string };
export type CaptureReceipt = NonNullable<typeof captureRuns.$inferSelect.receipt>;
const emptyMergeEvidence = (): MergeEvidence => ({ variants: [], warnings: [] });

function normalizedSegmentContent(type: string, content: string): string {
  const normalized = sanitizeDatabaseText(content).replace(/\r+\n/g, "\n");
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
  return revisionIdentityFromSnapshotHash(snapshot, snapshotHash(snapshot));
}

function revisionIdentityFromSnapshotHash(snapshot: CaptureSnapshotV1, hash: string): string {
  return createHash("sha256").update(JSON.stringify({
    snapshotHash: hash,
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
export function contentIntegrityHash(snapshot: CaptureSnapshotV1, evidence?: MergeEvidence): string {
  const metadata = {
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
    ...(evidence ? { reportedTokenUsage: snapshot.tokenUsage ?? null, mergeEvidence: {
      variants: evidence.variants.map((message) => ({
        ordinal: message.ordinal, externalMessageId: message.externalMessageId ?? null,
        role: message.role, model: message.model ?? null,
        createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : null,
        segments: message.segments.map((segment) => ({
          type: segment.type, content: normalizedSegmentContent(segment.type, segment.content),
          href: segment.href ?? null, language: segment.language ?? null,
        })),
      })),
      warnings: evidence.warnings,
      ...(evidence.sourceReview ? { sourceReview: {
        version: evidence.sourceReview.version, source: evidence.sourceReview.source,
        ...(evidence.sourceReview.contentComplete !== undefined ? { contentComplete: evidence.sourceReview.contentComplete } : {}),
        ...(evidence.sourceReview.captureComplete !== undefined ? { captureComplete: evidence.sourceReview.captureComplete } : {}),
        sessionId: evidence.sourceReview.sessionId, verifiedAt: evidence.sourceReview.verifiedAt,
        sourceUrl: evidence.sourceReview.sourceUrl, currentMessageIds: evidence.sourceReview.currentMessageIds,
        inactiveMessages: evidence.sourceReview.inactiveMessages.map((message) => ({
          messageId: message.messageId, replacedByMessageId: message.replacedByMessageId,
        })),
        ...(evidence.sourceReview.inactiveAnonymousBodies !== undefined
          ? { inactiveAnonymousBodies: evidence.sourceReview.inactiveAnonymousBodies } : {}),
        selectedBodies: evidence.sourceReview.selectedBodies.map((message) => ({ messageId: message.messageId, bodyHash: message.bodyHash })),
        reviewedBodies: evidence.sourceReview.reviewedBodies.map((message) => ({
          messageId: message.messageId, bodyHash: message.bodyHash, kind: message.kind,
        })),
        ...(evidence.sourceReview.invalidatedByCapture ? { invalidatedByCapture: {
          capturedAt: evidence.sourceReview.invalidatedByCapture.capturedAt,
          reason: evidence.sourceReview.invalidatedByCapture.reason,
        } } : {}),
      } } : {}),
    } } : {}),
  };
  const hash = createHash("sha256");
  const serializedMetadata = JSON.stringify(metadata);
  hash.update(serializedMetadata.slice(0, -1));
  hash.update(',"messages":[');
  const orderedMessages = [...snapshot.messages]
    .sort((left, right) => left.ordinal - right.ordinal);
  for (const [index, message] of orderedMessages.entries()) {
    if (index > 0) hash.update(",");
    hash.update(JSON.stringify({
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
    }));
  }
  hash.update("]}");
  return hash.digest("hex");
}

export function storedTokenUsage(
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
  ).text.replace(/\r+\n/g, "\n");
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
  snapshot: CapturePayloadV1,
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
  await persistConversationParent(tx, conversation.id, snapshot);
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
    requestHash?: string | null;
    receipt?: CaptureReceipt | null;
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
      requestHash: input.requestHash ?? null,
      receipt: input.receipt ?? null,
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

export async function writeAccumulatedRevision(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    conversationId: string;
    snapshot: CaptureSnapshotV1;
    deviceId: string | null;
    existing?: RevisionRow | undefined;
    mergeEvidence: MergeEvidence;
    replaceBody: boolean;
    messageMetadata?: MessageStorageMetadata[];
    previousBody?: CaptureMessage[] | undefined;
  },
) {
  const sortedMessages = [...input.snapshot.messages].sort((left, right) => left.ordinal - right.ordinal);
  // Callers prepare new captures before merging them with archived facts. A
  // metadata-only write must hash the exact body that remains in the database.
  if (!input.replaceBody) {
    if (!input.existing) throw new Error("Cannot skip the body of a new accumulated revision");
    const previousBody = input.previousBody ?? await loadCaptureRevisionMessages(input.existing.id, tx);
    if (!storedBodiesEqual(previousBody, sortedMessages)) {
      throw new Error("Cannot skip writing a changed accumulated revision body");
    }
  }
  // Decide before updating revision metadata: the previous evidence describes
  // which alternate observations are already indexed alongside old messages.
  const appendOnly = Boolean(input.existing?.isAccumulated && input.existing.storageKind === "snapshot" &&
    !input.existing.baseRevisionId && !input.messageMetadata && input.previousBody &&
    sortedMessages.length > input.previousBody.length &&
    storedBodiesEqual(input.previousBody, sortedMessages.slice(0, input.previousBody.length)) &&
    JSON.stringify(input.mergeEvidence) === JSON.stringify(input.existing.mergeEvidence ?? emptyMergeEvidence()) &&
    !input.mergeEvidence.variants.some((variant) => variant.externalMessageId &&
      sortedMessages.slice(input.previousBody!.length).some((message) => message.externalMessageId === variant.externalMessageId)));
  const textStats = storedMessageTextStats([...input.snapshot.messages, ...input.mergeEvidence.variants]);
  const readModel = buildArchiveReadModel({ sessionId: input.snapshot.sessionId, provider: input.snapshot.provider,
    messages: sortedMessages, evidence: input.mergeEvidence });
  const values = {
      conversationId: input.conversationId,
      branchFingerprint: input.snapshot.branchFingerprint,
      snapshotHash: snapshotHash(input.snapshot),
      revisionIdentityHash: revisionIdentityHash(input.snapshot),
      contentIntegrityHash: contentIntegrityHash(input.snapshot, input.mergeEvidence),
      isAccumulated: true,
      mergeEvidence: input.mergeEvidence,
      completeness: input.snapshot.completeness.status,
      topReached: input.snapshot.completeness.topReached,
      bottomReached: input.snapshot.completeness.bottomReached,
      stable: input.snapshot.completeness.stable,
      completenessReason: input.snapshot.completeness.reason ?? null,
      captureMode: input.snapshot.captureMode,
      triggerReason: input.snapshot.triggerReason ?? null,
      baseRevisionId: null,
      baseMessageCount: null,
      storageKind: "snapshot" as const,
      adapterVersion: input.snapshot.adapterVersion,
      capturedTitle: input.snapshot.title ?? null,
      capturedCanonicalUrl: input.snapshot.canonicalUrl ?? null,
      metadataCaptured: true,
      sourceDeviceId: input.deviceId ?? input.existing?.sourceDeviceId ?? null,
      capturedAt: new Date(input.snapshot.capturedAt),
      messageCount: input.snapshot.messages.length,
      searchText: "",
      presentationMessageCount: readModel.presentationMessageCount,
      storedMessageCount: readModel.storedMessageCount,
      sourceContentPending: readModel.sourceContentPending,
      archiveReview: readModel.archiveReview,
      archivedTextUnits: textStats.textUnits,
      reasoningTextUnits: textStats.reasoningTextUnits,
      toolTextUnits: textStats.toolTextUnits,
      ...(input.snapshot.tokenUsage
        ? tokenUsageValues(input.snapshot.tokenUsage)
        : {}),
    };
  const [revision] = input.existing
    ? await tx.update(conversationRevisions).set(values).where(eq(conversationRevisions.id, input.existing.id)).returning()
    : await tx.insert(conversationRevisions).values(values).returning();
  if (!revision) throw new Error("Failed to store accumulated conversation");
  if (!input.existing || input.existing.presentationMessageCount == null ||
      JSON.stringify(input.existing.mergeEvidence) !== JSON.stringify(input.mergeEvidence) ||
      ((readModel.archiveReview || input.mergeEvidence.variants.length > 0) && input.existing.messageCount !== sortedMessages.length) ||
      (input.replaceBody && !appendOnly)) {
    await persistArchiveReferences(tx, revision.id, readModel);
  }
  if (!input.replaceBody) return revision;
  const previousMessages: MessageStorageMetadata[] = appendOnly ? [] : input.messageMetadata ?? (input.existing
    ? await tx.select().from(messages).where(eq(messages.revisionId, revision.id)) : []);
  const previousBody = new Map(appendOnly ? [] : input.previousBody?.map((message) => [message.ordinal, message]) ?? []);
  const previousByKey = new Map<string, MessageStorageMetadata[]>();
  for (const message of previousMessages) {
    const fingerprint = message.fingerprint ?? (previousBody.has(message.ordinal) ? messageFingerprint(previousBody.get(message.ordinal)!) : undefined);
    const key = message.externalMessageId ? `id:${message.externalMessageId}` : fingerprint ? `body:${fingerprint}` : `ordinal:${message.ordinal}:${message.role}`;
    const group = previousByKey.get(key) ?? [];
    group.push(message);
    previousByKey.set(key, group);
  }
  for (const group of previousByKey.values()) group.sort((left, right) =>
    Number(right.revisionId === revision.id) - Number(left.revisionId === revision.id) || left.createdAt.getTime() - right.createdAt.getTime());
  const reusedMessageIds = new Set<string>();
  if (input.existing && !appendOnly) await tx.delete(messages).where(eq(messages.revisionId, revision.id));
  const primaryOrdinals = new Map(sortedMessages.flatMap((message) => message.externalMessageId ? [[message.externalMessageId, message.ordinal] as const] : []));
  const variantsByOrdinal = new Map<number, CaptureMessage[]>();
  for (const variant of input.mergeEvidence.variants) {
    const ordinal = (variant.externalMessageId ? primaryOrdinals.get(variant.externalMessageId) : undefined) ?? sortedMessages[0]!.ordinal;
    const group = variantsByOrdinal.get(ordinal) ?? [];
    group.push(variant);
    variantsByOrdinal.set(ordinal, group);
  }

  const messagesToInsert = appendOnly ? sortedMessages.slice(input.previousBody!.length) : sortedMessages;
  const incomingSearchTerms = new Set<string>();
  for (const messageBatch of chunks(messagesToInsert, MESSAGE_INSERT_BATCH_SIZE)) {
    const insertedMessages = await tx
      .insert(messages)
      .values(
        messageBatch.map((message) => {
          const candidates = previousByKey.get(message.externalMessageId ? `id:${message.externalMessageId}` : `body:${messageFingerprint(message)}`) ?? [];
          const previous = candidates.find((candidate) => !reusedMessageIds.has(candidate.id));
          const earliest = candidates.reduce((date, candidate) => candidate.createdAt < date ? candidate.createdAt : date, previous?.createdAt ?? new Date());
          if (previous) reusedMessageIds.add(previous.id);
          // Reuse the first-observed timestamp and durable message ID when a
          // message survives a reorder or a richer rendering of its content.
          return ({
          ...(previous ? { id: previous.id, createdAt: earliest } : {}),
          revisionId: revision.id,
          externalMessageId: message.externalMessageId ?? null,
          ordinal: message.ordinal,
          role: message.role,
          model: message.model ?? null,
          sourceCreatedAt: message.createdAt ? new Date(message.createdAt) : null,
        }); }),
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
        // Already prepared at ingestion, or read unchanged from the archive.
        // Reapplying today's limits/redaction would destroy older stored facts
        // after their hash had been calculated from the original content.
        content: segment.content,
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
      const content = [message, ...(variantsByOrdinal.get(message.ordinal) ?? [])].flatMap((item) => item.segments)
        .map((segment) => segment.content)
        .join("\n");
      return chunkSearchContent(content).map((chunk, chunkIndex) => ({
        revisionId: revision.id,
        messageId,
        chunkIndex,
        content: chunk,
      }));
    });
    for (const row of searchChunkRows) for (const term of extractCjkTerms(row.content)) incomingSearchTerms.add(term);
    for (const searchChunkBatch of chunks(searchChunkRows, SEGMENT_INSERT_BATCH_SIZE)) {
      await tx.insert(conversationSearchChunks).values(searchChunkBatch);
    }
  }
  await storeConversationSearchTerms(tx, input.conversationId, incomingSearchTerms, appendOnly);
  return revision;
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
  if (!input.delta.baseContentHash || !input.baseRevision.contentIntegrityHash ||
      input.delta.baseContentHash !== input.baseRevision.contentIntegrityHash) {
    throw new IncrementalBaseMismatchError("Incremental content baseline is missing or no longer current");
  }
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
    ...(input.delta.parentSessionId ? { parentSessionId: input.delta.parentSessionId } : {}),
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
      topReached: input.delta.appendedMessages.length ? true : input.baseRevision.topReached ?? true,
      bottomReached: input.delta.appendedMessages.length ? true : input.baseRevision.bottomReached ?? true,
      stable: input.delta.appendedMessages.length ? true : input.baseRevision.stable ?? true,
      ...(!input.delta.appendedMessages.length && input.baseRevision.completenessReason
        ? { reason: input.baseRevision.completenessReason }
        : {}),
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

export function captureRequestHash(payload: CapturePayloadV1): string {
  // Capture timestamps and lineage may be refreshed while retrying identical
  // source content. The body, baseline, title, URL and usage remain strict.
  const { capturedAt: _capturedAt, triggerReason: _triggerReason, parentSessionId: _parentSessionId, ...facts } = payload;
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
  return createHash("sha256").update(JSON.stringify(canonical(facts))).digest("hex");
}

function maxTokenUsage(left?: TokenUsage, right?: TokenUsage): TokenUsage | undefined {
  if (!left) return right ? { ...right, scope: "cumulative" } : undefined;
  if (!right) return { ...left, scope: "cumulative" };
  return {
    scope: "cumulative",
    inputTokens: Math.max(left.inputTokens, right.inputTokens),
    cachedInputTokens: Math.max(left.cachedInputTokens, right.cachedInputTokens),
    cacheWriteInputTokens: Math.max(left.cacheWriteInputTokens, right.cacheWriteInputTokens),
    outputTokens: Math.max(left.outputTokens, right.outputTokens),
    reasoningOutputTokens: Math.max(left.reasoningOutputTokens, right.reasoningOutputTokens),
    totalTokens: Math.max(left.totalTokens, right.totalTokens),
  };
}

function snapshotWithoutBase(snapshot: CaptureSnapshotV1): CaptureSnapshotV1 {
  const { baseRevisionId: _baseId, baseMessageCount: _baseCount, baseLastMessageId: _baseLastId,
    baseLastMessageTextHash: _baseTextHash, ...canonical } = snapshot;
  return canonical;
}

function observationFingerprint(message: CaptureMessage): string {
  return createHash("sha256").update(JSON.stringify({ body: messageFingerprint(message), model: message.model ?? null,
    createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : null })).digest("hex");
}

function collectMergeEvidence(
  evidence: readonly MergeEvidence[],
  conflicts: ReturnType<typeof mergeConversationMessages>["conflicts"],
  body: readonly CaptureMessage[],
  verifiedOrderMessageIds?: ReadonlySet<string>,
  sourceObservations: readonly CaptureMessage[] = [],
): MergeEvidence {
  const variants = new Map<string, CaptureMessage>();
  const localSourceRepair = evidence.flatMap(prior => prior.localSourceRepair ? [prior.localSourceRepair] : [])
    .sort((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt))[0];
  const warnings = new Map<string, MergeEvidence["warnings"][number]>();
  const sourceReview = evidence.flatMap((prior) => prior.sourceReview ? [prior.sourceReview] : [])
    .sort((left, right) => Date.parse(right.verifiedAt) - Date.parse(left.verifiedAt) ||
      (right.invalidatedByCapture ? Date.parse(right.invalidatedByCapture.capturedAt) : 0) -
      (left.invalidatedByCapture ? Date.parse(left.invalidatedByCapture.capturedAt) : 0))[0];
  const reviewedIds = new Set(sourceReview ? [...sourceReview.currentMessageIds,
    ...sourceReview.inactiveMessages.map((message) => message.messageId)] : []);
  const reviewedAnonymous = new Set(sourceReview?.inactiveAnonymousBodies ?? []);
  const isReviewed = (message: CaptureMessage) => message.externalMessageId
    ? reviewedIds.has(message.externalMessageId) : reviewedAnonymous.has(sourceReviewBodyHash(message));
  const fingerprint = (message: CaptureMessage) => isReviewed(message)
    ? createHash("sha256").update(JSON.stringify({ body: sourceReviewBodyHash(message), model: message.model ?? null,
      createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : null })).digest("hex")
    : observationFingerprint(message);
  for (const prior of evidence) {
    for (const message of prior.variants ?? []) variants.set(fingerprint(message), message);
    for (const warning of prior.warnings ?? []) {
      if ((warning.type === "order" || warning.type === "disconnected") && warning.messageIds.length > 0 &&
        warning.messageIds.every((id) => verifiedOrderMessageIds?.has(id))) continue;
      warnings.set(JSON.stringify(warning), warning);
    }
  }
  for (const conflict of conflicts) {
    if (conflict.type === "content") {
      for (const message of [conflict.previous, conflict.incoming]) {
        if (message) variants.set(fingerprint(message), message);
      }
    }
    const warning = { type: conflict.type, messageIds: conflict.messageIds ??
      [conflict.previous?.externalMessageId, conflict.incoming?.externalMessageId].filter((id): id is string => Boolean(id)) };
    warnings.set(JSON.stringify(warning), warning);
  }
  // Prefix expansion and whitespace equivalence intentionally do not create
  // core merge conflicts. A source review needs their exact observations:
  // keep its selected body and make every unknown scoped body reviewable.
  for (const message of sourceObservations) if (isReviewed(message)) {
    variants.set(fingerprint(message), message);
  }
  if (!variants.size) return { variants: [], warnings: [...warnings.values()], ...(sourceReview ? { sourceReview } : {}),
    ...(localSourceRepair ? { localSourceRepair } : {}) };
  const variantIds = new Set([...variants.values()].flatMap((message) => message.externalMessageId ? [message.externalMessageId] : []));
  const hasAnonymousVariants = [...variants.values()].some((message) => !message.externalMessageId);
  // Long Codex histories usually contain no variants. Only hash primary
  // messages that can actually match a stored alternate observation.
  const primaryFingerprints = new Set(body.filter((message) => message.externalMessageId
    ? variantIds.has(message.externalMessageId) : hasAnonymousVariants).map(fingerprint));
  return { variants: [...variants].filter(([fingerprint]) => !primaryFingerprints.has(fingerprint)).map(([, message]) => message),
    warnings: [...warnings.values()], ...(sourceReview ? { sourceReview } : {}),
    ...(localSourceRepair ? { localSourceRepair } : {}) };
}

function verifiedFullCaptureOrder(
  existing: CaptureSnapshotV1 | undefined,
  incoming: CaptureSnapshotV1,
  merged: ReturnType<typeof mergeConversationMessages>,
): ReadonlySet<string> | undefined {
  if (!existing?.messages.length || incoming.captureMode !== "full" || incoming.completeness.status !== "complete" ||
    !incoming.completeness.topReached || !incoming.completeness.bottomReached || !incoming.completeness.stable ||
    !(new Date(incoming.capturedAt).getTime() >= new Date(existing.capturedAt).getTime()) || !merged.sourceMatchesArchive) return;
  const byId = (body: readonly CaptureMessage[]) => {
    const result = new Map<string, CaptureMessage>();
    for (const message of body) {
      const id = message.externalMessageId;
      // Known positional DOM fallbacks do not establish identity across scans.
      if (!id?.trim() || /^(?:turn|conversation-turn)-\d+$/i.test(id) || result.has(id)) return;
      result.set(id, message);
    }
    return result;
  };
  const oldMessages = byId(existing.messages);
  const observedMessages = byId(incoming.messages);
  if (!oldMessages || !observedMessages ||
    [...oldMessages].some(([id, message]) => observedMessages.get(id)?.role !== message.role)) return;
  // A complete observation can correct an old ordering in one pass, provided
  // every old identity survives and the merge reproduces this exact source.
  // Content changes and ambiguous/anonymous conflicts are never order proof.
  if (merged.conflicts.some((conflict) => conflict.type !== "order" || !conflict.messageIds?.length ||
    conflict.messageIds.some((id) => !observedMessages.has(id)))) return;
  return new Set(observedMessages.keys());
}

function nativeCaptureCompleteness(source: CaptureSnapshotV1): CaptureSnapshotV1["completeness"] {
  // Adapter 1.2.14 reports source generation state as partial capture. Accept
  // only its precise, fully covered and stable native-branch evidence. Missing
  // or unsupported bodies, DOM windows and unknown partial reasons stay partial.
  if (source.sourceKind !== "chatgpt_current_branch" || source.provider !== "chatgpt" ||
    source.captureMode !== "full" || source.completeness.status !== "partial" ||
    !source.completeness.topReached || !source.completeness.bottomReached || !source.completeness.stable) return source.completeness;
  const unfinished = source.messages.filter(message => message.segments.some(segment =>
    segment.type === "text" && segment.content === "[原会话未将此消息标记为完成；已保存当前可读取的正文]")).length;
  const expected = `已读取当前分支全部 ${source.messages.length} 条消息，顺序和原始时间已保留；${unfinished} 条在原会话中未标记完成，请在原会话核对`;
  if (!unfinished || source.completeness.reason !== expected) return source.completeness;
  return { ...source.completeness, status: "complete",
    reason: `${unfinished} 条原回答在源站未标记完成；已归档当前分支全部 ${source.messages.length} 条消息及源站返回的正文。` };
}

function reviewNativeBranch(source: CaptureSnapshotV1, physical: readonly CaptureMessage[], previous: readonly CaptureMessage[]): MergeEvidence["sourceReview"] {
  if (!source.canonicalUrl || source.provider !== "chatgpt" || source.captureMode !== "full" ||
    !source.completeness.topReached || !source.completeness.bottomReached || !source.completeness.stable) return;
  const currentIds = new Set(source.messages.map(message => message.externalMessageId));
  const identifiedPhysical = physical.filter(message => message.externalMessageId);
  const physicalIds = new Set(identifiedPhysical.map(message => message.externalMessageId));
  const observed = [...physical, ...previous, ...source.messages];
  if (currentIds.size !== source.messages.length || currentIds.has(undefined) ||
    physicalIds.size !== identifiedPhysical.length ||
    observed.some(message => message.externalMessageId && (
      /^(?:fallback-)?(?:turn|conversation-turn)-\d+/i.test(message.externalMessageId) ||
      !physicalIds.has(message.externalMessageId)))) return;
  const selected = new Set(source.messages.map(sourceReviewBodyHash));
  const otherBodies = new Map(observed.filter(message => !selected.has(sourceReviewBodyHash(message)))
    .map(message => [sourceReviewBodyHash(message), message]));
  return {
    version: 1, source: "chatgpt_current_branch", sessionId: source.sessionId,
    contentComplete: source.completeness.status === "complete" && !source.messages.some(message => message.segments.some(segment =>
      segment.type === "text" && segment.content === "[原会话未将此消息标记为完成；已保存当前可读取的正文]")),
    captureComplete: nativeCaptureCompleteness(source).status === "complete",
    sourceUrl: source.canonicalUrl, verifiedAt: source.capturedAt,
    currentMessageIds: source.messages.map(message => message.externalMessageId!),
    inactiveMessages: identifiedPhysical.filter(message => !currentIds.has(message.externalMessageId))
      .map(message => ({ messageId: message.externalMessageId! })),
    inactiveAnonymousBodies: [...new Set(observed.filter(message => !message.externalMessageId).map(sourceReviewBodyHash))],
    selectedBodies: source.messages.map(message => ({ messageId: message.externalMessageId!, bodyHash: sourceReviewBodyHash(message) })),
    reviewedBodies: [...otherBodies].filter(([, message]) => message.externalMessageId)
      .map(([bodyHash, message]) => ({ messageId: message.externalMessageId!, bodyHash, kind: "source_text" })),
  };
}

function accumulatedSnapshot(input: {
  existing?: CaptureSnapshotV1 | undefined;
  existingEvidence?: MergeEvidence | undefined;
  incoming: CaptureSnapshotV1;
  incomingEvidence?: MergeEvidence;
  verifyIncomingOrder?: boolean;
}) {
  const merged = mergeConversationMessages(input.existing?.messages ?? [], input.incoming.messages, {
    allowKnownPrefixReorder: input.incoming.completeness.status === "complete" && input.incoming.completeness.topReached,
  });
  // Historical consolidation replays stored observations; only a new ingest
  // may establish the proof that resolves previously recorded order warnings.
  const verifiedOrderMessageIds = input.verifyIncomingOrder
    ? verifiedFullCaptureOrder(input.existing, input.incoming, merged) : undefined;
  const conflicts = verifiedOrderMessageIds ? [] : merged.conflicts;
  const orderReliable = Boolean(verifiedOrderMessageIds) || merged.orderReliable;
  const sourceComplete = input.incoming.completeness.status === "complete";
  const sourceMatchesArchive = merged.sourceMatchesArchive && orderReliable && !conflicts.length;
  const retainComplete = input.existing?.completeness.status === "complete" && !merged.changed && !conflicts.length;
  const complete = (sourceComplete && sourceMatchesArchive) || retainComplete;
  const latest = !input.existing || new Date(input.incoming.capturedAt) >= new Date(input.existing.capturedAt)
    ? input.incoming : input.existing;
  const tokenUsage = maxTokenUsage(input.existing?.tokenUsage, input.incoming.tokenUsage);
  const completeness: CaptureSnapshotV1["completeness"] = complete
    ? (sourceComplete && sourceMatchesArchive ? input.incoming.completeness : input.existing!.completeness)
    : {
      status: "partial", topReached: Boolean(input.existing?.completeness.topReached || input.incoming.completeness.topReached),
      bottomReached: input.incoming.completeness.bottomReached, stable: input.incoming.completeness.stable && orderReliable,
      reason: conflicts.length ? "accumulated_content_requires_review" : "accumulated_capture_is_partial",
    };
  const snapshot = snapshotWithoutBase({
    ...latest,
    ...(latest.title ?? input.existing?.title ? { title: latest.title ?? input.existing?.title } : {}),
    ...(latest.canonicalUrl ?? input.existing?.canonicalUrl ? { canonicalUrl: latest.canonicalUrl ?? input.existing?.canonicalUrl } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    completeness,
    messages: merged.messages,
  });
  // Only a freshly read, linked native branch can establish which retained
  // edits are outside the current conversation. A DOM window cannot do this.
  const nativeReview = input.verifyIncomingOrder && input.incoming.sourceKind === "chatgpt_current_branch" &&
    (!input.existing || Date.parse(input.incoming.capturedAt) >= Date.parse(input.existing.capturedAt)) &&
    (!input.existingEvidence?.sourceReview || Date.parse(input.incoming.capturedAt) >= Date.parse(input.existingEvidence.sourceReview.verifiedAt))
    ? reviewNativeBranch(input.incoming, snapshot.messages, [
      ...(input.existing?.messages ?? []), ...(input.existingEvidence?.variants ?? []),
      ...(input.incomingEvidence?.variants ?? []),
    ]) : undefined;
  const evidence = collectMergeEvidence(
    [{
      ...(input.incomingEvidence ?? emptyMergeEvidence()), ...(nativeReview ? { sourceReview: nativeReview } : {}),
    }, input.existingEvidence ?? emptyMergeEvidence()], conflicts, snapshot.messages,
    verifiedOrderMessageIds, [...(input.existing?.messages ?? []), ...input.incoming.messages],
  );
  const freshFullObservation = input.verifyIncomingOrder && input.incoming.captureMode === "full" &&
    input.incoming.completeness.stable &&
    (!input.existing || Date.parse(input.incoming.capturedAt) >= Date.parse(input.existing.capturedAt));
  if (evidence.sourceReview && !evidence.sourceReview.invalidatedByCapture && input.verifyIncomingOrder &&
      freshFullObservation && Date.parse(input.incoming.capturedAt) >= Date.parse(evidence.sourceReview.verifiedAt)) {
    const sourceIds = input.incoming.messages.map((message) => message.externalMessageId);
    const stableUniqueIds = sourceIds.every((id) => Boolean(id?.trim() && id === id.trim() &&
      !/^(?:turn|conversation-turn)-\d+$/i.test(id))) && new Set(sourceIds).size === sourceIds.length;
    const positions = new Map(evidence.sourceReview.currentMessageIds.map((id, index) => [id, index]));
    const observed = [...input.incoming.messages].sort((left, right) => left.ordinal - right.ordinal).flatMap((message) => {
      const index = message.externalMessageId ? positions.get(message.externalMessageId) : undefined;
      return index === undefined ? [] : [index];
    });
    const newBranch = input.incoming.completeness.status === "complete" && input.incoming.completeness.topReached &&
      input.incoming.completeness.bottomReached && evidence.sourceReview.inactiveMessages.some((message) =>
        sourceIds.includes(message.messageId) && (!message.replacedByMessageId || !sourceIds.includes(message.replacedByMessageId)));
    if (stableUniqueIds && (newBranch || observed.some((index, position) => position > 0 && index < observed[position - 1]!))) {
      evidence.sourceReview = { ...evidence.sourceReview,
        invalidatedByCapture: { capturedAt: input.incoming.capturedAt, reason: newBranch ? "new_branch" : "order_changed" } };
    }
  }
  if (evidence.sourceReview) {
    const reviewed = projectSourceReview({ sessionId: snapshot.sessionId, provider: snapshot.provider,
      sourceReview: evidence.sourceReview, primaryMessages: snapshot.messages,
      variants: evidence.variants, warnings: evidence.warnings });
    const observed = [...input.incoming.messages].sort((left, right) => left.ordinal - right.ordinal);
    const completeReviewedContinuation = freshFullObservation && sourceComplete &&
      input.incoming.completeness.topReached && input.incoming.completeness.bottomReached &&
      Date.parse(input.incoming.capturedAt) >= Date.parse(evidence.sourceReview.verifiedAt) &&
      reviewed.reviewedOrderApplicable && !reviewed.unresolvedWarnings.length &&
      observed.length === reviewed.projectedMessages.length && observed.every((message, index) =>
        sourceReviewBodyHash(message) === sourceReviewBodyHash(reviewed.projectedMessages[index]!));
    // A repeat observation of the exact reviewed bodies does not undo an
    // established source review merely because it contains a rendering shell
    // or omits an explicitly retained, inactive edit.
    if (!reviewed.validation.valid || reviewed.invalidatedMessageIds.length) {
      snapshot.completeness = { ...snapshot.completeness, status: "partial", reason: "accumulated_content_requires_review" };
    } else if (nativeReview && reviewed.fullyApplicable) {
      // Capturing every available body and finishing source generation are
      // separate facts. Unsupported content still prevents complete capture.
      snapshot.completeness = nativeCaptureCompleteness(input.incoming);
    } else if (completeReviewedContinuation) {
      // The source can cover the reviewed active branch plus a new tail while
      // intentionally omitting retained inactive edits. This proves archive
      // completeness, never equality with the physical append baseline.
      snapshot.completeness = input.incoming.completeness;
    } else if (reviewed.reviewedOrderApplicable && !reviewed.unresolvedWarnings.length &&
        input.existing?.completeness.status === "complete") {
      const previousObservations = new Set([...input.existing.messages, ...(input.existingEvidence?.variants ?? [])]
        .map(sourceReviewBodyHash));
      if (input.incoming.messages.every((message) => previousObservations.has(sourceReviewBodyHash(message)))) {
        snapshot.completeness = input.existing.completeness;
      }
    }
  }
  return { snapshot, evidence, sourceMatchesArchive,
    bodyChanged: !input.existing || !storedBodiesEqual(input.existing.messages, snapshot.messages) };
}

function snapshotFromStoredRevision(conversation: typeof conversations.$inferSelect, revision: RevisionRow, body: CaptureMessage[]): CaptureSnapshotV1 {
  const usage = storedTokenUsage(revision);
  return {
    schemaVersion: 1, provider: conversation.provider, sessionId: conversation.externalSessionId,
    branchFingerprint: revision.branchFingerprint,
    ...(revision.capturedTitle !== null ? { title: revision.capturedTitle } : conversation.title ? { title: conversation.title } : {}),
    ...(revision.capturedCanonicalUrl !== null ? { canonicalUrl: revision.capturedCanonicalUrl } : conversation.canonicalUrl ? { canonicalUrl: conversation.canonicalUrl } : {}),
    adapterVersion: revision.adapterVersion, capturedAt: revision.capturedAt.toISOString(),
    captureMode: revision.captureMode,
    ...(revision.triggerReason ? { triggerReason: revision.triggerReason } : {}),
    ...(usage ? { tokenUsage: usage } : {}),
    completeness: { status: revision.completeness, topReached: revision.topReached, bottomReached: revision.bottomReached,
      stable: revision.stable, ...(revision.completenessReason ? { reason: revision.completenessReason } : {}) },
    messages: body,
  };
}

function storedBodiesEqual(left: readonly CaptureMessage[], right: readonly CaptureMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => {
    const other = right[index]!;
    if (message.ordinal !== other.ordinal) return false;
    if (message === other) return true;
    return (message.externalMessageId ?? null) === (other.externalMessageId ?? null) &&
      message.role === other.role && (message.model ?? null) === (other.model ?? null) &&
      (message.createdAt ?? null) === (other.createdAt ?? null) && message.segments.length === other.segments.length &&
      message.segments.every((segment, ordinal) => {
        const next = other.segments[ordinal]!;
        return segment.type === next.type && segment.content === next.content &&
          (segment.href ?? null) === (next.href ?? null) && (segment.language ?? null) === (next.language ?? null);
      });
  });
}

async function consolidateStoredRevisions(tx: Transaction, conversation: typeof conversations.$inferSelect) {
  const revisions = await tx.select().from(conversationRevisions)
    .where(eq(conversationRevisions.conversationId, conversation.id))
    .orderBy(asc(conversationRevisions.capturedAt), asc(conversationRevisions.createdAt), asc(conversationRevisions.id));
  if (!revisions.length) return null;
  // Every delta must be reconstructed before any old base or body is removed.
  const bodies = await loadCaptureRevisionMessagesBatch(revisions.map((revision) => revision.id), tx);
  const stable = revisions.find((revision) => revision.isAccumulated) ?? revisions[0]!;
  const firstSnapshot = snapshotWithoutBase(snapshotFromStoredRevision(conversation, revisions[0]!, bodies.get(revisions[0]!.id)!));
  if (revisions.length === 1 && stable.isAccumulated && stable.storageKind === "snapshot" && !stable.baseRevisionId) {
    return { row: stable, snapshot: firstSnapshot, evidence: stable.mergeEvidence ?? emptyMergeEvidence(), mergedRevisionCount: 0, changed: false };
  }
  const initial = accumulatedSnapshot({ incoming: firstSnapshot, incomingEvidence: revisions[0]!.mergeEvidence ?? emptyMergeEvidence() });
  let snapshot = initial.snapshot;
  let evidence = initial.evidence;
  // A single physical snapshot already owns all of its messages and search
  // chunks. Upgrade only revision metadata when normalization changed neither
  // the exact stored body (including ordinals) nor its alternate observations.
  if (revisions.length === 1 && !stable.isAccumulated && stable.storageKind === "snapshot" && !stable.baseRevisionId &&
      storedBodiesEqual(firstSnapshot.messages, snapshot.messages) &&
      JSON.stringify(stable.mergeEvidence ?? emptyMergeEvidence()) === JSON.stringify(evidence)) {
    const row = await writeAccumulatedRevision(tx, { conversationId: conversation.id, existing: stable,
      snapshot, mergeEvidence: evidence, replaceBody: false, previousBody: firstSnapshot.messages, deviceId: stable.sourceDeviceId });
    return { row, snapshot, evidence, mergedRevisionCount: 0, changed: true };
  }
  for (const revision of revisions.slice(1)) {
    const merged = accumulatedSnapshot({ existing: snapshot, existingEvidence: evidence,
      incoming: snapshotFromStoredRevision(conversation, revision, bodies.get(revision.id)!),
      incomingEvidence: revision.mergeEvidence ?? emptyMergeEvidence() });
    snapshot = merged.snapshot;
    evidence = merged.evidence;
  }
  // The main body plus deduplicated single-message variants now contains every
  // observed text. Remove redundant bodies in this same atomic transaction.
  const storedMessageMetadata = await tx.select().from(messages).where(inArray(messages.revisionId, revisions.map((revision) => revision.id)));
  const anonymousFingerprints = new WeakMap<CaptureMessage, string>();
  const messageMetadata = storedMessageMetadata.map((message) => {
    if (message.externalMessageId) return message;
    const observed = bodies.get(message.revisionId)?.[message.ordinal];
    let fingerprint = observed ? anonymousFingerprints.get(observed) : undefined;
    if (observed && !fingerprint) { fingerprint = messageFingerprint(observed); anonymousFingerprints.set(observed, fingerprint); }
    return { ...message, ...(fingerprint ? { fingerprint } : {}) };
  });
  await tx.delete(conversationRevisions).where(and(eq(conversationRevisions.conversationId, conversation.id), ne(conversationRevisions.id, stable.id)));
  const row = await writeAccumulatedRevision(tx, { conversationId: conversation.id, existing: stable,
    snapshot, mergeEvidence: evidence, replaceBody: true, messageMetadata, deviceId: revisions.at(-1)!.sourceDeviceId });
  return { row, snapshot, evidence, mergedRevisionCount: revisions.length - 1, changed: true };
}

/** Used by the maintenance CLI after a complete backup; no capture is fabricated. */
export async function consolidateConversationRevisions(conversationId: string): Promise<{
  revisionId: string | null; mergedRevisionCount: number; messageCount: number; changed: boolean;
}> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(847231955)`);
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!conversation) return { revisionId: null, mergedRevisionCount: 0, messageCount: 0, changed: false };
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`conversation:${conversation.provider}:${conversation.externalSessionId}`}, 0))`);
    const state = await consolidateStoredRevisions(tx, conversation);
    return { revisionId: state?.row.id ?? null, mergedRevisionCount: state?.mergedRevisionCount ?? 0,
      messageCount: state?.snapshot.messages.length ?? 0, changed: state?.changed ?? false };
  });
}

function captureReceipt(input: {
  conversationId: string; revision: RevisionRow; source: CaptureSnapshotV1; sourceMatchesArchive: boolean; unchanged: boolean;
}): CaptureReceipt {
  const complete = input.source.completeness.status === "complete" && input.sourceMatchesArchive && input.revision.completeness === "complete";
  return {
    conversationId: input.conversationId, revisionId: input.revision.id, unchanged: input.unchanged,
    completeness: complete ? "complete" : "partial", messageCount: input.source.messages.length,
    archiveMessageCount: input.revision.messageCount, archiveCompleteness: input.revision.completeness,
    ...(complete && input.revision.contentIntegrityHash ? { baselineContentHash: input.revision.contentIntegrityHash } : {}),
    captureMode: input.source.captureMode, triggerReason: input.source.triggerReason ?? null,
  };
}

export async function ingestCapture(rawPayload: unknown, deviceId: string | null, idempotencyKey?: string,
  expectedArchive?: { revisionId: string; contentIntegrityHash: string }): Promise<CaptureReceipt> {
  const parsedPayload = CapturePayloadV1Schema.parse(rawPayload);
  const sanitized = sanitizeCapturePayloadForStorage(parsedPayload, await loadEnabledCustomRedactionRules());
  const payload: CapturePayloadV1 = "appendedMessages" in sanitized
    ? { ...sanitized, appendedMessages: normalizeCaptureMessagesForStorage(sanitized.appendedMessages) }
    : { ...sanitized, messages: normalizeCaptureMessagesForStorage(sanitized.messages) };
  const requestHash = captureRequestHash(payload);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(847231955)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`conversation:${payload.provider}:${payload.sessionId}`}, 0))`);
    if (idempotencyKey?.startsWith("recapture:")) {
      const parts = /^recapture:([0-9a-f-]{36}):([0-9a-f-]{36}):[0-9a-f]{64}$/i.exec(idempotencyKey);
      if (!parts || !deviceId || payload.provider !== "chatgpt" || payload.captureMode !== "full") throw new BatchCaptureExpiredError();
      const rows = await tx.execute(sql`select c.id from recapture_items i
        join recapture_jobs j on j.id=i.job_id join conversations c on c.id=i.conversation_id
        where i.id=${parts[1]}::uuid and i.lease_token=${parts[2]}::uuid and j.device_id=${deviceId}::uuid
          and j.status in ('running','paused','completed') and c.deleted_at is null
          and c.provider=${payload.provider} and c.external_session_id=${payload.sessionId}
          and ((i.status='running' and i.lease_expires_at>now()) or i.capture_id=${idempotencyKey})
        for update of c,i`);
      if (!rows.length) throw new BatchCaptureExpiredError();
    }
    // Maintenance replays must not overwrite a newer observation between
    // their read-only audit and ingestion. Check under the same capture lock.
    if (expectedArchive) {
      const [revision] = await tx.select().from(conversationRevisions)
        .where(eq(conversationRevisions.id, expectedArchive.revisionId)).limit(1);
      const [conversation] = revision ? await tx.select().from(conversations)
        .where(eq(conversations.id, revision.conversationId)).limit(1) : [];
      if (!revision || revision.contentIntegrityHash !== expectedArchive.contentIntegrityHash ||
        conversation?.provider !== payload.provider || conversation?.externalSessionId !== payload.sessionId) {
        throw new Error("Archive changed since the verified replay was prepared");
      }
    }
    let previousRun: typeof captureRuns.$inferSelect | undefined;
    if (deviceId && idempotencyKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${deviceId}:${idempotencyKey}`}, 0))`);
      [previousRun] = await tx.select().from(captureRuns)
        .where(and(eq(captureRuns.deviceId, deviceId), eq(captureRuns.idempotencyKey, idempotencyKey))).limit(1);
      if (previousRun?.requestHash) {
        if (previousRun.requestHash !== requestHash) throw new Error("Idempotency-Key was already used for another capture payload");
        if (!previousRun.receipt) throw new Error("Capture receipt is missing");
        await tx.update(conversations).set({ deletedAt: null,
          updatedAt: sql`greatest(${conversations.updatedAt}, ${payload.capturedAt}::timestamptz)` })
          .where(eq(conversations.id, previousRun.receipt.conversationId));
        await persistConversationParent(tx, previousRun.receipt.conversationId, payload);
        // Resolve the immutable receipt before checking a now-advanced delta
        // baseline. An accepted append and its token delta are never reapplied.
        return { ...previousRun.receipt, unchanged: true };
      }
      if (previousRun) {
        if ("appendedMessages" in payload) throw new IncrementalBaseMismatchError("Legacy delta receipt requires a full capture");
        const mode = captureIdempotencyReplayMode({ previousSnapshotHash: previousRun.snapshotHash,
          previousPayloadIdentityHash: previousRun.payloadIdentityHash,
          currentSnapshotHash: snapshotHash(payload), currentRevisionIdentityHash: revisionIdentityHash(payload) });
        if (mode === "conflict") throw new Error("Idempotency-Key was already used for another capture payload");
        if (mode === "legacy_bypass") { previousRun = undefined; idempotencyKey = undefined; }
      }
    }
    const { id: conversationId } = await upsertConversationForSnapshot(tx, payload);
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    if (!conversation) throw new Error("Conversation disappeared during capture");
    const state = await consolidateStoredRevisions(tx, conversation);
    let source: CaptureSnapshotV1;
    if ("appendedMessages" in payload) {
      if (!state) throw new IncrementalBaseMismatchError("No base conversation exists");
      validateDeltaBase({ delta: payload, baseRevision: state.row, baseMessages: state.snapshot.messages });
      source = mergedSnapshotFromDelta({ delta: payload, baseRevision: state.row, baseMessages: state.snapshot.messages });
    } else source = payload;
    if (previousRun && state) {
      const exact = state.snapshot.messages.length === source.messages.length &&
        state.snapshot.messages.every((message, index) => messageFingerprint(message) === messageFingerprint(source.messages[index]!));
      const receipt = captureReceipt({ conversationId, revision: state.row, source, sourceMatchesArchive: exact, unchanged: true });
      await tx.update(captureRuns).set({ requestHash, receipt }).where(eq(captureRuns.id, previousRun.id));
      return receipt;
    }
    const merged = accumulatedSnapshot({ existing: state?.snapshot, existingEvidence: state?.evidence, incoming: source,
      verifyIncomingOrder: true });
    const unchanged = Boolean(state && !state.changed && !merged.bodyChanged &&
      revisionIdentityHash(merged.snapshot) === state.row.revisionIdentityHash &&
      JSON.stringify(merged.evidence) === JSON.stringify(state.evidence));
    const revision = await writeAccumulatedRevision(tx, { conversationId, existing: state?.row,
      snapshot: merged.snapshot, mergeEvidence: merged.evidence, deviceId,
      previousBody: state?.snapshot.messages,
      replaceBody: !state || merged.bodyChanged || JSON.stringify(merged.evidence) !== JSON.stringify(state.evidence) });
    const receipt = captureReceipt({ conversationId, revision, source, sourceMatchesArchive: merged.sourceMatchesArchive, unchanged });
    await insertCaptureRun(tx, {
      deviceId, provider: payload.provider, sessionId: payload.sessionId, idempotencyKey,
      requestHash, receipt, snapshotHash: revision.snapshotHash, payloadIdentityHash: revisionIdentityHash(source),
      adapterVersion: payload.adapterVersion, messageCount: receipt.messageCount, status: receipt.completeness,
      capturedAt: payload.capturedAt, captureMode: payload.captureMode, triggerReason: payload.triggerReason,
      baseRevisionId: "appendedMessages" in payload ? payload.baseRevisionId ?? null : null,
      baseMessageCount: "appendedMessages" in payload ? payload.baseMessageCount : null,
    });
    return receipt;
  });
}

/** Admin-only repair after a full scan of the original local history files.
 * Does not discard prior observations or change projects, tags or identity. */
export async function repairVerifiedLocalCodexArchive(input: {
  payload: unknown;
  deviceId: string;
  expectedDeviceName?: string;
  expectedProvider?: "codex" | "openclaw";
  expectedSnapshotHash: string;
  files: Array<{ name: string; sha256: string; bytes: number }>;
  apply: boolean;
}) {
  const parsed = CaptureSnapshotV1Schema.parse(input.payload);
  const expectedProvider = input.expectedProvider ?? "codex";
  if (parsed.provider !== expectedProvider) throw new Error("Repair provider does not match the explicitly selected source");
  const sanitized = sanitizeCapturePayloadForStorage(parsed, await loadEnabledCustomRedactionRules()) as CaptureSnapshotV1;
  const source = { ...sanitized, messages: normalizeCaptureMessagesForStorage(sanitized.messages) };
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(847231955)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`conversation:${expectedProvider}:${source.sessionId}`}, 0))`);
    const [device] = await tx.select().from(devices).where(eq(devices.id, input.deviceId)).limit(1);
    const expectedDeviceName = (input.expectedDeviceName ?? "QML-PC").normalize("NFKC").toLowerCase().trim();
    if (!expectedDeviceName || !device || device.revokedAt || device.name.normalize("NFKC").toLowerCase().trim() !== expectedDeviceName) throw new Error("Repair device must match the explicitly selected paired source");
    const [conversation] = await tx.select().from(conversations)
      .where(and(eq(conversations.provider, expectedProvider), eq(conversations.externalSessionId, source.sessionId))).limit(1);
    if (!conversation || conversation.deletedAt) throw new Error("Active Codex archive not found");
    const revisions = await tx.select().from(conversationRevisions).where(eq(conversationRevisions.conversationId, conversation.id));
    if (revisions.length !== 1 || !revisions[0]!.isAccumulated || revisions[0]!.storageKind !== "snapshot") {
      throw new Error("Repair requires one accumulated snapshot");
    }
    const current = revisions[0]!;
    const [owner] = current.sourceDeviceId ? await tx.select().from(devices).where(eq(devices.id, current.sourceDeviceId)).limit(1) : [];
    if (owner?.name.normalize("NFKC").toLowerCase().trim() !== expectedDeviceName) throw new Error("Archive is not owned by the selected source device");
    if (current.snapshotHash !== input.expectedSnapshotHash) throw new Error("Archive changed since the audit; repair refused");
    const previous = await loadCaptureRevisionMessages(current.id, tx);
    const snapshot: CaptureSnapshotV1 = { ...source,
      ...(current.capturedTitle ?? conversation.title ? { title: current.capturedTitle ?? conversation.title! } : {}),
      tokenUsage: maxTokenUsage(storedTokenUsage(current) ?? undefined, source.tokenUsage),
    };
    const plan = planLocalCodexRepair({ source: snapshot, previous, evidence: current.mergeEvidence, files: input.files, expectedProvider });
    if (!input.apply) return { conversationId: conversation.id, sessionId: source.sessionId,
      sourceMessages: source.messages.length, historicalObservations: plan.historicalObservationCount, applied: false };
    const revision = await writeAccumulatedRevision(tx, { conversationId: conversation.id, existing: current,
      snapshot: plan.snapshot, mergeEvidence: plan.evidence, deviceId: input.deviceId, previousBody: previous, replaceBody: true });
    const receipt = captureReceipt({ conversationId: conversation.id, revision, source: plan.snapshot, sourceMatchesArchive: true, unchanged: false });
    await insertCaptureRun(tx, { deviceId: input.deviceId, provider: expectedProvider, sessionId: source.sessionId,
      idempotencyKey: `local-source-repair:${current.snapshotHash}:${plan.evidence.localSourceRepair!.sourceMessageHash}`,
      snapshotHash: revision.snapshotHash, payloadIdentityHash: revisionIdentityHash(plan.snapshot),
      requestHash: captureRequestHash(plan.snapshot), receipt, adapterVersion: source.adapterVersion,
      messageCount: source.messages.length, status: "complete", capturedAt: source.capturedAt,
      captureMode: "full", triggerReason: "local_file_rewritten" });
    return { ...receipt, historicalObservations: plan.historicalObservationCount, applied: true };
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
