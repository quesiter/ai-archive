import { describe, expect, it } from "vitest";
import type { CaptureMessage } from "@ai-archive/contracts";
import { mergeConversationMessages } from "../src/services/conversation-merge.js";

const message = (id: string, content = id): CaptureMessage => ({ ordinal: 0, externalMessageId: id, role: "user", segments: [{ type: "text", content }] });
const sequence = (...ids: string[]) => ids.map((id, ordinal) => ({ ...message(id), ordinal }));
const ids = (messages: readonly CaptureMessage[]) => messages.map((item) => item.externalMessageId);

describe("one accumulating conversation", () => {
  it.each(["same", "shorter"])("enriches a %s body with a newly recovered source timestamp", (kind) => {
    const existing = [message("a", "Full answer")];
    const incoming = [{ ...message("a", kind === "same" ? "Full answer" : "Full"),
      createdAt: "2026-09-14T13:38:00.000Z", model: "source-model" }];
    const result = mergeConversationMessages(existing, incoming);
    expect(result.changed).toBe(true);
    expect(result.messages[0]).toMatchObject({ createdAt: incoming[0]!.createdAt, model: "source-model", segments: existing[0]!.segments });
    expect(result.conflicts).toEqual([]);
    expect(mergeConversationMessages(result.messages, incoming).changed).toBe(false);
    expect(mergeConversationMessages(result.messages, existing).messages[0]?.createdAt).toBe(incoming[0]!.createdAt);
  });
  it("retains the original beginning when a later full-labelled capture contains only the last thirty messages", () => {
    const existing = sequence(...Array.from({ length: 40 }, (_, index) => String(index)));
    const result = mergeConversationMessages(existing, existing.slice(10).map((item, ordinal) => ({ ...item, ordinal })));
    expect(ids(result.messages)).toEqual(ids(existing));
    expect(result).toMatchObject({ changed: false, sourceMatchesArchive: false });
  });
  it("appends a partially loaded window using its overlap and remains idempotent", () => {
    const result = mergeConversationMessages(sequence("a", "b", "c"), sequence("b", "c", "d"));
    expect(ids(result.messages)).toEqual(["a", "b", "c", "d"]);
    expect(mergeConversationMessages(result.messages, sequence("b", "c", "d")).changed).toBe(false);
  });
  it("fills an older prefix and a missing middle without discarding the current tail", () => {
    expect(ids(mergeConversationMessages(sequence("b", "d", "e"), sequence("a", "b", "c", "d")).messages)).toEqual(["a", "b", "c", "d", "e"]);
  });
  it("uses later window order to correct displaced known messages while retaining the saved prefix", () => {
    const result = mergeConversationMessages(sequence("a", "b", "late", "x", "y", "z"), sequence("y", "z", "late"));
    expect(ids(result.messages)).toEqual(["a", "b", "x", "y", "z", "late"]);
    expect(result.orderReliable).toBe(false);
  });
  it("keeps both disconnected windows and records that order is unknown", () => {
    const result = mergeConversationMessages(sequence("a", "b"), sequence("c", "d"));
    expect(ids(result.messages)).toEqual(["a", "b", "c", "d"]);
    expect(result.conflicts[0]?.type).toBe("disconnected");
  });
  it("does not let a contradictory partial window replace the already saved first message", () => {
    const result = mergeConversationMessages(sequence("a", "b", "c"), sequence("b", "a"));
    expect(ids(result.messages)).toEqual(["a", "b", "c"]);
    expect(result.orderReliable).toBe(false);
    expect(ids(mergeConversationMessages(sequence("a", "b", "c"), sequence("b", "a", "c"), { allowKnownPrefixReorder: true }).messages)).toEqual(["b", "a", "c"]);
  });
  it("records both observations when a message changes instead of losing the previous text", () => {
    const before = message("a", "First wording");
    const after = message("a", "Revised wording");
    const result = mergeConversationMessages([before], [after]);
    expect(result.messages[0]?.segments).toEqual(after.segments);
    expect(result.conflicts).toEqual([{ type: "content", previous: before, incoming: after }]);
  });
  it("expands a shell but never shortens an already captured answer", () => {
    const full = message("a", "Answer with all the details");
    expect(mergeConversationMessages([message("a", "Answer")], [full]).conflicts).toEqual([]);
    expect(mergeConversationMessages([full], [message("a", "Answer")]).messages[0]?.segments).toEqual(full.segments);
  });
  it("preserves repeated anonymous turns and deduplicates an identical observed window", () => {
    const anonymous = ["continue", "answer", "continue", "answer"].map((content, ordinal) => ({ ordinal, role: "user" as const, segments: [{ type: "text" as const, content }] }));
    const first = mergeConversationMessages([], anonymous);
    expect(first.messages).toHaveLength(4);
    expect(mergeConversationMessages(first.messages, anonymous).messages).toHaveLength(4);
    const grown = [...anonymous, { ...anonymous[0]!, ordinal: 4, segments: [{ type: "text" as const, content: "new turn" }] }];
    expect(mergeConversationMessages(first.messages, grown).messages).toHaveLength(5);
    expect(mergeConversationMessages(first.messages, grown.slice(2).map((item, ordinal) => ({ ...item, ordinal }))).messages).toHaveLength(5);
  });
});
