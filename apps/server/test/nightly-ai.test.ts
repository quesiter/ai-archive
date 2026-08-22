import { describe, expect, it } from "vitest";
import {
  NIGHTLY_AI_MAINTENANCE_HOUR,
  NIGHTLY_AI_STATUS_POLL_MS,
  nightlyAiRunKey,
} from "../src/services/nightly-ai.js";

describe("nightly AI maintenance schedule", () => {
  it("runs at 22:00 and derives the date in the configured timezone", () => {
    expect(NIGHTLY_AI_MAINTENANCE_HOUR).toBe(22);
    expect(NIGHTLY_AI_STATUS_POLL_MS).toBe(10 * 60_000);
    expect(
      nightlyAiRunKey(new Date("2026-08-21T16:30:00.000Z"), "Asia/Shanghai"),
    ).toBe("2026-08-22");
  });
});
