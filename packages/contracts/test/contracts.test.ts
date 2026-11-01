import { describe, expect, it } from "vitest";
import {
  CaptureDeltaV1Schema,
  CaptureSnapshotV1Schema,
  providers,
  stripInternalConversationMetadata,
} from "../src/index.js";

describe("stripInternalConversationMetadata", () => {
  it("removes runtime envelopes but keeps the user prompt", () => {
    expect(
      stripInternalConversationMetadata(
        "<recommended_plugins>hidden</recommended_plugins>\n" +
          "<environment_context><cwd>/repo</cwd></environment_context>\n" +
          "保留这句话",
      ),
    ).toBe("保留这句话");
  });
});

describe("CaptureSnapshotV1", () => {
  it("preserves PostgreSQL UUID format compatibility for legacy revision identifiers", () => {
    const delta = {
      schemaVersion: 1, captureMode: "append", provider: "codex", sessionId: "child",
      parentSessionId: "parent", branchFingerprint: "12345678", adapterVersion: "test",
      capturedAt: "2026-10-25T00:00:00.000Z", baseMessageCount: 2,
      baseLastMessageId: "last", appendedMessages: [],
      baseRevisionId: "11111111-1111-1111-1111-111111111111",
    };
    expect(CaptureDeltaV1Schema.parse(delta).baseRevisionId).toBe(delta.baseRevisionId);
    for (const baseRevisionId of ["not-a-uuid", "11111111-1111-1111-1111", "11111111-1111-1111-1111-11111111111g"]) {
      expect(CaptureDeltaV1Schema.safeParse({ ...delta, baseRevisionId }).success).toBe(false);
    }
  });

  it("requires stable native branch identity independently of a completeness claim", () => {
    const snapshot = { schemaVersion: 1, provider: "chatgpt", sessionId: "session", captureMode: "full",
      sourceKind: "chatgpt_current_branch", canonicalUrl: "https://chatgpt.com/c/session",
      branchFingerprint: "12345678", adapterVersion: "1.2.13", capturedAt: "2026-10-07T00:00:00.000Z",
      completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
      messages: [{ externalMessageId: "source-id", ordinal: 0, role: "user", segments: [{ type: "text", content: "hello" }] }] };
    expect(CaptureSnapshotV1Schema.parse(snapshot).sourceKind).toBe("chatgpt_current_branch");
    for (const change of [{ provider: "gemini" }, { captureMode: "import" },
      { completeness: { ...snapshot.completeness, status: "partial", topReached: false } },
      { messages: [{ ...snapshot.messages[0], externalMessageId: "fallback-turn-0:0:user" }] },
      { messages: [{ ...snapshot.messages[0], externalMessageId: undefined }] },
      { messages: [...snapshot.messages, { ...snapshot.messages[0], ordinal: 1 }] }]) {
      expect(CaptureSnapshotV1Schema.safeParse({ ...snapshot, ...change }).success).toBe(false);
    }
  });
  it("accepts an optional content baseline hash for mutable conversation appends", () => {
    const delta = {
      schemaVersion: 1, captureMode: "append", provider: "codex", sessionId: "session",
      parentSessionId: "parent", branchFingerprint: "12345678", adapterVersion: "2.4.0",
      capturedAt: "2026-09-14T00:00:00.000Z", baseMessageCount: 2,
      baseLastMessageId: "last", appendedMessages: [], baseContentHash: "a".repeat(64),
    };
    expect(CaptureDeltaV1Schema.parse(delta).baseContentHash).toBe(delta.baseContentHash);
    expect(CaptureDeltaV1Schema.safeParse({ ...delta, baseContentHash: undefined }).success).toBe(true);
    expect(CaptureDeltaV1Schema.safeParse({ ...delta, baseContentHash: "not-a-hash" }).success).toBe(false);
  });
  it("accepts parent-only deltas for existing subagents but rejects self-parenting and empty updates", () => {
    const delta = {
      schemaVersion: 1, captureMode: "append", provider: "codex",
      sessionId: "child-session", parentSessionId: "root-session",
      branchFingerprint: "12345678", adapterVersion: "codex-jsonl-v6",
      capturedAt: "2026-09-13T12:00:00.000Z", baseMessageCount: 2,
      baseLastMessageTextHash: "a".repeat(64), appendedMessages: [],
    };
    expect(CaptureDeltaV1Schema.parse(delta).parentSessionId).toBe("root-session");
    expect(CaptureDeltaV1Schema.safeParse({ ...delta, parentSessionId: "child-session" }).success).toBe(false);
    expect(CaptureDeltaV1Schema.safeParse({ ...delta, parentSessionId: undefined }).success).toBe(false);
    const snapshot = {
      ...delta, captureMode: "import",
      completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
      messages: [{ ordinal: 0, role: "user", segments: [{ type: "text", content: "Task" }] }],
    };
    expect(CaptureSnapshotV1Schema.parse(snapshot).parentSessionId).toBe("root-session");
    expect(CaptureSnapshotV1Schema.safeParse({ ...snapshot, parentSessionId: "child-session" }).success).toBe(false);
  });

  it("contains all planned providers", () => {
    expect(providers).toEqual([
      "chatgpt",
      "gemini",
      "grok",
      "grok_build",
      "yuanbao",
      "doubao",
      "minimax_agent",
      "deepseek",
      "qianwen",
      "kimi",
      "openclaw",
      "codex",
      "claude_code",
    ]);
  });

  it("rejects a capture that claims completeness without evidence", () => {
    const result = CaptureSnapshotV1Schema.safeParse({
      schemaVersion: 1,
      provider: "chatgpt",
      sessionId: "session-1",
      branchFingerprint: "12345678",
      adapterVersion: "1.0.0",
      capturedAt: new Date().toISOString(),
      completeness: {
        status: "complete",
        topReached: true,
        bottomReached: false,
        stable: true,
      },
      messages: [
        {
          ordinal: 0,
          role: "user",
          segments: [{ type: "text", content: "hello" }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("accepts only HTTP(S) links in captured metadata", () => {
    const result = CaptureSnapshotV1Schema.safeParse({
      schemaVersion: 1,
      provider: "chatgpt",
      sessionId: "session-url",
      branchFingerprint: "12345678",
      canonicalUrl: "javascript:alert(1)",
      adapterVersion: "1.0.0",
      capturedAt: new Date().toISOString(),
      completeness: {
        status: "partial",
        topReached: true,
        bottomReached: false,
        stable: false,
      },
      messages: [
        {
          ordinal: 0,
          role: "user",
          segments: [
            {
              type: "citation",
              content: "unsafe",
              href: "javascript:alert(1)",
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("requires append deltas to declare a verifiable base", () => {
    const result = CaptureDeltaV1Schema.safeParse({
      schemaVersion: 1,
      captureMode: "append",
      provider: "chatgpt",
      sessionId: "session-1",
      branchFingerprint: "12345678",
      adapterVersion: "1.0.0",
      capturedAt: new Date().toISOString(),
      baseMessageCount: 2,
      appendedMessages: [
        {
          ordinal: 2,
          role: "assistant",
          segments: [{ type: "text", content: "new answer" }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("accepts usage-only append metadata and rejects incremental snapshot usage", () => {
    const usage = {
      scope: "cumulative" as const,
      inputTokens: 900,
      cachedInputTokens: 700,
      cacheWriteInputTokens: 0,
      outputTokens: 100,
      reasoningOutputTokens: 40,
      totalTokens: 1_000,
    };
    const delta = CaptureDeltaV1Schema.safeParse({
      schemaVersion: 1,
      captureMode: "append",
      provider: "codex",
      sessionId: "session-usage",
      branchFingerprint: "12345678",
      adapterVersion: "codex-jsonl-v5",
      capturedAt: new Date().toISOString(),
      baseMessageCount: 2,
      baseLastMessageTextHash: "a".repeat(64),
      tokenUsage: usage,
      appendedMessages: [],
    });
    expect(delta.success).toBe(true);

    const snapshot = CaptureSnapshotV1Schema.safeParse({
      schemaVersion: 1,
      provider: "codex",
      sessionId: "session-usage",
      branchFingerprint: "12345678",
      adapterVersion: "codex-jsonl-v5",
      capturedAt: new Date().toISOString(),
      tokenUsage: { ...usage, scope: "incremental" },
      completeness: {
        status: "complete",
        topReached: true,
        bottomReached: true,
        stable: true,
      },
      messages: [
        {
          ordinal: 0,
          role: "user",
          segments: [{ type: "text", content: "hello" }],
        },
      ],
    });
    expect(snapshot.success).toBe(false);
  });
});
