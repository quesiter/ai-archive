import type { CaptureMessage } from "@ai-archive/contracts";
import { describe, expect, it } from "vitest";
import { mergeConversationMessages } from "../src/services/conversation-merge.js";
const message = (ordinal: number, role: "user" | "assistant", content: string, id?: string): CaptureMessage => ({ ordinal, role, segments: [{ type: "text", content }], ...(id ? { externalMessageId: id } : {}) });
describe("identified and ID-less observations", () => {
  it.each([false, true])("matches a user prompt through the shared assistant anchor, incoming has ID=%s", (identifiedIncoming) => {
    const anonymous = [message(0,"user","question"), message(1,"assistant","answer","a")];
    const identified = [message(0,"user","question","u"),message(1,"assistant","answer","a")];
    const result = mergeConversationMessages(identifiedIncoming ? anonymous : identified, identifiedIncoming ? identified : anonymous);
    expect(result.messages).toEqual(identified);
    expect(result.changed).toBe(identifiedIncoming);
    expect(result.conflicts).toEqual([]);
    expect(result.sourceMatchesArchive).toBe(true);
    expect(mergeConversationMessages(result.messages, anonymous).changed).toBe(false);
  });
  it("promotes IDs in an exact repeated window one occurrence at a time", () => {
    const anonymous = [message(0,"user","continue"),message(1,"assistant","ok"),message(2,"user","continue"),message(3,"assistant","ok")];
    const identified = anonymous.map((value,index) => ({ ...value, externalMessageId: `id-${index}` }));
    const result = mergeConversationMessages(anonymous, identified);
    expect(result.messages).toEqual(identified);
    expect(mergeConversationMessages(result.messages, anonymous).changed).toBe(false);
  });
  it("matches a unique partial body window when all its IDs are absent", () => {
    const old = [message(0,"user","prefix","p"),message(1,"assistant","first","a"),message(2,"user","question","u"),message(3,"assistant","answer","b")];
    const partial = [message(0,"user","question"),message(1,"assistant","answer")];
    expect(mergeConversationMessages(old,partial)).toMatchObject({ messages: old, changed: false, conflicts: [] });
  });
  it("preserves distinct IDs even when bodies and neighboring anchors match", () => {
    const old = [message(0,"user","continue","u1"),message(1,"assistant","ok","a")];
    const next = [message(0,"user","continue","u2"),message(1,"assistant","ok","a")];
    const result = mergeConversationMessages(old,next);
    expect(result.messages.map(value => value.externalMessageId)).toEqual(["u1","u2","a"]);
  });
  it("does not guess an ID for a repeated ambiguous partial prompt", () => {
    const old = [message(0,"user","continue","u1"),message(1,"assistant","ok","a1"),message(2,"user","continue","u2"),message(3,"assistant","ok","a2")];
    const result = mergeConversationMessages(old,[message(0,"user","continue")]);
    expect(result.messages).toHaveLength(5);
    expect(result.conflicts.some(value => value.type === "disconnected")).toBe(true);
  });
  it("uses shared anchors when a neighboring response has expanded", () => {
    const old = [message(0,"user","question"),message(1,"assistant","answer","a")];
    const next = [message(0,"user","question","u"),message(1,"assistant","answer expanded","a")];
    expect(mergeConversationMessages(old,next)).toMatchObject({ messages: next, conflicts: [] });
  });
});it("promotes ordered exact prompts before stable ID anchors were ever captured", () => {
  const old = [message(0,"user","first"),message(1,"assistant","old first answer"),message(2,"user","second"),message(3,"assistant","old second answer")];
  const next = [message(0,"user","first","u1"),message(1,"assistant","updated first answer","a1"),message(2,"user","second","u2"),message(3,"assistant","updated second answer","a2"),message(4,"user","new","u3")];
  const result = mergeConversationMessages(old,next);
  expect(result.messages.filter(value => value.role === "user").map(value => value.externalMessageId)).toEqual(["u1","u2","u3"]);
  expect(result.messages.filter(value => value.role === "assistant")).toHaveLength(4);
  expect(mergeConversationMessages(result.messages,next).changed).toBe(false);
});
it("promotes a single-turn prompt while preserving revised response text", () => {
  const old = [message(0,"user","question"),message(1,"assistant","old answer")];
  const next = [message(0,"user","question","u"),message(1,"assistant","new answer","a")];
  const result = mergeConversationMessages(old,next);
  expect(result.messages.filter(value => value.role === "user")).toEqual([next[0]]);
  expect(result.messages.filter(value => value.role === "assistant")).toHaveLength(2);
  expect(mergeConversationMessages(result.messages,next).changed).toBe(false);
});
it("retains a new repeated turn after shared identified anchors", () => {
  const old = [message(0,"user","continue","u"),message(1,"assistant","ok","a")];
  const next = [...old,message(2,"user","continue"),message(3,"assistant","ok")];
  expect(mergeConversationMessages(old,next).messages).toEqual(next);
});