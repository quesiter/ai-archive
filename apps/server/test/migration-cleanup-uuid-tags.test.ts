import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  new URL("../migrations/0015_cleanup_uuid_tags.sql", import.meta.url),
  "utf8",
);

describe("UUID tag cleanup migration", () => {
  it("moves UUID tag links to semantic targets before deleting malformed tags", () => {
    expect(sql).toContain("WITH RECURSIVE tag_paths");
    expect(sql).toContain("INSERT INTO conversation_tags");
    expect(sql).toContain("ON CONFLICT (conversation_id, tag_id) DO UPDATE");
    expect(sql.indexOf("DELETE FROM tags")).toBeGreaterThan(
      sql.indexOf("INSERT INTO conversation_tags"),
    );
  });

  it("never deletes archived conversations or their content", () => {
    expect(sql).not.toMatch(/DELETE FROM\s+(conversations|conversation_revisions|messages|message_segments)/i);
    expect(sql).not.toMatch(/DROP TABLE|TRUNCATE/i);
  });
});
