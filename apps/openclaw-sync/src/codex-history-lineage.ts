import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import fg from "fast-glob";
import { codexParentSessionId } from "./parser.js";
import { AuthenticationRevoked } from "./sync-auth.js";

export async function scanCodexHistoryLineage(roots: string[]) {
  const relations = new Map<string, string>();
  const conflicts = new Set<string>();
  let files = 0;
  for (const root of roots) {
    const paths = await fg(["sessions/**/*.jsonl", "archived_sessions/**/*.jsonl"], {
      cwd: root, absolute: true, onlyFiles: true, followSymbolicLinks: false,
      suppressErrors: false,
    });
    for (const path of paths) {
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      const stream = createReadStream(path, { encoding: "utf8" });
      const reader = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          if (!line.trim()) continue;
          const record = JSON.parse(line.replace(/^\uFEFF/, "")) as { type?: string; payload?: Record<string, unknown> };
          if (record.type !== "session_meta") throw new Error(`Codex transcript lacks an initial session_meta: ${path}`);
          files += 1;
          const sessionId = record.payload?.id;
          const parent = codexParentSessionId(record.payload);
          if (parent && typeof sessionId === "string" && sessionId && sessionId.length <= 1_024) {
            if (relations.has(sessionId) && relations.get(sessionId) !== parent) conflicts.add(sessionId);
            relations.set(sessionId, parent);
          }
          break;
        }
      } finally { reader.close(); stream.destroy(); }
    }
  }
  for (const conflict of conflicts) relations.delete(conflict);
  return { files, conflicts: [...conflicts], relations: [...relations].map(([sessionId, parentSessionId]) => ({ sessionId, parentSessionId })) };
}

export async function uploadCodexHistoryLineage(input: {
  serverUrl: string; deviceToken: string;
  relations: Array<{ sessionId: string; parentSessionId: string }>;
}) {
  const totals = { updated: 0, unchanged: 0, notFound: 0, rejected: 0 };
  for (let offset = 0; offset < input.relations.length; offset += 500) {
    const response = await fetch(`${input.serverUrl.replace(/\/$/, "")}/api/v1/captures/codex-lineage`, {
      method: "POST", headers: { Authorization: `Bearer ${input.deviceToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ relations: input.relations.slice(offset, offset + 500) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (response.status === 401) throw new AuthenticationRevoked();
    if (!response.ok) throw new Error(`Codex history lineage upload failed: HTTP ${response.status}`);
    const result = await response.json() as Record<string, unknown>;
    for (const key of ["updated", "unchanged", "notFound", "rejected"] as const) {
      if (typeof result[key] !== "number" || !Number.isSafeInteger(result[key]) || result[key] < 0) throw new Error("Invalid Codex history lineage response");
      totals[key] += result[key];
    }
  }
  return totals;
}
