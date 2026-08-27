import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("V2.3 long-term reliability migration", () => {
  it("adds pending TOTP, adapter telemetry, revision metadata, mail delivery and restore jobs", async () => {
    const sql = await readFile(
      new URL("../migrations/0019_v2_3_archive_reliability.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/pending_totp_secret_encrypted/i);
    expect(sql).toMatch(/last_successful_sync_at/i);
    expect(sql).toMatch(/captured_title/i);
    expect(sql).toMatch(/metadata_captured boolean NOT NULL DEFAULT false/i);
    expect(sql).toMatch(/adapter_version/i);
    expect(sql).toMatch(/email_status/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS restore_jobs/i);
    expect(sql).toMatch(/rebuilding_search/i);
  });

  it("registers every migration through 0021 in order", async () => {
    const journal = JSON.parse(await readFile(
      new URL("../migrations/meta/_journal.json", import.meta.url),
      "utf8",
    )) as { entries: Array<{ idx: number; tag: string }> };
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 21,
      tag: "0021_restore_freeze_hardening",
    });
    expect(journal.entries.map((entry) => entry.idx)).toEqual(
      Array.from({ length: 22 }, (_, index) => index),
    );
  });

  it("adds a nullable integrity hash without inventing hashes for old revisions", async () => {
    const sql = await readFile(
      new URL("../migrations/0020_revision_content_integrity.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/content_integrity_hash text/i);
    expect(sql).toMatch(/revision_identity_hash text/i);
    expect(sql).toMatch(/payload_identity_hash text/i);
    expect(sql).toMatch(/DROP INDEX IF EXISTS conversation_revision_snapshot_uidx/i);
    expect(sql).not.toMatch(/UPDATE conversation_revisions/i);
  });

  it("keeps post-commit restore failures in maintenance mode and tracks staged cleanup", async () => {
    const sql = await readFile(
      new URL("../migrations/0021_restore_freeze_hardening.sql", import.meta.url),
      "utf8",
    );
    expect(sql).toMatch(/facts_committed_at timestamptz/i);
    expect(sql).toMatch(/staged_deleted_at timestamptz/i);
    expect(sql).toMatch(/recovery_required/i);
    expect(sql).toMatch(/restore_jobs_staging_cleanup_idx/i);
  });
});
