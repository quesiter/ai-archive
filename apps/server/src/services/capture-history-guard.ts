import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import type { db } from "../db.js";
import { conversationRevisions } from "../schema.js";
import { loadCaptureRevisionMessages } from "./revision-storage.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type MessageFingerprint = (message: CaptureMessage) => string;
const MAX_HISTORY_CANDIDATES = 20;
export const INTERIOR_HISTORY_GAP_REASON = "server_detected_interior_history_gap";

// ChatGPT's real message IDs are UUIDs. Positional/fallback IDs cannot prove
// that two captures describe the same path through the source conversation.
function stableMessageIds(messages: readonly CaptureMessage[]) {
  const ids = messages.map((message) => message.externalMessageId);
  if (ids.some((id) => !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) return null;
  return new Set(ids).size === ids.length ? ids as string[] : null;
}

/** A shorter count alone is never sufficient evidence of incomplete capture. */
export function interiorHistoryGap(input: {
  incoming: readonly CaptureMessage[];
  reference: readonly CaptureMessage[];
  fingerprint: MessageFingerprint;
}): { missingMessageIds: string[]; referenceMessageCount: number } | null {
  const incoming = [...input.incoming].sort((left, right) => left.ordinal - right.ordinal);
  const reference = [...input.reference].sort((left, right) => left.ordinal - right.ordinal);
  if (incoming.length < 2 || incoming.length >= reference.length) return null;
  const incomingIds = stableMessageIds(incoming);
  const referenceIds = stableMessageIds(reference);
  if (!incomingIds || !referenceIds || incomingIds[0] !== referenceIds[0] || incomingIds.at(-1) !== referenceIds.at(-1)) return null;
  let referenceIndex = 0;
  const retained = new Set(incomingIds);
  for (let index = 0; index < incoming.length; index++) {
    while (referenceIndex < reference.length && referenceIds[referenceIndex] !== incomingIds[index]) referenceIndex++;
    if (referenceIndex === reference.length || input.fingerprint(incoming[index]!) !== input.fingerprint(reference[referenceIndex]!)) return null;
    referenceIndex++;
  }
  return {
    missingMessageIds: referenceIds.filter((id) => !retained.has(id)),
    referenceMessageCount: reference.length,
  };
}

export function historyGapCandidateFilter(conversationId: string, snapshot: CaptureSnapshotV1) {
  const ordered = [...snapshot.messages].sort((left, right) => left.ordinal - right.ordinal);
  return and(
    eq(conversationRevisions.conversationId, conversationId),
    eq(conversationRevisions.completeness, "complete"),
    gt(conversationRevisions.messageCount, snapshot.messages.length),
    // A delta may inherit either endpoint from its base. Its complete logical
    // history must be hydrated before endpoints and the exact path are checked.
    or(eq(conversationRevisions.storageKind, "delta"), and(
      eq(conversationRevisions.storageKind, "snapshot"),
      sql`exists (
      select 1 from messages first_message
      where first_message.revision_id = ${conversationRevisions.id}
        and first_message.ordinal = 0
        and first_message.external_message_id = ${ordered[0]!.externalMessageId}
    )`,
      sql`exists (
      select 1 from messages last_message
      where last_message.revision_id = ${conversationRevisions.id}
        and last_message.ordinal = ${conversationRevisions.messageCount} - 1
        and last_message.external_message_id = ${ordered.at(-1)!.externalMessageId}
    )`,
    )),
  );
}

/** Preserve the observed body; downgrade only proven interior omissions. */
export async function guardFullSnapshotHistory(
  tx: Transaction,
  conversationId: string,
  snapshot: CaptureSnapshotV1,
  fingerprint: MessageFingerprint,
): Promise<CaptureSnapshotV1> {
  if (snapshot.provider !== "chatgpt" || snapshot.captureMode !== "full" ||
      snapshot.completeness.status !== "complete" || snapshot.messages.length < 2 ||
      !stableMessageIds(snapshot.messages)) return snapshot;
  const candidates = await tx.select({ id: conversationRevisions.id })
    .from(conversationRevisions)
    .where(historyGapCandidateFilter(conversationId, snapshot))
    .orderBy(desc(conversationRevisions.capturedAt), desc(conversationRevisions.createdAt))
    .limit(MAX_HISTORY_CANDIDATES);
  for (const candidate of candidates) {
    const reference = await loadCaptureRevisionMessages(candidate.id, tx);
    if (!interiorHistoryGap({ incoming: snapshot.messages, reference, fingerprint })) continue;
    return {
      ...snapshot,
      completeness: {
        ...snapshot.completeness,
        status: "partial",
        reason: INTERIOR_HISTORY_GAP_REASON,
      },
    };
  }
  return snapshot;
}
