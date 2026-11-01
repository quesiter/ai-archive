import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import type { CapturePayloadV1 } from "@ai-archive/contracts";
import { afterEach, describe, expect, it } from "vitest";

const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cliPath = process.env.AI_ARCHIVE_TEST_BUNDLE ?? fileURLToPath(new URL("../src/index.ts", import.meta.url));
const directories: string[] = [];
const servers: Server[] = [];
const children: Array<{ child: ChildProcess; completed: Promise<number | null> }> = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map(async ({ child, completed }) => {
    if (child.exitCode === null) child.kill();
    await completed;
  }));
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function waitFor(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function jsonl(...records: unknown[]) {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

async function fixture(existingRoots = true) {
  const directory = await mkdtemp(join(tmpdir(), "ai-archive-watch-test-"));
  directories.push(directory);
  const roots = {
    openclaw: join(directory, "openclaw"),
    codex: join(directory, "codex"),
    claude: join(directory, "claude"),
    grok: join(directory, "grok"),
  };
  if (existingRoots) await Promise.all(Object.values(roots).map((root) => mkdir(root, { recursive: true })));
  const captures: CapturePayloadV1[] = [];
  const heartbeats: unknown[] = [];
  let rejectCapture = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    if (request.url === "/api/v1/captures") {
      const payload = JSON.parse(gunzipSync(raw).toString("utf8")) as CapturePayloadV1;
      captures.push(payload);
      response.statusCode = rejectCapture ? 401 : 200;
      const messageCount = "appendedMessages" in payload
        ? payload.baseMessageCount + payload.appendedMessages.length : payload.messages.length;
      response.end(JSON.stringify(rejectCapture ? { error: "Valid device token required" } : {
        revisionId: "11111111-1111-4111-8111-111111111111",
        messageCount,
        completeness: "completeness" in payload ? payload.completeness.status : "complete",
        baselineContentHash: "a".repeat(64),
      }));
    } else {
      if (request.url === "/api/v1/devices/heartbeat") heartbeats.push(JSON.parse(raw.toString("utf8")));
      response.end(JSON.stringify({ version: "test", ok: true }));
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  const configPath = join(directory, "openclaw-sync.json");
  const statePath = join(directory, "openclaw-sync-state.json");
  await writeFile(configPath, JSON.stringify({
    serverUrl: `http://127.0.0.1:${address.port}`,
    deviceId: "22222222-2222-4222-8222-222222222222",
    deviceToken: "test-device-token-for-watch-regression",
    openClawRoot: roots.openclaw,
    codexRoots: [roots.codex],
    claudeCodeRoots: [roots.claude],
    grokBuildRoots: [roots.grok],
    scanSeconds: 3600,
  }));
  await writeFile(statePath, JSON.stringify({ files: {}, codexHistoryLineageVersion: 1 }));
  let stdout = "";
  let stderr = "";
  const launch = (args: string[]) => {
    const child = spawn(process.execPath, [
      "--import", loader, cliPath, ...args,
    ], { cwd: directory, env: { ...process.env, AI_ARCHIVE_SYNC_CONFIG: configPath, PATH: directory } });
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    const completed = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    children.push({ child, completed });
    return { child, completed };
  };
  const start = async () => {
    const { child, completed } = launch([
      "run", "--skip-initial-scan", "--delay-ms", "0", "--recent-days", "0", "--max-files", "0",
    ]);
    await waitFor(() => stdout.includes("sync watching") || child.exitCode !== null, "watcher readiness");
    if (child.exitCode !== null) throw new Error(`Agent exited before readiness: ${stderr}`);
    expect(stdout).toContain("Initial and periodic scans skipped");
    return { child, completed };
  };
  return {
    roots, captures, heartbeats, start,
    rejectCaptures: () => { rejectCapture = true; },
    logs: () => ({ stdout, stderr }),
    runOnce: async () => {
      const { child, completed } = launch(["rebuild", "--delay-ms", "0", "--recent-days", "0", "--max-files", "0"]);
      await waitFor(() => child.exitCode !== null, "one-shot synchronization");
      expect(await completed, stderr).toBe(0);
    },
    seedState: (files: Record<string, unknown>) => writeFile(statePath, JSON.stringify({ files, codexHistoryLineageVersion: 1 })),
    readState: async () => JSON.parse(await readFile(statePath, "utf8")) as {
      files: Record<string, { readOffset: number; completeness: string; adapterVersion?: string; baselineContentHash?: string }>;
    },
    write: async (path: string, content: string) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content);
    },
  };
}

describe("watch-only transcript synchronization", () => {
  it("collects Grok Build CLI/Desktop journals and reassembles appended stream chunks", async () => {
    const test = await fixture();
    await test.start();
    const directory = join(test.roots.grok, "sessions", "%2Fproject", "grok-session");
    const path = join(directory, "updates.jsonl");
    const event = (kind: string, text: string, eventId: string) => ({
      timestamp: 1_762_000_000_000, method: "session/update",
      params: { sessionId: "grok-session", update: { sessionUpdate: kind, content: { type: "text", text } }, _meta: { eventId } },
    });
    await test.write(join(directory, "summary.json"), JSON.stringify({ info: { id: "grok-session" }, generated_title: "Desktop session" }));
    await test.write(join(directory, "chat_history.jsonl"), jsonl({ type: "user", content: "Private model projection" }));
    await test.write(join(test.roots.grok, "auth.json"), JSON.stringify({ token: "never read" }));
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(test.captures).toHaveLength(0);
    await test.write(path, jsonl(event("user_message_chunk", "Question", "u1"), event("agent_message_chunk", "First", "a1")));
    await waitFor(() => test.captures.length === 1, "Grok Build transcript");
    await appendFile(path, jsonl(event("agent_message_chunk", " second", "a2")));
    await waitFor(() => test.captures.length === 2, "Grok Build streamed continuation");
    const capture = test.captures[1];
    if (!capture || !("messages" in capture)) throw new Error("Grok stream updates must reassemble a full snapshot");
    expect(capture).toMatchObject({ provider: "grok_build", sessionId: "grok-session", title: "Desktop session", captureMode: "import" });
    expect(capture.messages.map((message) => message.segments[0]?.content)).toEqual(["Question", "First second"]);
    expect(JSON.stringify(test.captures)).not.toContain("Private model projection");
    expect(test.logs().stderr).not.toContain("sync failed");
  }, 30_000);
  it("uploads new and appended transcripts for all local providers without a scan timer", async () => {
    const test = await fixture();
    await test.start();
    expect(test.captures).toHaveLength(0);
    expect(test.heartbeats).toHaveLength(0);
    const openclaw = join(test.roots.openclaw, "agents", "main", "sessions", "session.jsonl");
    const codex = join(test.roots.codex, "sessions", "2026", "10", "session.jsonl");
    const claude = join(test.roots.claude, "projects", "demo", "session.jsonl");
    await Promise.all([
      test.write(openclaw, jsonl({ type: "session", id: "openclaw-session" }, { id: "u1", role: "user", content: "OpenClaw question" })),
      test.write(codex, jsonl({ type: "session_meta", payload: { id: "codex-session" } },
        { type: "response_item", payload: { type: "message", role: "user", content: "Codex question" } })),
      test.write(claude, jsonl({ sessionId: "claude-session" }, { id: "u1", role: "user", content: "Claude question" })),
    ]);
    await waitFor(() => test.captures.length === 3, "three newly created transcripts");
    expect(test.captures.map((capture) => capture.provider).sort()).toEqual(["claude_code", "codex", "openclaw"]);
    expect(test.captures.every((capture) => capture.captureMode === "import")).toBe(true);
    await waitFor(() => test.heartbeats.length > 0, "the first completed scan");
    await Promise.all([
      appendFile(openclaw, jsonl({ id: "a1", role: "assistant", content: "OpenClaw answer" })),
      appendFile(codex, jsonl({ type: "response_item", payload: { type: "message", role: "assistant", content: "Codex answer" } })),
      appendFile(claude, jsonl({ id: "a1", role: "assistant", content: "Claude answer" })),
    ]);
    await waitFor(() => test.captures.length === 6, "three appended transcript messages");
    for (const capture of test.captures.slice(3)) {
      expect(capture.captureMode).toBe("append");
      if (!("appendedMessages" in capture)) throw new Error("Expected an append capture");
      expect(capture.baseMessageCount).toBe(1);
      expect(capture.appendedMessages).toHaveLength(1);
      expect(capture.appendedMessages[0]?.role).toBe("assistant");
    }
    expect(test.logs().stderr).not.toContain("sync failed");
  }, 30_000);

  it("discovers source roots created after startup and ignores non-source and credential files", async () => {
    const test = await fixture(false);
    await test.start();
    await Promise.all([
      test.write(join(test.roots.openclaw, "agents", "main", "unrelated", "ignored.jsonl"), jsonl({ role: "user", content: "Ignore" })),
      test.write(join(test.roots.codex, "unrelated", "ignored.jsonl"), jsonl({ role: "user", content: "Ignore" })),
      test.write(join(test.roots.claude, "projects", "credential-cache", "ignored.jsonl"), jsonl({ role: "user", content: "Ignore" })),
      test.write(join(test.roots.claude, "projects", "ignored.jsonl.bak"), jsonl({ role: "user", content: "Ignore" })),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(test.captures).toHaveLength(0);
    expect(test.heartbeats).toHaveLength(0);
    await test.write(join(test.roots.codex, "sessions", "created.jsonl"), jsonl(
      { type: "session_meta", payload: { id: "created-after-start" } },
      { type: "response_item", payload: { type: "message", role: "user", content: "Archive after startup" } },
    ));
    await waitFor(() => test.captures.length === 1, "a transcript under a newly created root")
      .catch((error) => { throw new Error(`${String(error)}\n${JSON.stringify({ ...test.logs(), captures: test.captures })}`); });
    expect(test.captures[0]?.sessionId).toBe("created-after-start");
    expect(test.logs().stderr).not.toContain("sync failed");
  }, 30_000);

  it("closes the watcher after authorization is revoked during an event-triggered upload", async () => {
    const test = await fixture();
    test.rejectCaptures();
    const { child, completed } = await test.start();
    await test.write(join(test.roots.claude, "projects", "session.jsonl"), jsonl(
      { sessionId: "revoked-session" }, { role: "user", content: "Authorization was revoked" },
    ));
    await waitFor(() => child.exitCode !== null, "authorization shutdown")
      .catch((error) => { throw new Error(`${String(error)}\n${JSON.stringify(test.logs())}`); });
    expect(await completed).toBe(3);
    expect(test.captures).toHaveLength(1);
    expect(test.heartbeats).toHaveLength(0);
    expect(test.logs().stderr).toContain("AUTH_REVOKED");
  }, 30_000);

  it("falls back to an acknowledged partial snapshot when an appended Claude record is corrupt", async () => {
    const test = await fixture();
    const path = join(test.roots.claude, "projects", "session.jsonl");
    await test.write(path, jsonl({ sessionId: "damaged-tail" }, { id: "u1", role: "user", content: "Question" }));
    await test.runOnce();
    expect(test.captures).toHaveLength(1);
    await appendFile(path, '{"role":"assistant","content":"damaged\n' +
      jsonl({ id: "a1", role: "assistant", content: "Readable later answer" }));
    await test.runOnce();
    const recovered = test.captures[1];
    expect(recovered?.captureMode).toBe("import");
    if (!recovered || !("messages" in recovered)) throw new Error("Expected a full recovery snapshot");
    expect(recovered.completeness.status).toBe("partial");
    expect(recovered.completeness.reason).toContain("3");
    expect(recovered.messages.map((message) => message.segments[0]?.content)).toEqual(["Question", "Readable later answer"]);
    const stored = (await test.readState()).files[path.replace(/\\/g, "/")];
    expect(stored?.completeness).toBe("partial");
    expect(stored?.baselineContentHash).toBeUndefined();
    expect(stored?.readOffset).toBe((await stat(path)).size);
    expect(test.logs().stderr).not.toContain("sync failed");
  }, 30_000);

  it.each([undefined, "claude-code-jsonl-v2"])("rechecks unchanged Claude files once after upgrading from parser %s", async (previousAdapterVersion) => {
    const test = await fixture();
    const path = join(test.roots.claude, "projects", "legacy.jsonl");
    const sourcePath = path.replace(/\\/g, "/");
    const content = jsonl({ sessionId: "legacy-damaged" }, { id: "u1", role: "user", content: "Question" }) +
      '{broken historical answer\n' + jsonl({ id: "a1", role: "assistant", content: "Readable later answer" });
    await test.write(path, content);
    const metadata = await stat(path);
    await test.seedState({ [sourcePath]: {
      source: "claude_code", adapterVersion: previousAdapterVersion, filePath: sourcePath,
      fileSize: metadata.size, modifiedAt: metadata.mtimeMs, readOffset: metadata.size,
      fullFileHash: createHash("sha256").update(content).digest("hex"),
      sessionId: "legacy-damaged", completeness: "complete", messageCount: 2,
      branchFingerprint: "legacy-branch", baselineContentHash: "b".repeat(64), lastMessageId: "a1",
    } });
    await test.runOnce();
    expect(test.captures).toHaveLength(1);
    const capture = test.captures[0];
    if (!capture || !("messages" in capture)) throw new Error("Expected a full upgrade snapshot");
    expect(capture.completeness.status).toBe("partial");
    const stored = (await test.readState()).files[sourcePath];
    expect(stored?.adapterVersion).toBe(capture.adapterVersion);
    expect(stored?.baselineContentHash).toBeUndefined();
    await test.runOnce();
    expect(test.captures).toHaveLength(1);
  }, 30_000);
});
