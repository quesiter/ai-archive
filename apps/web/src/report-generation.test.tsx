import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api.js";
import {
  createReportGenerationController,
  ReportGenerationDetails,
  ReportRegenerateButton,
  type ReportGenerationRun,
  type ReportGenerationState,
} from "./report-generation.js";

function run(status: string, generationId = "new-generation"): ReportGenerationRun {
  return { id: "same-period-run", status, stats: { generationId, regeneratingReportId: "weekly-report" } };
}

function state(run: ReportGenerationRun | null = null): ReportGenerationState {
  return { run, loading: false, submitting: false, loadError: "", submitError: "", message: "" };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup(request = vi.fn<typeof api>()) {
  let latest = state();
  const onCompleted = vi.fn();
  const controller = createReportGenerationController({
    reportId: "weekly-report", request: request as typeof api, onCompleted,
    onChange: (next) => { latest = next; },
  });
  return { request, controller, onCompleted, latest: () => latest };
}

afterEach(() => { vi.useRealTimers(); });

describe("report regeneration", () => {
  it("does not mistake an old completed run for a successful request after a network error", async () => {
    vi.useFakeTimers();
    const previous = run("completed", "old-generation");
    const task = setup();
    task.request.mockResolvedValueOnce({ run: previous })
      .mockRejectedValueOnce(new Error("Network unavailable"))
      .mockResolvedValueOnce({ run: previous });
    await task.controller.start();
    expect(task.onCompleted).not.toHaveBeenCalled();
    await task.controller.regenerate();
    await vi.advanceTimersByTimeAsync(2500);
    expect(task.onCompleted).not.toHaveBeenCalled();
    expect(task.latest().message).toBe("");
    expect(task.latest().submitError).toContain("Network unavailable");
    expect(task.latest().submitting).toBe(false);
    task.controller.dispose();
  });

  it("refreshes the report once after the newly submitted generation finishes and then stops polling", async () => {
    vi.useFakeTimers();
    const task = setup();
    task.request.mockResolvedValueOnce({ run: run("completed", "old-generation") })
      .mockResolvedValueOnce({ jobId: "job", run: run("queued") })
      .mockResolvedValueOnce({ run: run("running") })
      .mockResolvedValueOnce({ run: run("completed") });
    await task.controller.start();
    await task.controller.regenerate();
    expect(task.request.mock.calls[1]?.[0]).toBe("/api/v1/reports/weekly-report/regenerate");
    expect(task.request.mock.calls[1]?.[1]?.method).toBe("POST");
    expect(task.request.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(task.latest().run?.status).toBe("queued");
    await vi.advanceTimersByTimeAsync(2500);
    expect(task.latest().run?.status).toBe("running");
    expect(task.onCompleted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(task.onCompleted).toHaveBeenCalledTimes(1);
    expect(task.latest().message).toContain("重新生成已完成");
    await vi.advanceTimersByTimeAsync(10000);
    expect(task.request).toHaveBeenCalledTimes(4);
    task.controller.dispose();
  });

  it("resumes polling an active generation after a temporary status request failure", async () => {
    vi.useFakeTimers();
    const task = setup();
    task.request.mockResolvedValueOnce({ run: run("running") })
      .mockRejectedValueOnce(new Error("Connection lost"))
      .mockResolvedValueOnce({ run: run("completed") });
    await task.controller.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(task.latest().loadError).toContain("Connection lost");
    expect(task.latest().run?.status).toBe("running");
    await vi.advanceTimersByTimeAsync(2500);
    expect(task.latest().loadError).toBe("");
    expect(task.onCompleted).toHaveBeenCalledTimes(1);
    task.controller.dispose();
  });

  it("keeps a failed generation retryable without refreshing the saved report", async () => {
    vi.useFakeTimers();
    const failed = { ...run("failed"), error: "正文缺少本周主要讨论章节" };
    const task = setup();
    task.request.mockResolvedValueOnce({ run: run("running") })
      .mockResolvedValueOnce({ run: failed });
    await task.controller.start();
    await vi.advanceTimersByTimeAsync(2500);
    expect(task.onCompleted).not.toHaveBeenCalled();
    const html = renderToStaticMarkup(<ReportGenerationDetails state={task.latest()} />);
    expect(html).toContain("生成失败，已保留当前正文");
    expect(html).toContain("正文缺少本周主要讨论章节");
    expect(renderToStaticMarkup(<ReportRegenerateButton state={task.latest()} onRegenerate={() => {}} />)).not.toContain("disabled");
    task.controller.dispose();
  });

  it("submits only one request for a double click and cancels its pending request on navigation", async () => {
    const pending = deferred<{ run: ReportGenerationRun }>();
    const task = setup();
    task.request.mockResolvedValueOnce({ run: run("completed", "old-generation") }).mockReturnValueOnce(pending.promise);
    await task.controller.start();
    const first = task.controller.regenerate();
    await task.controller.regenerate();
    expect(task.request).toHaveBeenCalledTimes(2);
    expect(task.latest().submitting).toBe(true);
    const signal = task.request.mock.calls[1]?.[1]?.signal;
    task.controller.dispose();
    expect(signal?.aborted).toBe(true);
    pending.resolve({ run: run("completed") });
    await first;
    expect(task.onCompleted).not.toHaveBeenCalled();
  });

  it("ignores an outdated status response that resolves after a regeneration submission", async () => {
    vi.useFakeTimers();
    const pendingRead = deferred<{ run: ReportGenerationRun }>();
    const task = setup();
    task.request.mockReturnValueOnce(pendingRead.promise).mockResolvedValueOnce({ run: run("queued") });
    const reading = task.controller.start();
    await task.controller.regenerate();
    expect(task.request.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    pendingRead.resolve({ run: run("completed", "old-generation") });
    await reading;
    expect(task.latest().run?.status).toBe("queued");
    expect(task.onCompleted).not.toHaveBeenCalled();
    task.controller.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(task.request).toHaveBeenCalledTimes(2);
  });
});

describe("report generation diagnostics", () => {
  it("shows the latest attempts and escapes model content inside collapsed diagnostic details", () => {
    const latest = run("failed");
    latest.stats!.responseDiagnostics = [{
      attempt: 1, model: "report-model", responseChars: 321, finishReason: "length", status: "rejected",
      error: "正文不完整", content: '<script>alert("raw response")</script>', contentTruncated: true,
      usage: { completionTokens: 100 }, recordedAt: "2026-09-14T00:00:00Z",
    }];
    const html = renderToStaticMarkup(<ReportGenerationDetails state={state(latest)} />);
    expect(html).toContain("最近一次生成诊断（1 次尝试）");
    expect(html).toContain("第 1 次尝试 · 未通过校验");
    expect(html).toContain("report-model");
    expect(html).toContain("结束原因：length");
    expect(html).toContain("响应长度：321 字符");
    expect(html).toContain("输出 token：100");
    expect(html).toContain("原始响应（已脱敏，已截断）");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('open=""');
  });

  it("explains missing legacy diagnostics without claiming an old completed run was regenerated", () => {
    const html = renderToStaticMarkup(<ReportGenerationDetails state={state(run("completed", "legacy"))} />);
    expect(html).toContain("早期生成任务未记录原始响应");
    expect(html).not.toContain("重新生成已完成");
    expect(html).toContain("此次操作不会发送邮件");
  });

  it.each(["queued", "running"])("disables regeneration while %s", (status) => {
    const html = renderToStaticMarkup(<ReportRegenerateButton state={state(run(status))} onRegenerate={() => {}} />);
    expect(html).toContain('disabled=""');
    expect(html).toContain("重新生成中");
  });
});
