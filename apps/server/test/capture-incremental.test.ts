import type { CaptureDeltaV1, CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ db: {} }));

const baseMessages: CaptureMessage[] = [
  {
    ordinal: 0,
    externalMessageId: "u1",
    role: "user",
    segments: [{ type: "text", content: "Question" }],
  },
  {
    ordinal: 1,
    externalMessageId: "a1",
    role: "assistant",
    segments: [{ type: "text", content: "Answer" }],
  },
];

const baseRevision = {
  id: "11111111-1111-1111-1111-111111111111",
  completeness: "complete",
  branchFingerprint: "branch-fingerprint-1",
  messageCount: 2,
};

function delta(overrides: Partial<CaptureDeltaV1> = {}): CaptureDeltaV1 {
  return {
    schemaVersion: 1,
    captureMode: "append",
    provider: "chatgpt",
    sessionId: "session-1",
    branchFingerprint: "branch-fingerprint-1",
    adapterVersion: "1.2.1",
    capturedAt: "2026-07-25T04:00:00.000Z",
    triggerReason: "new_messages",
    baseRevisionId: baseRevision.id,
    baseMessageCount: 2,
    baseLastMessageId: "a1",
    appendedMessages: [
      {
        ordinal: 2,
        externalMessageId: "u2",
        role: "user",
        segments: [{ type: "text", content: "Follow up" }],
      },
      {
        ordinal: 3,
        externalMessageId: "a2",
        role: "assistant",
        segments: [{ type: "text", content: "Second answer" }],
      },
    ],
    ...overrides,
  };
}

