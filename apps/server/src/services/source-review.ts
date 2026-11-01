import { createHash } from "node:crypto";
import type { CaptureMessage } from "@ai-archive/contracts";
import { z } from "zod";
import type { MergeEvidence, SourceReview, SourceReviewBodyKind } from "../schema.js";

const messageId = z.string().min(1).max(512).refine((value) => value.trim() === value &&
  !/^(?:turn|conversation-turn)-\d+$/i.test(value));
const bodyHash = z.string().regex(/^[a-f0-9]{64}$/);
const bodyReference = z.object({ messageId, bodyHash }).strict();
export const SourceReviewSchema = z.object({
  version: z.literal(1), source: z.enum(["chatgpt_source_ui", "chatgpt_current_branch"]),
  contentComplete: z.boolean().optional(),
  captureComplete: z.boolean().optional(),
  sessionId: z.string().min(1).max(1_024), verifiedAt: z.string().datetime({ offset: true }),
  sourceUrl: z.string().url().max(8_192),
  currentMessageIds: z.array(messageId).min(1).max(100_000),
  inactiveMessages: z.array(z.object({ messageId, replacedByMessageId: messageId.optional() }).strict()).max(100_000),
  inactiveAnonymousBodies: z.array(bodyHash).max(200_000).optional(),
  selectedBodies: z.array(bodyReference).min(1).max(100_000),
  reviewedBodies: z.array(bodyReference.extend({
    kind: z.enum(["map_rendering", "partial_rendering", "attachment_preview", "source_text"]),
  }).strict()).max(200_000),
  invalidatedByCapture: z.object({
    capturedAt: z.string().datetime({ offset: true }), reason: z.enum(["order_changed", "new_branch"]),
  }).strict().optional(),
}).strict();

type ReviewBody = Pick<CaptureMessage, "externalMessageId" | "role" | "segments">;

/** Exact body identity, excluding ordinal/model/time; only CR runs before LF are normalized. */
export function sourceReviewBodyHash<T extends ReviewBody>(message: T): string {
  return createHash("sha256").update(JSON.stringify({
    externalMessageId: message.externalMessageId ?? null,
    role: message.role,
    segments: message.segments.map((segment) => ({
      type: segment.type,
      content: segment.content.replace(/\r+\n/g, "\n"),
      href: segment.href ?? null,
      language: segment.language ?? null,
    })),
  })).digest("hex");
}

export interface SourceReviewInput {
  sessionId: string;
  provider?: string;
  sourceReview?: unknown;
  primaryMessages: readonly CaptureMessage[];
  variants?: readonly CaptureMessage[];
}

export type SourceReviewValidation = { valid: true; review: SourceReview; errors: [] } |
  { valid: false; errors: string[] };

type Observation = { message: CaptureMessage; bodyHash: string; origin: "primary" | "variant"; index: number };
const referenceKey = (id: string, hash: string) => JSON.stringify([id, hash]);
function observations(input: SourceReviewInput): Observation[] {
  return [
    ...input.primaryMessages.map((message, index) => ({ message, index, origin: "primary" as const })),
    ...(input.variants ?? []).map((message, index) => ({ message, index, origin: "variant" as const })),
  ].map((row) => ({ ...row, bodyHash: sourceReviewBodyHash(row.message) }));
}

