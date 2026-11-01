import { copyFile, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(resolve(root, "apps", "extension", "package.json"), "utf8"));
const version = `V${manifest.version}`;
const filename = `ai-archiveextension-${version}-chrome.zip`;
const source = resolve(root, "apps", "extension", ".output", filename);
const destination = resolve(root, "release", filename);

const sourceStat = await stat(source);
if (!sourceStat.isFile() || sourceStat.size === 0) {
  throw new Error(`Chrome package is missing or empty: ${source}`);
}
await mkdir(resolve(root, "release"), { recursive: true });
const temporary = `${destination}.${process.pid}.tmp`;
try {
  await copyFile(source, temporary);
  await rename(temporary, destination);
} finally {
  await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
}
console.log(`Created ${destination} (${sourceStat.size} bytes)`);
