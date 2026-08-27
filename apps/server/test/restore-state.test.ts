import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  db: {},
  sqlClient: {},
}));

import {
  ACTIVE_RESTORE_STATUSES,
  restoreFailureStatus,
} from "../src/services/restore.js";

describe("restore maintenance state", () => {
  it("treats failures before the facts transaction commits as retryable failures", () => {
    expect(restoreFailureStatus({
      status: "restoring",
      factsCommittedAt: null,
    })).toBe("failed");
  });

  it("keeps every post-commit failure in recovery-required maintenance", () => {
    expect(restoreFailureStatus({
      status: "rebuilding_search",
      factsCommittedAt: new Date("2026-08-27T00:00:00Z"),
    })).toBe("recovery_required");
    expect(restoreFailureStatus({
      status: "verifying",
      factsCommittedAt: null,
    })).toBe("recovery_required");
    expect(ACTIVE_RESTORE_STATUSES).toContain("recovery_required");
  });
});
