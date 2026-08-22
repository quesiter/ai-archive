export type LocalTranscriptProvider = "openclaw" | "codex" | "claude_code";

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
