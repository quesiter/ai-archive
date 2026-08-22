import { describe, expect, it, vi } from "vitest";
import {
  createCoalescedRunner,
  lfSeparatedLines,
  observedCaptureTime,
} from "../src/sync-runtime.js";

describe("local sync runtime", () => {
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
});
