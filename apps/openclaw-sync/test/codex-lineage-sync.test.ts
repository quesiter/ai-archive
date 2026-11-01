import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import { CapturePayloadV1Schema, type CapturePayloadV1 } from "@ai-archive/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { captureMessageFingerprint, parseCodexJsonl } from "../src/parser.js";
import { captureIdempotencyKey } from "../src/sync-runtime.js";

const execFileAsync = promisify(execFile);
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
const cliPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const temporaryDirectories: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture(input: { child?: boolean; legacyHash?: boolean; trustedBase?: boolean; receipt?: "old" | "partial" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "ai-archive-lineage-test-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "codex");
  const path = join(root, "sessions", "child.jsonl").replace(/\\/g, "/");
  await mkdir(dirname(path), { recursive: true });
  const content = [
    JSON.stringify({
      type: "session_meta",
      payload: {
        id: "child-thread",
        cwd: "/repo/homeassistant",
        source: input.child === false
          ? "appServer"
          : { subagent: { thread_spawn: { parent_thread_id: "main-thread" } } },
        forked_from_id: "main-thread",
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "user", content: "Inspect the thermostat" },
    }),
  ].join("\n") + "\n";
  await writeFile(path, content);
  const snapshot = parseCodexJsonl({ path, content });
  const metadata = await stat(path);
  const hash = createHash("sha256").update(content).digest("hex");
  const statePath = join(directory, "openclaw-sync-state.json");
  await writeFile(statePath, JSON.stringify({
    files: {
      [path]: input.legacyHash ? hash : {
        source: "codex",
        filePath: path,
        fileSize: metadata.size,
        modifiedAt: metadata.mtimeMs,
        readOffset: metadata.size,
        fullFileHash: hash,
        sessionId: snapshot.sessionId,
        revisionId: "11111111-1111-4111-8111-111111111111",
        ...(input.trustedBase === false ? {} : { completeness: "complete", baselineContentHash: "b".repeat(64) }),
        branchFingerprint: snapshot.branchFingerprint,
        messageCount: snapshot.messages.length,
        lastMessageTextHash: captureMessageFingerprint(snapshot.messages.at(-1)!),
      },
    },
  }));
  const captures: Array<{ payload: CapturePayloadV1; idempotencyKey: string | undefined }> = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api/v1/captures") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const decoded: unknown = JSON.parse(gunzipSync(Buffer.concat(chunks)).toString("utf8"));
      const parsed = CapturePayloadV1Schema.safeParse(decoded);
      if (!parsed.success) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "invalid test capture", issues: parsed.error.issues }));
        return;
      }
      const payload = parsed.data;
      captures.push({
        payload,
        idempotencyKey: typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"] : undefined,
      });
      response.end(JSON.stringify({
        revisionId: "11111111-1111-4111-8111-111111111111",
        ...(input.receipt === "old" ? {} : {
          completeness: input.receipt === "partial" ? "partial" : "complete",
          baselineContentHash: "c".repeat(64),
          archiveMessageCount: 40,
          archiveCompleteness: "complete",
        }),
        messageCount: "appendedMessages" in payload
          ? payload.baseMessageCount + payload.appendedMessages.length
          : payload.messages.length,
      }));
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
    path,
    captures,
    readState: async () => JSON.parse(await readFile(statePath, "utf8")) as {
      files: Record<string, { codexLineageVersion?: number; parentSessionId?: string; messageCount?: number; completeness?: string; baselineContentHash?: string }>;
    },
    run: async () => {
      const result = await execFileAsync(process.execPath, [
        "--import", loader, cliPath, "rebuild", "--recent-days", "0", "--max-files", "0", "--delay-ms", "0",
      ], {
        cwd: directory,
        env: { ...process.env, AI_ARCHIVE_SYNC_CONFIG: configPath, PATH: directory },
        timeout: 20_000,
      });
      expect(result.stderr).not.toContain("sync failed");
    },
  };
}

describe("Codex relationship upgrade sync", () => {
  it.each(["old", "partial"] as const)("uses full imports until a %s receipt supplies a complete source baseline", async (receipt) => {
    const test = await fixture({ trustedBase: false, receipt });
    await test.run();
    expect(test.captures[0]?.payload.captureMode).toBe("import");
    const state = (await test.readState()).files[test.path];
    expect(state?.messageCount).toBe(1);
    expect(state?.baselineContentHash).toBeUndefined();
    await appendFile(test.path, JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: "New answer" } }) + "\n");
    await test.run();
    expect(test.captures).toHaveLength(2);
    expect(test.captures[1]?.payload.captureMode).toBe("import");
    expect((await test.readState()).files[test.path]?.messageCount).toBe(2);
    expect((await test.readState()).files[test.path]?.baselineContentHash).toBeUndefined();
  }, 30_000);

  it("backfills an unchanged child once, then retains its parent on later deltas", async () => {
    const test = await fixture();
    await test.run();
    expect(test.captures).toHaveLength(1);
    expect(test.captures[0]?.payload).toMatchObject({
      captureMode: "append",
      parentSessionId: "main-thread",
      baseMessageCount: 1,
      baseContentHash: "b".repeat(64),
      appendedMessages: [],
    });
    expect((await test.readState()).files[test.path]).toMatchObject({
      codexLineageVersion: 1,
      parentSessionId: "main-thread",
    });
    await test.run();
    expect(test.captures).toHaveLength(1);
    await appendFile(test.path, JSON.stringify({
      type: "response_item",
      payload: { type: "message", role: "assistant", content: "Inspection complete" },
    }) + "\n");
    await test.run();
    expect(test.captures).toHaveLength(2);
    expect(test.captures[1]?.payload).toMatchObject({
      captureMode: "append",
      parentSessionId: "main-thread",
      baseContentHash: "c".repeat(64),
      appendedMessages: [expect.objectContaining({ ordinal: 1, role: "assistant" })],
    });
  }, 30_000);

  it("does not let a legacy content hash suppress the one required relationship import", async () => {
    const test = await fixture({ legacyHash: true });
    await test.run();
    expect(test.captures).toHaveLength(1);
    const capture = test.captures[0]!;
    expect(capture.payload).toMatchObject({ captureMode: "import", parentSessionId: "main-thread" });
    expect(capture.idempotencyKey).toBe(captureIdempotencyKey({
      provider: capture.payload.provider,
      adapterVersion: capture.payload.adapterVersion,
      captureMode: capture.payload.captureMode,
      payload: capture.payload,
    }));
    const { parentSessionId: _parentSessionId, ...withoutParent } = capture.payload;
    expect(capture.idempotencyKey).not.toBe(captureIdempotencyKey({
      provider: capture.payload.provider,
      adapterVersion: capture.payload.adapterVersion,
      captureMode: capture.payload.captureMode,
      payload: withoutParent,
    }));
    await test.run();
    expect(test.captures).toHaveLength(1);
  }, 30_000);

  it("checks a normal fork once without uploading it as a child or replaying its transcript", async () => {
    const test = await fixture({ child: false });
    await test.run();
    await test.run();
    expect(test.captures).toHaveLength(0);
    const state = (await test.readState()).files[test.path];
    expect(state?.codexLineageVersion).toBe(1);
    expect(state?.parentSessionId).toBeUndefined();
  }, 30_000);
});
