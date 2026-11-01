import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
if (![22, 24].includes(nodeMajor)) {
  console.error(`FAIL\tRuntime\tNode.js ${process.versions.node} is unsupported; use Node.js 22 or 24 LTS.`);
  process.exit(1);
}

const checks = [
  { id: "release", label: "Release Consistency", args: ["release:check"] },
  { id: "typecheck", label: "Typecheck", args: ["typecheck"] },
  { id: "unit", label: "Unit Tests", args: ["-r", "--workspace-concurrency=1", "--if-present", "test", "--maxWorkers=4"] },
  { id: "docs", label: "Documentation", args: ["docs:check"] },
  { id: "packaging", label: "Packaging Regression Tests", args: ["test:packaging"] },
  { id: "launchers", label: "Launcher Regression Tests", args: ["test:launchers"] },
  { id: "audit", label: "Production Dependency Audit", args: ["audit", "--prod"] },
  { id: "build", label: "Production Build", args: ["build"] },
];

if (process.env.RELEASE_QUALIFICATION_E2E === "true") {
  checks.push({ id: "api-e2e", label: "API E2E", args: ["test:e2e-api"] });
}

const pnpmEntrypoint = process.env.npm_execpath;
const packageManager = pnpmEntrypoint
  ? { command: process.execPath, prefixArgs: [pnpmEntrypoint] }
  : { command: "pnpm", prefixArgs: [] };

const startedAt = new Date();
const results = [];
for (const check of checks) {
  const start = Date.now();
  const result = spawnSync(packageManager.command, [...packageManager.prefixArgs, ...check.args], {
    cwd: process.cwd(),
    encoding: "utf8",
    shell: process.platform === "win32",
    env: process.env,
  });
  const passed = result.status === 0;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  results.push({
    id: check.id,
    label: check.label,
    status: passed ? "PASS" : "FAIL",
    durationMs: Date.now() - start,
    exitCode: result.status,
    ...(check.id === "unit" ? { summary: {
      passedTests: [...output.matchAll(/\bTests\s+[^\r\n]*?(\d+) passed/g)].reduce((total, match) => total + Number(match[1]), 0),
      passedFiles: [...output.matchAll(/Test Files\s+[^\r\n]*?(\d+) passed/g)].reduce((total, match) => total + Number(match[1]), 0),
    } } : {}),
    output: output.slice(-20_000),
  });
  console.log(`${passed ? "PASS" : "FAIL"}\t${check.label}\t${results.at(-1).durationMs}ms`);
  if (!passed && process.env.RELEASE_QUALIFICATION_CONTINUE !== "true") break;
}

const report = {
  version: `V${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}`,
  startedAt: startedAt.toISOString(),
  completedAt: new Date().toISOString(),
  passed: results.length === checks.length && results.every((item) => item.status === "PASS"),
  results,
  scope: "automated-checks-only",
  productionReady: false,
  manualChecks: [
    "Fresh PostgreSQL migration 0000 → 0028",
    "V2.2 production-shaped database migration to the current release",
    "Windows 10/11 portable package smoke",
    "macOS LaunchAgent package smoke",
    "Chrome fixtures and eight live adapters",
    "SMTP delivery against deployment provider",
    "Configured LLM connection and quota behavior",
    "Backup → restore drill on a disposable environment",
    "Restore Worker restart before and after the facts commit boundary",
    "Restore staging UID 1000 permissions, retention, cleanup, and disk accounting",
    "Host Monitor on the target cgroup layout",
    "Chinese history search benchmark P50/P95/P99 and EXPLAIN",
    "PostgreSQL disaster restore drill in an isolated environment",
  ].map((name) => ({ name, status: "NOT_RUN", evidence: null })),
};

if (process.env.RELEASE_QUALIFICATION_REPORT) {
  writeFileSync(process.env.RELEASE_QUALIFICATION_REPORT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
if (!report.passed) process.exitCode = 1;
