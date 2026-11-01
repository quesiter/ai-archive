// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { batchDiagnosticIssue, classifyBatchNotice, readBatchPageIssue } from "../lib/batch-page-state";

describe("batch source-page failures", () => {
  it("skips the actual permission toast even when it suggests checking the account", () => {
    expect(classifyBatchNotice("你无权访问此对话。请确认已登录正确的账户，或请对话所有者向你发送分享链接。")?.outcome).toBe("skipped");
    expect(classifyBatchNotice("You do not have access to this conversation. Please log in to the correct account.")?.outcome).toBe("skipped");
  });
  it.each(["Conversation not found", "对话已删除"])("skips a local source error: %s", text => {
    expect(classifyBatchNotice(text)?.outcome).toBe("skipped");
  });
  it.each(["Too many requests", "Verify you are human", "登录已过期，请重新登录", "Unable to load conversation 123", "Unusual activity detected", "账户异常"])("pauses a shared browser problem: %s", text => {
    expect(classifyBatchNotice(text)?.outcome).toBe("attention");
  });
  it("ignores error phrases in conversation messages and hidden notices", () => {
    document.body.innerHTML = '<article data-testid="conversation-turn-4"><h2>Conversation not found</h2><div role="alert">Too many requests</div></article><div role="alert" hidden>请重新登录</div><div role="alert" style="display:none">对话不存在</div>';
    expect(readBatchPageIssue(document)).toBeUndefined();
  });
  it("reads the actual toast and gives login or challenge UI priority", () => {
    document.body.innerHTML = '<div role="alert">你无权访问此对话。请确认已登录正确的账户。</div>';
    expect(readBatchPageIssue(document)?.outcome).toBe("skipped");
    document.body.insertAdjacentHTML("beforeend", '<button data-testid="login-button">登录</button>');
    expect(readBatchPageIssue(document)?.outcome).toBe("attention");
  });
  it("ignores login and challenge controls inside hidden ancestors without relying on layout dimensions", () => {
    document.body.innerHTML = '<main><article data-message-author-role="user">Loaded conversation</article></main><div style="display:none"><button data-testid="login-button">登录</button><iframe src="https://challenges.cloudflare.com/widget"></iframe></div>';
    expect(readBatchPageIssue(document)).toBeUndefined();
    document.querySelector("div")!.removeAttribute("style");
    expect(readBatchPageIssue(document)?.outcome).toBe("attention");
  });
  it("ignores notices hidden by an ancestor stylesheet rule", () => {
    document.body.innerHTML = '<style>.inactive-shell { display:none }</style><div class="inactive-shell"><div role="alert">请重新登录</div></div>';
    expect(readBatchPageIssue(document)).toBeUndefined();
  });
  it.each([
    'data-message-id="message-1"', 'id="conversation-turn-3"',
    'data-chatgpt-selection-message-id="message-2"',
    'data-chatgpt-search-unit-key="turn:assistant"',
    'data-content-search-unit-key="turn:user"',
  ])("does not read source errors or login links from a current message wrapper (%s)", wrapper => {
    document.body.innerHTML = `<article ${wrapper}><h2>Conversation not found</h2><div role="alert">Too many requests</div><a href="/auth/login">Log in</a></article>`;
    expect(readBatchPageIssue(document)).toBeUndefined();
    document.body.insertAdjacentHTML("beforeend", '<div role="alert">Too many requests</div>');
    expect(readBatchPageIssue(document)?.outcome).toBe("attention");
  });
  it("distinguishes conversation authorization from an expired browser session", () => {
    expect(batchDiagnosticIssue({ stage: "conversation", code: "http_error", httpStatus: 403 })?.outcome).toBe("attention");
    expect(batchDiagnosticIssue({ stage: "conversation", code: "http_error", httpStatus: 404 })?.outcome).toBe("skipped");
    expect(batchDiagnosticIssue({ stage: "conversation", code: "http_error", httpStatus: 401 })?.outcome).toBe("attention");
    expect(batchDiagnosticIssue({ stage: "auth", code: "http_error", httpStatus: 403 })?.outcome).toBe("attention");
    expect(batchDiagnosticIssue({ stage: "conversation", code: "rate_limited", httpStatus: 429 })?.outcome).toBe("attention");
    expect(batchDiagnosticIssue({ stage: "conversation", code: "network_error" })).toBeUndefined();
  });
});
