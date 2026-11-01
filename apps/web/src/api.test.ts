import { afterEach, expect, it, vi } from "vitest";
import { api, ApiError } from "./api";

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it("uses the HTTP code when an HTTP/2 proxy error has an empty reason and no JSON", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 502, statusText: "" })));
  await expect(api("/api/v1/recapture/jobs")).rejects.toMatchObject({ status: 502, message: expect.stringContaining("HTTP 502") });
});

it.each([null, {}, { error: "" }, { error: "Error" }, { error: { detail: "not a string" } }])("does not render an empty or object error: %j", async payload => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status: 503, statusText: "" })));
  await expect(api("/test")).rejects.toMatchObject({ message: expect.stringContaining("HTTP 503"), status: 503 });
});

it("retains a useful server message and Retry-After seconds for throttling", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "请等待设备连接" }), {
    status: 429, headers: { "Retry-After": "30" },
  })));
  await expect(api("/test")).rejects.toMatchObject({ message: "请等待设备连接", status: 429, retryAfterMs: 30_000 });
});

it("accepts a structured API message and HTTP-date retry delay", async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-26T01:00:00Z"));
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: "Temporarily unavailable" }), {
    status: 503, headers: { "Retry-After": "Mon, 26 Oct 2026 01:01:00 GMT" },
  })));
  await expect(api("/test")).rejects.toMatchObject({ message: "Temporarily unavailable", retryAfterMs: 60_000 });
});

it("does not display a proxy HTML body", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>private gateway diagnostics</html>", { status: 500 })));
  await expect(api("/test")).rejects.toMatchObject({ status: 500, message: "HTTP 500：服务器处理失败，请稍后重试" });
});

it("distinguishes network interruption from an intentional request abort", async () => {
  const fetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch")); vi.stubGlobal("fetch", fetch);
  await expect(api("/test")).rejects.toMatchObject({ status: 0, message: expect.stringContaining("网络连接失败") });
  const abort = new DOMException("Aborted", "AbortError");fetch.mockRejectedValueOnce(abort);
  await expect(api("/test")).rejects.toBe(abort);
});

it("handles successful JSON, empty responses and malformed success responses", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(new Response("<html>not JSON</html>", { status: 200 })));
  expect(await api("/test")).toEqual({ ok: true });
  expect(await api("/test")).toBeUndefined();
  await expect(api("/test")).rejects.toBeInstanceOf(ApiError);
});
