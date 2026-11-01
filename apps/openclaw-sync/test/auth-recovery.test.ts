import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cliPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

type AuthEndpoint = "capture" | "heartbeat" | "lineage";

async function fixture(input: {
  revoked?: AuthEndpoint;
  claim?: Record<string, unknown>;
  claimStatus?: number;
  empty?: boolean;
  scanSeconds?: number;
  malformedUnauthorizedBody?: boolean;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ai-archive-auth-test-"));
  directories.push(directory);
  const root = join(directory, "custom-codex");
  await mkdir(join(root, "sessions"), { recursive: true });
  if (input.revoked !== "heartbeat" && !input.empty) {
    for (const id of ["first", "second"]) {
      await writeFile(join(root, "sessions", `${id}.jsonl`), [
        { type: "session_meta", payload: {
          id,
          source: input.revoked === "lineage"
            ? { subagent: { thread_spawn: { parent_thread_id: "main-thread" } } }
            : "appServer",
        } },
        { type: "response_item", payload: {
          type: "message", role: "user", content: `Archive ${id}`,
        } },
      ].map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
  }
  const requests: string[] = [];
  let revoked = input.revoked;
  let firstHeartbeatReceived: (() => void) | undefined;
  const firstHeartbeat = new Promise<void>((resolve) => { firstHeartbeatReceived = resolve; });
  const server = createServer(async (request, response) => {
    requests.push(request.url ?? "");
    for await (const _chunk of request) { /* Drain request bodies before replying. */ }
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v1/devices/claim") {
      response.statusCode = input.claimStatus ?? 200;
      response.end(JSON.stringify(input.claim ?? {
        deviceId: "33333333-3333-4333-8333-333333333333",
        token: "replacement-device-token-for-local-server",
      }));
      return;
    }
    const endpoint = request.url === "/api/v1/captures" ? "capture"
      : request.url === "/api/v1/devices/heartbeat" ? "heartbeat"
      : request.url === "/api/v1/captures/codex-lineage" ? "lineage" : undefined;
    if (endpoint === revoked && endpoint !== undefined) {
      response.statusCode = 401;
      if (input.malformedUnauthorizedBody) {
        response.setHeader("Content-Encoding", "gzip");
        response.end("broken-gzip-body");
        return;
      }
      response.end(JSON.stringify({ error: "Valid device token required" }));
      return;
    }
    response.end(JSON.stringify(endpoint === "lineage"
      ? { updated: 0, unchanged: 0, notFound: 2, rejected: 0 }
      : endpoint === "capture"
        ? { revisionId: "11111111-1111-4111-8111-111111111111", messageCount: 1 }
        : { version: "test", ok: true }));
    if (endpoint === "heartbeat") firstHeartbeatReceived?.();
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const serverUrl = `http://127.0.0.1:${address.port}`;
  const configPath = join(directory, "openclaw-sync.json");
  const config = {
    serverUrl,
    deviceId: "22222222-2222-4222-8222-222222222222",
    deviceToken: "previous-device-token-for-local-server",
    openClawRoot: join(directory, "custom-openclaw"),
    codexRoots: [root, join(directory, "second-codex")],
    claudeCodeRoots: [join(directory, "custom-claude"), join(directory, "second-claude")],
    scanSeconds: input.scanSeconds ?? 17,
    customSetting: { enabled: true, label: "Preserve this unknown field" },
  };
  const configBytes = JSON.stringify(config, null, 4) + "\n";
  await writeFile(configPath, configBytes);
  const statePath = join(directory, "openclaw-sync-state.json");
  const stateBytes = JSON.stringify({
    files: {},
    ...(input.revoked === "lineage" ? {} : { codexHistoryLineageVersion: 1 }),
    customState: "preserve the exact bytes\nincluding whitespace",
  }, null, 4) + "\n\n";
  await writeFile(statePath, stateBytes);
  const run = async (...args: string[]) => {
    try {
      const result = await execFileAsync(process.execPath, ["--import", loader, cliPath, ...args], {
        cwd: directory,
        env: { ...process.env, AI_ARCHIVE_SYNC_CONFIG: configPath, PATH: directory },
        timeout: 20_000,
      });
      return { ...result, code: 0 };
    } catch (error) {
      const result = error as Error & { stdout: string; stderr: string; code: number | string; killed?: boolean };
      if (result.killed || typeof result.code !== "number") throw error;
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    }
  };
  return {
    config, configBytes, stateBytes, requests, serverUrl, run, firstHeartbeat,
    setRevoked: (endpoint: AuthEndpoint) => { revoked = endpoint; },
    readConfig: () => readFile(configPath, "utf8"),
    readState: () => readFile(statePath, "utf8"),
  };
}

describe("local sync authorization recovery", () => {
  it("stops on 401 headers even when the error response body cannot be decoded", async () => {
    const test = await fixture({ revoked: "capture", malformedUnauthorizedBody: true });
    const result = await test.run("run", "--delay-ms", "0");
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("AUTH_REVOKED");
    expect(result.stderr).not.toContain("upload retry");
    expect(result.stdout).not.toContain("sync watching");
    expect(test.requests.filter((path) => path !== "/healthz")).toEqual(["/api/v1/captures"]);
    expect(await test.readConfig()).toBe(test.configBytes);
    expect(await test.readState()).toBe(test.stateBytes);
  }, 30_000);

  it("replaces credentials while preserving all existing settings and the exact sync state", async () => {
    const test = await fixture();
    const result = await test.run("pair", "--preserve-config", "--code", "NEWCODE1");
    expect(result.code).toBe(0);
    expect(JSON.parse(await test.readConfig())).toEqual({
      ...test.config,
      deviceId: "33333333-3333-4333-8333-333333333333",
      deviceToken: "replacement-device-token-for-local-server",
    });
    expect(await test.readState()).toBe(test.stateBytes);
    expect(test.requests.filter((path) => path === "/api/v1/devices/claim")).toHaveLength(1);
  }, 30_000);

  it.each([
    { name: "rejected claim", claimStatus: 400, claim: { error: "Pairing code is invalid" } },
    { name: "invalid device UUID", claim: { deviceId: "not-a-uuid", token: "replacement-device-token-for-local-server" } },
    { name: "invalid device token", claim: { deviceId: "33333333-3333-4333-8333-333333333333", token: "short" } },
  ])("preserves config and state after a $name", async ({ claim, claimStatus }) => {
    const test = await fixture({ claim, ...(claimStatus === undefined ? {} : { claimStatus }) });
    const result = await test.run("pair", "--preserve-config", "--code", "BADCODE1");
    expect(result.code).not.toBe(0);
    expect(result.stderr).not.toContain(test.config.deviceToken);
    expect(result.stderr).not.toContain("replacement-device-token-for-local-server");
    expect(await test.readConfig()).toBe(test.configBytes);
    expect(await test.readState()).toBe(test.stateBytes);
  }, 30_000);

  it.each([
    { command: "run", revoked: "capture" },
    { command: "run", revoked: "heartbeat" },
    { command: "run", revoked: "lineage" },
    { command: "rebuild", revoked: "capture" },
    { command: "rebuild", revoked: "heartbeat" },
    { command: "rebuild", revoked: "lineage" },
  ] as const)("stops $command after the first $revoked authorization rejection", async ({ command, revoked }) => {
    const test = await fixture({ revoked });
    const result = await test.run(command, "--recent-days", "0", "--max-files", "0", "--delay-ms", "0");
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("AUTH_REVOKED");
    expect(result.stdout).not.toContain("sync watching");
    expect(result.stdout).not.toContain("Rebuild completed");
    const authenticated = test.requests.filter((path) => path !== "/healthz");
    expect(authenticated).toEqual([revoked === "capture" ? "/api/v1/captures"
      : revoked === "heartbeat" ? "/api/v1/devices/heartbeat"
      : "/api/v1/captures/codex-lineage"]);
    expect(await test.readConfig()).toBe(test.configBytes);
    expect(await test.readState()).toBe(test.stateBytes);
  }, 30_000);

  it.each(["run", "rebuild"] as const)("lets launchd stop %s successfully after revoked authorization", async (command) => {
    const test = await fixture({ revoked: "heartbeat" });
    const result = await test.run(command, "--delay-ms", "0", "--auth-revoked-exit-success");
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("AUTH_REVOKED");
    expect(result.stdout).not.toContain("sync watching");
    expect(result.stdout).not.toContain("Rebuild completed");
    expect(test.requests.filter((path) => path !== "/healthz")).toEqual(["/api/v1/devices/heartbeat"]);
    expect(await test.readConfig()).toBe(test.configBytes);
    expect(await test.readState()).toBe(test.stateBytes);
  }, 30_000);

  it("closes the watcher and scan timer when authorization is revoked after startup", async () => {
    const test = await fixture({ empty: true, scanSeconds: 15 });
    const completed = test.run("run", "--delay-ms", "0");
    await test.firstHeartbeat;
    test.setRevoked("heartbeat");
    const result = await completed;
    expect(result.code).toBe(3);
    expect(result.stdout).toContain("sync watching");
    expect(result.stderr).toContain("AUTH_REVOKED");
    expect(test.requests.filter((path) => path !== "/healthz")).toEqual([
      "/api/v1/devices/heartbeat", "/api/v1/devices/heartbeat",
    ]);
    expect(await test.readConfig()).toBe(test.configBytes);
    expect(await test.readState()).toBe(test.stateBytes);
  }, 25_000);
});
