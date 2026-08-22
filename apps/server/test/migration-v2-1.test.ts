import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../migrations/0012_v2_1_tags_and_remove_knowledge.sql", import.meta.url),
  "utf8",
);

describe("V2.1 migration", () => {
  it("creates tag storage before removing the legacy Knowledge table", () => {
    expect(sql.indexOf("CREATE TABLE IF NOT EXISTS tags")).toBeGreaterThanOrEqual(0);
    expect(sql.indexOf("CREATE TABLE IF NOT EXISTS conversation_tags")).toBeGreaterThan(
      sql.indexOf("CREATE TABLE IF NOT EXISTS tags"),
    );
    expect(sql.indexOf("DROP TABLE IF EXISTS knowledge_items")).toBeGreaterThan(
      sql.indexOf("CREATE TABLE IF NOT EXISTS conversation_tags"),
    );
  });

  it("cleans obsolete tasks without deleting conversations, revisions, projects, or reports", () => {
    expect(sql).toContain("knowledge_rebuild");
    expect(sql).not.toMatch(/DROP TABLE[^;]+\"?(conversations|conversation_revisions|projects|reports)\"?/i);
    expect(sql).not.toMatch(/DELETE FROM \"?(conversations|conversation_revisions|projects|reports)\"?/i);
  });
});
