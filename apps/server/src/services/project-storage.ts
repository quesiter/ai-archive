import { lstat, readdir } from "node:fs/promises";
import { resolve } from "node:path";

export type DirectoryUsage = {
  bytes: number;
  files: number;
  incomplete: boolean;
};

async function walkDirectory(path: string): Promise<DirectoryUsage> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { bytes: 0, files: 0, incomplete: false };
    return { bytes: 0, files: 0, incomplete: true };
  }

  const values = await Promise.all(entries.map(async (entry): Promise<DirectoryUsage> => {
    const entryPath = resolve(path, entry.name);
    if (entry.isDirectory()) return walkDirectory(entryPath);
    if (!entry.isFile()) return { bytes: 0, files: 0, incomplete: false };
    try {
      const stat = await lstat(entryPath);
      return { bytes: stat.size, files: 1, incomplete: false };
    } catch {
      return { bytes: 0, files: 0, incomplete: true };
    }
  }));

  return values.reduce<DirectoryUsage>((total, value) => ({
    bytes: total.bytes + value.bytes,
    files: total.files + value.files,
    incomplete: total.incomplete || value.incomplete,
  }), { bytes: 0, files: 0, incomplete: false });
}

export async function measureImportStorage(paths: string[]): Promise<DirectoryUsage> {
  const uniquePaths = [...new Set(paths.map((path) => resolve(path)))];
  const roots = uniquePaths.filter((path) => !uniquePaths.some((candidate) => (
    candidate !== path && path.startsWith(`${candidate}\\`) ||
    candidate !== path && path.startsWith(`${candidate}/`)
  )));
  const values = await Promise.all(roots.map(walkDirectory));
  return values.reduce<DirectoryUsage>((total, value) => ({
    bytes: total.bytes + value.bytes,
    files: total.files + value.files,
    incomplete: total.incomplete || value.incomplete,
  }), { bytes: 0, files: 0, incomplete: false });
}
