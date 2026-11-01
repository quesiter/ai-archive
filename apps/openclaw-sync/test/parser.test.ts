import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_ADAPTER_VERSION,
  EmptyOpenClawTranscriptError,
  IncompleteClaudeCodeDeltaError,
  MissingCodexUserMessagesError,
  captureMessageFingerprint,
  codexParentSessionId,
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

  it("captures structured thinking and provider-reported usage", () => {
    const snapshot = parseOpenClawJsonl({
      path: "/Users/me/.openclaw/agents/main/sessions/session-usage.jsonl",
      content: [
        JSON.stringify({ type: "session", id: "session-usage" }),
        JSON.stringify({
          type: "message",
          message: { role: "user", content: [{ type: "text", text: "question" }] },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private plan" },
              { type: "text", text: "answer" },
              { type: "toolCall", name: "search", input: { q: "docs" } },
            ],
            usage: {
              input: 120,
              output: 30,
              cacheRead: 80,
              cacheWrite: 10,
              total: 240,
            },
          },
        }),
      ].join("\n"),
    });

    expect(snapshot.adapterVersion).toBe("openclaw-jsonl-v3");
    expect(snapshot.messages[1]?.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", content: "answer" }),
        expect.objectContaining({ type: "reasoning", content: "private plan" }),
        expect.objectContaining({ type: "tool_status" }),
      ]),
    );
    expect(snapshot.tokenUsage).toEqual({
      scope: "cumulative",
      inputTokens: 120,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 10,
      outputTokens: 30,
      reasoningOutputTokens: 0,
      totalTokens: 240,
    });
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
  it.each(["compaction", "assistant-only"])("reports %s without user text as skippable", (kind) => {
    const content = [
      { type: "session_meta", payload: { id: "without-user" } },
      kind === "compaction"
        ? { type: "response_item", payload: { type: "compaction", content: "Summary" } }
        : { type: "response_item", payload: { type: "message", role: "assistant", content: "Done" } },
    ].map((record) => JSON.stringify(record)).join("\n");
    expect(() => parseCodexJsonl({ path: "/tmp/no-user.jsonl", content }))
      .toThrowError(MissingCodexUserMessagesError);
    expect(() => parseCodexJsonl({ path: "/tmp/no-user.jsonl", content }))
      .toThrowError(expect.objectContaining({ sessionId: "without-user" }));
  });

  it("keeps a spawned agent as a child of its explicit parent", () => {
    const snapshot = parseCodexJsonl({
      path: "/repo/child.jsonl",
      content: [
        JSON.stringify({
          type: "session_meta",
          payload: {
            id: "child-thread",
            cwd: "/repo/homeassistant",
            source: { subagent: { thread_spawn: { parent_thread_id: "main-thread" } } },
          },
        }),
        JSON.stringify({
          type: "response_item",
          payload: { type: "message", role: "user", content: "Inspect the thermostat" },
        }),
      ].join("\n"),
    });
    expect(snapshot.sessionId).toBe("child-thread");
    expect(snapshot.parentSessionId).toBe("main-thread");
    expect(snapshot.messages).toHaveLength(1);
  });

  it.each([
    { source: { subagent: { parent_thread_id: "main-thread" } } },
    { source: { subagent: "review" }, parent_thread_id: "main-thread" },
  ])("accepts an explicit parent only for a subagent source: %j", (meta) => {
    expect(codexParentSessionId({ id: "child-thread", ...meta })).toBe("main-thread");
  });

  it.each([
    { source: "cli", parent_thread_id: "main-thread" },
    { source: "vscode", forked_from_id: "main-thread" },
    { source: "appServer", forked_from_id: "main-thread" },
    { forked_from_id: "main-thread" },
    { source: { subagent: null }, parent_thread_id: "main-thread" },
    { source: { subagent: { thread_spawn: { parent_thread_id: "child-thread" } } } },
    { source: { subagent: { parent_thread_id: " " } } },
    { source: { subagent: { parent_thread_id: "p".repeat(1_025) } } },
  ])("does not infer a child relationship from a fork or invalid metadata: %j", (meta) => {
    expect(codexParentSessionId({ id: "child-thread", ...meta })).toBeUndefined();
  });

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
          payload: {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Inspect the source tree" }],
            encrypted_content: "not-archived",
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
        JSON.stringify({
          timestamp: "2026-07-24T14:00:04Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 10_000,
                cached_input_tokens: 8_000,
                cache_write_input_tokens: 0,
                output_tokens: 500,
                reasoning_output_tokens: 120,
                total_tokens: 10_500,
              },
            },
          },
        }),
      ].join("\n"),
    });
    expect(snapshot.provider).toBe("codex");
    expect(snapshot.sessionId).toBe("thread-1");
    expect(snapshot.title).toBe("Local Codex task");
    expect(snapshot.adapterVersion).toBe("codex-jsonl-v6");
    expect(snapshot.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(snapshot.messages[1]?.segments[0]).toEqual({
      type: "reasoning",
      content: "Inspect the source tree",
    });
    expect(JSON.stringify(snapshot.messages)).not.toContain("not-archived");
    expect(snapshot.messages[2]?.segments[0]?.type).toBe("tool_status");
    expect(snapshot.tokenUsage).toEqual({
      scope: "cumulative",
      inputTokens: 10_000,
      cachedInputTokens: 8_000,
      cacheWriteInputTokens: 0,
      outputTokens: 500,
      reasoningOutputTokens: 120,
      totalTokens: 10_500,
    });
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
    expect(snapshot.adapterVersion).toBe(CLAUDE_CODE_ADAPTER_VERSION);
    expect(snapshot.completeness).toMatchObject({
      status: "partial",
      stable: false,
      reason: "Transcript contains 1 malformed JSONL record at line 3",
    });
  });

  it("reports every damaged middle record without losing later messages or source line numbers", () => {
    const snapshot = parseClaudeCodeJsonl({
      path: "/sessions/claude.jsonl",
      content: [
        JSON.stringify({ sessionId: "claude-session" }),
        JSON.stringify({ uuid: "u1", type: "user", message: { role: "user", content: "question" } }),
        "",
        '{"sensitiveText":"damaged secret value',
        JSON.stringify({ type: "progress", elapsed: 2 }),
        "{damaged again",
        JSON.stringify({ uuid: "a1", type: "assistant", message: { role: "assistant", content: "answer" } }),
      ].join("\r\n"),
    });

    expect(snapshot.messages.map((message) => message.segments[0]?.content)).toEqual(["question", "answer"]);
    expect(snapshot.messages.map((message) => message.ordinal)).toEqual([0, 1]);
    expect(snapshot.completeness).toEqual({
      status: "partial",
      topReached: true,
      bottomReached: true,
      stable: false,
      reason: "Transcript contains 2 malformed JSONL records at lines 4, 6",
    });
    expect(snapshot.completeness.reason).not.toContain("secret value");
  });

  it("keeps valid mixed event logs complete, including a final record without a newline", () => {
    const snapshot = parseClaudeCodeJsonl({
      path: "/sessions/claude.jsonl",
      content: [
        JSON.stringify({ sessionId: "claude-session" }),
        JSON.stringify({ type: "file-history-snapshot", snapshot: { files: [] } }),
        JSON.stringify({ type: "user", message: { role: "user", content: "question" } }),
        JSON.stringify({ type: "progress", elapsed: 2 }),
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: "answer" } }),
      ].join("\n"),
    });

    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.completeness).toEqual({ status: "complete", topReached: true, bottomReached: true, stable: true });
  });

  it.each([false, true])("preserves trailing partial record evidence with middle corruption=%s", (middleCorruption) => {
    const snapshot = parseClaudeCodeJsonl({
      path: "/sessions/claude.jsonl",
      content: [
        JSON.stringify({ sessionId: "claude-session", role: "user", content: "question" }),
        ...(middleCorruption ? ["{damaged middle"] : []),
        JSON.stringify({ role: "assistant", content: "answer" }),
        '{"role":"assistant","content":',
        "",
        "  ",
      ].join("\n"),
    });

    expect(snapshot.messages).toHaveLength(2);
    expect(snapshot.completeness.status).toBe("partial");
    expect(snapshot.completeness.stable).toBe(false);
    expect(snapshot.completeness.reason).toBe(middleCorruption
      ? "Transcript contains 1 malformed JSONL record at line 2; Transcript ended with a partial JSONL record"
      : "Transcript ended with a partial JSONL record");
  });

  it("bounds malformed-line diagnostics for heavily damaged transcripts", () => {
    const snapshot = parseClaudeCodeJsonl({
      path: "/sessions/claude.jsonl",
      content: [
        JSON.stringify({ sessionId: "claude-session", role: "user", content: "question" }),
        ...Array.from({ length: 2_000 }, () => "{damaged"),
        JSON.stringify({ role: "assistant", content: "answer" }),
      ].join("\n"),
    });

    expect(snapshot.completeness.status).toBe("partial");
    expect(snapshot.completeness.reason).toContain("2000 malformed JSONL records at lines 2, 3");
    expect(snapshot.completeness.reason).toContain("and 1990 more");
    expect(snapshot.completeness.reason!.length).toBeLessThanOrEqual(1_000);
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
  const claudeDeltaInput = {
    provider: "claude_code" as const,
    path: "/sessions/claude.jsonl",
    base: {
      sessionId: "claude-session",
      baselineContentHash: "b".repeat(64),
      branchFingerprint: "claude-branch-fingerprint",
      messageCount: 2,
      lastMessageId: "a1",
    },
  };

  it.each([
    { damagedLines: ["{damaged"], lineNumbers: [2] },
    { damagedLines: ["{damaged", "{damaged again"], lineNumbers: [2, 3] },
  ])("requires a full Claude import after damaged middle records: $lineNumbers", ({ damagedLines, lineNumbers }) => {
    const parse = () => parseLocalJsonlDelta({
      ...claudeDeltaInput,
      content: [
        JSON.stringify({ id: "u2", role: "user", content: "next question" }),
        ...damagedLines,
        JSON.stringify({ id: "a2", role: "assistant", content: "next answer" }),
      ].join("\n"),
    });

    expect(parse).toThrowError(IncompleteClaudeCodeDeltaError);
    expect(parse).toThrowError(expect.objectContaining({ malformedLineNumbers: lineNumbers }));
  });

  it("does not hide damaged Claude records in a tail without messages", () => {
    expect(() => parseLocalJsonlDelta({
      ...claudeDeltaInput,
      content: ["{damaged", JSON.stringify({ type: "progress", elapsed: 2 })].join("\n"),
    })).toThrowError(IncompleteClaudeCodeDeltaError);
  });

  it("preserves a valid Claude delta with interleaved event records and a complete final line", () => {
    const delta = parseLocalJsonlDelta({
      ...claudeDeltaInput,
      content: [
        JSON.stringify({ type: "file-history-snapshot", snapshot: { files: [] } }),
        JSON.stringify({ id: "u2", role: "user", content: "next question" }),
        JSON.stringify({ type: "progress", elapsed: 2 }),
        JSON.stringify({ id: "a2", role: "assistant", content: "next answer" }),
      ].join("\n"),
    });

    expect(delta?.adapterVersion).toBe(CLAUDE_CODE_ADAPTER_VERSION);
    expect(delta?.baseContentHash).toBe(claudeDeltaInput.base.baselineContentHash);
    expect(delta?.appendedMessages.map((message) => [message.ordinal, message.externalMessageId])).toEqual([[2, "u2"], [3, "a2"]]);
  });

  it("waits for a trailing incomplete Claude record rather than uploading a shortened delta", () => {
    expect(parseLocalJsonlDelta({
      ...claudeDeltaInput,
      content: [
        JSON.stringify({ id: "u2", role: "user", content: "next question" }),
        '{"id":"a2","role":"assistant","content":',
        "  ",
      ].join("\n"),
    })).toBeNull();
  });

  it("sends a requested parent relationship without replaying transcript messages", () => {
    const input = {
      provider: "codex" as const,
      path: "/repo/child.jsonl",
      content: "",
      base: {
        sessionId: "child-thread",
        baselineContentHash: "b".repeat(64),
        parentSessionId: "main-thread",
        branchFingerprint: "branch-fingerprint-child",
        messageCount: 40,
        lastMessageTextHash: "a".repeat(64),
      },
    };
    expect(parseLocalJsonlDelta(input)).toBeNull();
    expect(parseLocalJsonlDelta({ ...input, includeSessionMetadata: true })).toMatchObject({
      captureMode: "append",
      sessionId: "child-thread",
      parentSessionId: "main-thread",
      baseMessageCount: 40,
      appendedMessages: [],
    });
    const appended = parseLocalJsonlDelta({
      ...input,
      content: JSON.stringify({
        type: "response_item",
        payload: { type: "message", role: "assistant", content: "Inspection complete" },
      }),
    });
    expect(appended?.parentSessionId).toBe("main-thread");
    expect(appended?.appendedMessages).toHaveLength(1);
  });

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
        baselineContentHash: "b".repeat(64),
        sessionId: "session-1",
        branchFingerprint: "branch-fingerprint-1",
        messageCount: 2,
        lastMessageId: "a1",
        lastMessageTextHash: captureMessageFingerprint(baseLastMessage),
      },
    });

    expect(delta?.captureMode).toBe("append");
    expect(delta?.baseMessageCount).toBe(2);
    expect(delta?.baseContentHash).toBe("b".repeat(64));
    expect(delta?.appendedMessages.map((message) => message.ordinal)).toEqual([2, 3]);
    expect(delta?.appendedMessages.map((message) => message.externalMessageId)).toEqual([
      "u2",
      "a2",
    ]);
  });

  it("does not build a delta from a legacy baseline without a server content hash", () => {
    expect(parseLocalJsonlDelta({
      provider: "openclaw", path: "/sessions/session.jsonl",
      content: JSON.stringify({ id: "a2", role: "assistant", content: "New answer" }),
      base: { sessionId: "session-1", branchFingerprint: "branch-fingerprint-1", messageCount: 2, lastMessageId: "a1" },
    })).toBeNull();
  });

  it("returns null for tails that contain no importable messages", () => {
    const delta = parseLocalJsonlDelta({
      provider: "codex",
      path: "/Users/me/.codex/sessions/session.jsonl",
      content: JSON.stringify({ type: "session_meta", payload: { id: "thread-1" } }),
      base: {
        sessionId: "thread-1",
        baselineContentHash: "b".repeat(64),
        branchFingerprint: "branch-fingerprint-2",
        messageCount: 4,
        lastMessageTextHash: "a".repeat(64),
      },
    });

    expect(delta).toBeNull();
  });

  it("keeps a usage-only Codex tail as a metadata delta", () => {
    const delta = parseLocalJsonlDelta({
      provider: "codex",
      path: "/Users/me/.codex/sessions/session.jsonl",
      content: JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            total_token_usage: {
              input_tokens: 900,
              cached_input_tokens: 700,
              output_tokens: 100,
              reasoning_output_tokens: 40,
              total_tokens: 1_000,
            },
          },
        },
      }),
      base: {
        sessionId: "thread-1",
        baselineContentHash: "b".repeat(64),
        branchFingerprint: "branch-fingerprint-2",
        messageCount: 4,
        lastMessageTextHash: "a".repeat(64),
      },
    });

    expect(delta?.appendedMessages).toEqual([]);
    expect(delta?.tokenUsage).toMatchObject({
      scope: "cumulative",
      totalTokens: 1_000,
      reasoningOutputTokens: 40,
    });
  });
});
