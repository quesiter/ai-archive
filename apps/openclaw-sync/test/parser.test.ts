import { describe, expect, it } from "vitest";
import {
  EmptyOpenClawTranscriptError,
  captureMessageFingerprint,
  parseClaudeCodeJsonl,
  parseCodexJsonl,
  parseLocalJsonlDelta,
  parseOpenClawJsonl,
} from "../src/parser.js";

describe("OpenClaw JSONL parser", () => {
  it("keeps user, assistant, reasoning, and tool text", () => {
    const snapshot = parseOpenClawJsonl({
      path: "/Users/me/.openclaw/agents/main/sessions/session-1.jsonl",
      content: [
        JSON.stringify({ sessionId: "session-1", title: "Demo" }),
        JSON.stringify({ id: "u1", role: "user", content: "hello" }),
        JSON.stringify({ id: "a1", role: "assistant", reasoning: "plan", content: "answer" }),
        JSON.stringify({ id: "t1", role: "tool", toolName: "search", toolResult: "done" }),
      ].join("\n"),
    });
    expect(snapshot.sessionId).toBe("session-1");
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages[1]?.segments.some((segment) => segment.type === "reasoning")).toBe(true);
    expect(snapshot.messages[2]?.segments.some((segment) => segment.type === "tool_status")).toBe(true);
    expect(snapshot.completeness.status).toBe("complete");
  });

  it("uses the session record ID when OpenClaw calls it id", () => {
    const snapshot = parseOpenClawJsonl({
      path: "/Users/me/.openclaw/agents/main/sessions/rotated-file.jsonl",
      content: [
        JSON.stringify({ type: "session", id: "canonical-session-id" }),
        JSON.stringify({ type: "message", message: { role: "user", content: "hello" } }),
        JSON.stringify({ type: "message", message: { role: "assistant", content: "world" } }),
      ].join("\n"),
    });
    expect(snapshot.sessionId).toBe("canonical-session-id");
  });

  it("marks a transcript with a trailing partial record as incomplete", () => {
    const snapshot = parseOpenClawJsonl({
      path: "/tmp/session-partial.jsonl",
      content: [
        JSON.stringify({ sessionId: "session-partial", type: "user", content: "hello" }),
        '{"type":"assistant","content":',
      ].join("\n") + "\n",
    });
    expect(snapshot.completeness.status).toBe("partial");
    expect(snapshot.completeness.stable).toBe(false);
  });

  it("reports empty trajectory files as skippable OpenClaw transcripts", () => {
    expect(() =>
      parseOpenClawJsonl({
        path: "/Users/me/.openclaw/agents/main/sessions/empty-session.trajectory.jsonl",
        content: [
          JSON.stringify({ type: "session", id: "empty-session" }),
          JSON.stringify({ type: "event", status: "started" }),
          JSON.stringify({ type: "event", status: "finished" }),
        ].join("\n"),
      }),
    ).toThrowError(EmptyOpenClawTranscriptError);
  });
});

describe("Codex JSONL parser", () => {
  it("imports local Codex messages under the Codex provider", () => {
    const snapshot = parseCodexJsonl({
      path: "/Users/me/.codex/sessions/2026/07/24/rollout-2026-07-24T22-07-25-thread-1.jsonl",
      titleBySessionId: { "thread-1": "Local Codex task" },
      content: [
        JSON.stringify({
          timestamp: "2026-07-24T14:00:00Z",
          type: "session_meta",
          payload: { id: "thread-1", cwd: "/repo/app", originator: "Codex Desktop" },
        }),
        JSON.stringify({
          timestamp: "2026-07-24T14:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "please inspect the app" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-24T14:00:02Z",
          type: "response_item",
          payload: { type: "function_call", name: "shell_command", arguments: { command: "ls" } },
        }),
        JSON.stringify({
          timestamp: "2026-07-24T14:00:03Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I found the entrypoint." }],
          },
        }),
      ].join("\n"),
    });
    expect(snapshot.provider).toBe("codex");
    expect(snapshot.sessionId).toBe("thread-1");
    expect(snapshot.title).toBe("Local Codex task");
    expect(snapshot.adapterVersion).toBe("codex-jsonl-v4");
    expect(snapshot.messages.map((message) => message.role)).toEqual([
      "user",
      "tool",
      "assistant",
    ]);
    expect(snapshot.messages[1]?.segments[0]?.type).toBe("tool_status");
  });

  it("redacts large Codex tool blobs before archiving", () => {
    const snapshot = parseCodexJsonl({
      path: "/Users/me/.codex/sessions/2026/07/24/blob-thread.jsonl",
      content: [
        JSON.stringify({
          timestamp: "2026-07-24T14:00:00Z",
          type: "session_meta",
          payload: { id: "blob-thread", cwd: "/repo/app" },
        }),
        JSON.stringify({
          timestamp: "2026-07-24T14:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "check the UI" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-24T14:00:02Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: {
              ok: true,
              _meta: { screenshot: `data:image/png;base64,${"A".repeat(12_000)}` },
              text: "visible output",
            },
          },
        }),
      ].join("\n"),
    });

    const toolContent = snapshot.messages.find((message) => message.role === "tool")
      ?.segments[0]?.content;
    expect(toolContent).toContain("visible output");
    expect(toolContent).toContain("[omitted _meta]");
    expect(toolContent).not.toContain("A".repeat(200));
  });

  it("removes terminal control characters from Codex tool output", () => {
    const snapshot = parseCodexJsonl({
      path: "/Users/me/.codex/sessions/2026/07/24/control-thread.jsonl",
      content: [
        JSON.stringify({
          timestamp: "2026-07-24T14:00:00Z",
          type: "session_meta",
          payload: { id: "control-thread", cwd: "/repo/app" },
        }),
        JSON.stringify({
          timestamp: "2026-07-24T14:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "scan secrets" }],
          },
        }),
        JSON.stringify({
          timestamp: "2026-07-24T14:00:02Z",
          type: "response_item",
          payload: {
            type: "function_call_output",
            output: "Finding: ENCRYPTION_KEY=\u001b[1;3;mREDACTED\u001b[0m\u0000\u0005done",
          },
        }),
      ].join("\n"),
    });

    const toolContent = snapshot.messages.find((message) => message.role === "tool")
      ?.segments[0]?.content ?? "";
    expect(toolContent).toContain("ENCRYPTION_KEY=REDACTEDdone");
    expect(toolContent).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  });
});

