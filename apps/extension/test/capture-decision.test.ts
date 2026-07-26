// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { decideCaptureAction } from "../lib/capture-decision";
import type { LightweightConversationFingerprint } from "../lib/scanner";

const light: LightweightConversationFingerprint = {
  provider: "chatgpt",
  sessionId: "session-1",
  adapterVersion: "1.2.1",
  messageCount: 2,
  lastMessageId: "a1",
  lastMessageRole: "assistant",
  lastMessageTextHash: "hash-a1",
  streaming: false,
};

const state = {
  adapterVersion: "1.2.1",
  messageCount: 2,
  lastMessageId: "a1",
  lastMessageRole: "assistant" as const,
  lastMessageTextHash: "hash-a1",
  completeness: "complete" as const,
};

describe("capture decision state machine", () => {
  it("skips unchanged conversations without requesting a full scan", () => {
    expect(
      decideCaptureAction({
        light,
        state,
        requestedReason: "new_messages",
      }),
    ).toMatchObject({ action: "skip" });
  });

  it("waits while the provider is still streaming", () => {
    expect(
      decideCaptureAction({
        light: { ...light, streaming: true },
        state,
        requestedReason: "new_messages",
      }),
    ).toMatchObject({ action: "wait", triggerReason: "stream_finished" });
  });

  it("uses append after a completed new answer when a full baseline exists", () => {
    expect(
      decideCaptureAction({
        light: { ...light, messageCount: 4, lastMessageId: "a2", lastMessageTextHash: "hash-a2" },
        state,
        requestedReason: "stream_finished",
        previousStreaming: true,
      }),
    ).toMatchObject({ action: "append", triggerReason: "stream_finished" });
  });

  it("falls back to a full scan for new sessions, branch changes, and manual retry", () => {
    expect(
      decideCaptureAction({ light, state: null, requestedReason: "new_session" }),
    ).toMatchObject({ action: "full", triggerReason: "new_session" });
    expect(
      decideCaptureAction({
        light: { ...light, messageCount: 1 },
        state,
        requestedReason: "new_messages",
      }),
    ).toMatchObject({ action: "full", triggerReason: "branch_changed" });
    expect(
      decideCaptureAction({
        light,
        state,
        requestedReason: "manual_retry",
        forceFullReason: "manual_retry",
      }),
    ).toMatchObject({ action: "full", triggerReason: "manual_retry" });
  });

  it("does not use time alone as a capture trigger when the adapter version is unchanged", () => {
    expect(
      decideCaptureAction({
        light,
        state,
        requestedReason: "new_messages",
      }),
    ).not.toMatchObject({ action: "full" });
  });
});
