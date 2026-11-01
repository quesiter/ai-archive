import { describe, expect, it, vi } from "vitest";
import { BatchRecaptureHttpError, batchTaskUrl, createBatchRunner, type BatchRunnerDependencies, type BatchRunnerState, type BatchSafetyState } from "../lib/batch-capture";
import type { RecaptureNext, RecaptureTask } from "@ai-archive/contracts";

const task: RecaptureTask = { jobId: "job", itemId: "item", leaseToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sessionId: "session-123", title: "One source conversation", url: "https://chatgpt.com/c/session-123", startedAt: new Date(0).toISOString() };
function fixture() {
  let saved: BatchRunnerState | null = null;
  let next: RecaptureNext = { job: { id: "job", status: "running", message: null }, task };
  let tab: { url?: string; status?: string } | null = { url: batchTaskUrl(task), status: "complete" };
  let content: any = { running: false };
  let now = 1_000;
  const deps: BatchRunnerDependencies = {
    load: vi.fn(async () => structuredClone(saved)),
    save: vi.fn(async state => { saved = structuredClone(state); }),
    next: vi.fn(async () => next), report: vi.fn(async () => { next = { job: null, task: null }; return { ok: true }; }),
    open: vi.fn(async () => 7), tab: vi.fn(async () => tab), close: vi.fn(async () => {}),
    findOwned: vi.fn(async () => undefined),
    send: vi.fn(async (_id, message: any) => message.type === "getContentState"
      ? { provider: "chatgpt", sessionId: task.sessionId, messageCount: 2 }
      : message.type === "getBatchCaptureState" ? content : { ok: true }),
    status: vi.fn(async () => {}), now: () => now,
  };
  return { deps, runner: () => createBatchRunner(deps), saved: () => saved, setNext: (value: RecaptureNext) => { next = value; },
    setTab: (value: typeof tab) => { tab = value; }, setContent: (value: any) => { content = value; }, time: (value: number) => { now = value; } };
}

