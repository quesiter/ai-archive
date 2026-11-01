import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MIB = 1024 * 1024;
const memory = vi.hoisted(() => ({ available: 1024 * 1024 * 1024, heapLimit: 1024 * 1024 * 1024, heapUsed: 0 }));

vi.mock("node:process", async (original) => ({
  ...await original<typeof import("node:process")>(),
  availableMemory: () => memory.available,
}));
vi.mock("node:v8", async (original) => ({
  ...await original<typeof import("node:v8")>(),
  getHeapStatistics: () => ({ heap_size_limit: memory.heapLimit, used_heap_size: memory.heapUsed }),
}));
vi.mock("../src/db.js", () => ({ db: {}, sqlClient: {} }));
vi.mock("../src/config.js", () => ({ config: { masterKey: Buffer.alloc(32) } }));

import { assertBackupReadMemory, BACKUP_FORMAT, MAX_BACKUP_COMPRESSED_BYTES, parseBackupArchive, verifyParsedBackupArchive } from "../src/services/backup.js";

function envelope(content = "test") {
  return Buffer.from(JSON.stringify({
    format: BACKUP_FORMAT,
    schemaVersion: 1,
    exportedAt: "2026-10-25T00:00:00.000Z",
    tables: { settings: [{ key: "test", value: content }] },
  }));
}

beforeEach(() => {
  memory.available = 1024 * MIB;
  memory.heapLimit = 1024 * MIB;
  memory.heapUsed = 0;
});
afterEach(() => { vi.restoreAllMocks(); });

describe("backup memory protection", () => {
  it("rejects an oversized staged file before it is read and keeps the format size cap", () => {
    memory.available = 64 * MIB;
    expect(() => assertBackupReadMemory(16 * MIB)).toThrow(/Increase the app and worker memory limits/);
    expect(() => assertBackupReadMemory(MAX_BACKUP_COMPRESSED_BYTES + 1)).toThrow(/compressed size limit/);
    expect(() => assertBackupReadMemory(1024)).not.toThrow();
  });

  it("rejects plain JSON before parsing when the container has insufficient free memory", async () => {
    const backup = envelope("x".repeat(MIB));
    memory.available = 64 * MIB;
    const parse = vi.spyOn(JSON, "parse");

    await expect(parseBackupArchive("backup.json", backup)).rejects.toThrow(/Insufficient memory/);
    expect(parse).not.toHaveBeenCalled();
  });

  it("uses V8 heap headroom as well as the container memory allowance", async () => {
    const backup = envelope("x".repeat(MIB));
    memory.heapLimit = 128 * MIB;
    memory.heapUsed = 96 * MIB;
    const parse = vi.spyOn(JSON, "parse");

    await expect(parseBackupArchive("backup.json", backup)).rejects.toThrow(/PostgreSQL disaster recovery backup/);
    expect(parse).not.toHaveBeenCalled();
  });

  it("stops highly compressed gzip expansion at the memory budget before JSON parsing", async () => {
    const compressed = gzipSync(envelope("x".repeat(MIB)));
    expect(compressed.length).toBeLessThan(4096);
    memory.available = 64 * MIB;
    const parse = vi.spyOn(JSON, "parse");

    await expect(parseBackupArchive("backup.json.gz", compressed)).rejects.toThrow(/Insufficient memory/);
    expect(parse).not.toHaveBeenCalled();
  });

  it("permits the same archive after memory is increased instead of permanently lowering the size cap", async () => {
    const compressed = gzipSync(envelope("x".repeat(MIB)));
    memory.available = 64 * MIB;
    await expect(parseBackupArchive("backup.json.gz", compressed)).rejects.toThrow(/Insufficient memory/);

    memory.available = 1024 * MIB;
    const parsed = await parseBackupArchive("backup.json.gz", compressed);
    expect(parsed.tables.settings?.[0]?.value).toHaveLength(MIB);
  });

  it("preserves corrupt-gzip errors and allows a later valid parse", async () => {
    await expect(parseBackupArchive("bad.json.gz", Buffer.from("invalid"))).rejects.toThrow();
    await expect(parseBackupArchive("backup.json", envelope())).resolves.toMatchObject({ format: BACKUP_FORMAT });
  });

  it("verifies an already parsed envelope without decoding or parsing it again", async () => {
    const parsed = await parseBackupArchive("backup.json", envelope());
    const parse = vi.spyOn(JSON, "parse");
    const verification = verifyParsedBackupArchive(parsed);

    expect(verification.counts.settings).toBe(1);
    expect(parse).not.toHaveBeenCalled();
  });
});
