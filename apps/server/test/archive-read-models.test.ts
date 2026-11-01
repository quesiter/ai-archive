import { describe, expect, it, vi } from "vitest";
import type { CaptureMessage } from "@ai-archive/contracts";
import { buildArchiveReadModel } from "../src/services/archive-read-models.js";
import { sourceReviewBodyHash } from "../src/services/source-review.js";

vi.mock("../src/db.js", () => ({ db: {} }));
const message = (ordinal: number, externalMessageId?: string): CaptureMessage => ({ ordinal, role: "user",
  ...(externalMessageId ? { externalMessageId } : {}), segments: [{ type: "text", content: externalMessageId ?? "Same anonymous body" }] });

describe("archive read model references", () => {
  it("retains separate physical ordinals for identical anonymous messages after a reviewed branch", () => {
    const current = message(0, "current-message");
    const input = { provider: "chatgpt", sessionId: "reviewed-session",
      messages: [current, message(1), { ...message(2), model: "different-model" }],
      evidence: { variants: [], warnings: [], sourceReview: { version: 1 as const, source: "chatgpt_current_branch" as const,
        sessionId: "reviewed-session", sourceUrl: "https://chatgpt.com/c/reviewed-session", verifiedAt: "2026-11-01T00:00:00Z",
        currentMessageIds: ["current-message"], inactiveMessages: [], selectedBodies: [{ messageId: "current-message", bodyHash: sourceReviewBodyHash(current) }], reviewedBodies: [] } } };
    const model = buildArchiveReadModel(input);
    expect(model.presentation.map(row => row.storedOrdinal)).toEqual([0, 1, 2]);
    expect(model.presentationMessageCount).toBe(3);
  });

  it("keeps unreviewed variants distinct without storing their bodies again", () => {
    const primary = message(0, "current-message");
    const variant = { ...primary, segments: [{ type: "text" as const, content: "Different observed body" }] };
    const model = buildArchiveReadModel({ provider: "chatgpt", sessionId: "unreviewed", messages: [primary],
      evidence: { variants: [primary, variant, variant], warnings: [] } });
    expect(model.observations).toEqual([{ category: "unresolved", ordinal: 0, storedOrdinal: null, variantIndex: 1, observationKind: null }]);
    expect(model.presentation).toEqual([]);
    expect(model).toMatchObject({ presentationMessageCount: 1, storedMessageCount: 1, sourceContentPending: false });
  });
});
