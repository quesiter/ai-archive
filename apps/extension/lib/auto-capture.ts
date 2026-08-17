import type { CaptureTriggerReason } from "@ai-archive/contracts";

export const AUTO_CAPTURE_IDLE_MS = 12_000;

export function remainingIdleDelay(
  lastUserActivityAt: number,
  now = Date.now(),
): number {
  if (lastUserActivityAt <= 0) return 0;
  const elapsed = now - lastUserActivityAt;
  return elapsed >= AUTO_CAPTURE_IDLE_MS ? 0 : AUTO_CAPTURE_IDLE_MS - elapsed;
}

export function shouldDeferAutoCapture(input: {
  reason: CaptureTriggerReason;
  forceFull?: boolean | undefined;
  lastUserActivityAt: number;
  now?: number | undefined;
}): boolean {
  if (input.forceFull || input.reason === "manual_retry") return false;
  return remainingIdleDelay(input.lastUserActivityAt, input.now) > 0;
}
