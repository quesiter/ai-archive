import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CaptureSnapshotV1 } from "@ai-archive/contracts";
import { conversationRevisions, devices, messages } from "../src/schema.js";
import { ingestCapture, repairVerifiedLocalCodexArchive, contentIntegrityHash } from "../src/services/capture.js";
import { captureStore } from "./capture-store-fixture.js";
const mocks = vi.hoisted(() => ({ transaction: vi.fn(), loadBatch: vi.fn(), loadMessages: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: { transaction: mocks.transaction } }));
vi.mock("../src/services/conversation-lineage.js", () => ({ persistConversationParent: vi.fn() }));
vi.mock("../src/services/revision-storage.js", () => ({ loadCaptureRevisionMessages: mocks.loadMessages, loadCaptureRevisionMessagesBatch: mocks.loadBatch }));
vi.mock("../src/services/redaction.js", async original => ({ ...await original<typeof import("../src/services/redaction.js")>(), loadEnabledCustomRedactionRules: vi.fn(async () => []) }));
const deviceId = "00000000-0000-4000-8000-000000000123";
const payload: CaptureSnapshotV1 = { schemaVersion: 1, provider: "codex", sessionId: "test-local-source",
  branchFingerprint: "local-test-source", adapterVersion: "codex-jsonl-v6", capturedAt: "2026-10-07T02:00:00Z", captureMode: "full",
  completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
  messages: [{ ordinal: 0, role: "user", createdAt: "2026-10-07T01:00:00Z", segments: [{ type: "text", content: "Edited request" }] },
    { ordinal: 1, role: "assistant", createdAt: "2026-10-07T01:00:01Z", segments: [{ type: "text", content: "Answer" }] }] };
const files = [{ name: "rollout.jsonl", sha256: "a".repeat(64), bytes: 999 }];
function setup(provider: "codex" | "openclaw" = "codex") {
  const store = captureStore(mocks);
  store.rows(devices).push({ id: deviceId, name: "QML-PC", revokedAt: null });
  const old: CaptureSnapshotV1 = { ...payload, provider, completeness: { ...payload.completeness, status: "partial" },
    messages: [{ ...payload.messages[0]!, segments: [{ type: "text" as const, content: "Original request" }] }, ...payload.messages] .map((message, ordinal) => ({ ...message, ordinal })) };
  const revision = store.seedSnapshot(old, { isAccumulated: true, sourceDeviceId: deviceId,
    mergeEvidence: { variants: [], warnings: [{ type: "order", messageIds: [] }] } });
  return { store, revision };
}
describe("local source repair transaction", () => {
  beforeEach(() => vi.clearAllMocks());
  it("repairs OpenClaw and preserves source evidence on a subsequent capture", async () => {
    const { store, revision } = setup("openclaw");
    const source = { ...payload, provider: "openclaw" as const, adapterVersion: "openclaw-jsonl-v3" };
    await expect(repairVerifiedLocalCodexArchive({ payload: source, deviceId, files, expectedSnapshotHash: revision.snapshotHash, apply: true })).rejects.toThrow("provider does not match");
    const result = await repairVerifiedLocalCodexArchive({ payload: source, deviceId, files, expectedProvider: "openclaw", expectedSnapshotHash: revision.snapshotHash, apply: true });
    expect(result).toMatchObject({ archiveCompleteness: "complete" });
    const receipt = await ingestCapture(source, deviceId, "repeat-openclaw");
    expect(receipt.archiveCompleteness).toBe("complete");
    expect(store.rows(conversationRevisions)[0].mergeEvidence.localSourceRepair.source).toBe("openclaw_local_jsonl");
  });
  it("requires the explicitly selected company source and refuses another device", async () => {
    const { store, revision } = setup();
    store.rows(devices)[0].name = "公司codex";
    const input = { payload, deviceId, files, expectedSnapshotHash: revision.snapshotHash, apply: false };
    await expect(repairVerifiedLocalCodexArchive(input)).rejects.toThrow("selected paired source");
    await expect(repairVerifiedLocalCodexArchive({ ...input, expectedDeviceName: "公司codex" })).resolves.toMatchObject({ applied: false });
    const otherId = "00000000-0000-4000-8000-000000000456";
    store.rows(devices).push({ id: otherId, name: "Another PC", revokedAt: null });
    store.rows(conversationRevisions)[0].sourceDeviceId = otherId;
    await expect(repairVerifiedLocalCodexArchive({ ...input, expectedDeviceName: "公司codex" })).rejects.toThrow("not owned");
  });
  it("dry run and stale-archive rejection leave stored observations unchanged", async () => {
    const { store, revision } = setup(); const before = JSON.stringify(store.rows(messages));
    await repairVerifiedLocalCodexArchive({ payload, deviceId, files, expectedSnapshotHash: revision.snapshotHash, apply: false });
    expect(JSON.stringify(store.rows(messages))).toBe(before);
    expect(revision.completeness).toBe("partial");
    await expect(repairVerifiedLocalCodexArchive({ payload, deviceId, files, expectedSnapshotHash: "stale", apply: true })).rejects.toThrow("changed since");
    expect(JSON.stringify(store.rows(messages))).toBe(before);
  });
  it("rebuilds hashes and preserves historical edits across subsequent full and fragment captures", async () => {
    const { store, revision } = setup();
    const result = await repairVerifiedLocalCodexArchive({ payload, deviceId, files, expectedSnapshotHash: revision.snapshotHash, apply: true });
    expect(result).toMatchObject({ applied: true, archiveCompleteness: "complete", archiveMessageCount: 2, historicalObservations: 1 });
    let row = store.rows(conversationRevisions)[0];
    expect(row.contentIntegrityHash).toBe(contentIntegrityHash(payload, row.mergeEvidence));
    expect(row.mergeEvidence.variants[0].segments[0].content).toBe("Original request");
    const full = await ingestCapture(payload, deviceId, "repeat-full");
    expect(full.archiveCompleteness).toBe("complete");
    const fragment = await ingestCapture({ ...payload, captureMode: "import", messages: [payload.messages[0]] }, deviceId, "fragment");
    expect(fragment.archiveCompleteness).toBe("complete");
    row = store.rows(conversationRevisions)[0];
    expect(row.mergeEvidence.localSourceRepair.files).toEqual(files);
    expect(row.mergeEvidence.variants[0].segments[0].content).toBe("Original request");
  });
});
