import { execFile } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cliPath = process.env.AI_ARCHIVE_TEST_BUNDLE ??
  fileURLToPath(new URL("../src/index.ts", import.meta.url));
const directories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(captureStatus = 200) {
  const directory = await mkdtemp(join(tmpdir(), "ai-archive-skipped-test-"));
  directories.push(directory);
  const root = join(directory, "codex");
  const path = join(root, "sessions", "without-user.jsonl").replace(/\\/g, "/");
  await mkdir(dirname(path), { recursive: true });
  const content = [
    { type: "session_meta", payload: {
      id: "without-user",
      source: { subagent: { thread_spawn: { parent_thread_id: "main-thread" } } },
    } },
    { type: "response_item", payload: { type: "compaction", content: "Summary" } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  await writeFile(path, content);
  const statePath = join(directory, "openclaw-sync-state.json");
  await writeFile(statePath, JSON.stringify({ files: {}, codexHistoryLineageVersion: 1 }));
  const heartbeats: Array<Record<string, unknown>> = [];
  const captures: Array<{ messages: unknown[] }> = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v1/captures" || request.url === "/api/v1/devices/heartbeat") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks);
      const body = JSON.parse((request.headers["content-encoding"] === "gzip"
        ? gunzipSync(raw) : raw).toString("utf8"));
      if (request.url === "/api/v1/devices/heartbeat") {
        heartbeats.push(body);
        response.end(JSON.stringify({ ok: true }));
      } else {
        captures.push(body);
        response.statusCode = captureStatus;
        response.end(JSON.stringify(captureStatus === 200 ? {
          revisionId: "11111111-1111-4111-8111-111111111111",
          messageCount: body.messages.length,
          completeness: "complete",
          baselineContentHash: "a".repeat(64),
        } : { error: "Rejected test capture" }));
      }
      return;
    }
    response.end(JSON.stringify({ version: "test" }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test server port");
  const configPath = join(directory, "openclaw-sync.json");
  await writeFile(configPath, JSON.stringify({
    serverUrl: `http://127.0.0.1:${address.port}`,
    deviceId: "22222222-2222-4222-8222-222222222222",
    deviceToken: "test-only-device-token-for-local-server",
    openClawRoot: join(directory, "empty-openclaw"),
    codexRoots: [root],
  }));
  return {
    path, captures, heartbeats, content,
    readState: async () => JSON.parse(await readFile(statePath, "utf8")) as {
      files: Record<string, { lastSkippedReason?: string; lastSuccessfulSyncAt?: string }>;
    },
    addUser: async () => appendFile(path, JSON.stringify({
      type: "response_item", payload: { type: "message", role: "user", content: "Now archive this" },
    }) + "\n"),
    run: () => execFileAsync(process.execPath, [
      "--import", loader, cliPath, "rebuild", "--recent-days", "0", "--max-files", "0", "--delay-ms", "0",
    ], {
      cwd: directory,
      env: { ...process.env, AI_ARCHIVE_SYNC_CONFIG: configPath, PATH: directory },
      timeout: 20_000,
    }),
  };
}

describe("Codex transcripts without user text", () => {
  it("skips once without an error heartbeat, then uploads when user text appears", async () => {
    const test = await fixture();
    const first = await test.run();
    expect(first.stderr).toContain("skipped codex:without-user: no textual user messages");
    expect(first.stderr).not.toContain("sync failed");
    expect(test.heartbeats.at(-1)).toMatchObject({ skippedFiles: 1, lastErrorCode: null, lastErrorAt: null });
    expect((await test.readState()).files[test.path]?.lastSkippedReason).toBe("no textual user messages");
    expect(test.captures).toHaveLength(0);
    const unchanged = await test.run();
    expect(unchanged.stderr).not.toContain("skipped codex");
    expect(test.captures).toHaveLength(0);
    expect(await readFile(test.path, "utf8")).toBe(test.content);
    await test.addUser();
    const updated = await test.run();
    expect(updated.stderr).not.toContain("sync failed");
    expect(test.captures).toHaveLength(1);
    expect(test.captures[0]?.messages).toHaveLength(1);
    expect((await test.readState()).files[test.path]?.lastSkippedReason).toBeUndefined();
    expect((await test.readState()).files[test.path]?.lastSuccessfulSyncAt).toBeTruthy();
    expect(test.heartbeats.at(-1)).toMatchObject({ skippedFiles: 0, lastErrorCode: null });
  }, 30_000);

  it("keeps malformed JSONL visible as a sync failure", async () => {
    const test = await fixture();
    await writeFile(test.path, "invalid JSON\n" + test.content);
    const result = await test.run();
    expect(result.stderr).toContain("sync failed");
    expect(test.heartbeats.at(-1)).toMatchObject({ skippedFiles: 0, lastErrorCode: "SYNC_FAILED" });
    expect((await test.readState()).files[test.path]).toBeUndefined();
  }, 30_000);

  it("keeps an upload rejection visible as a sync failure", async () => {
    const test = await fixture(400);
    await test.addUser();
    const result = await test.run();
    expect(result.stderr).toContain("sync failed");
    expect(test.captures).toHaveLength(1);
    expect(test.heartbeats.at(-1)).toMatchObject({ skippedFiles: 0, lastErrorCode: "SYNC_FAILED" });
    expect((await test.readState()).files[test.path]).toBeUndefined();
  }, 30_000);
});
