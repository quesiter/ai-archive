import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RecaptureJob } from "@ai-archive/contracts";
import { api, ApiError } from "./api.js";
import { createRecaptureController, RecaptureView, recaptureRequestError } from "./recapture-panel.js";

const device = { id: "chrome-one", name: "Chrome 家用", kind: "chrome_extension", revokedAt: null, lastSeenAt: "2026-10-26T00:00:00Z", clientVersion: "reported-build-17" };
function job(status: RecaptureJob["status"] = "running"): RecaptureJob {
  return { id: "job-one", deviceId: device.id, deviceName: device.name, status, message: status === "paused" ? "已暂停" : "逐条采集中",
    lastRunnerSeenAt: null, createdAt: "2026-10-26T00:00:00Z",
    counts: { pending: 16, running: 0, complete: 7, partial: 0, failed: 0, skipped: 122 }, items: [] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
function setup() {
  let clock = 0;
  const jobs: Array<() => Promise<unknown>> = [];
  const devices: Array<() => Promise<unknown>> = [];
  const mutations: Array<() => Promise<unknown>> = [];
  const onChange = vi.fn();
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (init?.method === "POST") return mutations.shift()?.() ?? { count: 145, excluded: 0 };
    if (path === "/api/v1/devices") return devices.shift()?.() ?? [device];
    if (path === "/api/v1/recapture/jobs") return jobs.shift()?.() ?? [job()];
    throw new Error(`Unexpected endpoint ${path}`);
  });
  const controller = createRecaptureController({ request: request as typeof api, onChange, now: () => clock });
  const reads = () => request.mock.calls.filter(([path, init]) => path === "/api/v1/recapture/jobs" && init?.method !== "POST");
  const posts = () => request.mock.calls.filter(([, init]) => init?.method === "POST");
  return { controller, request, onChange, jobs, devices, mutations, reads, posts, advance: (ms: number) => { clock += ms; } };
}

afterEach(() => vi.useRealTimers());