describe("incremental capture validation", () => {
  it("keeps identical complete snapshots idempotent even when capture metadata changes", async () => {
    const { snapshotHash } = await import("../src/services/capture.js");
    const snapshot: CaptureSnapshotV1 = {
      schemaVersion: 1,
      provider: "chatgpt",
      sessionId: "session-1",
      branchFingerprint: "branch-fingerprint-1",
      title: "Old title",
      adapterVersion: "1.2.1",
      capturedAt: "2026-07-25T04:00:00.000Z",
      captureMode: "full",
      completeness: {
        status: "complete",
        topReached: true,
        bottomReached: true,
        stable: true,
      },
      messages: baseMessages,
    };

    expect(
      snapshotHash({
        ...snapshot,
        title: "New title",
        capturedAt: "2026-07-25T05:00:00.000Z",
      }),
    ).toBe(snapshotHash(snapshot));
  });

  it("accepts a valid append delta and materializes a full revision body", async () => {
    const { mergedSnapshotFromDelta, snapshotHash, validateDeltaBase } = await import(
      "../src/services/capture.js"
    );
    const input = {
      delta: delta(),
      baseRevision: baseRevision as never,
      baseMessages,
    };

    expect(() => validateDeltaBase(input)).not.toThrow();
    const merged = mergedSnapshotFromDelta(input);

    expect(merged.captureMode).toBe("append");
    expect(merged.baseRevisionId).toBe(baseRevision.id);
    expect(merged.messages.map((message) => message.ordinal)).toEqual([0, 1, 2, 3]);
    expect(snapshotHash(merged)).toBe(snapshotHash({ ...merged }));
  });

  it("bounds revision search text without dropping the archived messages", async () => {
    const {
      buildRevisionSearchText,
      databaseSafeSegmentContent,
      REVISION_SEARCH_TEXT_LIMIT,
      REVISION_SEARCH_TEXT_MESSAGE_LIMIT,
    } = await import("../src/services/capture.js");
    const largeMessages: CaptureMessage[] = [
      {
        ordinal: 0,
        role: "user",
        segments: [{ type: "text", content: "needle prompt" }],
      },
      {
        ordinal: 1,
        role: "tool",
        segments: [{ type: "text", content: "tool-output ".repeat(30_000) }],
      },
      ...Array.from({ length: 80 }, (_, index) => ({
        ordinal: index + 2,
        role: "assistant" as const,
        segments: [
          {
            type: "text" as const,
            content: `assistant-${index} ${"long-answer ".repeat(500)}`,
          },
        ],
      })),
    ];

    const searchText = buildRevisionSearchText(largeMessages);

    expect(REVISION_SEARCH_TEXT_LIMIT).toBeLessThanOrEqual(2_048);
    expect(searchText.length).toBeLessThanOrEqual(REVISION_SEARCH_TEXT_LIMIT);
    expect(searchText).toContain("needle prompt");
    expect(searchText).toContain("search index bounded");
    expect(searchText).toContain("tool messages not indexed");
    expect(searchText).not.toContain("tool-output");

    const safeToolText = databaseSafeSegmentContent({
      type: "tool_status",
      content: "Finding: ENCRYPTION_KEY=\u001b[1;3;mREDACTED\u001b[0m\u0000\u0005done",
    });
    expect(safeToolText).toBe("Finding: ENCRYPTION_KEY=REDACTEDdone");
    expect(safeToolText).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
  });

  it("keeps Codex import search text small enough for trigram indexing", async () => {
    const { buildRevisionSearchText, REVISION_SEARCH_TEXT_LIMIT } = await import(
      "../src/services/capture.js"
    );
    const longToolOutput = JSON.stringify({
      command: "Get-ChildItem -Recurse",
      output: "line ".repeat(80_000),
    });
    const codexMessages: CaptureMessage[] = [
      {
        ordinal: 0,
        role: "user",
        segments: [
          {
            type: "text",
            content:
              "<environment_context><cwd>F:\\AI_IDE\\CamOps</cwd><shell>powershell</shell></environment_context>\n在本地创建测试环境，并填充300条mock数据",
          },
        ],
      },
      ...Array.from({ length: 268 }, (_, index) => ({
        ordinal: index + 1,
        role: index % 3 === 0 ? ("tool" as const) : ("assistant" as const),
        segments: [
          {
            type: index % 3 === 0 ? ("tool_status" as const) : ("text" as const),
            content:
              index % 3 === 0
                ? longToolOutput
                : `assistant ${index} ${"mock data ".repeat(2_000)}`,
          },
        ],
      })),
    ];

    const searchText = buildRevisionSearchText(codexMessages);

    expect(searchText.length).toBeLessThanOrEqual(REVISION_SEARCH_TEXT_LIMIT);
    expect(searchText).toContain("CamOps");
    expect(searchText).toContain("search index bounded");
    expect(searchText).toContain("tool messages not indexed");
    expect(searchText).not.toContain("Get-ChildItem");
    expect(searchText).not.toContain("line ");
  });

  it("rejects wrong base count, wrong base last ID, duplicate IDs, and non-contiguous ordinals", async () => {
    const { validateDeltaBase } = await import("../src/services/capture.js");
    const input = (candidate: CaptureDeltaV1) => ({
      delta: candidate,
      baseRevision: baseRevision as never,
      baseMessages,
    });

    expect(() => validateDeltaBase(input(delta({ baseMessageCount: 3 })))).toThrow(
      /message count/,
    );
    expect(() => validateDeltaBase(input(delta({ baseLastMessageId: "other" })))).toThrow(
      /last message ID/,
    );
    expect(() =>
      validateDeltaBase(
        input(
          delta({
            appendedMessages: [
              {
                ordinal: 2,
                externalMessageId: "a1",
                role: "assistant",
                segments: [{ type: "text", content: "duplicate" }],
              },
            ],
          }),
        ),
      ),
    ).toThrow(/duplicate/);
    expect(() =>
      validateDeltaBase(
        input(
          delta({
            appendedMessages: [
              {
                ordinal: 4,
                externalMessageId: "a3",
                role: "assistant",
                segments: [{ type: "text", content: "gap" }],
              },
            ],
          }),
        ),
      ),
    ).toThrow(/contiguous/);
  });

  it("rejects partial base revisions and branch mismatches", async () => {
    const { validateDeltaBase } = await import("../src/services/capture.js");

    expect(() =>
      validateDeltaBase({
        delta: delta(),
        baseRevision: { ...baseRevision, completeness: "partial" } as never,
        baseMessages,
      }),
    ).toThrow(/Partial/);
    expect(() =>
      validateDeltaBase({
        delta: delta({ branchFingerprint: "different-branch" }),
        baseRevision: baseRevision as never,
        baseMessages,
      }),
    ).toThrow(/branch/);
  });
});