describe("durable batch recapture runner", () => {
  it("preserves cooldown across worker restart without claiming another task", async () => {
    const f = fixture();
    let safety: BatchSafetyState | null = null;
    f.deps.loadSafety = async () => structuredClone(safety);
    f.deps.saveSafety = async value => { safety = structuredClone(value); };
    const runner = f.runner(); await runner.tick();
    f.setContent({ result: { captureId: "captured" } });
    await runner.tick(); await runner.tick();
    vi.mocked(f.deps.next).mockClear();
    await f.runner().tick();
    expect(f.deps.next).not.toHaveBeenCalled();
    f.time(61_000); await f.runner().tick();
    expect(f.deps.next).toHaveBeenCalledTimes(1);
  });
  it("pauses on the third consecutive inaccessible item and retains its page", async () => {
    const f = fixture();
    f.deps.loadSafety = async () => ({ jobId: "job", completed: 2, consecutiveErrors: 2, nextAllowedAt: 0 });
    const runner = f.runner(); await runner.tick();
    f.setContent({ result: { outcome: "skipped", message: "无权访问" } });
    await runner.tick(); await runner.tick();
    expect(f.deps.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: "attention", message: expect.stringContaining("连续 3 条") }));
    expect(f.deps.close).not.toHaveBeenCalled();
  });
  it("rests ten minutes after ten items", async () => {
    const f = fixture();
    f.deps.loadSafety = async () => ({ jobId: "job", completed: 9, consecutiveErrors: 0, nextAllowedAt: 0 });
    f.deps.saveSafety = vi.fn(async () => {});
    const runner = f.runner(); await runner.tick();
    f.setContent({ result: { captureId: "tenth" } });
    await runner.tick(); await runner.tick();
    expect(f.deps.saveSafety).toHaveBeenCalledWith(expect.objectContaining({ nextAllowedAt: 601_000, completed: 10 }));
  });
  it("does not claim a resumed task while a persisted risk cooldown is active", async () => {
    const f = fixture();
    let safety: BatchSafetyState | null = null;
    f.deps.loadSafety = async () => structuredClone(safety);
    f.deps.saveSafety = async value => { safety = structuredClone(value); };
    const runner = f.runner(); await runner.tick();
    f.setContent({ result: { outcome: "attention", message: "限流" } });
    await runner.tick(); await runner.tick();
    f.setNext({ job: { id: "job", status: "running", message: null }, task: { ...task, itemId: "resumed", leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
    vi.mocked(f.deps.next).mockClear();
    await f.runner().tick();
    expect(f.deps.next).not.toHaveBeenCalled();
    expect(f.deps.open).toHaveBeenCalledTimes(1);
  });
  it("opens one owned page, resumes its operation after restart and reports its exact receipt", async () => {
    const f = fixture(); const first = f.runner();
    await first.tick(); await first.tick();
    expect(f.deps.open).toHaveBeenCalledTimes(1);
    expect(f.deps.send).toHaveBeenCalledWith(7, { type: "startBatchCapture", operationId: task.leaseToken, itemId: task.itemId, sessionId: task.sessionId });
    f.setContent({ running: true });
    const restarted = f.runner(); await restarted.tick();
    expect(f.deps.open).toHaveBeenCalledTimes(1);
    f.setContent({ running: false, result: { captureId: "capture:own" } });
    await restarted.tick();
    expect(f.saved()?.result).toEqual({ captureId: "capture:own" });
    expect(f.deps.report).not.toHaveBeenCalled();
    await restarted.tick();
    expect(f.deps.report).toHaveBeenCalledWith({ jobId: "job", itemId: "item", leaseToken: task.leaseToken, captureId: "capture:own" });
    expect(f.deps.close).toHaveBeenCalledWith(7);
    expect(f.saved()).toBeNull();
  });
  it("serializes simultaneous alarms without opening duplicate tabs", async () => {
    const f = fixture(); const runner = f.runner();
    await Promise.all([runner.tick(), runner.tick(), runner.tick()]);
    expect(f.deps.next).toHaveBeenCalledTimes(1);
    expect(f.deps.open).toHaveBeenCalledTimes(1);
  });
  it("recovers a created tab when suspension preceded saving its numeric ID", async () => {
    const f = fixture(); vi.mocked(f.deps.findOwned).mockResolvedValue(7);
    await f.runner().tick();
    expect(f.saved()?.tabId).toBe(7); expect(f.deps.open).not.toHaveBeenCalled();
  });
  it("retains a persisted receipt through a lost report response", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setContent({ result: { captureId: "capture:stored" } }); await runner.tick();
    vi.mocked(f.deps.report).mockRejectedValueOnce(new Error("network offline"));
    await runner.tick(); expect(f.saved()?.result?.captureId).toBe("capture:stored");
    await f.runner().tick(); expect(f.saved()).toBeNull(); expect(f.deps.report).toHaveBeenCalledTimes(2);
  });
  it("settles a report committed by the server but with a lost acknowledgement before claiming its next lease", async () => {
    const f = fixture();
    let safety: BatchSafetyState | null = null;
    f.deps.loadSafety = async () => structuredClone(safety);
    f.deps.saveSafety = async value => { safety = structuredClone(value); };
    const runner = f.runner(); await runner.tick();
    f.setContent({ result: { outcome: "skipped", message: "原会话无权访问" } }); await runner.tick();
    let committed = false;
    f.deps.report = vi.fn(async () => {
      if (!committed) {
        committed = true;
        f.setNext({ job: { id: "job", status: "running", message: null }, task: { ...task,
          itemId: "next", leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
        throw new Error("response lost after commit");
      }
      return { ok: true, status: "skipped" };
    });
    vi.mocked(f.deps.next).mockClear();
    await runner.tick();
    expect(f.saved()?.result?.outcome).toBe("skipped");
    expect(f.deps.next).not.toHaveBeenCalled();
    await f.runner().tick();
    expect(f.deps.report).toHaveBeenCalledTimes(2);
    expect(f.deps.next).not.toHaveBeenCalled();
    expect(safety).toMatchObject({ completed: 1, consecutiveErrors: 1, lastItemId: "item", nextAllowedAt: 61_000 });
    await f.runner().tick(); expect(f.deps.next).not.toHaveBeenCalled();
    f.time(61_000); await f.runner().tick();
    expect(f.deps.next).toHaveBeenCalledOnce();
    expect(f.deps.open).toHaveBeenCalledTimes(2);
  });
  it("does not lose a confirmed report or its safety count when persisting safety temporarily fails", async () => {
    const f = fixture();
    f.deps.saveSafety = vi.fn(async () => { throw new Error("storage temporarily unavailable"); });
    const runner = f.runner(); await runner.tick();
    f.setContent({ result: { outcome: "skipped", message: "原会话无权访问" } }); await runner.tick();
    f.deps.report = vi.fn(async () => ({ ok: true }));
    await runner.tick();
    expect(f.saved()?.result?.outcome).toBe("skipped");
    f.deps.saveSafety = vi.fn(async () => {});
    vi.mocked(f.deps.next).mockClear();
    await runner.tick();
    expect(f.deps.next).not.toHaveBeenCalled();
    expect(f.deps.saveSafety).toHaveBeenCalledWith(expect.objectContaining({ completed: 1, consecutiveErrors: 1 }));
    expect(f.saved()).toBeNull();
  });
  it("does not count the same confirmed failure twice if tab cleanup interrupts the report finalization", async () => {
    const f = fixture();
    let safety: BatchSafetyState = { jobId: "job", completed: 1, consecutiveErrors: 1, nextAllowedAt: 0 };
    f.deps.loadSafety = async () => structuredClone(safety);
    f.deps.saveSafety = async value => { safety = structuredClone(value); };
    const runner = f.runner(); await runner.tick();
    f.setContent({ result: { outcome: "skipped", message: "原会话无权访问" } }); await runner.tick();
    f.deps.report = vi.fn(async () => ({ ok: true, status: "skipped" }));
    vi.mocked(f.deps.tab).mockRejectedValueOnce(new Error("tab query interrupted"));
    await runner.tick();
    expect(safety).toMatchObject({ completed: 2, consecutiveErrors: 2 });
    await runner.tick();
    expect(safety).toMatchObject({ completed: 2, consecutiveErrors: 2 });
    expect(f.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "skipped" }));
    expect(f.saved()).toBeNull();
  });
  it("keeps a report pending on a transient receipt-not-ingested conflict", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setContent({ result: { captureId: "still-uploading" } }); await runner.tick();
    vi.mocked(f.deps.report).mockRejectedValueOnce(new BatchRecaptureHttpError("采集尚未入库或与本条任务不匹配", 409));
    vi.mocked(f.deps.next).mockClear(); await runner.tick();
    expect(f.saved()?.result?.captureId).toBe("still-uploading");
    expect(f.deps.next).not.toHaveBeenCalled();
    expect(f.deps.close).not.toHaveBeenCalled();
    await runner.tick(); expect(f.saved()).toBeNull();
  });
  it.each(["补采任务已失效，请重新获取队列", "补采队列已取消"])("releases an unreportable lease with a cooldown instead of retrying forever: %s", async message => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setContent({ result: { captureId: "lease-ended" } }); await runner.tick();
    vi.mocked(f.deps.report).mockRejectedValueOnce(new BatchRecaptureHttpError(message, 409));
    vi.mocked(f.deps.next).mockClear(); await runner.tick();
    expect(f.saved()).toBeNull(); expect(f.deps.close).toHaveBeenCalledWith(7);
    expect(f.deps.next).not.toHaveBeenCalled();
    await runner.tick(); expect(f.deps.next).not.toHaveBeenCalled();
    f.time(61_000); await runner.tick(); expect(f.deps.next).toHaveBeenCalledOnce();
  });
  it("turns a persistently unconfirmed upload into attention without claiming another item", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setContent({ result: { captureId: "unconfirmed" } }); await runner.tick();
    vi.mocked(f.deps.report).mockRejectedValueOnce(new BatchRecaptureHttpError("采集尚未入库或与本条任务不匹配", 409));
    vi.mocked(f.deps.next).mockClear(); f.time(9 * 60_000 + 1); await runner.tick();
    expect(f.saved()?.result).toMatchObject({ outcome: "attention" });
    await runner.tick();
    expect(f.deps.report).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "attention" }));
    expect(f.saved()?.parked).toBe(true); expect(f.deps.next).not.toHaveBeenCalled();
    expect(f.deps.close).not.toHaveBeenCalled();
  });
  it("requires an explicit server acknowledgement before dropping the persisted report", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setContent({ result: { captureId: "receipt" } }); await runner.tick();
    vi.mocked(f.deps.report).mockResolvedValueOnce({ job: null, task: null });
    vi.mocked(f.deps.next).mockClear(); await runner.tick();
    expect(f.saved()?.result?.captureId).toBe("receipt");
    expect(f.deps.next).not.toHaveBeenCalled();
    expect(f.deps.close).not.toHaveBeenCalled();
  });
  it("never closes or navigates a tab the user moved to another conversation", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setTab({ url: "https://chatgpt.com/c/my-current-work", status: "complete" });
    await runner.tick(); await runner.tick();
    expect(f.deps.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: "attention" }));
    expect(f.deps.close).not.toHaveBeenCalled();
    expect(f.saved()?.parked).toBe(true);
  });
  it("continues the exact source conversation after a same-document router removes only its batch hash", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setTab({ url: task.url, status: "complete" });
    f.setContent({ running: false, batchOwner: task.leaseToken });
    await runner.tick();
    expect(f.saved()?.result).toBeUndefined();
    expect(f.deps.send).toHaveBeenCalledWith(7, expect.objectContaining({ type: "startBatchCapture", operationId: task.leaseToken }));
  });
  it("closes a completed hash-normalized source document only with its live ownership proof", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setTab({ url: task.url, status: "complete" });
    f.setContent({ batchOwner: task.leaseToken, result: { captureId: "owned-normalized" } });
    await runner.tick(); await runner.tick();
    expect(f.deps.report).toHaveBeenCalledWith(expect.objectContaining({ captureId: "owned-normalized" }));
    expect(f.deps.close).toHaveBeenCalledWith(7);
  });
  it.each([undefined, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"])("does not adopt a hash-free page without matching live ownership (%s)", async batchOwner => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setTab({ url: task.url, status: "complete" }); f.setContent({ batchOwner });
    await runner.tick(); await runner.tick();
    expect(f.deps.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: "attention" }));
    expect(f.deps.close).not.toHaveBeenCalled();
  });
  it("does not close a tab navigated during the live-document cancellation round trip", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setContent({ result: { captureId: "captured" } }); await runner.tick();
    const originalSend = f.deps.send;
    f.deps.send = vi.fn(async (id, message: any) => {
      if (message.type === "cancelBatchCapture") f.setTab({ url: "https://chatgpt.com/c/my-current-work", status: "complete" });
      return originalSend(id, message);
    });
    await runner.tick();
    expect(f.deps.close).not.toHaveBeenCalled();
  });
  it("keeps the login or rate-limit page available while the queue is paused", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setContent({ result: { outcome: "attention", message: "需要登录" } });
    await runner.tick(); await runner.tick();
    f.setNext({ job: { id: "job", status: "paused", message: "需要登录" }, task: null });
    await runner.tick();
    expect(f.deps.close).not.toHaveBeenCalled(); expect(f.saved()?.parked).toBe(true);
  });
  it("finishes a leased item during a user pause, but starts no next task", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setNext({ job: { id: "job", status: "paused", message: null }, task });
    f.setContent({ result: { captureId: "captured-before-pause" } });
    await runner.tick(); await runner.tick();
    expect(f.deps.report).toHaveBeenCalledTimes(1); expect(f.deps.open).toHaveBeenCalledTimes(1);
  });
  it("aborts and closes only its owned tab after cancellation", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setNext({ job: null, task: null }); await runner.tick();
    expect(f.deps.send).toHaveBeenCalledWith(7, { type: "cancelBatchCapture", operationId: task.leaseToken });
    expect(f.deps.close).toHaveBeenCalledWith(7); expect(f.saved()).toBeNull();
  });
  it("pauses when the page has no connected content script after its load deadline", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    vi.mocked(f.deps.send).mockRejectedValue(new Error("no receiving end")); f.time(91_000); await runner.tick();
    expect(f.saved()?.result).toMatchObject({ outcome: "attention" });
  });
  it("bounds a stuck scan without starting a second capture", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick(); f.setContent({ running: true });
    f.time(9 * 60_000 + 1); await runner.tick();
    expect(f.deps.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
    expect(f.deps.open).toHaveBeenCalledTimes(1);
  });
  it("skips an inaccessible conversation redirected home, closes only its proven document and takes the next task", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setTab({ url: "https://chatgpt.com/", status: "complete" });
    f.setContent({ running: false, batchOwner: task.leaseToken, pageIssue: { outcome: "skipped", message: "原会话无权访问" } });
    await runner.tick(); await runner.tick();
    expect(f.deps.report).toHaveBeenCalledWith(expect.objectContaining({ outcome: "skipped" }));
    expect(f.deps.close).toHaveBeenCalledWith(7); expect(f.saved()).toBeNull();
    f.setNext({ job: { id: "job", status: "running", message: null }, task: { ...task, itemId: "next", leaseToken: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" } });
    await runner.tick(); expect(f.deps.open).toHaveBeenCalledTimes(1);
    f.time(61_000); await runner.tick(); expect(f.deps.open).toHaveBeenCalledTimes(2);
  });
  it("never closes a redirected document without proof of ownership", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setTab({ url: "https://chatgpt.com/", status: "complete" });
    f.setContent({ pageIssue: { outcome: "skipped", message: "原会话不可访问" } });
    await runner.tick(); await runner.tick();
    expect(f.deps.close).not.toHaveBeenCalled(); expect(f.saved()).toBeNull();
  });
  it("waits for a transient home redirect then pauses on a page that never loads", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    f.setTab({ url: "https://chatgpt.com/", status: "complete" });
    await runner.tick(); expect(f.saved()?.result).toBeUndefined();
    f.time(91_000); await runner.tick(); expect(f.saved()?.result?.outcome).toBe("attention");
  });
  it.each(["需要登录", "验证码", "暂时限流"])("preserves a global blocking page: %s", message => {
    return (async () => {
      const f = fixture(); const runner = f.runner(); await runner.tick();
      f.setTab({ url: "https://chatgpt.com/", status: "complete" });
      f.setContent({ pageIssue: { outcome: "attention", message } });
      await runner.tick(); await runner.tick();
      expect(f.saved()?.parked).toBe(true); expect(f.deps.close).not.toHaveBeenCalled();
    })();
  });
  it("pauses on an empty but connected source page at its load deadline", async () => {
    const f = fixture(); const runner = f.runner(); await runner.tick();
    vi.mocked(f.deps.send).mockImplementation(async (_id, message: any) => message.type === "getContentState"
      ? { provider: "chatgpt", sessionId: task.sessionId, messageCount: 0 } : { running: false });
    f.time(91_000); await runner.tick(); expect(f.saved()?.result?.outcome).toBe("attention");
  });
  it("rejects untrusted server links instead of opening arbitrary sites", async () => {
    const f = fixture(); f.setNext({ job: null, task: { ...task, url: "https://example.org/login" } });
    await f.runner().tick(); expect(f.deps.open).not.toHaveBeenCalled();
    expect(() => batchTaskUrl({ ...task, sessionId: "../logout" })).toThrow();
  });
});
