import { createHash } from "node:crypto";
import type { CaptureMessage } from "@ai-archive/contracts";
import { describe, expect, it } from "vitest";
import type { MergeEvidence, SourceReview } from "../src/schema.js";
import { projectSourceReview, sourceReviewBodyHash, validateSourceReview } from "../src/services/source-review.js";

const message = (id: string, text: string, ordinal = 0): CaptureMessage => ({
  externalMessageId: id, ordinal, role: "assistant", segments: [{ type: "text", content: text }],
});
const ref = (body: CaptureMessage) => ({ messageId: body.externalMessageId!, bodyHash: sourceReviewBodyHash(body) });
function fixture() {
  const a = { ...message("a", "Verified user question", 2), role: "user" as const };
  const b = message("b", "Answer with a map widget", 3);
  const bClean = message("b", "Answer", 3);
  const c = message("c", "Verified text plus attachment preview", 0);
  const cClean = message("c", "Verified text", 0);
  const inactive = { ...message("old-edit", "Earlier edited question", 1), role: "user" as const };
  const primaryMessages = [c, inactive, a, b];
  const variants = [bClean, cClean];
  const sourceReview: SourceReview = {
    version: 1, source: "chatgpt_source_ui", sessionId: "review-session",
    verifiedAt: "2026-09-14T15:00:00.000Z", sourceUrl: "https://chatgpt.com/c/review-session",
    currentMessageIds: ["a", "b", "c"], inactiveMessages: [{ messageId: "old-edit", replacedByMessageId: "a" }],
    selectedBodies: [ref(a), ref(bClean), ref(cClean)],
    reviewedBodies: [{ ...ref(b), kind: "map_rendering" }, { ...ref(c), kind: "attachment_preview" },
      { ...ref(inactive), kind: "source_text" }],
  };
  const warnings: MergeEvidence["warnings"] = [
    { type: "order", messageIds: ["a", "b", "c", "old-edit"] },
    { type: "disconnected", messageIds: ["old-edit", "a"] },
    { type: "content", messageIds: ["b", "b"] },
    { type: "content", messageIds: ["c"] },
    { type: "order", messageIds: [] },
    { type: "order", messageIds: ["unknown"] },
    { type: "future_warning", messageIds: ["b"] },
  ];
  return { sessionId: sourceReview.sessionId, provider: "chatgpt", sourceReview, primaryMessages, variants, warnings,
    a, b, c, bClean, cClean, inactive };
}
const displayedIds = (rows: CaptureMessage[]) => rows.map((row) => row.externalMessageId);

describe("source review exact observation identity", () => {
  it("uses the specified fixed JSON fields and only idempotent CR-before-LF normalization", () => {
    const body = message("a", " \r\r\nA\rB\u001b[31m ");
    const expected = createHash("sha256").update(JSON.stringify({ externalMessageId: "a", role: "assistant",
      segments: [{ type: "text", content: " \nA\rB\u001b[31m ", href: null, language: null }] })).digest("hex");
    expect(sourceReviewBodyHash(body)).toBe(expected);
    expect(sourceReviewBodyHash({ ...body, ordinal: 100, model: "other", createdAt: "2026-09-14T00:00:00Z" })).toBe(expected);
    expect(sourceReviewBodyHash(message("a", "\nA\rB\u001b[31m"))).not.toBe(expected);
    expect(sourceReviewBodyHash(message("a", " \nA\nB\u001b[31m "))).not.toBe(expected);
  });

  it.each(["id", "role", "segment_type", "href", "language", "segment_order"])("keeps %s differences distinct", (kind) => {
    const original = message("a", "same words");
    const changed = structuredClone(original);
    if (kind === "id") changed.externalMessageId = "b";
    if (kind === "role") changed.role = "user";
    if (kind === "segment_type") changed.segments[0]!.type = "code";
    if (kind === "href") changed.segments[0]!.href = "https://example.com/reference";
    if (kind === "language") changed.segments[0]!.language = "python";
    if (kind === "segment_order") changed.segments = [{ type: "text", content: "words" }, { type: "text", content: "same" }];
    expect(sourceReviewBodyHash(changed)).not.toBe(sourceReviewBodyHash(original));
  });
});

