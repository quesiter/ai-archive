import { createHash } from "node:crypto";
import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import type { MergeEvidence } from "../schema.js";

/** A reviewed local source becomes the active transcript. Every superseded
 * observation, including repeated copies, remains in the historical evidence. */
export function planLocalCodexRepair(input: {
  source: CaptureSnapshotV1;
  previous: readonly CaptureMessage[];
  evidence: MergeEvidence;
  files: Array<{ name: string; sha256: string; bytes: number }>;
  expectedProvider?: "codex" | "openclaw";
}) {
  const { source } = input;
  if (source.provider !== (input.expectedProvider ?? "codex") || source.captureMode !== "full" ||
      source.completeness.status !== "complete" || !source.completeness.topReached ||
      !source.completeness.bottomReached || !source.completeness.stable ||
      !source.messages.length || !source.messages.some(message => message.role === "user")) {
    throw new Error("Repair requires a complete, stable local transcript for the selected provider");
  }
  if (!input.files.length || input.files.some(file => !file.name ||
      !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0)) {
    throw new Error("Verified original file manifest is required");
  }
  if (source.messages.some((message, index) => message.ordinal !== index)) {
    throw new Error("Source ordinals must be contiguous");
  }
  const key = (message: CaptureMessage) => JSON.stringify({
    role: message.role,
    createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : null,
    model: message.model ?? null,
    segments: message.segments.map(segment => ({ type: segment.type, content: segment.content,
      href: segment.href ?? null, language: segment.language ?? null })),
  });
  const available = new Map<string, number>();
  for (const message of source.messages) available.set(key(message), (available.get(key(message)) ?? 0) + 1);
  const historical: CaptureMessage[] = [];
  for (const message of input.previous) {
    const identity = key(message);
    const count = available.get(identity) ?? 0;
    if (count) available.set(identity, count - 1);
    else historical.push(message);
  }
  const evidence: MergeEvidence = {
    variants: [...input.evidence.variants, ...historical],
    warnings: [],
    localSourceRepair: {
      version: 1, source: source.provider === "openclaw" ? "openclaw_local_jsonl" : "codex_local_jsonl", sessionId: source.sessionId,
      verifiedAt: source.capturedAt,
      sourceMessageHash: createHash("sha256").update(JSON.stringify(source.messages)).digest("hex"),
      files: input.files, previousMessageCount: input.previous.length,
      historicalObservationCount: historical.length,
      resolvedWarnings: [...(input.evidence.localSourceRepair?.resolvedWarnings ?? []), ...input.evidence.warnings],
    },
  };
  return { snapshot: source, evidence, historicalObservationCount: historical.length };
}
