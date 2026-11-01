import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { gunzipSync } from "node:zlib";
import { closeDatabase } from "./db.js";
import { repairVerifiedLocalCodexArchive } from "./services/capture.js";

async function main() {
  const args = process.argv.slice(2);
  const directory = args[0];
  if (!directory) throw new Error("Usage: repair-local-codex <verified-source-directory> [--apply] [--session ID]");
  const apply = args.includes("--apply");
  const sessionIndex = args.indexOf("--session");
  const selected = sessionIndex < 0 ? undefined : args[sessionIndex + 1];
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Array<{ sessionId: string; file: string; sha256: string }>;
  let processed = 0;
  for (const entry of manifest) {
    if (selected && entry.sessionId !== selected) continue;
    if (basename(entry.file) !== entry.file || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("Invalid source manifest");
    const bytes = await readFile(join(directory, entry.file));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Source payload checksum mismatch");
    const input = JSON.parse(gunzipSync(bytes).toString("utf8"));
    if (input.payload.sessionId !== entry.sessionId) throw new Error("Source session mismatch");
    const result = await repairVerifiedLocalCodexArchive({ ...input, apply });
    console.log(JSON.stringify(result));
    processed++;
  }
  if (!processed) throw new Error("No matching source sessions");
  console.log(JSON.stringify({ processed, applied: apply }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Local source repair failed"); process.exitCode = 1; })
  .finally(() => closeDatabase());
