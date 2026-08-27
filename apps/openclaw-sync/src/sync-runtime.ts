import { createHash } from "node:crypto";

export type LocalTranscriptProvider = "openclaw" | "codex" | "claude_code";

export function captureIdempotencyKey(input: {
  provider: string;
  adapterVersion: string;
  captureMode?: string;
  payload: unknown;
}): string {
  const payloadHash = createHash("sha256")
    .update(JSON.stringify(input.payload))
    .digest("hex");
  return `${input.provider}:${input.adapterVersion}:${input.captureMode ?? "full"}:${payloadHash}`;
}

export async function* lfSeparatedLines(
  input: AsyncIterable<string | Buffer>,
): AsyncGenerator<string> {
  let pending = "";
  for await (const chunk of input) {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const rawLine = pending.slice(0, newline);
      yield rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  }
  if (pending) yield pending;
}

export function observedCaptureTime(input: {
  provider: LocalTranscriptProvider;
  fileModifiedAt: Date;
  hasPreviousSync: boolean;
  now?: Date;
}): Date {
  if (input.provider !== "codex" || !input.hasPreviousSync) {
    return input.fileModifiedAt;
  }
  return input.now ?? new Date();
}

export function createCoalescedRunner(task: () => Promise<void>): () => Promise<void> {
  let running = false;
  let rerunRequested = false;

  return async () => {
    if (running) {
      rerunRequested = true;
      return;
    }
    running = true;
    try {
      do {
        rerunRequested = false;
        await task();
      } while (rerunRequested);
    } finally {
      running = false;
    }
  };
}

export function retryDelayMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(15 * 60_000, seconds * 1_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(15 * 60_000, Math.max(0, date - Date.now()));
  }
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.max(0, attempt - 1));
}

export function retryableUploadStatus(status: number): boolean {
  return status === 429 || status >= 500;
}
