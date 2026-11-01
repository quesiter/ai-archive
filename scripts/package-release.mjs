import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const version = `V${JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version}`;
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error("Run this command through pnpm package:release");
mkdirSync(resolve(root, "release"), { recursive: true });
const reportName = `release-qualification-${version}.json`;
const env = { ...process.env, RELEASE_QUALIFICATION_REPORT: resolve(root, "release", reportName) };
for (const script of ["release:qualify", "package:chrome", "package:windows-sync", "package:macos-sync", "package:nas"]) {
  const result = spawnSync(process.execPath, [pnpm, script], { cwd: root, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const names = [
  `ai-archiveextension-${version}-chrome.zip`,
  `ai-conversation-archive-windows-sync-${version}.zip`,
  `ai-conversation-archive-macos-sync-${version}.tar.gz`,
  `ai-conversation-archive-nas-${version}-clean-install.tar.gz`,
  reportName,
];
const checksums = names.map((name) => {
  const data = readFileSync(resolve(root, "release", name));
  if (!data.length) throw new Error(`Empty release artifact: ${name}`);
  return `${createHash("sha256").update(data).digest("hex")}  ${name}`;
}).join("\n") + "\n";
const checksumPath = resolve(root, "release", `SHA256SUMS-${version}.txt`);
const temporary = `${checksumPath}.${process.pid}.tmp`;
writeFileSync(temporary, checksums, "utf8");
renameSync(temporary, checksumPath);
console.log(`Created ${version}: four verified packages, qualification report and SHA-256 checksums.`);
