import { describe, expect, it } from "vitest";
import type { CaptureMessage } from "@ai-archive/contracts";
import { diffRevisionMessages } from "../src/services/revision-diff.js";

function message(ordinal: number, content: string, externalMessageId?: string): CaptureMessage {
  return {
    ordinal,
    role: ordinal % 2 ? "assistant" : "user",
    ...(externalMessageId ? { externalMessageId } : {}),
    segments: [{ type: "text", content }],
  };
}

describe("revision diff", () => {
  it("reports added, removed, and modified messages independently", () => {
    const diff = diffRevisionMessages(
      [message(0, "old", "m0"), message(1, "remove", "m1")],
      [message(0, "new", "m0"), message(2, "added", "m2")],
    );
    expect(diff.summary).toEqual({ added: 1, removed: 1, modified: 1 });
    expect(diff.added[0]?.content).toContain("added");
    expect(diff.modified[0]).toMatchObject({ before: "text:old", after: "text:new" });
  });
});
