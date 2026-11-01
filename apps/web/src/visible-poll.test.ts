import { afterEach, expect, it, vi } from "vitest";
import { setVisibleInterval } from "./visible-poll";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it("pauses hidden-tab polling, resumes when visible and stops on cleanup", () => {
  vi.useFakeTimers();
  let visibilityState = "hidden";
  vi.stubGlobal("window", { setInterval, clearInterval });
  vi.stubGlobal("document", { get visibilityState() { return visibilityState; } });
  const callback = vi.fn();
  const timer = setVisibleInterval(callback, 2500);
  vi.advanceTimersByTime(10000);
  expect(callback).not.toHaveBeenCalled();
  visibilityState = "visible";
  vi.advanceTimersByTime(5000);
  expect(callback).toHaveBeenCalledTimes(2);
  window.clearInterval(timer);
  vi.advanceTimersByTime(5000);
  expect(callback).toHaveBeenCalledTimes(2);
});
