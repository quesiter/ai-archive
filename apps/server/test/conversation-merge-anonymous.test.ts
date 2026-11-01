import type { CaptureMessage } from "@ai-archive/contracts";
import { describe, expect, it } from "vitest";
import { mergeConversationMessages } from "../src/services/conversation-merge.js";

const sequence = (...contents: string[]): CaptureMessage[] => contents.map((content, ordinal) => ({
  ordinal, role: "tool", segments: [{ type: "tool_status", content }],
}));
const text = (messages: readonly CaptureMessage[]) => messages.map(message => message.segments[0]!.content);
const repeats = (messages: readonly CaptureMessage[], content = "X") => text(messages).filter(value => value === content).length;
function isSubsequence(needle: readonly string[], haystack: readonly string[]): boolean {
  let cursor = 0;
  for (const value of haystack) if (value === needle[cursor]) cursor++;
  return cursor === needle.length;
}

describe("ordered anonymous observations", () => {
  it("matches CRCRLF captures repeatedly without changing saved text or standalone carriage returns", () => {
    const raw = "start\r\r\nmiddle\rprogress\r\r\nend";
    const normalized = "start\nmiddle\rprogress\nend";
    const capture = (content: string): CaptureMessage[] => (["code", "tool_status"] as const).map((type, ordinal) => ({
      ordinal, role: "tool", segments: [{ type, content }],
    }));
    const saved = capture(normalized);
    for (let retry = 0; retry < 5; retry++) {
      const result = mergeConversationMessages(saved, capture(raw));
      expect(result).toMatchObject({ messages: saved, changed: false, conflicts: [], sourceMatchesArchive: true });
    }
    const rawFirst = capture(raw);
    expect(mergeConversationMessages(rawFirst, saved).messages).toEqual(rawFirst);
    const changedStandalone = capture("start\nmiddle\nprogress\nend");
    const distinct = mergeConversationMessages(saved, changedStandalone);
    expect(distinct.messages).toHaveLength(4);
    expect(text(distinct.messages)).toEqual([normalized, normalized, "start\nmiddle\nprogress\nend", "start\nmiddle\nprogress\nend"]);
    expect(mergeConversationMessages(distinct.messages, changedStandalone).changed).toBe(false);
  });

  it("retains both changed wordings without duplicating unchanged repeated turns", () => {
    const old = sequence("A", "X", "B_old", "X", "C");
    const incoming = sequence("A", "X", "B_new", "X", "C", "D");
    const merged = mergeConversationMessages(old, incoming);
    expect(text(merged.messages)).toEqual(["A", "X", "B_new", "B_old", "X", "C", "D"]);
    expect(merged.orderReliable).toBe(false);
    expect(repeats(merged.messages)).toBe(2);
    for (let retry = 0; retry < 5; retry++) {
      expect(mergeConversationMessages(merged.messages, incoming)).toMatchObject({ messages: merged.messages, changed: false });
    }
  });

  it("adds only distinct observations across repeated middle-message expansions, then retains a genuinely new third repeat", () => {
    let old = sequence("A", "X", "B", "X", "C");
    for (let version = 1; version <= 20; version++) {
      const incoming = sequence("A", "X", `B${" details".repeat(version)}`, "X", "C", "D");
      old = mergeConversationMessages(old, incoming).messages;
      expect(old).toHaveLength(6 + version);
      expect(repeats(old)).toBe(2);
      expect(mergeConversationMessages(old, incoming).changed).toBe(false);
    }
    const extra = sequence("A", "X", `B${" details".repeat(20)}`, "X", "X", "C", "D");
    const extended = mergeConversationMessages(old, extra);
    expect(extended.messages).toHaveLength(old.length + 1);
    expect(repeats(extended.messages)).toBe(3);
    expect(mergeConversationMessages(extended.messages, extra).changed).toBe(false);
  });

  it("matches a partial middle window and a temporarily missing repeat using surrounding order", () => {
    const old = sequence("A", "X", "B_old", "X", "C");
    const middle = sequence("X", "B_new", "X");
    const merged = mergeConversationMessages(old, middle);
    expect(merged.messages).toHaveLength(6);
    expect(repeats(merged.messages)).toBe(2);
    expect(mergeConversationMessages(merged.messages, middle).changed).toBe(false);
    const missing = sequence("A", "X", "B_new", "C");
    const observed = mergeConversationMessages(merged.messages, missing);
    expect(observed.changed).toBe(false);
    const restored = mergeConversationMessages(observed.messages, sequence("A", "X", "B_new", "X", "C", "D"));
    expect(restored.messages).toHaveLength(7);
    expect(repeats(restored.messages)).toBe(2);
  });

  it("does not require the unique boundary text to survive unchanged", () => {
    const old = sequence("A_old", "X", "B_old", "X", "C_old");
    const incoming = sequence("A_new", "X", "B_new", "X", "C_new", "D");
    const merged = mergeConversationMessages(old, incoming);
    expect(merged.messages).toHaveLength(9);
    expect(repeats(merged.messages)).toBe(2);
    expect(isSubsequence(text(old), text(merged.messages))).toBe(true);
    expect(isSubsequence(text(incoming), text(merged.messages))).toBe(true);
    expect(mergeConversationMessages(merged.messages, incoming).changed).toBe(false);
  });

  it("keeps growing fully repeated anonymous turns instead of globally deduplicating their text", () => {
    const old = sequence("X", "X");
    const incoming = sequence("X", "X", "X");
    const merged = mergeConversationMessages(old, incoming);
    expect(merged.messages).toHaveLength(3);
    expect(mergeConversationMessages(merged.messages, incoming).changed).toBe(false);
  });

  it("bounds alignment work for a long range without unique shared anchors", () => {
    const body = Array.from({ length: 20_000 }, (_, index) => `repeat-${index % 16}`);
    const old = sequence("old-start", ...body, "old-end");
    const changed = [...body];
    changed[10_000] = "updated-middle";
    const incoming = sequence("new-start", ...changed, "new-end", "new-tail");
    const merged = mergeConversationMessages(old, incoming);
    expect(merged.orderReliable).toBe(false);
    expect(merged.messages.length).toBeLessThan(old.length + 20);
    expect(isSubsequence(text(old), text(merged.messages))).toBe(true);
    expect(isSubsequence(text(incoming), text(merged.messages))).toBe(true);
    expect(mergeConversationMessages(merged.messages, incoming).changed).toBe(false);
  });

  it("preserves the multiplicity and order of both observations and is idempotent for repeated small windows", () => {
    let state = 12345;
    const random = (limit: number) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return (state >>> 8) % limit; };
    for (let trial = 0; trial < 300; trial++) {
      const old = sequence(...Array.from({ length: 1 + random(12) }, () => String(random(4))));
      const incoming = sequence(...Array.from({ length: 1 + random(12) }, () => String(random(4))));
      const merged = mergeConversationMessages(old, incoming);
      expect(isSubsequence(text(old), text(merged.messages))).toBe(true);
      expect(isSubsequence(text(incoming), text(merged.messages))).toBe(true);
      expect(mergeConversationMessages(merged.messages, incoming).changed).toBe(false);
    }
  });
});
