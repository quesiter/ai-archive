import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
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
  type SourceReference,
} from "@ai-archive/contracts";
import { db } from "../db.js";
import {
  captureRuns,
  conversationRevisions,
  conversations,
  knowledgeItems,
  messageSegments,
  messages,
} from "../schema.js";
import { sanitizeDatabaseText, truncateDatabaseText } from "./text-safety.js";
import { loadCaptureRevisionMessages } from "./revision-storage.js";

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

export const REVISION_SEARCH_TEXT_LIMIT = 2_048;
export const REVISION_SEARCH_TEXT_MESSAGE_LIMIT = 480;
export const MESSAGE_SEGMENT_CONTENT_LIMIT = 200_000;
export const TOOL_SEGMENT_CONTENT_LIMIT = 8_000;
export const REASONING_SEGMENT_CONTENT_LIMIT = 20_000;
const MESSAGE_INSERT_BATCH_SIZE = 500;
const SEGMENT_INSERT_BATCH_SIZE = 500;

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
  const normalized = sanitizeDatabaseText(segment.content).replace(/\r\n/g, "\n");
  const limit =
    segment.type === "tool_status"
      ? TOOL_SEGMENT_CONTENT_LIMIT
      : segment.type === "reasoning"
        ? REASONING_SEGMENT_CONTENT_LIMIT
        : MESSAGE_SEGMENT_CONTENT_LIMIT;
  return truncateDatabaseText(normalized, limit, `${segment.type} segment`);
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
    deviceId: string | null;
  },
) {
  // Delta revisions index only the newly stored body. Searching a conversation
  // already spans all revisions, so copying the inherited prefix here wastes
  // space and can crowd the newest text out of the bounded search document.
  const searchText = buildRevisionSearchText(input.storedMessages);
  const [revision] = await tx
    .insert(conversationRevisions)
    .values({
      conversationId: input.conversationId,
      branchFingerprint: input.snapshot.branchFingerprint,
      snapshotHash: input.hash,
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
      sourceDeviceId: input.deviceId,
      capturedAt: new Date(input.snapshot.capturedAt),
      messageCount: input.snapshot.messages.length,
      searchText,
    })
    .onConflictDoNothing({
      target: [
        conversationRevisions.conversationId,
        conversationRevisions.snapshotHash,
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
          eq(conversationRevisions.snapshotHash, input.hash),
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
  return CaptureSnapshotV1Schema.parse({
    schemaVersion: 1,
    provider: input.delta.provider,
    sessionId: input.delta.sessionId,
    branchFingerprint: input.delta.branchFingerprint,
    ...(input.delta.title ? { title: input.delta.title } : {}),
    ...(input.delta.canonicalUrl ? { canonicalUrl: input.delta.canonicalUrl } : {}),
    adapterVersion: input.delta.adapterVersion,
    capturedAt: input.delta.capturedAt,
    captureMode: "append",
    triggerReason: input.delta.triggerReason,
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
  const delta = CaptureDeltaV1Schema.safeParse(payload);
  return delta.success
    ? { storedMessages: delta.data.appendedMessages, storageKind: "delta" }
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
  if (CaptureDeltaV1Schema.safeParse(payload).success) {
    const delta = CaptureDeltaV1Schema.parse(payload);
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
  const payload = CapturePayloadV1Schema.parse(rawPayload);

  return db.transaction(async (tx) => {
    const provider = payload.provider;
    const sessionId = payload.sessionId;
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`conversation:${provider}:${sessionId}`}, 0))`,
    );

    const { snapshot, storedMessages, storageKind } = await snapshotFromPayload(tx, payload);
    const hash = snapshotHash(snapshot);

    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${snapshot.provider}:${snapshot.sessionId}:${snapshot.branchFingerprint}`}, 0))`,
    );

    if (deviceId && idempotencyKey) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${deviceId}:${idempotencyKey}`}, 0))`,
      );
      const [previousRun] = await tx
        .select({ snapshotHash: captureRuns.snapshotHash })
        .from(captureRuns)
        .where(
          and(
            eq(captureRuns.deviceId, deviceId),
            eq(captureRuns.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (previousRun) {
        if (previousRun.snapshotHash !== hash) {
          throw new Error("Idempotency-Key was already used for another capture payload");
        }
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
        const [previousRevision] = previousConversation
          ? await tx
              .select({ id: conversationRevisions.id })
              .from(conversationRevisions)
              .where(
                and(
                  eq(conversationRevisions.conversationId, previousConversation.id),
                  eq(conversationRevisions.snapshotHash, hash),
                ),
              )
              .limit(1)
          : [];
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

    const conversation = await upsertConversationForSnapshot(tx, snapshot);
    const [existing] = await tx
      .select({ id: conversationRevisions.id })
      .from(conversationRevisions)
      .where(
        and(
          eq(conversationRevisions.conversationId, conversation.id),
          eq(conversationRevisions.snapshotHash, hash),
        ),
      )
      .limit(1);

    if (existing) {
      await insertCaptureRun(tx, {
        deviceId,
        provider: snapshot.provider,
        sessionId: snapshot.sessionId,
        idempotencyKey,
        snapshotHash: hash,
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
      deviceId,
    });
    await insertCaptureRun(tx, {
      deviceId,
      provider: snapshot.provider,
      sessionId: snapshot.sessionId,
      idempotencyKey,
      snapshotHash: hash,
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
}): Promise<void> {
  await db.insert(captureRuns).values({
    deviceId: input.deviceId,
    provider: input.provider,
    externalSessionId: input.sessionId,
    idempotencyKey: null,
    captureMode: input.captureMode ?? "full",
    triggerReason: input.triggerReason ?? null,
    status: "failed",
    error: truncateDatabaseText(input.error, 10_000, "capture error"),
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

    const knowledge = await tx
      .select({ id: knowledgeItems.id, sourceReferences: knowledgeItems.sourceReferences })
      .from(knowledgeItems);
    for (const item of knowledge) {
      const references = item.sourceReferences.filter(
        (reference: SourceReference) => reference.conversationId !== id,
      );
      if (references.length === item.sourceReferences.length) continue;
      if (references.length === 0) {
        await tx
          .update(knowledgeItems)
          .set({ supersedesId: null })
          .where(eq(knowledgeItems.supersedesId, item.id));
        await tx.delete(knowledgeItems).where(eq(knowledgeItems.id, item.id));
      } else {
        await tx
          .update(knowledgeItems)
          .set({ sourceReferences: references, updatedAt: new Date() })
          .where(eq(knowledgeItems.id, item.id));
      }
    }

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
