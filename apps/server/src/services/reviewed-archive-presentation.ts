import type { CaptureMessage } from "@ai-archive/contracts";
import type { MergeEvidence } from "../schema.js";
import type { HydratedRevisionMessage } from "./revision-storage.js";
import { projectSourceReview, sourceReviewBodyHash } from "./source-review.js";

export function reviewedArchivePresentation(input: {
  sessionId: string;
  provider: string;
  messages: HydratedRevisionMessage[];
  evidence: MergeEvidence;
}) {
  if (!input.evidence.sourceReview) return null;
  const primary: CaptureMessage[] = input.messages.map((message) => ({
    ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
    ordinal: message.ordinal, role: message.role,
    ...(message.model != null ? { model: message.model } : {}),
    ...(message.sourceCreatedAt ? { createdAt: new Date(message.sourceCreatedAt).toISOString() } : {}),
    segments: message.segments.map((segment) => ({ type: segment.type, content: segment.content,
      ...(segment.href != null ? { href: segment.href } : {}), ...(segment.language != null ? { language: segment.language } : {}) })),
  }));
  const projected = projectSourceReview({ sessionId: input.sessionId, provider: input.provider,
    primaryMessages: primary, variants: input.evidence.variants,
    sourceReview: input.evidence.sourceReview, warnings: input.evidence.warnings });
  if (!projected.validation.valid) return null;
  const rows = new Map(input.messages.flatMap((message) => message.externalMessageId
    ? [[message.externalMessageId, message] as const] : []));
  const anonymousRows = new Map<string, HydratedRevisionMessage[]>();
  for (const [index, message] of primary.entries()) if (!message.externalMessageId) {
    const hash = sourceReviewBodyHash(message);
    anonymousRows.set(hash, [...(anonymousRows.get(hash) ?? []), input.messages[index]!]);
  }
  const messages = projected.projectedMessages.map((message) => {
    const original = message.externalMessageId ? rows.get(message.externalMessageId) : anonymousRows.get(sourceReviewBodyHash(message))?.shift();
    return { ...original, ...message,
      storedOrdinal: original?.ordinal ?? null,
      createdAt: original?.createdAt ?? null,
      sourceCreatedAt: message.createdAt ?? original?.sourceCreatedAt ?? null,
      segments: message.segments.map((segment, index) => ({ ...segment,
        id: `${original?.id ?? message.externalMessageId}:review:${index}`, ordinal: index,
        href: segment.href ?? null, language: segment.language ?? null })) };
  });
  return { messages, archiveReview: {
    verifiedAt: projected.validation.review.verifiedAt,
    fullyApplicable: projected.fullyApplicable,
    reviewedOrderApplicable: projected.reviewedOrderApplicable,
    ...(projected.validation.review.contentComplete !== undefined ? { contentComplete: projected.validation.review.contentComplete } : {}),
    ...(projected.validation.review.captureComplete !== undefined ? { captureComplete: projected.validation.review.captureComplete } : {}),
    storedMessageCount: input.messages.length,
    inactiveMessages: projected.inactiveMessages,
    resolvedObservations: projected.remainderObservations.filter((row) => row.resolved && (!row.inactive || row.origin === "variant"))
      .map((row) => ({ message: row.message, kind: row.kind ?? "source_text" })),
    unresolvedVariants: projected.remainderObservations.filter((row) => !row.resolved).map((row) => row.message),
    unresolvedWarnings: projected.unresolvedWarnings,
  } };
}
