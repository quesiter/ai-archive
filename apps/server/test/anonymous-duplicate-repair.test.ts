import { describe, expect, it } from "vitest";
import { repairAnonymousDuplicates } from "../src/services/anonymous-duplicate-repair.js";
import type { CaptureMessage } from "@ai-archive/contracts";
const message = (ordinal: number, id?: string, text = "Question"): CaptureMessage => ({ ordinal, role: "user", ...(id ? { externalMessageId: id } : {}), segments: [{ type: "text", content: text }] });
describe("confirmed anonymous duplicate correction", () => {
  it.each([false, true])("keeps the identified observation in either order (%s)", (reverse) => {
    const input = reverse ? [message(0), message(1, "user-id")] : [message(0, "user-id"), message(1)];
    const before = JSON.stringify(input);
    const result = repairAnonymousDuplicates(input);
    expect(result.messages).toEqual([message(0, "user-id")]);
    expect(result.removed).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(before);
    expect(repairAnonymousDuplicates(result.messages).removed).toHaveLength(0);
  });
  it("preserves repeated anonymous messages, distinct IDs, changed text, and separated repeats", () => {
    for (const input of [[message(0), message(1)], [message(0, "one"), message(1, "two")], [message(0, "one"), message(1, undefined, "Changed")], [message(0, "one"), message(1, "middle", "Different"), message(2)]]) {
      expect(repairAnonymousDuplicates(input).messages).toEqual(input);
    }
  });
});

it("repairs separated parallel observation runs without dropping changed bodies", () => {
  const input = [message(0,"one","First"),message(1,"two","Second"),message(2,"three","Original answer"),message(3,undefined,"First"),message(4,undefined,"Second"),message(5,undefined,"Changed answer")];
  const result = repairAnonymousDuplicates(input);
  expect(result.removed).toHaveLength(2);
  expect(result.messages.map(value => value.segments[0]!.content)).toEqual(["First","Second","Original answer","Changed answer"]);
  expect(repairAnonymousDuplicates(result.messages).removed).toHaveLength(0);
});
it("keeps ambiguous repeated prompts, crossed order and different IDs", () => {
  const cases = [
    [message(0,"one","First"),message(1,"two","Second"),message(2,undefined,"Second"),message(3,undefined,"First")],
    [message(0,"one","First"),message(1,"two","First"),message(2,undefined,"First"),message(3,undefined,"First")],
    [message(0,"one","First"),message(1,"two","Second"),message(2,"three","First"),message(3,"four","Second")],
  ];
  for (const input of cases) expect(repairAnonymousDuplicates(input).messages).toEqual(input);
});it("matches parallel runs even when a retained identified prefix lies before the anonymous copy", () => {
  const input = [message(0,"prefix","First"),message(1,undefined,"First"),message(2,undefined,"Second"),message(3,undefined,"Third"),message(4,"two","Second"),message(5,"three","Third")];
  const result = repairAnonymousDuplicates(input);
  expect(result.removed).toHaveLength(3);
  expect(result.messages.map(value => value.externalMessageId)).toEqual(["prefix","two","three"]);
});it("repairs corroborated ordered subsequences but retains an isolated crossed copy", () => {
  const input = [message(0,undefined,"First"),message(1,undefined,"Third"),message(2,undefined,"Second"),message(3,"one","First"),message(4,"two","Second"),message(5,"three","Third")];
  const result = repairAnonymousDuplicates(input);
  expect(result.removed).toHaveLength(2);
  expect(result.messages.some(value => !value.externalMessageId && value.segments[0]!.content === "Third")).toBe(true);
  expect(repairAnonymousDuplicates(result.messages).removed).toHaveLength(0);
});