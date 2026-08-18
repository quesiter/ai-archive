import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ db: {} }));

function revision(input: {
  id: string;
  baseRevisionId?: string;
  storageKind: "snapshot" | "delta";
  messageCount: number;
}): {
  id: string;
  conversationId: string;
  baseRevisionId: string | null;
  storageKind: "snapshot" | "delta";
  messageCount: number;
} {
  return {
    id: input.id,
    conversationId: "conversation-1",
    baseRevisionId: input.baseRevisionId ?? null,
    storageKind: input.storageKind,
    messageCount: input.messageCount,
  };
}

function message(revisionId: string, ordinal: number, content: string): {
  id: string;
  revisionId: string;
  externalMessageId: null;
  ordinal: number;
  role: "user" | "assistant";
  model: null;
  sourceCreatedAt: null;
  createdAt: Date;
  segments: Array<{
    id: string;
    messageId: string;
    ordinal: number;
    type: "text";
    content: string;
    href: null;
    language: null;
    createdAt: Date;
  }>;
} {
  return {
    id: `${revisionId}-${ordinal}`,
    revisionId,
    externalMessageId: null,
    ordinal,
    role: ordinal % 2 ? "assistant" : "user",
    model: null,
    sourceCreatedAt: null,
    createdAt: new Date(0),
    segments: [
      {
        id: `${revisionId}-${ordinal}-segment`,
        messageId: `${revisionId}-${ordinal}`,
        ordinal: 0,
        type: "text",
        content,
        href: null,
        language: null,
        createdAt: new Date(0),
      },
    ],
  };
}

describe("revision storage reconstruction", () => {
  it("reconstructs a full logical revision from a snapshot and delta chain", async () => {
    const { composeRevisionMessages, resolveRevisionStorageChain } = await import(
      "../src/services/revision-storage.js"
    );
    const root = revision({ id: "root", storageKind: "snapshot", messageCount: 2 });
    const middle = revision({
      id: "middle",
      baseRevisionId: "root",
      storageKind: "delta",
      messageCount: 3,
    });
    const leaf = revision({
      id: "leaf",
      baseRevisionId: "middle",
      storageKind: "delta",
      messageCount: 4,
    });
    const revisions = new Map([
      [root.id, root],
      [middle.id, middle],
      [leaf.id, leaf],
    ]);
    const chain = resolveRevisionStorageChain(leaf as never, revisions as never);
    const composed = composeRevisionMessages(
      chain as never,
      new Map([
        [root.id, [message(root.id, 0, "question"), message(root.id, 1, "answer")]],
        [middle.id, [message(middle.id, 2, "follow-up")]],
        [leaf.id, [message(leaf.id, 3, "final answer")]],
      ]) as never,
    );

    expect(chain.map((item) => item.id)).toEqual(["root", "middle", "leaf"]);
    expect(composed.map((item) => item.ordinal)).toEqual([0, 1, 2, 3]);
    expect(composed[3]?.segments[0]?.content).toBe("final answer");
  });

  it("rejects missing bases, cycles, and incomplete chains", async () => {
    const { composeRevisionMessages, resolveRevisionStorageChain } = await import(
      "../src/services/revision-storage.js"
    );
    const missing = revision({
      id: "missing",
      baseRevisionId: "unknown",
      storageKind: "delta",
      messageCount: 2,
    });
    expect(() => resolveRevisionStorageChain(missing as never, new Map([[missing.id, missing]]) as never)).toThrow(
      /missing base/,
    );

    const left = revision({
      id: "left",
      baseRevisionId: "right",
      storageKind: "delta",
      messageCount: 2,
    });
    const right = revision({
      id: "right",
      baseRevisionId: "left",
      storageKind: "delta",
      messageCount: 2,
    });
    expect(() =>
      resolveRevisionStorageChain(left as never, new Map([[left.id, left], [right.id, right]]) as never),
    ).toThrow(/cycle/);

    const snapshot = revision({ id: "snapshot", storageKind: "snapshot", messageCount: 2 });
    expect(() =>
      composeRevisionMessages([snapshot] as never, new Map([[snapshot.id, [message(snapshot.id, 0, "only")]]]) as never),
    ).toThrow(/cannot be reconstructed/);
  });
});
