import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("V2.2 reliability migrations", () => {
  it("adds normalized projects and retry metadata", async () => {
    const correctness = await readFile(new URL("../migrations/0016_correctness_foundations.sql", import.meta.url), "utf8");
    const imports = await readFile(new URL("../migrations/0017_import_reliability.sql", import.meta.url), "utf8");
    expect(correctness).toMatch(/normalize\(name, NFKC\)/);
    expect(correctness).toMatch(/projects_normalized_name_uidx/);
    expect(imports).toMatch(/attempt integer NOT NULL DEFAULT 0/i);
    expect(imports).toMatch(/last_retry_at timestamptz/i);
  });

  it("adds full-history chunks, a GIN index, saved views, and recycle-bin lookup", async () => {
    const sql = await readFile(new URL("../migrations/0018_search_and_saved_views.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/conversation_search_chunks/);
    expect(sql).toMatch(/USING gin\(search_vector\)/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS saved_searches/i);
    expect(sql).toMatch(/conversations_deleted_at_idx/);
  });
});
