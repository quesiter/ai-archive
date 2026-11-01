import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";

export function isCanonicalReleaseVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.[0-9]\.[0-9]$/.test(version)) return false;
  return Number.isSafeInteger(Number(version.split(".")[0]));
}

export function nextReleaseVersion(version) {
  if (!isCanonicalReleaseVersion(version)) throw new Error("Version must be major.minor.patch with minor and patch in 0–9");
  let [major, minor, patch] = version.split(".").map(Number);
  if (++patch === 10) {patch = 0; minor++;}
  if (minor === 10) {minor = 0; major++;}
  if (!Number.isSafeInteger(major)) throw new Error("Major version exceeds the safe integer limit");
  return `${major}.${minor}.${patch}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const current = process.argv[2] ?? JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
  console.log(nextReleaseVersion(current));
}
