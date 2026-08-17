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
  it("contains all planned providers", () => {
    expect(providers).toEqual([
      "chatgpt",
      "gemini",
      "grok",
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
});
