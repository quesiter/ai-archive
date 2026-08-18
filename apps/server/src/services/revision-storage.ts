import { asc, eq, inArray } from "drizzle-orm";
import type { CaptureMessage } from "@ai-archive/contracts";
import { db } from "../db.js";
import {
  conversationRevisions,
  messageSegments,
  messages,
} from "../schema.js";

type QueryExecutor = Pick<typeof db, "select">;
type RevisionRow = typeof conversationRevisions.$inferSelect;
type MessageRow = typeof messages.$inferSelect;
type SegmentRow = typeof messageSegments.$inferSelect;

export type HydratedRevisionMessage = MessageRow & {
  segments: SegmentRow[];
};

const MAX_REVISION_CHAIN_LENGTH = 10_000;

export function resolveRevisionStorageChain(
  selected: RevisionRow,
  revisionsById: ReadonlyMap<string, RevisionRow>,
): RevisionRow[] {
  const reverseChain: RevisionRow[] = [];
  const visited = new Set<string>();
  let current: RevisionRow | undefined = selected;

  while (current) {
    if (visited.has(current.id)) {
      throw new Error(`Revision storage chain contains a cycle at ${current.id}`);
    }
    if (current.conversationId !== selected.conversationId) {
      throw new Error(`Revision storage chain crosses conversations at ${current.id}`);
    }
    visited.add(current.id);
    reverseChain.push(current);
    if (reverseChain.length > MAX_REVISION_CHAIN_LENGTH) {
      throw new Error("Revision storage chain exceeds the safety limit");
    }

    if (current.storageKind === "snapshot") break;
    if (!current.baseRevisionId) {
      throw new Error(`Delta revision ${current.id} does not declare a base revision`);
    }
    current = revisionsById.get(current.baseRevisionId);
    if (!current) {
      throw new Error(`Delta revision ${selected.id} references a missing base revision`);
    }
  }

  return reverseChain.reverse();
}

export async function loadRevisionStorageChain(
  revisionId: string,
  executor: QueryExecutor = db,
): Promise<RevisionRow[]> {
  const [selected] = await executor
    .select()
    .from(conversationRevisions)
    .where(eq(conversationRevisions.id, revisionId))
    .limit(1);
  if (!selected) throw new Error(`Revision ${revisionId} does not exist`);
  const relatedRevisions = await executor
    .select()
    .from(conversationRevisions)
    .where(eq(conversationRevisions.conversationId, selected.conversationId));
  return resolveRevisionStorageChain(
    selected,
    new Map(relatedRevisions.map((revision) => [revision.id, revision])),
  );
}

export function composeRevisionMessages(
  chain: readonly RevisionRow[],
  storedByRevision: ReadonlyMap<string, readonly HydratedRevisionMessage[]>,
): HydratedRevisionMessage[] {
  const messagesByOrdinal = new Map<number, HydratedRevisionMessage>();
  for (const revision of chain) {
    for (const message of storedByRevision.get(revision.id) ?? []) {
      messagesByOrdinal.set(message.ordinal, message);
    }
  }
  const composed = [...messagesByOrdinal.values()].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  if (
    composed.length !== chain.at(-1)?.messageCount ||
    composed.some((message, index) => message.ordinal !== index)
  ) {
    throw new Error(
      `Revision ${chain.at(-1)?.id ?? "unknown"} cannot be reconstructed from its storage chain`,
    );
  }
  return composed;
}

/**
 * Reconstructs one or more logical revisions. Snapshot revisions read their own
 * rows; delta revisions inherit the immutable prefix from their base chain.
 */
export async function loadHydratedRevisionMessagesBatch(
  revisionIds: readonly string[],
  executor: QueryExecutor = db,
): Promise<Map<string, HydratedRevisionMessage[]>> {
  const uniqueRevisionIds = [...new Set(revisionIds)];
  if (!uniqueRevisionIds.length) return new Map();

  const selectedRevisions = await executor
    .select()
    .from(conversationRevisions)
    .where(inArray(conversationRevisions.id, uniqueRevisionIds));
  const selectedById = new Map(selectedRevisions.map((revision) => [revision.id, revision]));
  const missingRevisionId = uniqueRevisionIds.find((id) => !selectedById.has(id));
  if (missingRevisionId) throw new Error(`Revision ${missingRevisionId} does not exist`);

  const conversationIds = [
    ...new Set(selectedRevisions.map((revision) => revision.conversationId)),
  ];
  const relatedRevisions = await executor
    .select()
    .from(conversationRevisions)
    .where(inArray(conversationRevisions.conversationId, conversationIds));
  const revisionsById = new Map(relatedRevisions.map((revision) => [revision.id, revision]));
  const chainsBySelectedId = new Map<string, RevisionRow[]>();
  const storedRevisionIds = new Set<string>();
  for (const revisionId of uniqueRevisionIds) {
    const selected = selectedById.get(revisionId)!;
    const chain = resolveRevisionStorageChain(selected, revisionsById);
    chainsBySelectedId.set(revisionId, chain);
    for (const revision of chain) storedRevisionIds.add(revision.id);
  }

  const storedRows = await executor
    .select({
      message: messages,
      segment: messageSegments,
    })
    .from(messages)
    .innerJoin(messageSegments, eq(messageSegments.messageId, messages.id))
    .where(inArray(messages.revisionId, [...storedRevisionIds]))
    .orderBy(
      asc(messages.revisionId),
      asc(messages.ordinal),
      asc(messageSegments.ordinal),
    );
  const storedByRevisionAndMessage = new Map<
    string,
    Map<string, HydratedRevisionMessage>
  >();
  for (const row of storedRows) {
    let byMessage = storedByRevisionAndMessage.get(row.message.revisionId);
    if (!byMessage) {
      byMessage = new Map();
      storedByRevisionAndMessage.set(row.message.revisionId, byMessage);
    }
    let message = byMessage.get(row.message.id);
    if (!message) {
      message = { ...row.message, segments: [] };
      byMessage.set(row.message.id, message);
    }
    message.segments.push(row.segment);
  }
  const storedByRevision = new Map<string, HydratedRevisionMessage[]>();
  for (const [revisionId, byMessage] of storedByRevisionAndMessage) {
    storedByRevision.set(
      revisionId,
      [...byMessage.values()].sort((left, right) => left.ordinal - right.ordinal),
    );
  }

  const result = new Map<string, HydratedRevisionMessage[]>();
  for (const revisionId of uniqueRevisionIds) {
    result.set(
      revisionId,
      composeRevisionMessages(chainsBySelectedId.get(revisionId)!, storedByRevision),
    );
  }
  return result;
}

export async function loadHydratedRevisionMessages(
  revisionId: string,
  executor: QueryExecutor = db,
): Promise<HydratedRevisionMessage[]> {
  return (await loadHydratedRevisionMessagesBatch([revisionId], executor)).get(revisionId)!;
}

export async function loadCaptureRevisionMessages(
  revisionId: string,
  executor: QueryExecutor = db,
): Promise<CaptureMessage[]> {
  const hydrated = await loadHydratedRevisionMessages(revisionId, executor);
  return hydrated.map((message) => ({
    ordinal: message.ordinal,
    role: message.role,
    ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
    ...(message.model ? { model: message.model } : {}),
    ...(message.sourceCreatedAt
      ? { createdAt: message.sourceCreatedAt.toISOString() }
      : {}),
    segments: message.segments.map((segment) => ({
      type: segment.type,
      content: segment.content,
      ...(segment.href ? { href: segment.href } : {}),
      ...(segment.language ? { language: segment.language } : {}),
    })),
  }));
}
