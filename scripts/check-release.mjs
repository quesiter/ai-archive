import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const version = JSON.parse(read("package.json")).version;
const errors = [];
for (const name of ["server", "web", "extension", "openclaw-sync"]) {
  const actual = JSON.parse(read(`apps/${name}/package.json`)).version;
  if (actual !== version) errors.push(`${name}: ${actual} != ${version}`);
}
if (JSON.parse(read("packages/contracts/package.json")).version !== version) errors.push("contracts version differs");
for (const [file, constant] of [
  ["apps/server/src/version.ts", "APP_VERSION"],
  ["apps/web/src/shared-ui.tsx", "WEB_VERSION"],
  ["apps/openclaw-sync/src/index.ts", "SYNC_AGENT_VERSION"],
]) {
  if (!read(file).includes(`${constant} = "V${version}"`)) errors.push(`${file}: stale runtime version`);
}
if (!read("README.md").includes(`当前源码版本：V${version}`)) errors.push("README: stale source version");
const newest = /^## \d{4}-\d{2}-\d{2} (V\d+\.\d+\.\d+)/m.exec(read("docs/13-版本变更记录.md"));
const releaseDates = [...read("docs/13-版本变更记录.md").matchAll(/^## (\d{4}-\d{2}-\d{2}) /gm)].map(match => match[1]);
if (new Set(releaseDates).size !== releaseDates.length) errors.push("changelog: merge same-day updates under the latest version");
if (newest?.[1] !== `V${version}`) errors.push("changelog: missing current release entry");
if (!read("docs/08-部署与发布.md").includes(`当前发布版本为 \`V${version}\``)) errors.push("deployment guide: stale release version");
if (errors.length) {
  errors.forEach((error) => console.error(`FAIL\tRelease consistency\t${error}`));
  process.exitCode = 1;
} else {
  console.log(`PASS\tRelease consistency\tV${version}; all component/runtime/document versions match`);
}