function validate(input: SourceReviewInput, observed: readonly Observation[]): SourceReviewValidation {
  const parsed = SourceReviewSchema.safeParse(input.sourceReview);
  if (!parsed.success) return { valid: false, errors: [input.sourceReview == null ? "review_missing" : "invalid_review_schema"] };
  const { invalidatedByCapture, ...review } = parsed.data;
  if (invalidatedByCapture) return { valid: false, errors: ["review_superseded"] };
  const errors = new Set<string>();
  if (input.provider !== undefined && input.provider !== "chatgpt") errors.add("provider_mismatch");
  if (review.sessionId !== input.sessionId) errors.add("session_mismatch");
  try {
    const url = new URL(review.sourceUrl);
    const sessionPath = /(?:^|\/)c\/([^/]+)\/?$/.exec(url.pathname);
    if (url.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(url.hostname) ||
        url.username || url.password || (url.port && url.port !== "443") ||
        !sessionPath || decodeURIComponent(sessionPath[1]!) !== review.sessionId) errors.add("source_url_mismatch");
  } catch { errors.add("source_url_mismatch"); }
  const currentIds = new Set(review.currentMessageIds);
  if (currentIds.size !== review.currentMessageIds.length) errors.add("duplicate_current_id");
  const selectedIds = new Set(review.selectedBodies.map((row) => row.messageId));
  if (selectedIds.size !== review.selectedBodies.length || selectedIds.size !== currentIds.size ||
      [...selectedIds].some((id) => !currentIds.has(id))) errors.add("selected_ids_do_not_cover_current_ids");
  const inactiveIds = new Set<string>();
  const primaryCounts = new Map<string, number>();
  for (const message of input.primaryMessages) if (message.externalMessageId) {
    primaryCounts.set(message.externalMessageId, (primaryCounts.get(message.externalMessageId) ?? 0) + 1);
  }
  for (const inactive of review.inactiveMessages) {
    if (inactiveIds.has(inactive.messageId) || currentIds.has(inactive.messageId)) errors.add("duplicate_or_active_inactive_id");
    inactiveIds.add(inactive.messageId);
    // Replacements point directly to active IDs. Chains and cycles are not accepted.
    if (inactive.replacedByMessageId ? (!currentIds.has(inactive.replacedByMessageId) || inactive.messageId === inactive.replacedByMessageId)
      : review.source !== "chatgpt_current_branch") errors.add("invalid_inactive_replacement");
    if (!primaryCounts.has(inactive.messageId)) errors.add("inactive_message_not_physical");
  }
  const scopedIds = new Set([...currentIds, ...inactiveIds]);
  if ([...scopedIds].some((id) => (primaryCounts.get(id) ?? 0) > 1)) errors.add("duplicate_physical_message_id");
  const observedKeys = new Set(observed.flatMap((row) => row.message.externalMessageId
    ? [referenceKey(row.message.externalMessageId, row.bodyHash)] : []));
  const anonymousHashes = new Set(observed.filter(row => !row.message.externalMessageId).map(row => row.bodyHash));
  const inactiveAnonymous = review.inactiveAnonymousBodies ?? [];
  if (inactiveAnonymous.length && review.source !== "chatgpt_current_branch") errors.add("anonymous_review_requires_native_branch");
  if (new Set(inactiveAnonymous).size !== inactiveAnonymous.length) errors.add("duplicate_anonymous_body");
  if (inactiveAnonymous.some(hash => !anonymousHashes.has(hash))) errors.add("anonymous_body_not_found");
  for (const selected of review.selectedBodies) if (!observedKeys.has(referenceKey(selected.messageId, selected.bodyHash))) errors.add("selected_body_not_found");
  const reviewedKeys = new Set<string>();
  for (const reviewed of review.reviewedBodies) {
    const key = referenceKey(reviewed.messageId, reviewed.bodyHash);
    if (!scopedIds.has(reviewed.messageId)) errors.add("reviewed_body_outside_scope");
    if (reviewedKeys.has(key)) errors.add("duplicate_reviewed_body");
    reviewedKeys.add(key);
    if (!observedKeys.has(key)) errors.add("reviewed_body_not_found");
  }
  return errors.size ? { valid: false, errors: [...errors] } : { valid: true, review, errors: [] };
}

export function validateSourceReview(input: SourceReviewInput): SourceReviewValidation {
  return validate(input, observations(input));
}

export interface SourceReviewObservation extends Observation {
  resolved: boolean;
  inactive: boolean;
  kind?: SourceReviewBodyKind;
}

