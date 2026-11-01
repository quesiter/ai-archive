import { describe, expect, it } from "vitest";
import { latestAdaptersByProvider } from "./adapter-health";

describe("latest adapter health", () => {
  it("compares numeric versions and keeps each platform's latest row intact", () => {
    const rows = [
      { provider: "chatgpt", adapterVersion: "1.2.9", status: "healthy" },
      { provider: "codex", adapterVersion: "codex-jsonl-v5", status: "healthy" },
      { provider: "chatgpt", adapterVersion: "1.2.11", status: "degraded" },
      { provider: "chatgpt", adapterVersion: "1.2.10", status: "healthy" },
      { provider: "codex", adapterVersion: "codex-jsonl-v6", status: "healthy" },
    ];
    expect(latestAdaptersByProvider(rows)).toEqual([rows[2], rows[4]]);
    expect(rows).toHaveLength(5);
    expect(latestAdaptersByProvider([])).toEqual([]);
  });
});
