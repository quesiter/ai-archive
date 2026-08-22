import { promisify } from "node:util";
import { gzip } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../src/db.js";
import {
  BACKUP_FORMAT,
  parseBackupArchive,
  sanitizeRestoredBackupTables,
} from "../src/services/backup.js";

const gzipAsync = promisify(gzip);

function backupEnvelope() {
  return {
    format: BACKUP_FORMAT,
    schemaVersion: 1,
    exportedAt: "2026-07-26T00:00:00.000Z",
    metadata: {
      appVersion: "test",
      masterKeyFingerprint: "0123456789abcdef",
    },
    tables: {
      settings: [
        {
          key: "classification.runMode",
          value: "economy",
          encrypted: false,
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
      ],
    },
  };
}

afterAll(async () => {
  await closeDatabase();
});

describe("backup archive parsing", () => {
  it("accepts gzip-compressed backup JSON", async () => {
    const envelope = backupEnvelope();
    const parsed = await parseBackupArchive(
      "backup.json.gz",
      await gzipAsync(Buffer.from(JSON.stringify(envelope))),
    );

    expect(parsed.format).toBe(BACKUP_FORMAT);
    expect(parsed.tables.settings).toHaveLength(1);
  });

  it("accepts plain JSON backup files with a UTF-8 BOM", async () => {
    const envelope = backupEnvelope();
    const parsed = await parseBackupArchive(
      "backup.json",
      Buffer.from(`\uFEFF${JSON.stringify(envelope)}`),
    );

    expect(parsed.metadata.masterKeyFingerprint).toBe("0123456789abcdef");
  });

  it("rejects archives with an unknown format", async () => {
    const invalid = {
      ...backupEnvelope(),
      format: "not-ai-conversation-archive",
    };

    await expect(
      parseBackupArchive("backup.json", Buffer.from(JSON.stringify(invalid))),
    ).rejects.toThrow();
  });

  it("rejects unknown backup tables", async () => {
    const invalid = {
      ...backupEnvelope(),
      tables: { ...backupEnvelope().tables, users: [] },
    };
    await expect(
      parseBackupArchive("backup.json", Buffer.from(JSON.stringify(invalid))),
    ).rejects.toThrow(/Unknown backup table/);
  });

  it("redacts archived message secrets before backup rows are restored", () => {
    const sanitized = sanitizeRestoredBackupTables({
      redactionRules: [],
      messageSegments: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          content: "password=DemoOnly_123",
          href: "https://example.com/path?api_key=DemoOnlyKey",
        },
      ],
      conversationRevisions: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          searchText: "Authorization: Bearer DemoOnlyTokenValue",
        },
      ],
    });

    expect(sanitized.messageSegments?.[0]?.content).not.toContain("DemoOnly_123");
    expect(sanitized.messageSegments?.[0]?.href).not.toContain("DemoOnlyKey");
    expect(sanitized.conversationRevisions?.[0]?.searchText).not.toContain(
      "DemoOnlyTokenValue",
    );
  });
});