export interface SourceReviewProjection {
  validation: SourceReviewValidation;
  fullyApplicable: boolean;
  /** The reviewed order still applies, possibly followed by an unreviewed tail. */
  reviewedOrderApplicable: boolean;
  projectedMessages: CaptureMessage[];
  /** References to the unchanged input primary messages, not replacements or deletions. */
  inactiveMessages: CaptureMessage[];
  remainderObservations: SourceReviewObservation[];
  resolvedWarnings: MergeEvidence["warnings"];
  unresolvedWarnings: MergeEvidence["warnings"];
  invalidatedMessageIds: string[];
  unreviewedMessageIds: string[];
}

export function projectSourceReview(input: SourceReviewInput & { warnings?: readonly MergeEvidence["warnings"][number][] }): SourceReviewProjection {
  const observed = observations(input);
  const validation = validate(input, observed);
  const natural = [...input.primaryMessages].sort((left, right) => left.ordinal - right.ordinal);
  const warnings = input.warnings ?? [];
  if (!validation.valid) return {
    validation, fullyApplicable: false, reviewedOrderApplicable: false,
    projectedMessages: natural.map((message, ordinal) => ({ ...message, ordinal })),
    inactiveMessages: [], remainderObservations: observed.filter((row) => row.origin === "variant")
      .map((row) => ({ ...row, resolved: false, inactive: false })),
    resolvedWarnings: [], unresolvedWarnings: [...warnings], invalidatedMessageIds: [], unreviewedMessageIds: [],
  };
  const review = validation.review;
  const currentIds = new Set(review.currentMessageIds);
  const inactiveById = new Map(review.inactiveMessages.map((row) => [row.messageId, row.replacedByMessageId]));
  const scopedIds = new Set([...currentIds, ...inactiveById.keys()]);
  const inactiveAnonymous = new Set(review.inactiveAnonymousBodies ?? []);
  const knownAnonymous = (row: Observation) => !row.message.externalMessageId && inactiveAnonymous.has(row.bodyHash);
  const known = new Set([...review.selectedBodies, ...review.reviewedBodies].map((row) => referenceKey(row.messageId, row.bodyHash)));
  const selectedHashes = new Map(review.selectedBodies.map((row) => [row.messageId, row.bodyHash]));
  const reviewedKinds = new Map(review.reviewedBodies.map((row) => [referenceKey(row.messageId, row.bodyHash), row.kind]));
  const invalidated = new Set<string>();
  const unreviewedIds = new Set<string>();
  let hasUnscopedObservation = false;
  for (const row of observed) {
    const id = row.message.externalMessageId;
    if (knownAnonymous(row)) continue;
    if (!id || !scopedIds.has(id)) {
      hasUnscopedObservation = true;
      if (id) unreviewedIds.add(id);
    } else if (!known.has(referenceKey(id, row.bodyHash))) invalidated.add(id);
  }
  // UI replacement evidence depends on the exact replacement body. A native
  // chain establishes inactive identities independently of active body versions.
  const validInactiveIds = new Set([...inactiveById].filter(([id, replacement]) =>
    !invalidated.has(id) && (review.source === "chatgpt_current_branch" || !replacement || !invalidated.has(replacement))).map(([id]) => id));
  const chosen = new Map<string, CaptureMessage>();
  for (const row of observed) {
    const id = row.message.externalMessageId;
    if (id && !invalidated.has(id) && row.bodyHash === selectedHashes.get(id) && !chosen.has(id)) chosen.set(id, row.message);
  }
  const fullyApplicable = !hasUnscopedObservation && !invalidated.size && chosen.size === currentIds.size;
  const isInactive = (message: CaptureMessage) => message.externalMessageId
    ? validInactiveIds.has(message.externalMessageId) : inactiveAnonymous.has(sourceReviewBodyHash(message));
  const inactiveMessages = input.primaryMessages.filter(isInactive);
  const activeNatural = natural.filter(message => !isInactive(message));
  const tailStart = activeNatural.findIndex((message) => !message.externalMessageId || !currentIds.has(message.externalMessageId));
  const tail = tailStart < 0 ? [] : activeNatural.slice(tailStart);
  const tailIds = new Set(tail.flatMap((message) => message.externalMessageId ? [message.externalMessageId] : []));
  // A proven current branch can retain its order when only new, stable IDs
  // follow every physical current ID. Interleaved or variant-only additions
  // cannot establish that relation and retain the natural merged order.
  const safeTailExtension = !invalidated.size && chosen.size === currentIds.size && tailStart === currentIds.size &&
    tail.length > 0 && tailIds.size === tail.length && tail.every((message) =>
      messageId.safeParse(message.externalMessageId).success && !scopedIds.has(message.externalMessageId!)) &&
    observed.every((row) => knownAnonymous(row) || Boolean(row.message.externalMessageId &&
      (scopedIds.has(row.message.externalMessageId) || tailIds.has(row.message.externalMessageId))));
  // Native IDs establish message order independently from their body versions.
  // A new rendering of the same role/ID must still expose its content conflict,
  // but it cannot invalidate the already verified parent-chain order.
  const physicalById = new Map(natural.map(message => [message.externalMessageId, message]));
  const rolesById = new Map<string, Set<CaptureMessage["role"]>>();
  for (const row of observed) if (row.message.externalMessageId) {
    const id = row.message.externalMessageId;
    const roles = rolesById.get(id) ?? new Set<CaptureMessage["role"]>();
    roles.add(row.message.role);
    rolesById.set(id, roles);
  }
  const nativeIdentityOrder = review.source === "chatgpt_current_branch" && !hasUnscopedObservation &&
    [...inactiveById.keys()].every(id => !invalidated.has(id)) && review.currentMessageIds.every(id => {
      return physicalById.has(id) && rolesById.get(id)?.size === 1;
    });
  const reviewedOrderApplicable = fullyApplicable || safeTailExtension || nativeIdentityOrder;
  let projected: CaptureMessage[];
  if (reviewedOrderApplicable) projected = [...review.currentMessageIds.map((id) => chosen.get(id) ?? physicalById.get(id)!), ...tail];
  else {
    // New identities retain their natural merged positions. Do not invent an
    // order between new observations and an older reviewed branch.
    projected = activeNatural
      .map((message) => message.externalMessageId ? chosen.get(message.externalMessageId) ?? message : message);
    const physicalIds = new Set(natural.flatMap((message) => message.externalMessageId ? [message.externalMessageId] : []));
    for (const id of review.currentMessageIds) if (!physicalIds.has(id) && chosen.has(id)) projected.push(chosen.get(id)!);
  }
  const projectedMessages = projected.map((message, ordinal) => ({ ...message, ordinal }));
  const visibleKeys = new Set(projectedMessages.map(sourceReviewBodyHash));
  const scopedAndValid = (id: string) => scopedIds.has(id) && !invalidated.has(id) &&
    (!inactiveById.has(id) || validInactiveIds.has(id));
  const remainderObservations = observed.filter((row) => !visibleKeys.has(row.bodyHash)).map((row): SourceReviewObservation => {
    const id = row.message.externalMessageId;
    const kind = id ? reviewedKinds.get(referenceKey(id, row.bodyHash)) : undefined;
    return { ...row, resolved: knownAnonymous(row) || Boolean(id && scopedAndValid(id) && known.has(referenceKey(id, row.bodyHash))),
      inactive: isInactive(row.message), ...(kind ? { kind } : {}) };
  });
  const resolvedWarnings: MergeEvidence["warnings"] = [];
  const unresolvedWarnings: MergeEvidence["warnings"] = [];
  for (const warning of warnings) {
    const ids = warning.messageIds;
    const resolved = Array.isArray(ids) && ids.length > 0 && (warning.type === "content"
      ? ids.every(scopedAndValid)
      : reviewedOrderApplicable && (warning.type === "order" || warning.type === "disconnected") &&
        ids.every(id => nativeIdentityOrder ? scopedIds.has(id) : scopedAndValid(id)));
    (resolved ? resolvedWarnings : unresolvedWarnings).push(warning);
  }
  return { validation, fullyApplicable, reviewedOrderApplicable, projectedMessages, inactiveMessages, remainderObservations,
    resolvedWarnings, unresolvedWarnings, invalidatedMessageIds: [...invalidated], unreviewedMessageIds: [...unreviewedIds] };
}