describe("recapture polling and actions", () => {
  it("clears only a recovered progress error and retains the last successful task data during failure", async () => {
    const s = setup();
    await s.controller.start();
    s.jobs.push(async () => { throw new ApiError("数据库暂不可用", 500); });
    await s.controller.poll();
    expect(s.controller.getState()).toMatchObject({ jobs: [job()], loading: false, jobsError: expect.stringContaining("HTTP 500") });
    expect(s.controller.getState().jobsError).toContain("任务进度刷新失败");
    s.advance(5_000);
    await s.controller.poll();
    expect(s.controller.getState()).toMatchObject({ jobsError: "", jobs: [job()], refreshing: false });
    s.controller.dispose();
  });

  it("coalesces slow poll requests instead of overlapping every timer tick", async () => {
    const s = setup();
    await s.controller.start();
    const pending = deferred<RecaptureJob[]>();
    s.jobs.push(() => pending.promise);
    const polls = [s.controller.poll(), s.controller.poll(), s.controller.poll()];
    expect(s.reads()).toHaveLength(2);
    pending.resolve([job("paused")]);
    await Promise.all(polls);
    expect(s.controller.getState().jobs[0]?.status).toBe("paused");
    s.controller.dispose();
  });

  it.each(["success", "failure"])("ignores an old poll %s after an action refreshed newer state", async (settlement) => {
    const s = setup();
    await s.controller.start();
    const old = deferred<RecaptureJob[]>();
    s.jobs.push(() => old.promise);
    const oldPoll = s.controller.poll();
    s.jobs.push(async () => [job("paused")]);
    await s.controller.action("job-one", "pause");
    expect(s.reads()[1]?.[1]?.signal?.aborted).toBe(true);
    if (settlement === "success") old.resolve([job()]); else old.reject(new ApiError("旧请求失败", 500));
    await oldPoll;
    expect(s.controller.getState()).toMatchObject({ jobs: [job("paused")], jobsError: "", actionError: "" });
    s.controller.dispose();
  });

  it("keeps mutation failures distinct from successful background polling without replaying POST", async () => {
    const s = setup();
    await s.controller.start();
    s.mutations.push(async () => { throw new ApiError("服务暂时失败", 500); });
    expect(await s.controller.action("job-one", "resume")).toBe(false);
    const error = s.controller.getState().actionError;
    expect(error).toContain("继续任务失败（HTTP 500）");
    await s.controller.poll();
    expect(s.controller.getState()).toMatchObject({ actionError: error, jobsError: "", busy: false });
    expect(s.posts()).toHaveLength(1);
    s.controller.dispose();
  });

  it("labels an accepted action followed by failed GET accurately, observes Retry-After and recovers its status", async () => {
    const s = setup();
    await s.controller.start();
    const limited = Object.assign(new ApiError("请求过于频繁", 429), { retryAfterMs: 30_000 });
    s.jobs.push(async () => { throw limited; });
    expect(await s.controller.action("job-one", "pause")).toBe(true);
    expect(s.controller.getState()).toMatchObject({ actionError: "", jobsError: expect.stringContaining("HTTP 429"), message: expect.stringContaining("操作已提交") });
    expect(s.controller.getState().message).toContain("无需重复提交");
    s.advance(10_000);
    await s.controller.poll();
    expect(s.reads()).toHaveLength(2);
    s.advance(20_000);
    s.jobs.push(async () => [job("paused")]);
    await s.controller.poll();
    expect(s.controller.getState()).toMatchObject({ jobsError: "", message: "操作已提交：暂停任务。", jobs: [job("paused")] });
    expect(s.posts()).toHaveLength(1);
    s.controller.dispose();
  });

  it("serializes action clicks and pauses timer reads while POST is pending", async () => {
    const s = setup();
    await s.controller.start();
    const pending = deferred<unknown>();
    s.mutations.push(() => pending.promise);
    const first = s.controller.action("job-one", "pause");
    expect(await s.controller.action("job-one", "pause")).toBe(false);
    expect(await s.controller.poll()).toBe(false);
    expect(s.posts()).toHaveLength(1);
    expect(s.reads()).toHaveLength(1);
    pending.resolve({});
    await first;
    expect(s.reads()).toHaveLength(2);
    expect(s.controller.getState().busy).toBe(false);
    s.controller.dispose();
  });

  it("keeps a devices failure until that endpoint recovers instead of clearing it with job polling", async () => {
    const s = setup();
    s.devices.push(async () => { throw new ApiError("设备查询失败", 502); });
    await s.controller.start();
    const error = s.controller.getState().devicesError;
    expect(error).toContain("执行设备加载失败（HTTP 502）");
    await s.controller.poll();
    expect(s.controller.getState().devicesError).toBe(error);
    await s.controller.refresh();
    expect(s.controller.getState()).toMatchObject({ devicesError: "", devices: [device], deviceId: device.id });
    s.controller.dispose();
  });

  it("stops repetitive unauthorized GETs but permits an explicit recovery refresh", async () => {
    const s = setup();
    s.jobs.push(async () => { throw new ApiError("登录已过期", 401); });
    await s.controller.start();
    s.advance(60_000);
    await s.controller.poll();
    expect(s.reads()).toHaveLength(1);
    expect(s.controller.getState().autoRefreshBlocked).toBe(true);
    await s.controller.refresh();
    expect(s.controller.getState()).toMatchObject({ autoRefreshBlocked: false, jobsError: "" });
    s.controller.dispose();
  });

  it("aborts unmounted reads and ignores their late success or failure", async () => {
    const s = setup();
    const jobs = deferred<RecaptureJob[]>();
    const devices = deferred<unknown[]>();
    s.jobs.push(() => jobs.promise);
    s.devices.push(() => devices.promise);
    const starting = s.controller.start();
    const changeCount = s.onChange.mock.calls.length;
    s.controller.dispose();
    expect(s.request.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
    jobs.reject(new ApiError("已离开页面的请求", 500));
    devices.resolve([device]);
    await starting;
    expect(s.onChange).toHaveBeenCalledTimes(changeCount);
  });

  it("bounds a stuck GET and reports timeout instead of staying loading forever", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === "/api/v1/devices") return [device];
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    });
    const controller = createRecaptureController({ request: request as typeof api, onChange: vi.fn() });
    const starting = controller.start();
    await vi.advanceTimersByTimeAsync(20_000);
    await starting;
    expect(controller.getState()).toMatchObject({ loading: false, refreshing: false, jobsError: expect.stringContaining("20 秒") });
    controller.dispose();
  });

  it("does not replay a timed-out mutation and releases the action controls", async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
      if (init?.method === "POST") return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
      return path === "/api/v1/devices" ? [device] : [job()];
    });
    const controller = createRecaptureController({ request: request as typeof api, onChange: vi.fn() });
    await controller.start();
    const mutation = controller.action("job-one", "pause");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await mutation).toBe(false);
    expect(controller.getState()).toMatchObject({ busy: false, actionError: expect.stringContaining("30 秒"), message: expect.stringContaining("结果未确认") });
    await controller.poll();
    expect(request.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    controller.dispose();
  });

  it("preserves the selected-conversation create payload and never creates jobs merely by polling", async () => {
    const s = setup();
    s.jobs.push(async () => []);
    await s.controller.start();
    await s.controller.poll();
    expect(s.posts()).toHaveLength(0);
    await s.controller.create(false, ["conversation-one", "conversation-two"]);
    expect(s.posts()).toHaveLength(1);
    expect(JSON.parse(String(s.posts()[0]?.[1]?.body))).toEqual({ deviceId: device.id, conversationIds: ["conversation-one", "conversation-two"] });
    expect(s.controller.getState().message).toContain("已加入 145 条");
    s.controller.dispose();
  });
});

describe("recapture error and version presentation", () => {
  it("always gives an empty or generic ApiError a request source and HTTP status", () => {
    expect(recaptureRequestError("任务进度刷新", new ApiError("", 502))).toContain("HTTP 502");
    expect(recaptureRequestError("任务进度刷新", new ApiError("Error", 429))).toContain("请求过于频繁");
    expect(recaptureRequestError("执行设备加载", new TypeError("Failed to fetch"))).toContain("执行设备加载失败");
  });

  it("renders real reported device version and actionable scoped failures without stale hardcoded release claims", async () => {
    const s = setup();
    await s.controller.start();
    const state = { ...s.controller.getState(), jobs: [job("paused")], jobsError: "任务进度刷新失败（HTTP 502）：服务器暂时不可用。" };
    const html = renderToStaticMarkup(<MemoryRouter><RecaptureView state={state} selectedIds={[]} onRefresh={() => {}} onSelectDevice={() => {}} onCreate={() => {}} onAction={() => {}} /></MemoryRouter>);
    expect(html).toContain(`执行设备上报版本：${device.clientVersion}`);
    expect(html).not.toMatch(/V2\.4\.4|1\.2\.17/);
    expect(html).toContain('href="/devices"');
    expect(html).toContain('data-error-source="jobs"');
    expect(html).toContain("HTTP 502");
    expect(html).toContain("129/145");
    expect(html).toContain("已暂停");
    s.controller.dispose();
  });
});
