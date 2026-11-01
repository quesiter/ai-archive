import { describe, expect, it } from "vitest";
import { CaptureSnapshotV1Schema } from "@ai-archive/contracts";
import { EmptyGrokBuildTranscriptError, parseGrokBuildUpdates } from "../src/grok-build.js";

const path = "/home/test/.grok/sessions/%2Fwork/session-1/updates.jsonl";
const summary = { info: { id: "session-1", cwd: "/work" }, generated_title: "Build archive", current_model_id: "grok-code" };
const event = (kind: string, update: Record<string, unknown>, id: string, meta: Record<string, unknown> = {}) => ({
  timestamp: 1_762_000_000_000, method: "session/update",
  params: { sessionId: "session-1", update: { sessionUpdate: kind, ...update }, _meta: { eventId: id, ...meta } },
});
const user = (text: string, id: string) => event("user_message_chunk", { content: { type: "text", text } }, id);
const answer = (text: string, id: string) => event("agent_message_chunk", { content: { type: "text", text } }, id, { promptId: "prompt-1", streamStartMs: 100 });
const jsonl = (...records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";

describe("Grok Build ACP journal (CLI and Desktop)", () => {
  it("assembles streamed thoughts, answer chunks and updated tool calls with stable IDs", () => {
    const first = answer("First ", "a1");
    const snapshot = parseGrokBuildUpdates({ path, summary, content: jsonl(
      user("Build an archive", "u1"),
      event("agent_thought_chunk", { content: { type: "text", text: "Think" } }, "r1", { promptId: "prompt-1", streamStartMs: 100 }),
      first, first, answer("answer", "a2"),
      event("tool_call", { toolCallId: "tool-1", title: "Read file", rawInput: { apiKey: "never copied" } }, "t1"),
      event("tool_call_update", { toolCallId: "tool-1", title: "Read file", status: "completed", content: [{ type: "content", content: { type: "text", text: "ok" } }] }, "t2"),
      answer("Done", "a3"),
    ) });
    expect(CaptureSnapshotV1Schema.safeParse(snapshot).success).toBe(true);
    expect(snapshot).toMatchObject({ provider: "grok_build", sessionId: "session-1", title: "Build archive", completeness: { status: "complete" } });
    expect(snapshot.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(snapshot.messages[1]?.segments).toEqual([{ type: "reasoning", content: "Think" }, { type: "text", content: "First answer" }]);
    expect(snapshot.messages[2]?.segments[0]?.content).toBe("Read file (completed)\nok");
    expect(JSON.stringify(snapshot)).not.toContain("never copied");
  });

  it("replays rewind markers only from the xAI control channel", () => {
    const snapshot = parseGrokBuildUpdates({ path, summary, content: jsonl(
      user("First prompt", "u1"), answer("First answer", "a1"),
      user("Discard me", "u2"), answer("Discard answer", "a2"),
      { method: "_x.ai/session/update", params: { sessionId: "session-1", update: { sessionUpdate: "rewind_marker", target_prompt_index: 1 } } },
      user("Replacement", "u3"),
      event("rewind_marker", { target_prompt_index: 0 }, "fake-control"), answer("Kept answer", "a3"),
    ) });
    expect(snapshot.messages.map((message) => message.segments[0]?.content)).toEqual(["First prompt", "First answer", "Replacement", "Kept answer"]);
    expect(snapshot.messages.map((message) => message.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it("keeps copied fork events in the destination session, and combines multi-part prompts", () => {
    const part = (text: string, id: string) => event("user_message_chunk", { content: { type: "text", text }, _meta: { promptIndex: 0 } }, id);
    const snapshot = parseGrokBuildUpdates({ path, summary: { info: { id: "fork-session" } },
      content: jsonl(part("Question ", "u1"), part("continued", "u2"), answer("Answer", "a1")) });
    expect(snapshot.sessionId).toBe("fork-session");
    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.messages[0]?.segments[0]?.content).toBe("Question continued");
  });

  it("marks malformed records and non-text content partial without guessing their bodies", () => {
    const snapshot = parseGrokBuildUpdates({ path, content: jsonl(user("Question", "u1")) + "{broken\n" +
      jsonl(event("agent_message_chunk", { content: { type: "image", data: "encrypted data" } }, "image"), answer("Readable answer", "a1")) });
    expect(snapshot.completeness.status).toBe("partial");
    expect(snapshot.completeness.reason).toContain("lines 2");
    expect(JSON.stringify(snapshot)).not.toContain("encrypted data");
    expect(() => parseGrokBuildUpdates({ path, content: "" })).toThrow(EmptyGrokBuildTranscriptError);
  });

  it("does not turn context-size metadata into model-reported usage", () => {
    const snapshot = parseGrokBuildUpdates({ path, content: jsonl(user("Question", "u1"),
      event("agent_message_chunk", { content: { type: "text", text: "Answer" } }, "a1", { totalTokens: 100_000 })) });
    expect(snapshot.tokenUsage).toBeUndefined();
  });
});
