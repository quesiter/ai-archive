import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { parseArchive } from "../src/importers/archive.js";
import { MAX_ARCHIVE_ENTRY_BYTES } from "../src/importers/archive.js";

const temporaryDirectories: string[] = [];

async function archive(name: string, entries: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ai-archive-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, name);
  const zipped = zipSync(
    Object.fromEntries(
      Object.entries(entries).map(([filename, value]) => [
        filename,
        strToU8(typeof value === "string" ? value : JSON.stringify(value)),
      ]),
    ),
  );
  await writeFile(path, zipped);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("official archive import", () => {
  it("reconstructs a ChatGPT visible branch", async () => {
    const path = await archive("chatgpt.zip", {
      "conversations.json": [
        {
          id: "chatgpt-export-session",
          title: "Export fixture",
          update_time: 1_700_000_000,
          mapping: {
            user: {
              id: "user",
              parent: null,
              children: ["assistant"],
              message: { id: "u1", author: { role: "user" }, content: { parts: ["问题"] } },
            },
            assistant: {
              id: "assistant",
              parent: "user",
              children: [],
              message: { id: "a1", author: { role: "assistant" }, content: { parts: ["回答"] } },
            },
          },
        },
      ],
    });
    const parsed = await parseArchive(path);
    expect(parsed.provider).toBe("chatgpt");
    expect(parsed.snapshots).toHaveLength(1);
    expect(parsed.snapshots[0]?.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(parsed.snapshots[0]?.completeness.status).toBe("complete");
  });

  it("does not claim a prompt-only Gemini Takeout item is complete", async () => {
    const path = await archive("gemini.zip", {
      "Gemini/My Activity.json": [
        { conversation_id: "gemini-export-session", prompt: "只有问题" },
      ],
    });
    const parsed = await parseArchive(path);
    expect(parsed.provider).toBe("gemini");
    expect(parsed.snapshots[0]?.completeness.status).toBe("partial");
  });

  it("imports Chat Memo text exports with platform session IDs and titles", async () => {
    const path = await archive("chat-memo.zip", {
      "yuanbao_20260724221254_扁桃体是看耳鼻喉还是呼吸内科.txt": `Title: 扁桃体是看耳鼻喉还是呼吸内科
URL: https://yuanbao.tencent.com/chat/account/session-yuanbao
Platform: 腾讯元宝
Created: 2026-07-24 22:12:54
Messages: 2

User: [2026-07-24 22:12:54]
扁桃体看什么科？

AI: [2026-07-24 22:12:55]
首选耳鼻喉科。`,
      "doubao_20260319231634_问题.txt": `Title: 问题
URL: https://www.doubao.com/chat/session-doubao
Platform: 豆包
Created: 2026-03-19 23:16:34
Messages: 2

User: [2026-03-19 23:16:34]
你好

AI: [2026-03-19 23:16:35]
你好！`,
    });
    const parsed = await parseArchive(path);
    expect(parsed.provider).toBeUndefined();
    expect(parsed.providers).toEqual(["yuanbao", "doubao"]);
    expect(parsed.snapshots).toHaveLength(2);
    expect(parsed.snapshots[0]).toMatchObject({
      provider: "yuanbao",
      sessionId: "session-yuanbao",
      title: "扁桃体是看耳鼻喉还是呼吸内科",
      completeness: { status: "complete" },
    });
    expect(parsed.snapshots[1]).toMatchObject({
      provider: "doubao",
      sessionId: "session-doubao",
      title: "问题",
    });
  });

  it("rejects a ZIP entry whose declared expansion exceeds the safety limit", async () => {
    const path = await archive("zip-bomb.zip", {
      "conversations.json": "x".repeat(MAX_ARCHIVE_ENTRY_BYTES + 1),
    });
    await expect(parseArchive(path)).rejects.toThrow(/too large|allowed size/i);
  }, 20_000);
});
