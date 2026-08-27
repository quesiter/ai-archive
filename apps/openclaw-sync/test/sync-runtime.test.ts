import { describe, expect, it, vi } from "vitest";
import {
  captureIdempotencyKey,
  createCoalescedRunner,
  lfSeparatedLines,
  observedCaptureTime,
  retryDelayMs,
  retryableUploadStatus,
} from "../src/sync-runtime.js";

describe("local sync runtime", () => {
  it("derives idempotency from the exact capture payload", () => {
    const base = {
      provider: "codex",
      adapterVersion: "codex-jsonl-v4",
      captureMode: "import",
      payload: { sessionId: "session-1", capturedAt: "2026-08-28T00:00:00.000Z" },
    };
    expect(captureIdempotencyKey(base)).toBe(captureIdempotencyKey(base));
    expect(captureIdempotencyKey(base)).not.toBe(captureIdempotencyKey({
      ...base,
      payload: { ...base.payload, capturedAt: "2026-08-28T00:01:00.000Z" },
    }));
  });

  it("splits JSONL only on LF and preserves standalone CR whitespace", async () => {
    const chunks = [
      '{"type":"response_item",\r"payload":1}\r',
      '\n{"type":"session_meta"',
      ',"payload":2}\n',
    ];
    const lines: string[] = [];
    for await (const line of lfSeparatedLines(
      (async function* () {
        yield* chunks;
      })(),
    )) {
      lines.push(line);
    }

    expect(lines).toHaveLength(2);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { type: "response_item", payload: 1 },
      { type: "session_meta", payload: 2 },
    ]);
  });

  it("uses observation time for an updated Codex file with a stale mtime", () => {
    const fileModifiedAt = new Date("2026-08-22T00:58:49.735Z");
    const now = new Date("2026-08-22T01:00:59.000Z");
    expect(
      observedCaptureTime({
        provider: "codex",
        fileModifiedAt,
        hasPreviousSync: true,
        now,
      }),
    ).toEqual(now);
    expect(
      observedCaptureTime({
        provider: "codex",
        fileModifiedAt,
        hasPreviousSync: false,
        now,
      }),
    ).toEqual(fileModifiedAt);
  });

  it("coalesces a change received while a scan is running into one follow-up scan", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstScan = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const task = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => firstScan)
      .mockResolvedValue(undefined);
    const run = createCoalescedRunner(task);

    const initial = run();
    await Promise.resolve();
    await run();
    await run();
    releaseFirst?.();
    await initial;

    expect(task).toHaveBeenCalledTimes(2);
  });

  it("backs off network and server failures but does not retry invalid requests", () => {
    expect([retryDelayMs(1), retryDelayMs(2), retryDelayMs(3)])
      .toEqual([5_000, 10_000, 20_000]);
    expect(retryDelayMs(20)).toBe(15 * 60_000);
    expect(retryDelayMs(1, "120")).toBe(120_000);
    expect(retryableUploadStatus(429)).toBe(true);
    expect(retryableUploadStatus(503)).toBe(true);
    expect(retryableUploadStatus(400)).toBe(false);
    expect(retryableUploadStatus(401)).toBe(false);
  });
});