describe("Claude Code JSONL parser", () => {
  it("imports known messages, tool status, unknown roles, and skips damaged lines", () => {
    const snapshot = parseClaudeCodeJsonl({
      path: "/Users/me/.claude/projects/demo/session-1.jsonl",
      content: [
        JSON.stringify({ sessionId: "claude-session-1", title: "Claude task" }),
        JSON.stringify({ id: "u1", role: "user", content: "inspect this repo" }),
        "{not valid json",
        JSON.stringify({ id: "a1", role: "assistant", content: "I found the source tree." }),
        JSON.stringify({ id: "t1", type: "tool_use", toolName: "Bash", toolInput: "ls" }),
        JSON.stringify({ id: "x1", role: "mystery", content: "unclassified event" }),
      ].join("\n"),
    });

    expect(snapshot.provider).toBe("claude_code");
    expect(snapshot.sessionId).toBe("claude-session-1");
    expect(snapshot.captureMode).toBe("import");
    expect(snapshot.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "unknown",
    ]);
    expect(snapshot.messages[2]?.segments[0]?.type).toBe("tool_status");
  });

  it("does not archive credential-looking metadata fields as message text", () => {
    const snapshot = parseClaudeCodeJsonl({
      path: "/Users/me/.claude/projects/demo/session-2.jsonl",
      content: [
        JSON.stringify({ sessionId: "claude-session-2" }),
        JSON.stringify({
          id: "u1",
          role: "user",
          content: "safe prompt",
          apiKey: "sk-should-not-be-read",
          oauthToken: "secret-token",
        }),
      ].join("\n"),
    });

    expect(JSON.stringify(snapshot.messages)).toContain("safe prompt");
    expect(JSON.stringify(snapshot.messages)).not.toContain("sk-should-not-be-read");
    expect(JSON.stringify(snapshot.messages)).not.toContain("secret-token");
  });
});

describe("local JSONL incremental parsing", () => {
  it("builds an append delta from only the newly read tail", () => {
    const baseLastMessage = {
      ordinal: 1,
      externalMessageId: "a1",
      role: "assistant" as const,
      segments: [{ type: "text" as const, content: "first answer" }],
    };
    const delta = parseLocalJsonlDelta({
      provider: "openclaw",
      path: "/Users/me/.openclaw/agents/main/sessions/session-1.jsonl",
      content: [
        JSON.stringify({ id: "u2", role: "user", content: "next question" }),
        JSON.stringify({ id: "a2", role: "assistant", content: "next answer" }),
      ].join("\n"),
      base: {
        revisionId: "11111111-1111-1111-1111-111111111111",
        sessionId: "session-1",
        branchFingerprint: "branch-fingerprint-1",
        messageCount: 2,
        lastMessageId: "a1",
        lastMessageTextHash: captureMessageFingerprint(baseLastMessage),
      },
    });

    expect(delta?.captureMode).toBe("append");
    expect(delta?.baseMessageCount).toBe(2);
    expect(delta?.appendedMessages.map((message) => message.ordinal)).toEqual([2, 3]);
    expect(delta?.appendedMessages.map((message) => message.externalMessageId)).toEqual([
      "u2",
      "a2",
    ]);
  });

  it("returns null for tails that contain no importable messages", () => {
    const delta = parseLocalJsonlDelta({
      provider: "codex",
      path: "/Users/me/.codex/sessions/session.jsonl",
      content: JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
      base: {
        sessionId: "thread-1",
        branchFingerprint: "branch-fingerprint-2",
        messageCount: 4,
        lastMessageTextHash: "a".repeat(64),
      },
    });

    expect(delta).toBeNull();
  });
});
