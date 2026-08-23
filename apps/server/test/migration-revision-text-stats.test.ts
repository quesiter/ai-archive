import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../migrations/0014_revision_text_stats.sql", import.meta.url),
  "utf8",
);

describe("revision text stats migration", () => {
  it("backfills process-aware counters without deleting archive data", () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS "archived_text_units" bigint');
    expect(sql).toContain("segment.type = 'reasoning'");
    expect(sql).toContain("message.role = 'tool'");
    expect(sql).not.toMatch(/DROP TABLE|DELETE FROM|TRUNCATE/i);
  });
});
