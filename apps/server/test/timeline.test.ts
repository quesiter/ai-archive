import { describe, expect, it } from "vitest";
import { selectLatestTimelineRevisions } from "../src/services/timeline.js";

describe("project timeline revision selection", () => {
  it("prefers the newest complete revision and resolves timestamp ties deterministically", () => {
    const capturedAt = new Date("2026-08-20T00:00:00.000Z");
    const selected = selectLatestTimelineRevisions([
      { id: "partial-new", conversationId: "a", capturedAt: new Date("2026-08-21T00:00:00.000Z"), createdAt: capturedAt, completeness: "partial" },
      { id: "complete-old", conversationId: "a", capturedAt, createdAt: capturedAt, completeness: "complete" },
      { id: "b-old", conversationId: "b", capturedAt, createdAt: new Date("2026-08-20T00:00:00.000Z"), completeness: "complete" },
      { id: "b-new", conversationId: "b", capturedAt, createdAt: new Date("2026-08-20T00:01:00.000Z"), completeness: "complete" },
    ]);
    expect(selected.get("a")?.id).toBe("complete-old");
    expect(selected.get("b")?.id).toBe("b-new");
  });
});
