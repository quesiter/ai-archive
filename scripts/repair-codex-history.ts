import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { scanCodexHistoryLineage, uploadCodexHistoryLineage } from "../apps/openclaw-sync/src/codex-history-lineage.js";

async function main() {
  const args = process.argv.slice(2);
  const configPath = process.env.AI_ARCHIVE_SYNC_CONFIG || join(homedir(), ".config", "ai-archive", "openclaw-sync.json");
  let config: Record<string, unknown>;
  try {
    config = JSON.parse((await readFile(configPath, "utf8")).replace(/^\uFEFF/, "")) as Record<string, unknown>;
  } catch {
    throw new Error("Existing pairing configuration cannot be read or parsed.");
  }
  if (!config || typeof config !== "object") throw new Error("Existing pairing configuration is invalid.");
  if (typeof config.serverUrl !== "string" || typeof config.deviceToken !== "string" || config.deviceToken.length < 20) {
    throw new Error("Existing pairing configuration is invalid. Pair this computer in the archive device page first.");
  }
  const url = new URL(config.serverUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("The archive server must use HTTPS.");
  }
  if (!Array.isArray(config.codexRoots) || !config.codexRoots.length || config.codexRoots.some((root) => typeof root !== "string" || !root.trim())) {
    throw new Error("No Codex history directories are configured for this computer.");
  }
  const scan = await scanCodexHistoryLineage(config.codexRoots as string[]).catch(() => {
    throw new Error("A Codex history header could not be read. Check directory access and the original history files.");
  });
  if (!scan.files) throw new Error("No Codex history files were found. Run this file with the Windows account that owns the history.");
  if (scan.conflicts.length) throw new Error(`Conflicting parent metadata for ${scan.conflicts.length} sessions; no repair submitted.`);
  console.log(`Scanned ${scan.files} history files; found ${scan.relations.length} subagent relationships.`);
  if (args.includes("--dry-run")) {
    console.log("Dry run complete. No network requests, state changes, or archive updates.");
    return;
  }
  const result = await uploadCodexHistoryLineage({ serverUrl: config.serverUrl, deviceToken: config.deviceToken, relations: scan.relations });
  if (result.rejected) throw new Error(`The server rejected ${result.rejected} relationships. Review the archive before retrying.`);
  console.log(`Repair complete: updated ${result.updated}, already correct ${result.unchanged}, not archived ${result.notFound}.`);
  const reportIndex = args.indexOf("--report");
  if (reportIndex >= 0 && args[reportIndex + 1]) {
    await writeFile(args[reportIndex + 1]!, JSON.stringify({ files: scan.files, relationships: scan.relations.length, ...result }, null, 2), "utf8");
  }
}

main().catch((error: unknown) => {
  // Do not echo configuration contents, authorization headers, or request bodies.
  console.error(error instanceof Error ? error.message : "Codex history repair failed.");
  process.exitCode = 1;
});
