import type { CaptureMessage } from "@ai-archive/contracts";
import { describe, expect, it } from "vitest";
import type { MergeEvidence, SourceReview, SourceReviewBodyKind } from "../src/schema.js";
import type { HydratedRevisionMessage } from "../src/services/revision-storage.js";
import { reviewedArchivePresentation } from "../src/services/reviewed-archive-presentation.js";
import { sourceReviewBodyHash } from "../src/services/source-review.js";

const archivedAt = new Date("2026-09-14T01:00:00Z");
const sourceCreatedAt = "2026-09-13T10:00:00.000Z";
const reference = (message: CaptureMessage) => ({ messageId: message.externalMessageId!, bodyHash: sourceReviewBodyHash(message) });

function hydrate(message: CaptureMessage): HydratedRevisionMessage {
  const id = `physical-${message.ordinal}`;
  return {
    id, revisionId: "canonical-revision", externalMessageId: message.externalMessageId ?? null,
    ordinal: message.ordinal, role: message.role, model: message.model ?? null,
    createdAt: archivedAt, sourceCreatedAt: message.createdAt ? new Date(message.createdAt) : null,
    segments: message.segments.map((segment, index) => ({
      ...segment, id: `${id}-segment-${index}`, messageId: id, ordinal: index,
      href: segment.href ?? null, language: segment.language ?? null, createdAt: archivedAt,
    })),
  };
}

function fixture() {
  const original: CaptureMessage[] = Array.from({ length: 43 }, (_, ordinal) => ({
    externalMessageId: `source-${ordinal}`, ordinal, role: ordinal % 2 ? "assistant" : "user",
    createdAt: sourceCreatedAt, model: "observed-model",
    segments: [{ type: "text", content: `Original body ${ordinal}` }],
  }));
  original[3] = { ...original[3]!, role: "user", segments: [{ type: "text", content: "Earlier edited question" }] };
  const active = original.filter(message => message.ordinal !== 3);
  const kinds: SourceReviewBodyKind[] = ["attachment_preview", "map_rendering", "partial_rendering", "source_text"];
  const variants = active.slice(0, 14).map(message => ({ ...message,
    segments: [{ type: "text" as const, content: `Verified source body ${message.ordinal}` }],
  }));
  const byId = new Map(variants.map(message => [message.externalMessageId, message]));
  const reviewedOrder = [active[2]!, active[0]!, active[1]!, ...active.slice(3)];
  const selected = reviewedOrder.map(message => byId.get(message.externalMessageId) ?? message);
  const review: SourceReview = {
    version: 1, source: "chatgpt_source_ui", sessionId: "reviewed-presentation-session",
    verifiedAt: "2026-09-14T02:00:00.000Z", sourceUrl: "https://chatgpt.com/c/reviewed-presentation-session",
    currentMessageIds: selected.map(message => message.externalMessageId!),
    inactiveMessages: [{ messageId: original[3]!.externalMessageId!, replacedByMessageId: original[4]!.externalMessageId! }],
    selectedBodies: selected.map(reference),
    reviewedBodies: [
      ...active.slice(0, 14).map((message, index) => ({ ...reference(message), kind: kinds[index % kinds.length]! })),
      { ...reference(original[3]!), kind: "source_text" },
    ],
  };
  const evidence: MergeEvidence = {
    variants, sourceReview: review,
    warnings: [{ type: "order", messageIds: original.map(message => message.externalMessageId!) },
      { type: "content", messageIds: [active[0]!.externalMessageId!] }],
  };
  return { sessionId: review.sessionId, provider: "chatgpt", messages: original.map(hydrate), evidence, original, selected, review };
}

