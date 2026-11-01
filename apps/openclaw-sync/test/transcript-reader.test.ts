import { lstat, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { readTranscript } from "../src/transcript-reader.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "ai-archive-transcript-read-test-"));
  directories.push(directory);
  const path = join(directory, "session.jsonl.gz");
  const content = '{"role":"user","content":"测试压缩会话"}\n';
  await writeFile(path, gzipSync(content));
  return { directory, path, content };
}

describe("compressed transcript reads", () => {
  it("rejects a source removed after discovery without an uncaught stream error or a stalled read", async () => {
    const test = await fixture();
    expect((await lstat(test.path)).isFile()).toBe(true);
    await unlink(test.path);
    await expect(readTranscript(test.path, 1024)).rejects.toMatchObject({ code: "ENOENT" });
    await writeFile(test.path, gzipSync(test.content));
    expect(await readTranscript(test.path, 1024)).toBe(test.content);
  });

  it("closes corrupt compressed sources and can read the next transcript", async () => {
    const test = await fixture();
    const compressed = await readFile(test.path);
    await writeFile(test.path, compressed.subarray(0, compressed.length - 8));
    await expect(readTranscript(test.path, 1024)).rejects.toMatchObject({ code: "Z_BUF_ERROR" });
    await unlink(test.path);
    await writeFile(test.path, gzipSync(test.content));
    expect(await readTranscript(test.path, 1024)).toBe(test.content);
  });

  it("enforces the expanded-byte limit and releases the source after rejection", async () => {
    const test = await fixture();
    await writeFile(test.path, gzipSync("x".repeat(2 * 1024 * 1024)));
    await expect(readTranscript(test.path, 1024)).rejects.toThrow("Decompressed transcript exceeds");
    await unlink(test.path);
    await writeFile(test.path, gzipSync(test.content));
    expect(await readTranscript(test.path, 1024)).toBe(test.content);
  });
});
