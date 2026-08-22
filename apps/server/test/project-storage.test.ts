import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { measureImportStorage } from "../src/services/project-storage.js";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("project storage", () => {
  it("counts only actual files below the configured import directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-archive-storage-"));
    temporaryPaths.push(root);
    const inbox = join(root, "inbox");
    const processed = join(root, "processed");
    await mkdir(join(inbox, "nested"), { recursive: true });
    await mkdir(processed, { recursive: true });
    await writeFile(join(inbox, "one.txt"), "12345");
    await writeFile(join(inbox, "nested", "two.txt"), "1234567");
    await writeFile(join(processed, "three.txt"), "123");

    await expect(measureImportStorage([inbox, processed, join(root, "missing")])).resolves.toEqual({
      bytes: 15,
      files: 3,
      incomplete: false,
    });
  });
});
