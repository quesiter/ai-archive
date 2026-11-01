import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scanCodexHistoryLineage, uploadCodexHistoryLineage } from "../src/codex-history-lineage.js";
const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "codex-all-lineage-")); roots.push(root); return root; }
async function header(root: string, path: string, id: string, parent?: string, normalFork = false) {
  const directory = join(root, path);
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${id}.jsonl`);
  await writeFile(file, JSON.stringify({ type: "session_meta", payload: { id,
    source: normalFork ? "vscode" : { subagent: { thread_spawn: { parent_thread_id: parent } } },
    forked_from_id: parent,
  } }) + "\nTHIS INVALID BODY MUST NEVER BE PARSED\n");
  await utimes(file, new Date("2020-01-01"), new Date("2020-01-01"));
}
describe("all-history Codex relationship discovery", () => {
  it("reads only headers, covers old/nested archived files and deduplicates sessions without merging normal forks", async () => {
    const root = await fixture();
    await header(root, "sessions/2020/01/01", "child", "root");
    await header(root, "archived_sessions/old", "child", "root");
    await header(root, "archived_sessions", "fork", "root", true);
    const result = await scanCodexHistoryLineage([root]);
    expect(result).toEqual({ files: 3, conflicts: [], relations: [{ sessionId: "child", parentSessionId: "root" }] });
  });
  it("reports conflicting source metadata instead of guessing a parent", async () => {
    const root = await fixture();
    await header(root, "sessions/one", "child", "root-1");
    await header(root, "sessions/two", "child", "root-2");
    expect(await scanCodexHistoryLineage([root])).toEqual({ files: 2, conflicts: ["child"], relations: [] });
  });
  it("sends bounded metadata batches with no message bodies", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const count = JSON.parse(String(init.body)).relations.length;
      return new Response(JSON.stringify({ updated: count, unchanged: 0, notFound: 0, rejected: 0 }));
    });
    vi.stubGlobal("fetch", fetch);
    const relations = Array.from({ length: 501 }, (_, index) => ({ sessionId: `child-${index}`, parentSessionId: "root" }));
    expect(await uploadCodexHistoryLineage({ serverUrl: "https://example.test", deviceToken: "test-only", relations })).toMatchObject({ updated: 501 });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toEqual({ relations: relations.slice(0, 500) });
  });
  it("does not accept a failed request or an old-server response as completed history repair", async () => {
    const input = { serverUrl: "https://example.test", deviceToken: "test-only", relations: [{ sessionId: "child", parentSessionId: "root" }] };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(uploadCodexHistoryLineage(input)).rejects.toThrow("AUTH_REVOKED");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ version: "old" }))));
    await expect(uploadCodexHistoryLineage(input)).rejects.toThrow("Invalid");
  });
});