describe("reviewed archive detail presentation", () => {
  it("keeps the correct physical metadata for an unknown anonymous body after a known one is hidden", () => {
    const input = fixture();
    input.review.source = "chatgpt_current_branch";
    const anonymous: CaptureMessage = { ordinal: 43, role: "user", segments: [{ type: "text", content: "Old fragment" }] };
    const unknown: CaptureMessage = { ordinal: 44, role: "assistant", segments: [{ type: "text", content: "New fragment" }] };
    input.messages.push(hydrate(anonymous), hydrate(unknown));
    input.review.inactiveAnonymousBodies = [sourceReviewBodyHash(anonymous)];
    const result = reviewedArchivePresentation(input)!;
    const last = result.messages.at(-1)!;
    expect(last).toMatchObject({ id: "physical-44", ordinal: 42, storedOrdinal: 44 });
    expect(last.segments[0]!.content).toBe("New fragment");
    expect(result.archiveReview.inactiveMessages).toContainEqual(anonymous);
    expect(result.archiveReview.fullyApplicable).toBe(false);
  });
  it("presents 42 selected bodies with retained physical anchors, metadata and reviewed history", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const result = reviewedArchivePresentation(input)!;

    expect(result.messages).toHaveLength(42);
    expect(result.messages.map(message => message.externalMessageId)).toEqual(input.review.currentMessageIds);
    expect(result.messages.map(message => sourceReviewBodyHash({
      externalMessageId: message.externalMessageId ?? undefined, role: message.role,
      segments: message.segments.map(segment => ({ type: segment.type, content: segment.content,
        ...(segment.href != null ? { href: segment.href } : {}), ...(segment.language != null ? { language: segment.language } : {}) })),
    }))).toEqual(input.selected.map(sourceReviewBodyHash));
    expect(result.messages.map(message => message.ordinal)).toEqual(Array.from({ length: 42 }, (_, index) => index));
    for (const message of result.messages) {
      const original = input.messages.find(row => row.externalMessageId === message.externalMessageId)!;
      expect(message.id).toBe(original.id);
      expect(message.storedOrdinal).toBe(original.ordinal);
      expect(message.createdAt).toEqual(original.createdAt);
      expect(message.sourceCreatedAt).toBe(sourceCreatedAt);
      expect(message.segments.map(segment => segment.ordinal)).toEqual(message.segments.map((_, index) => index));
    }
    expect(result.messages[0]).toMatchObject({ ordinal: 0, storedOrdinal: 2, id: "physical-2" });
    expect(result.archiveReview).toMatchObject({
      fullyApplicable: true, storedMessageCount: 43, verifiedAt: input.review.verifiedAt,
      inactiveMessages: [input.original[3]], unresolvedVariants: [], unresolvedWarnings: [],
    });
    expect(result.archiveReview.resolvedObservations).toHaveLength(14);
    expect(new Set(result.archiveReview.resolvedObservations.map(row => row.kind))).toEqual(new Set([
      "attachment_preview", "map_rendering", "partial_rendering", "source_text",
    ]));
    expect(result.archiveReview.inactiveMessages[0]?.ordinal).toBe(3);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("returns no projection when there is no source review", () => {
    const input = fixture();
    delete input.evidence.sourceReview;
    expect(reviewedArchivePresentation(input)).toBeNull();
  });

  it.each(["wrong_session", "missing_selected_body", "superseded"])("returns no projection for invalid review %s", (reason) => {
    const input = fixture();
    if (reason === "wrong_session") input.sessionId = "another-session";
    if (reason === "missing_selected_body") input.review.selectedBodies[0]!.bodyHash = "f".repeat(64);
    if (reason === "superseded") input.review.invalidatedByCapture = { capturedAt: "2026-09-14T03:00:00Z", reason: "new_branch" };
    expect(reviewedArchivePresentation(input)).toBeNull();
  });

  it("retains a reviewed alternate body of an inactive edited message in the history DTO", () => {
    const input = fixture();
    const alternate = { ...input.original[3]!, segments: [{ type: "text" as const, content: "Another preserved wording of the earlier edit" }] };
    input.evidence.variants.push(alternate);
    input.review.reviewedBodies.push({ ...reference(alternate), kind: "source_text" });
    const result = reviewedArchivePresentation(input)!;

    expect(result.messages).toHaveLength(42);
    expect(result.archiveReview.fullyApplicable).toBe(true);
    expect(result.archiveReview.inactiveMessages).toEqual([input.original[3]]);
    expect(result.archiveReview.resolvedObservations).toContainEqual({ message: alternate, kind: "source_text" });
    expect(result.archiveReview.resolvedObservations).toHaveLength(15);
    expect(result.archiveReview.unresolvedVariants).toEqual([]);
  });

  it("keeps an unknown body pending instead of absorbing it under an old review", () => {
    const input = fixture();
    const unknown = { ...input.original[0]!, segments: [{ type: "text" as const, content: "New source wording not covered by the review" }] };
    input.evidence.variants.push(unknown);
    const warning = { type: "content", messageIds: [unknown.externalMessageId!] };
    input.evidence.warnings.push(warning);
    const result = reviewedArchivePresentation(input)!;

    expect(result.archiveReview.fullyApplicable).toBe(false);
    expect(result.archiveReview.unresolvedVariants).toContainEqual(unknown);
    expect(result.archiveReview.unresolvedWarnings).toContainEqual(warning);
    expect(result.archiveReview.resolvedObservations.map(row => sourceReviewBodyHash(row.message))).not.toContain(sourceReviewBodyHash(unknown));
  });

  it("retains a new tail and its warning without declaring the extended archive reviewed", () => {
    const input = fixture();
    const tail: CaptureMessage = { externalMessageId: "new-tail", ordinal: 43, role: "assistant", segments: [{ type: "text", content: "A new message after the reviewed branch" }] };
    input.messages.push(hydrate(tail));
    const warning = { type: "disconnected", messageIds: [input.review.currentMessageIds.at(-1)!, "new-tail"] };
    input.evidence.warnings.push(warning);
    const result = reviewedArchivePresentation(input)!;

    expect(result.messages).toHaveLength(43);
    expect(result.messages.at(-1)).toMatchObject({ externalMessageId: "new-tail", storedOrdinal: 43 });
    expect(result.archiveReview).toMatchObject({ fullyApplicable: false, storedMessageCount: 44 });
    expect(result.archiveReview.unresolvedWarnings).toContainEqual(warning);
  });

  it("maps anonymous messages to their original rows after an earlier inactive edit is hidden", () => {
    const input = fixture();
    const anonymous: CaptureMessage = { ordinal: 43, role: "user", segments: [{ type: "text", content: "Anonymous follow-up" }] };
    const row = hydrate(anonymous);
    row.createdAt = new Date("2026-09-14T04:00:00Z");
    input.messages.push(row);
    const result = reviewedArchivePresentation(input)!;
    const projected = result.messages.find(message => !message.externalMessageId)!;

    expect(result.archiveReview.fullyApplicable).toBe(false);
    expect(projected).toMatchObject({ id: row.id, ordinal: 42, storedOrdinal: 43, createdAt: row.createdAt });
    expect(projected.sourceCreatedAt).toBeNull();
    expect(projected.segments[0]?.content).toBe("Anonymous follow-up");
    expect(result.messages.filter(message => message.id === row.id)).toHaveLength(1);
  });

  it("preserves an empty code language in the exact reviewed body identity", () => {
    const input = fixture();
    const original = input.original[42]!;
    original.segments = [{ type: "code", content: "code without a language name", language: "" }];
    input.messages[42] = hydrate(original);
    input.review.selectedBodies = input.review.selectedBodies.map(row => row.messageId === original.externalMessageId ? reference(original) : row);
    const result = reviewedArchivePresentation(input)!;
    expect(result).not.toBeNull();
    expect(result.archiveReview.fullyApplicable).toBe(true);
    expect(result.messages.find(message => message.externalMessageId === original.externalMessageId)?.segments[0])
      .toMatchObject({ type: "code", content: "code without a language name", language: "" });
  });
});
