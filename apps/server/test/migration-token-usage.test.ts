import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../migrations/0013_reported_token_usage.sql", import.meta.url),
  "utf8",
);

describe("reported token usage migration", () => {
  it("adds non-destructive bigint usage counters", () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "reported_total_tokens" bigint');
    expect(sql).toContain("reported_token_usage_nonnegative");
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/i);
  });
});
