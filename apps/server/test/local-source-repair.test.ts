import { describe, expect, it } from "vitest";
import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import { planLocalCodexRepair } from "../src/services/local-source-repair.js";
const message = (text: string, ordinal = 0): CaptureMessage => ({ ordinal, role: "user",
  createdAt: "2026-10-07T01:00:00Z", segments: [{ type: "text", content: text }] });
const source = (messages: CaptureMessage[]): CaptureSnapshotV1 => ({ schemaVersion: 1, provider: "codex",
  sessionId: "local", branchFingerprint: "local", adapterVersion: "codex-jsonl-v6", capturedAt: "2026-10-07T02:00:00Z",
  captureMode: "full", completeness: { status: "complete", topReached: true, bottomReached: true, stable: true }, messages });
const files = [{ name: "rollout.jsonl", sha256: "a".repeat(64), bytes: 100 }];
describe("verified local Codex repair", () => {
  it("requires explicit OpenClaw selection and records its original source type", () => {
    const current = message("request");
    const input = { source: { ...source([current]), provider: "openclaw" as const }, previous: [message("old")], evidence: { variants: [], warnings: [] }, files };
    expect(() => planLocalCodexRepair(input)).toThrow("selected provider");
    const plan = planLocalCodexRepair({ ...input, expectedProvider: "openclaw" });
    expect(plan.evidence.localSourceRepair?.source).toBe("openclaw_local_jsonl");
    expect(plan.evidence.variants).toHaveLength(1);
  });
  it("preserves edited messages, extra copies and existing variants while adopting the full source", () => {
    const active = message("current"); const edit = message("earlier edit", 1); const copy = message("current", 2);
    const variant = message("older tool observation", 3);
    const plan = planLocalCodexRepair({ source: source([active]), previous: [active, edit, copy],
      evidence: { variants: [variant], warnings: [{ type: "order", messageIds: [] }] }, files });
    expect(plan.snapshot.messages).toEqual([active]);
    expect(plan.evidence.variants).toEqual([variant, edit, copy]);
    expect(plan.evidence.warnings).toEqual([]);
    expect(plan.evidence.localSourceRepair?.resolvedWarnings).toEqual([{ type: "order", messageIds: [] }]);
    expect(plan.evidence.localSourceRepair?.files).toEqual(files);
  });
  it("retains legitimate identical prompts as distinct occurrences", () => {
    const a = message("continue"); const b = message("continue", 1);
    const plan = planLocalCodexRepair({ source: source([a, b]), previous: [a, b], evidence: { variants: [], warnings: [] }, files });
    expect(plan.snapshot.messages).toHaveLength(2);
    expect(plan.historicalObservationCount).toBe(0);
  });
  it("preserves observations with a distinct timestamp or model", () => {
    const current = message("same body"); const historic = { ...current, createdAt: "2026-10-06T01:00:00Z" };
    const plan = planLocalCodexRepair({ source: source([current]), previous: [historic], evidence: { variants: [], warnings: [] }, files });
    expect(plan.evidence.variants).toEqual([historic]);
  });
  it("refuses partial sources, noncontiguous ordinals and missing original-file proofs", () => {
    const base = { source: source([message("hello")]), previous: [], evidence: { variants: [], warnings: [] }, files };
    expect(() => planLocalCodexRepair({ ...base, source: { ...base.source, completeness: { ...base.source.completeness, stable: false } } })).toThrow();
    expect(() => planLocalCodexRepair({ ...base, source: source([message("hello", 4)]) })).toThrow();
    expect(() => planLocalCodexRepair({ ...base, files: [] })).toThrow();
  });
});
