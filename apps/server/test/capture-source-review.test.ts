import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureRuns, conversationRevisions, conversations, messages, type MergeEvidence, type SourceReview } from "../src/schema.js";
import { consolidateConversationRevisions, contentIntegrityHash, ingestCapture } from "../src/services/capture.js";
import { projectSourceReview, sourceReviewBodyHash } from "../src/services/source-review.js";
import { captureStore } from "./capture-store-fixture.js";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), loadBatch: vi.fn(), loadMessages: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/services/conversation-lineage.js", () => ({ persistConversationParent: vi.fn() }));
vi.mock("../src/services/revision-storage.js", () => ({ loadCaptureRevisionMessages: mocks.loadMessages, loadCaptureRevisionMessagesBatch: mocks.loadBatch }));
vi.mock("../src/services/redaction.js", async (original) => ({ ...await original<typeof import("../src/services/redaction.js")>(), loadEnabledCustomRedactionRules: vi.fn(async () => []) }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const body = (n: number, content = `Message ${n}`): CaptureMessage => ({ externalMessageId: id(n), ordinal: n,
  role: n % 2 ? "assistant" : "user", createdAt: "2026-09-13T23:00:00.000Z", segments: [{ type: "text", content }] });
const reference = (message: CaptureMessage) => ({ messageId: message.externalMessageId!, bodyHash: sourceReviewBodyHash(message) });
function fixture() {
  const current = Array.from({ length: 42 }, (_, ordinal) => body(ordinal));
  const inactive = { ...body(99, "An explicitly inactive earlier edit"), ordinal: 42, role: "user" as const };
  const variants = Array.from({ length: 14 }, (_, index) => body(index * 2 + 1, `Map rendering ${index} around the recorded answer`));
  const proof: SourceReview = { version: 1, source: "chatgpt_source_ui", sessionId: "review-ingest",
    verifiedAt: "2026-09-14T01:00:00.000Z", sourceUrl: "https://chatgpt.com/c/review-ingest",
    currentMessageIds: current.map((message) => message.externalMessageId!),
    inactiveMessages: [{ messageId: inactive.externalMessageId!, replacedByMessageId: id(34) }],
    selectedBodies: current.map(reference), reviewedBodies: [
      ...variants.map((message) => ({ ...reference(message), kind: "map_rendering" as const })),
      { ...reference(inactive), kind: "source_text" },
    ] };
  const evidence: MergeEvidence = { sourceReview: proof, variants,
    warnings: [{ type: "order", messageIds: [...proof.currentMessageIds, id(99)] },
      { type: "disconnected", messageIds: [id(99), id(34)] },
      ...variants.map((message) => ({ type: "content", messageIds: [message.externalMessageId!] }))] };
  const snapshot: CaptureSnapshotV1 = { schemaVersion: 1, provider: "chatgpt", sessionId: proof.sessionId,
    branchFingerprint: "reviewed-branch", adapterVersion: "1.2.5", capturedAt: "2026-09-14T00:00:00.000Z",
    captureMode: "full", completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
    messages: [...current, inactive] };
  return { current, inactive, variants, proof, evidence, snapshot };
}
function incoming(snapshot: CaptureSnapshotV1, input: readonly CaptureMessage[], status: "partial" | "complete" = "partial", capturedAt = "2026-09-14T02:00:00.000Z"): CaptureSnapshotV1 {
  return { ...snapshot, capturedAt, triggerReason: "manual_retry", messages: input.map((message, ordinal) => ({ ...message, ordinal })),
    completeness: { status, topReached: true, bottomReached: status === "complete", stable: true } };
}
function projection(store: ReturnType<typeof captureStore>, snapshot: CaptureSnapshotV1) {
  const row = store.rows(conversationRevisions)[0]!;
  return projectSourceReview({ provider: snapshot.provider, sessionId: snapshot.sessionId,
    primaryMessages: store.hydrate(row.id), variants: row.mergeEvidence.variants,
    warnings: row.mergeEvidence.warnings, sourceReview: row.mergeEvidence.sourceReview });
}
function jsonb<T>(value: T): T {
  const transform = (item: unknown): unknown => Array.isArray(item) ? item.map(transform)
    : item && typeof item === "object" ? Object.fromEntries(Object.entries(item)
      .sort(([a], [b]) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(([key, child]) => [key, transform(child)])) : item;
  return transform(value) as T;
}

describe("source review through durable ingestion and consolidation", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["partial", "complete"] as const)("retains the reviewed archive for a known 42-message %s observation without issuing a 43-message baseline", async (status) => {
    const store = captureStore(mocks); const f = fixture();
    const revision = store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
    const metadata = new Map(store.rows(messages).map((row) => [row.externalMessageId,
      { id: row.id, createdAt: row.createdAt, sourceCreatedAt: row.sourceCreatedAt }]));
    const recaptured = f.current.map((message) => f.variants.find((variant) => variant.externalMessageId === message.externalMessageId) ?? message);
    const request = incoming(f.snapshot, recaptured, status);
    const receipt = await ingestCapture(request, id(900), "known-42");
    expect(receipt).toMatchObject({ messageCount: 42, completeness: "partial", archiveMessageCount: 43, archiveCompleteness: "complete" });
    expect(receipt.baselineContentHash).toBeUndefined();
    expect(store.rows(conversationRevisions)).toHaveLength(1);
    expect(store.rows(conversationRevisions)[0]!.mergeEvidence.sourceReview).toEqual(f.proof);
    const result = projection(store, f.snapshot);
    expect(result.fullyApplicable).toBe(true);
    expect(result.unresolvedWarnings).toEqual([]);
    expect(result.projectedMessages.map(sourceReviewBodyHash)).toEqual(f.current.map(sourceReviewBodyHash));
    expect(store.hydrate(revision.id)).toHaveLength(43);
    for (const row of store.rows(messages)) expect(row).toMatchObject(metadata.get(row.externalMessageId)!);
    expect(await ingestCapture(request, id(900), "known-42")).toEqual({ ...receipt, unchanged: true });
    expect(store.rows(captureRuns)).toHaveLength(1);
    expect(store.rows(captureRuns)[0]!.receipt.baselineContentHash).toBeUndefined();
  });

  it.each(["different", "longer_prefix", "shorter_prefix", "whitespace", "role"])("retains and exposes an unknown %s body for a reviewed ID and requires review", async (kind) => {
    const store = captureStore(mocks); const f = fixture();
    const revision = store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
    const changed = structuredClone(f.current);
    changed[1]!.segments[0]!.content = kind === "longer_prefix" ? "Message 1 with newly supplied material"
      : kind === "shorter_prefix" ? "Message" : kind === "whitespace" ? " Message 1 " : "An unknown new answer";
    if (kind === "role") { changed[1]!.role = "user"; changed[1]!.segments[0]!.content = "Message 1"; }
    const receipt = await ingestCapture(incoming(f.snapshot, changed), id(900), `unknown-${kind}`);
    const row = store.rows(conversationRevisions)[0]!;
    const observed = [...store.hydrate(revision.id), ...row.mergeEvidence.variants].map(sourceReviewBodyHash);
    expect(observed).toContain(sourceReviewBodyHash(f.current[1]!));
    expect(observed).toContain(sourceReviewBodyHash(changed[1]!));
    const result = projection(store, f.snapshot);
    expect(result.validation.valid).toBe(true);
    expect(result.invalidatedMessageIds).toContain(id(1));
    expect(result.remainderObservations.filter((entry) => entry.message.externalMessageId === id(1)).every((entry) => !entry.resolved)).toBe(true);
    expect(receipt).toMatchObject({ completeness: "partial", archiveCompleteness: "partial", archiveMessageCount: 43 });
    expect(receipt.baselineContentHash).toBeUndefined();
    // A later exact physical replay must not silently resolve the unknown body.
    const replay = await ingestCapture(incoming(f.snapshot, store.hydrate(revision.id), "complete", "2026-09-14T03:00:00.000Z"), id(900), `unknown-full-${kind}`);
    expect(replay.archiveCompleteness).toBe("partial");
    expect(replay.baselineContentHash).toBeUndefined();
  });

  it("invalidates a reviewed order only from a fresh stable source and retains the original proof and body", async () => {
    const store = captureStore(mocks); const f = fixture();
    store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
    const request = incoming(f.snapshot, [f.current[1]!, f.current[0]!, ...f.current.slice(2)]);
    const receipt = await ingestCapture(request, id(900), "fresh-reversal");
    const row = store.rows(conversationRevisions)[0]!;
    expect(row.mergeEvidence.sourceReview).toEqual({ ...f.proof,
      invalidatedByCapture: { capturedAt: request.capturedAt, reason: "order_changed" } });
    expect(projection(store, f.snapshot).validation).toEqual({ valid: false, errors: ["review_superseded"] });
    expect(receipt.archiveCompleteness).toBe("partial");
    expect(store.hydrate(row.id)).toHaveLength(43);
  });

  it.each(["duplicate", "anonymous", "positional", "unstable", "older_than_archive", "older_than_review", "import"])(
    "does not promote %s input into source-review order invalidation", async (kind) => {
      const store = captureStore(mocks); const f = fixture();
      if (kind === "older_than_archive") f.snapshot.capturedAt = "2026-09-14T04:00:00.000Z";
      store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
      const request = incoming(f.snapshot, [f.current[1]!, f.current[0]!, ...f.current.slice(2)]);
      if (kind === "duplicate") request.messages.push({ ...request.messages[0]!, ordinal: 42 });
      if (kind === "anonymous") delete request.messages[2]!.externalMessageId;
      if (kind === "positional") request.messages[2]!.externalMessageId = "conversation-turn-2";
      if (kind === "unstable") request.completeness.stable = false;
      if (kind === "older_than_review") request.capturedAt = "2026-09-14T00:30:00.000Z";
      if (kind === "import") request.captureMode = "import";
      await ingestCapture(request, id(900), kind);
      expect(store.rows(conversationRevisions)[0]!.mergeEvidence.sourceReview).toEqual(f.proof);
    });

  it("extends the reviewed order only before a natural new tail and retains old scoped warning evidence", async () => {
    const store = captureStore(mocks); const f = fixture();
    store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
    const receipt = await ingestCapture(incoming(f.snapshot, [...f.current, body(42, "A newly appended turn")]), id(900), "tail");
    const row = store.rows(conversationRevisions)[0]!;
    expect(receipt).toMatchObject({ archiveMessageCount: 44, messageCount: 43, archiveCompleteness: "partial" });
    expect(receipt.baselineContentHash).toBeUndefined();
    const result = projection(store, f.snapshot);
    expect(result.fullyApplicable).toBe(false);
    expect(result.reviewedOrderApplicable).toBe(true);
    expect(result.projectedMessages.map((message) => message.externalMessageId)).toEqual([...f.proof.currentMessageIds, id(42)]);
    expect(result.unresolvedWarnings).toEqual([]);
    expect(result.unreviewedMessageIds).toEqual([id(42)]);
    expect(row.mergeEvidence.warnings).toEqual(expect.arrayContaining(f.evidence.warnings));
  });

  it("does not mistake a reconstructed append prefix for fresh source order proof", async () => {
    const store = captureStore(mocks); const f = fixture();
    f.snapshot.messages = [f.current[1]!, f.current[0]!, ...f.current.slice(2), f.inactive].map((message, ordinal) => ({ ...message, ordinal }));
    const revision = store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
    const receipt = await ingestCapture({ schemaVersion: 1, provider: f.snapshot.provider, sessionId: f.snapshot.sessionId,
      branchFingerprint: f.snapshot.branchFingerprint, adapterVersion: f.snapshot.adapterVersion,
      capturedAt: "2026-09-14T02:00:00.000Z", captureMode: "append", baseRevisionId: revision.id,
      baseContentHash: revision.contentIntegrityHash, baseMessageCount: 43, baseLastMessageId: id(99),
      appendedMessages: [{ ...body(42, "A new continuation"), ordinal: 43 }] }, id(900), "delta");
    const row = store.rows(conversationRevisions)[0]!;
    expect(row.mergeEvidence.sourceReview).toEqual(f.proof);
    expect(projection(store, f.snapshot).reviewedOrderApplicable).toBe(true);
    // This baseline describes the real 44-message reconstructed delta, not the 42-message source projection.
    expect(receipt).toMatchObject({ messageCount: 44, archiveMessageCount: 44, baselineContentHash: row.contentIntegrityHash });
  });

  it("accepts a fully observed active continuation without requiring an inactive edit or fabricating its delta baseline", async () => {
    const store = captureStore(mocks); const f = fixture();
    const revision = store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
    const active44 = [...f.current, body(42, "Next question"), body(43, "Next answer")];
    const receipt = await ingestCapture(incoming(f.snapshot, active44, "complete"), id(900), "complete-tail");
    expect(receipt).toMatchObject({ messageCount: 44, archiveMessageCount: 45, completeness: "partial", archiveCompleteness: "complete" });
    expect(receipt.baselineContentHash).toBeUndefined();
    expect(store.hydrate(revision.id)).toHaveLength(45);
    const projected = projection(store, f.snapshot);
    expect(projected.fullyApplicable).toBe(false);
    expect(projected.reviewedOrderApplicable).toBe(true);
    expect(projected.projectedMessages.map(sourceReviewBodyHash)).toEqual(active44.map(sourceReviewBodyHash));
    const knownWindow = active44.slice(27).map((message) => f.variants.find((variant) => variant.externalMessageId === message.externalMessageId) ?? message);
    const partialReceipt = await ingestCapture(incoming(f.snapshot, knownWindow, "partial", "2026-09-14T02:30:00.000Z"), id(900), "known-tail-window");
    expect(partialReceipt).toMatchObject({ messageCount: 17, archiveMessageCount: 45, completeness: "partial", archiveCompleteness: "complete" });
    expect(partialReceipt.baselineContentHash).toBeUndefined();
    expect(projection(store, f.snapshot).reviewedOrderApplicable).toBe(true);
    // Another complete continuation can continue extending the same proof.
    const next = await ingestCapture(incoming(f.snapshot, [...active44, body(44, "Another question")], "complete", "2026-09-14T03:00:00.000Z"), id(900), "another-tail");
    expect(next).toMatchObject({ messageCount: 45, archiveMessageCount: 46, archiveCompleteness: "complete" });
    expect(next.baselineContentHash).toBeUndefined();
  });

  it("requires a new complete observation after a partial window adds another tail body", async () => {
    const store = captureStore(mocks); const f = fixture();
    store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
    const active44 = [...f.current, body(42, "Next question"), body(43, "Next answer")];
    await ingestCapture(incoming(f.snapshot, active44, "complete"), id(900), "complete-tail-before-new");
    const receipt = await ingestCapture(incoming(f.snapshot, [active44[43]!, body(44, "Unknown later tail")], "partial", "2026-09-14T03:00:00.000Z"), id(900), "unknown-partial-tail");
    expect(receipt).toMatchObject({ archiveMessageCount: 46, archiveCompleteness: "partial" });
    expect(receipt.baselineContentHash).toBeUndefined();
  });

  it.each(["partial_tail_only", "old_complete_tail", "interleaved_complete"])("does not infer active continuation completeness for %s", async (kind) => {
    const store = captureStore(mocks); const f = fixture();
    store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
    const extra = body(42, "New material");
    const request = kind === "partial_tail_only" ? incoming(f.snapshot, [extra])
      : kind === "old_complete_tail" ? incoming(f.snapshot, [...f.current, extra], "complete", "2026-09-14T00:30:00.000Z")
      : incoming(f.snapshot, [f.current[0]!, extra, ...f.current.slice(1)], "complete");
    const receipt = await ingestCapture(request, id(900), kind);
    expect(receipt.archiveCompleteness).toBe("partial");
    expect(receipt.baselineContentHash).toBeUndefined();
    expect(store.rows(conversationRevisions)[0]!.mergeEvidence.sourceReview).toEqual(f.proof);
  });

  it.each(["complete_old_branch", "partial_old_window", "complete_both_versions"])("distinguishes an explicit inactive branch return from %s", async (kind) => {
    const store = captureStore(mocks); const f = fixture();
    store.seedSnapshot(f.snapshot, { isAccumulated: true, mergeEvidence: f.evidence });
    const request = kind === "complete_both_versions" ? incoming(f.snapshot, f.snapshot.messages, "complete")
      : incoming(f.snapshot, [f.inactive], kind === "complete_old_branch" ? "complete" : "partial");
    const receipt = await ingestCapture(request, id(900), kind);
    const row = store.rows(conversationRevisions)[0]!;
    if (kind === "complete_old_branch") {
      expect(row.mergeEvidence.sourceReview).toEqual({ ...f.proof,
        invalidatedByCapture: { capturedAt: request.capturedAt, reason: "new_branch" } });
      expect(receipt.archiveCompleteness).toBe("partial");
      expect(projection(store, f.snapshot).inactiveMessages).toEqual([]);
    } else expect(row.mergeEvidence.sourceReview).toEqual(f.proof);
    expect(store.hydrate(row.id).map((message) => message.externalMessageId)).toEqual(expect.arrayContaining([id(34), id(99)]));
  });

  it("preserves the newest proof and never revives its uninvalidated copy during historical consolidation", async () => {
    const store = captureStore(mocks); const f = fixture();
    store.seedSnapshot(f.snapshot, { mergeEvidence: f.evidence });
    const superseded = { ...f.proof, invalidatedByCapture: { capturedAt: "2026-09-14T02:00:00.000Z", reason: "order_changed" as const } };
    store.seedSnapshot({ ...f.snapshot, capturedAt: "2026-09-14T03:00:00.000Z" }, { mergeEvidence: { ...f.evidence, sourceReview: superseded } });
    await consolidateConversationRevisions(store.rows(conversations)[0]!.id);
    const row = store.rows(conversationRevisions)[0]!;
    expect(store.rows(conversationRevisions)).toHaveLength(1);
    expect(row.mergeEvidence.sourceReview).toEqual(superseded);
    expect(store.hydrate(row.id)).toHaveLength(43);
    expect(row.mergeEvidence.variants).toHaveLength(14);
    expect(projection(store, f.snapshot).validation).toEqual({ valid: false, errors: ["review_superseded"] });
  });

  it("hashes review evidence canonically through a JSONB roundtrip and detects proof-only changes", () => {
    const f = fixture();
    f.proof.invalidatedByCapture = { capturedAt: "2026-09-14T02:00:00.000Z", reason: "new_branch" };
    const hash = contentIntegrityHash(f.snapshot, f.evidence);
    expect(contentIntegrityHash(f.snapshot, jsonb(f.evidence))).toBe(hash);
    const changed = structuredClone(f.evidence); changed.sourceReview!.reviewedBodies[0]!.kind = "source_text";
    expect(contentIntegrityHash(f.snapshot, changed)).not.toBe(hash);
    delete changed.sourceReview!.invalidatedByCapture;
    expect(contentIntegrityHash(f.snapshot, changed)).not.toBe(hash);
    expect(contentIntegrityHash(f.snapshot, { variants: f.variants, warnings: f.evidence.warnings })).not.toBe(hash);
  });

  it("preserves frozen pre-review hashes for both legacy and accumulated snapshots", () => {
    const f = fixture(); const snapshot = { ...f.snapshot, messages: [f.current[0]!] };
    // These reference digests use the pre-review serialized facts, including
    // its original warning field order and optional evidence boundary.
    expect(contentIntegrityHash(snapshot)).toBe("7483207487c9b0b497e474241acd1cc11f6216c1b4e635220062616f44824da4");
    const evidence = { variants: [f.variants[0]!], warnings: [{ type: "content", messageIds: [id(1)] }] };
    expect(contentIntegrityHash(snapshot, evidence)).toBe("454007ca565694f3a93953a7758b5eb38000c2d13bcdec476240cd0e9d8b8d88");
    expect(contentIntegrityHash(snapshot, jsonb(evidence))).toBe(contentIntegrityHash(snapshot, evidence));
  });
});
