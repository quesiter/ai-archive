import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { CaptureMessage } from "@ai-archive/contracts";
import { db } from "../db.js";
import { conversationRevisions, conversationRevisionPresentation, conversationRevisionObservations,
  conversations, type ArchiveReviewSummary, type MergeEvidence, type SourceReviewBodyKind } from "../schema.js";
import { loadCaptureRevisionMessages } from "./revision-storage.js";
import { projectSourceReview, sourceReviewBodyHash } from "./source-review.js";

type BodyReference = { storedOrdinal: number | null; variantIndex: number | null };
type ObservationReference = BodyReference & { category: "inactive" | "resolved" | "unresolved";
  ordinal: number; observationKind: SourceReviewBodyKind | null };

/** Compute once while the capture already holds the reconstructed transcript. */
export function buildArchiveReadModel(input: {
  sessionId: string; provider: string; messages: readonly CaptureMessage[]; evidence: MergeEvidence;
}) {
  if (!input.evidence.sourceReview && input.evidence.variants.length === 0) return {
    presentationMessageCount: input.messages.length, storedMessageCount: input.messages.length,
    sourceContentPending: false, archiveReview: null as ArchiveReviewSummary | null,
    presentation: [] as Array<BodyReference & { ordinal: number }>, observations: [] as ObservationReference[],
  };
  const primary = new Map<string, CaptureMessage[]>();
  for (const message of input.messages) {
    const key = sourceReviewBodyHash(message);
    const values = primary.get(key) ?? [];
    values.push(message);
    primary.set(key, values);
  }
  const variants = new Map(input.evidence.variants.map((message, index) => [sourceReviewBodyHash(message), index]));
  const primaryById = new Map(input.messages.flatMap(message => message.externalMessageId ? [[message.externalMessageId, message.ordinal] as const] : []));
  const reference = (message: CaptureMessage, used?: Set<number>): BodyReference => {
    const candidates = primary.get(sourceReviewBodyHash(message));
    const stored = used ? candidates?.find(row => !used.has(row.ordinal)) :
      candidates?.find(row => row.ordinal === message.ordinal) ?? candidates?.[0];
    if (stored) {
      used?.add(stored.ordinal);
      return { storedOrdinal: stored.ordinal, variantIndex: null };
    }
    const variantIndex = variants.get(sourceReviewBodyHash(message));
    if (variantIndex === undefined) throw new Error("Source review references an unrecorded body");
    // A reviewed rendering can replace a physical body while keeping its
    // durable ID, first-observed metadata and search-link anchor.
    return { storedOrdinal: message.externalMessageId ? primaryById.get(message.externalMessageId) ?? null : null, variantIndex };
  };
  const observations: ObservationReference[] = [];
  let presentation: Array<BodyReference & { ordinal: number }> = [];
  let archiveReview: ArchiveReviewSummary | null = null;
  const projection = input.evidence.sourceReview ? projectSourceReview({ sessionId: input.sessionId,
    provider: input.provider, primaryMessages: input.messages, variants: input.evidence.variants,
    sourceReview: input.evidence.sourceReview, warnings: input.evidence.warnings }) : null;
  if (projection?.validation.valid) {
    const review = projection.validation.review;
    const usedOrdinals = new Set<number>();
    presentation = projection.projectedMessages.map((message, ordinal) => ({ ordinal, ...reference(message, usedOrdinals) }));
    const resolved = projection.remainderObservations.filter(row => row.resolved && (!row.inactive || row.origin === "variant"));
    const unresolved = projection.remainderObservations.filter(row => !row.resolved);
    const add = (category: ObservationReference["category"], values: readonly { message: CaptureMessage; kind?: SourceReviewBodyKind }[]) => {
      values.forEach((row, ordinal) => observations.push({ category, ordinal, ...reference(row.message),
        observationKind: row.kind ?? (category === "resolved" ? "source_text" : null) }));
    };
    add("inactive", projection.inactiveMessages.map(message => ({ message })));
    add("resolved", resolved);
    add("unresolved", unresolved);
    archiveReview = { verifiedAt: review.verifiedAt, fullyApplicable: projection.fullyApplicable,
      reviewedOrderApplicable: projection.reviewedOrderApplicable,
      ...(review.contentComplete !== undefined ? { contentComplete: review.contentComplete } : {}),
      ...(review.captureComplete !== undefined ? { captureComplete: review.captureComplete } : {}),
      storedMessageCount: input.messages.length, inactiveMessageCount: projection.inactiveMessages.length,
      resolvedObservationCount: resolved.length, unresolvedVariantCount: unresolved.length,
      unresolvedWarnings: projection.unresolvedWarnings };
  } else {
    // Match the existing detail display: retain distinct alternate bodies only.
    const seen = new Set(primary.keys());
    input.evidence.variants.forEach((message, variantIndex) => {
      const key = sourceReviewBodyHash(message);
      if (seen.has(key)) return;
      seen.add(key);
      observations.push({ category: "unresolved", ordinal: observations.length,
        storedOrdinal: null, variantIndex, observationKind: null });
    });
  }
  return { presentationMessageCount: archiveReview ? presentation.length : input.messages.length,
    storedMessageCount: input.messages.length,
    sourceContentPending: Boolean(archiveReview?.fullyApplicable &&
      archiveReview.contentComplete === false && archiveReview.captureComplete !== true),
    archiveReview, presentation, observations };
}