describe("source review validation and projection", () => {
  it.each(["a", "b"])("keeps native identity order for changed body %s while exposing content differences", id => {
    const input = fixture();
    input.sourceReview.source = "chatgpt_current_branch";
    input.variants.push({ ...message(id, "New rendering"), role: id === "a" ? "user" : "assistant" });
    const contentWarning = { type: "content", messageIds: [id, id] };
    input.warnings.push(contentWarning);
    const result = projectSourceReview(input);
    expect(result.fullyApplicable).toBe(false);
    expect(result.reviewedOrderApplicable).toBe(true);
    expect(displayedIds(result.projectedMessages)).toEqual(["a", "b", "c"]);
    expect(result.unresolvedWarnings).toContainEqual(contentWarning);
    expect(result.unresolvedWarnings).not.toContainEqual(input.warnings[0]);
    expect(result.remainderObservations.some(row => row.message.segments[0]!.content === "New rendering" && !row.resolved)).toBe(true);
    input.variants.push({ ...message(id, "Conflicting role"), role: id === "a" ? "assistant" : "user" });
    expect(projectSourceReview(input).reviewedOrderApplicable).toBe(false);
  });
  it("scopes only exact known anonymous bodies to a native branch and exposes future anonymous content", () => {
    const input = fixture();
    input.sourceReview.source = "chatgpt_current_branch";
    const anonymous: CaptureMessage = { ordinal: 4, role: "user", segments: [{ type: "text", content: "Old fragment" }] };
    input.primaryMessages.push(anonymous);
    input.sourceReview.inactiveAnonymousBodies = [sourceReviewBodyHash(anonymous)];
    const before = projectSourceReview(input);
    expect(before.fullyApplicable).toBe(true);
    expect(before.inactiveMessages).toContain(anonymous);
    const newAnonymous: CaptureMessage = { ...anonymous, ordinal: 5, segments: [{ type: "text", content: "Unknown fragment" }] };
    input.primaryMessages.push(newAnonymous);
    const after = projectSourceReview(input);
    expect(after.fullyApplicable).toBe(false);
    expect(after.projectedMessages.map(sourceReviewBodyHash)).toContain(sourceReviewBodyHash(newAnonymous));
    expect(after.projectedMessages.map(sourceReviewBodyHash)).not.toContain(sourceReviewBodyHash(anonymous));
    input.sourceReview.source = "chatgpt_source_ui";
    expect(validateSourceReview(input)).toMatchObject({ valid: false, errors: ["anonymous_review_requires_native_branch"] });
    input.sourceReview.source = "chatgpt_current_branch";
    input.sourceReview.inactiveAnonymousBodies = ["f".repeat(64)];
    expect(validateSourceReview(input)).toMatchObject({ valid: false, errors: ["anonymous_body_not_found"] });
  });
  it("projects only the reviewed bodies and order while retaining unchanged primary and variant facts", () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const projected = projectSourceReview(input);
    expect(projected.validation.valid).toBe(true);
    expect(projected.fullyApplicable).toBe(true);
    expect(projected.reviewedOrderApplicable).toBe(true);
    expect(displayedIds(projected.projectedMessages)).toEqual(["a", "b", "c"]);
    expect(projected.projectedMessages.map((m) => m.segments[0]!.content)).toEqual(["Verified user question", "Answer", "Verified text"]);
    expect(projected.projectedMessages.map((m) => m.ordinal)).toEqual([0, 1, 2]);
    expect(projected.inactiveMessages).toHaveLength(1);
    expect(projected.inactiveMessages[0]).toBe(input.inactive);
    expect(projected.remainderObservations).toHaveLength(3);
    expect(projected.remainderObservations.every((r) => r.resolved)).toBe(true);
    expect(projected.remainderObservations.find((r) => r.message.externalMessageId === "b"))
      .toMatchObject({ kind: "map_rendering", origin: "primary", inactive: false });
    expect(projected.resolvedWarnings).toEqual(input.warnings.slice(0, 4));
    expect(projected.unresolvedWarnings).toEqual(input.warnings.slice(4));
    expect(JSON.stringify(input)).toBe(before);
  });

  const invalid: Array<[string, (input: ReturnType<typeof fixture>) => void, string]> = [
    ["wrong session", (x) => { x.sessionId = "other"; }, "session_mismatch"],
    ["wrong provider", (x) => { x.provider = "codex"; }, "provider_mismatch"],
    ["wrong source URL", (x) => { x.sourceReview.sourceUrl = "https://example.com/c/review-session"; }, "source_url_mismatch"],
    ["wrong URL session", (x) => { x.sourceReview.sourceUrl = "https://chatgpt.com/c/other"; }, "source_url_mismatch"],
    ["duplicate current ID", (x) => { x.sourceReview.currentMessageIds.push("a"); }, "duplicate_current_id"],
    ["unselected current ID", (x) => { x.sourceReview.selectedBodies.pop(); }, "selected_ids_do_not_cover_current_ids"],
    ["duplicate selection", (x) => { x.sourceReview.selectedBodies.push(ref(x.a)); }, "selected_ids_do_not_cover_current_ids"],
    ["missing selected body", (x) => { x.sourceReview.selectedBodies[0]!.bodyHash = "f".repeat(64); }, "selected_body_not_found"],
    ["missing reviewed body", (x) => { x.sourceReview.reviewedBodies[0]!.bodyHash = "f".repeat(64); }, "reviewed_body_not_found"],
    ["unscoped reviewed ID", (x) => { const extra = message("new", "new"); x.variants.push(extra);
      x.sourceReview.reviewedBodies.push({ ...ref(extra), kind: "source_text" }); }, "reviewed_body_outside_scope"],
    ["replacement outside active IDs", (x) => { x.sourceReview.inactiveMessages[0]!.replacedByMessageId = "other"; }, "invalid_inactive_replacement"],
    ["self replacement", (x) => { x.sourceReview.inactiveMessages[0]!.replacedByMessageId = "old-edit"; }, "invalid_inactive_replacement"],
    ["active ID marked inactive", (x) => { x.sourceReview.inactiveMessages.push({ messageId: "a", replacedByMessageId: "b" }); }, "duplicate_or_active_inactive_id"],
    ["inactive only stored as variant", (x) => { x.primaryMessages = x.primaryMessages.filter((m) => m !== x.inactive); x.variants.push(x.inactive); }, "inactive_message_not_physical"],
    ["duplicate physical ID", (x) => { x.primaryMessages.push({ ...x.a, ordinal: 4 }); }, "duplicate_physical_message_id"],
  ];
  it.each(invalid)("fails closed for %s", (_name, change, reason) => {
    const input = fixture(); change(input);
    const result = projectSourceReview(input);
    expect(result.validation).toEqual(expect.objectContaining({ valid: false, errors: expect.arrayContaining([reason]) }));
    expect(result.projectedMessages).toHaveLength(input.primaryMessages.length);
    expect(result.inactiveMessages).toEqual([]);
    expect(result.resolvedWarnings).toEqual([]);
    expect(result.unresolvedWarnings).toEqual(input.warnings);
  });

  it("rejects cycles between inactive IDs rather than following a replacement chain", () => {
    const input = fixture();
    const second = message("older-edit", "Other old edit", 4);
    input.primaryMessages.push(second);
    input.sourceReview.inactiveMessages = [{ messageId: "old-edit", replacedByMessageId: "older-edit" },
      { messageId: "older-edit", replacedByMessageId: "old-edit" }];
    expect(validateSourceReview(input)).toMatchObject({ valid: false, errors: expect.arrayContaining(["invalid_inactive_replacement"]) });
  });

  it.each(["order_changed", "new_branch"] as const)("preserves a proof superseded by %s but applies none of its selections or warning resolutions", (reason) => {
    const input = fixture();
    input.sourceReview.invalidatedByCapture = { capturedAt: "2026-09-14T16:00:00.000Z", reason };
    const originalProof = structuredClone(input.sourceReview);
    const result = projectSourceReview(input);
    expect(result.validation).toEqual({ valid: false, errors: ["review_superseded"] });
    expect(result.fullyApplicable).toBe(false);
    expect(result.reviewedOrderApplicable).toBe(false);
    expect(displayedIds(result.projectedMessages)).toEqual(["c", "old-edit", "a", "b"]);
    expect(result.projectedMessages.find((m) => m.externalMessageId === "b")!.segments).toEqual(input.b.segments);
    expect(result.inactiveMessages).toEqual([]);
    expect(result.resolvedWarnings).toEqual([]);
    expect(result.unresolvedWarnings).toEqual(input.warnings);
    expect(result.remainderObservations.every((row) => !row.resolved)).toBe(true);
    expect(input.sourceReview).toEqual(originalProof);
  });

  it.each([
    { capturedAt: "invalid date", reason: "order_changed" },
    { capturedAt: "2026-09-14T16:00:00.000Z", reason: "unknown" },
    { capturedAt: "2026-09-14T16:00:00.000Z" },
  ])("rejects malformed capture invalidation metadata %#", (invalidatedByCapture) => {
    const input = fixture();
    expect(validateSourceReview({ ...input, sourceReview: { ...input.sourceReview, invalidatedByCapture } }))
      .toEqual({ valid: false, errors: ["invalid_review_schema"] });
  });

  it.each(["turn-0", "conversation-turn-0"])("rejects positional identity %s in otherwise valid review evidence", (id) => {
    const input = fixture();
    input.sourceReview.currentMessageIds[0] = id;
    input.sourceReview.selectedBodies[0]!.messageId = id;
    expect(validateSourceReview(input)).toEqual({ valid: false, errors: ["invalid_review_schema"] });
  });

  it("retains a chosen clean body when a previously reviewed rendering is recaptured", () => {
    const input = fixture();
    input.variants.push(structuredClone(input.b), structuredClone(input.c));
    const result = projectSourceReview(input);
    expect(result.fullyApplicable).toBe(true);
    expect(result.projectedMessages.find((m) => m.externalMessageId === "b")!.segments).toEqual(input.bClean.segments);
    expect(result.invalidatedMessageIds).toEqual([]);
  });

  it.each(["different", "prefix_growth", "role_change", "new_link"])("invalidates only the affected selection and review for an unknown %s body", (kind) => {
    const input = fixture();
    const unknown = message("b", kind === "prefix_growth" ? "Answer with newly supplied information" : "An unknown new answer");
    if (kind === "role_change") unknown.role = "user";
    if (kind === "new_link") unknown.segments[0]!.href = "https://example.com/new-source";
    input.variants.push(unknown);
    const result = projectSourceReview(input);
    expect(result.validation.valid).toBe(true);
    expect(result.fullyApplicable).toBe(false);
    expect(result.invalidatedMessageIds).toEqual(["b"]);
    expect(result.projectedMessages.find((m) => m.externalMessageId === "b")!.segments).toEqual(input.b.segments);
    expect(result.projectedMessages.find((m) => m.externalMessageId === "c")!.segments).toEqual(input.cClean.segments);
    expect(result.unresolvedWarnings).toEqual(expect.arrayContaining(input.warnings.slice(0, 3)));
    expect(result.resolvedWarnings).toEqual([input.warnings[3]]);
    expect(result.remainderObservations.filter((r) => r.message.externalMessageId === "b").every((r) => !r.resolved)).toBe(true);
  });

  it("does not hide an inactive ID whose body has changed, or whose replacement was invalidated", () => {
    for (const id of ["old-edit", "a"]) {
      const input = fixture(); input.variants.push(message(id, "Unknown new text"));
      const result = projectSourceReview(input);
      expect(result.inactiveMessages).toEqual([]);
      expect(displayedIds(result.projectedMessages)).toContain("old-edit");
      expect(result.unresolvedWarnings).toEqual(expect.arrayContaining(input.warnings.slice(0, 2)));
    }
  });

  it("keeps new IDs at their natural merged positions and leaves their observations unreviewed", () => {
    const input = fixture();
    input.primaryMessages.splice(3, 0, message("new", "An additional message"));
    input.primaryMessages = input.primaryMessages.map((m, ordinal) => ({ ...m, ordinal }));
    const result = projectSourceReview(input);
    expect(result.fullyApplicable).toBe(false);
    expect(result.reviewedOrderApplicable).toBe(false);
    expect(displayedIds(result.projectedMessages)).toEqual(["c", "a", "new", "b"]);
    expect(result.unreviewedMessageIds).toEqual(["new"]);
    expect(result.unresolvedWarnings).toEqual(expect.arrayContaining(input.warnings.slice(0, 2)));
  });

  it("retains the verified order before an unreviewed tail, ignoring inactive physical rows", () => {
    const input = fixture();
    const tail = [message("new-1", "New user turn", 4), message("new-2", "New answer", 5)];
    input.inactive.ordinal = 6;
    input.primaryMessages.push(...tail);
    input.variants.push(message("new-2", "An unreviewed alternate rendering"));
    const newWarnings = [{ type: "order", messageIds: ["c", "new-1"] },
      { type: "content", messageIds: ["new-2"] }, { type: "future_warning", messageIds: ["a"] }];
    input.warnings.push(...newWarnings);
    const original = JSON.stringify(input);
    const result = projectSourceReview(input);
    expect(result.fullyApplicable).toBe(false);
    expect(result.reviewedOrderApplicable).toBe(true);
    expect(displayedIds(result.projectedMessages)).toEqual(["a", "b", "c", "new-1", "new-2"]);
    expect(result.projectedMessages[1]!.segments).toEqual(input.bClean.segments);
    expect(result.unreviewedMessageIds).toEqual(["new-1", "new-2"]);
    expect(result.resolvedWarnings).toEqual(input.warnings.slice(0, 4));
    expect(result.unresolvedWarnings).toEqual(input.warnings.slice(4));
    expect(result.remainderObservations.find((row) => row.message.externalMessageId === "new-2")!.resolved).toBe(false);
    expect(result.inactiveMessages).toEqual([input.inactive]);
    expect(JSON.stringify(input)).toBe(original);
  });

  it.each(["prefix", "duplicate_tail", "positional_tail", "variant_only", "missing_current_primary", "unknown_current_body"])(
    "does not extend the order proof across %s observations", (kind) => {
      const input = fixture();
      input.primaryMessages.push(message("new", "A new tail", 4));
      if (kind === "prefix") input.primaryMessages.push(message("prefix", "An earlier turn", -1));
      if (kind === "duplicate_tail") input.primaryMessages.push(message("new", "A repeated ID", 5));
      if (kind === "positional_tail") input.primaryMessages.push(message("conversation-turn-5", "An unstable identity", 5));
      if (kind === "variant_only") input.variants.push(message("variant-only", "An unordered observation"));
      if (kind === "missing_current_primary") input.primaryMessages = input.primaryMessages.filter((row) => row !== input.c);
      if (kind === "missing_current_primary") input.variants.push(input.c);
      if (kind === "unknown_current_body") input.variants.push(message("b", "Changed current text"));
      const result = projectSourceReview(input);
      expect(result.validation.valid).toBe(true);
      expect(result.fullyApplicable).toBe(false);
      expect(result.reviewedOrderApplicable).toBe(false);
      expect(result.unresolvedWarnings).toEqual(expect.arrayContaining(input.warnings.slice(0, 2)));
      expect(displayedIds(result.projectedMessages)).toContain("new");
      if (kind === "prefix") expect(displayedIds(result.projectedMessages)[0]).toBe("prefix");
      if (kind === "duplicate_tail") expect(displayedIds(result.projectedMessages).filter((id) => id === "new")).toHaveLength(2);
    });

  it("preserves true repeated anonymous extra messages rather than deduplicating their bodies", () => {
    const input = fixture();
    const anonymous = { ordinal: 4, role: "user" as const, segments: [{ type: "text" as const, content: "Continue" }] };
    input.primaryMessages.push(anonymous, { ...anonymous, ordinal: 5 });
    const result = projectSourceReview(input);
    expect(result.projectedMessages.filter((m) => !m.externalMessageId)).toHaveLength(2);
    expect(result.fullyApplicable).toBe(false);
    expect(result.reviewedOrderApplicable).toBe(false);
    expect(result.unresolvedWarnings).toEqual(expect.arrayContaining(input.warnings.slice(0, 2)));
  });

  it("does not resolve missing, unknown, or malformed warning scopes", () => {
    const input = fixture();
    input.warnings.push({ type: "content", messageIds: [] }, { type: "content", messageIds: ["b", "unknown"] },
      { type: "order" } as MergeEvidence["warnings"][number]);
    const result = projectSourceReview(input);
    expect(result.unresolvedWarnings).toEqual(input.warnings.slice(4));
  });

  it("falls back to all physical messages when no review is supplied", () => {
    const input = fixture();
    const result = projectSourceReview({ ...input, sourceReview: undefined });
    expect(result.validation).toEqual({ valid: false, errors: ["review_missing"] });
    expect(displayedIds(result.projectedMessages)).toEqual(["c", "old-edit", "a", "b"]);
    expect(result.resolvedWarnings).toEqual([]);
  });
});
