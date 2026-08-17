// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  AUTO_CAPTURE_IDLE_MS,
  remainingIdleDelay,
  shouldDeferAutoCapture,
} from "../lib/auto-capture";

describe("auto capture activity gating", () => {
  it("waits for the page to go idle before auto capturing", () => {
    const now = 1_000_000;
    expect(
      shouldDeferAutoCapture({
        reason: "new_messages",
        lastUserActivityAt: now - 2_000,
        now,
      }),
    ).toBe(true);
    expect(remainingIdleDelay(now - 2_000, now)).toBe(AUTO_CAPTURE_IDLE_MS - 2_000);
  });

  it("does not defer manual retry or idle captures", () => {
    const now = 1_000_000;
    expect(
      shouldDeferAutoCapture({
        reason: "manual_retry",
        forceFull: true,
        lastUserActivityAt: now - 2_000,
        now,
      }),
    ).toBe(false);
    expect(
      shouldDeferAutoCapture({
        reason: "new_messages",
        lastUserActivityAt: now - AUTO_CAPTURE_IDLE_MS,
        now,
      }),
    ).toBe(false);
  });
});