type Writer = Pick<Parameters<Parameters<typeof db.transaction>[0]>[0], "insert" | "delete">;
export async function persistArchiveReferences(tx: Writer, revisionId: string, model: ReturnType<typeof buildArchiveReadModel>) {
  await tx.delete(conversationRevisionPresentation).where(eq(conversationRevisionPresentation.revisionId, revisionId));
  await tx.delete(conversationRevisionObservations).where(eq(conversationRevisionObservations.revisionId, revisionId));
  for (let offset = 0; offset < model.presentation.length; offset += 500) {
    await tx.insert(conversationRevisionPresentation).values(model.presentation.slice(offset, offset + 500).map(row => ({ revisionId, ...row })));
  }
  for (let offset = 0; offset < model.observations.length; offset += 500) {
    await tx.insert(conversationRevisionObservations).values(model.observations.slice(offset, offset + 500).map(row => ({ revisionId, ...row })));
  }
}

/** Resumable and bounded to one revision body; shared with migration and restore. */
export async function backfillArchiveReadModels(): Promise<number> {
  let processed = 0;
  while (true) {
    const changed = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(847231955)`);
      const [candidate] = await tx.select({ id: conversationRevisions.id, provider: conversations.provider,
        sessionId: conversations.externalSessionId }).from(conversationRevisions)
        .innerJoin(conversations, eq(conversations.id, conversationRevisions.conversationId))
        .where(isNull(conversationRevisions.presentationMessageCount)).orderBy(asc(conversationRevisions.id)).limit(1);
      if (!candidate) return false;
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`conversation:${candidate.provider}:${candidate.sessionId}`}, 0))`);
      const [revision] = await tx.select().from(conversationRevisions).where(and(eq(conversationRevisions.id, candidate.id),
        isNull(conversationRevisions.presentationMessageCount))).limit(1);
      if (!revision) return true;
      const body = await loadCaptureRevisionMessages(revision.id, tx);
      const model = buildArchiveReadModel({ sessionId: candidate.sessionId, provider: candidate.provider,
        messages: body, evidence: revision.mergeEvidence });
      const ownMessages = revision.storageKind === "delta" ? body.filter(message => message.ordinal >= (revision.baseMessageCount ?? 0)) : body;
      const stats = { archivedTextUnits: 0, reasoningTextUnits: 0, toolTextUnits: 0 };
      for (const message of [...ownMessages, ...revision.mergeEvidence.variants]) for (const segment of message.segments) {
        const units = Array.from(segment.content).length;
        stats.archivedTextUnits += units;
        if (segment.type === "reasoning") stats.reasoningTextUnits += units;
        if (segment.type === "tool_status" || message.role === "tool") stats.toolTextUnits += units;
      }
      await tx.update(conversationRevisions).set({ presentationMessageCount: model.presentationMessageCount,
        storedMessageCount: model.storedMessageCount, sourceContentPending: model.sourceContentPending,
        archiveReview: model.archiveReview, ...stats }).where(eq(conversationRevisions.id, revision.id));
      await persistArchiveReferences(tx, revision.id, model);
      return true;
    });
    if (!changed) return processed;
    processed++;
  }
}
