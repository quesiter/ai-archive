import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { parseArchive } from "../src/importers/archive.js";

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
});
