import type { NativeConversationReadDiagnostic } from "./native-conversation";

export interface BatchPageIssue { outcome: "skipped" | "attention"; message: string }
const CONVERSATION_CONTENT = '[data-message-author-role], [data-message-id], [data-testid^="conversation-turn"], [id^="conversation-turn-"], [data-chatgpt-selection-message-id], [data-chatgpt-search-unit-key], [data-content-search-unit-key], #ai-archive-indicator';

function visibleSourceUi(element: Element, document: Document): boolean {
  // Do not use box dimensions: display:contents and test DOMs can have no box.
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current.hasAttribute("hidden") || current.getAttribute("aria-hidden") === "true") return false;
    const style = document.defaultView?.getComputedStyle(current);
    if (style?.display === "none" || style?.visibility === "hidden" || style?.visibility === "collapse" || style?.opacity === "0") return false;
  }
  return true;
}
function sourceUi(element: Element, document: Document): boolean {
  return !element.closest(CONVERSATION_CONTENT) && visibleSourceUi(element, document);
}

/** Only source-site UI notices are input here, never conversation text. */
export function classifyBatchNotice(text: string): BatchPageIssue | undefined {
  if (/unusual activity|suspicious activity|account.{0,20}(suspended|restricted|disabled)|异常活动|异常行为|可疑活动|账户异常|账号异常|账户.{0,8}(限制|停用|封禁)/i.test(text))
    return { outcome: "attention", message: "ChatGPT 提示账户或访问异常，队列已暂停；请停止批量采集并检查账户" };
  if (/unable to load conversation|无法加载.{0,8}(会话|对话)/i.test(text))
    return { outcome: "attention", message: "原会话暂时无法加载，队列已暂停；请检查页面和账户后再继续" };
  if (/too many requests|rate limit|请求过于频繁|请求太多|限流/i.test(text))
    return { outcome: "attention", message: "ChatGPT 暂时限流，队列已暂停；稍后继续" };
  if (/verify you are human|verifying your browser|checking your browser|确认您是人类|验证您是人类|安全验证|验证码/i.test(text))
    return { outcome: "attention", message: "ChatGPT 需要完成安全验证，请处理后继续队列" };
  // Access errors sometimes include a suggestion to check the signed-in account.
  // That suggestion does not mean this browser's login session has expired.
  if (/无权访问此对话|没有权限访问.{0,8}(对话|会话)|对话不存在|会话不存在|对话已删除|会话已删除|do not have (access|permission).{0,30}conversation|don't have (access|permission).{0,30}conversation|conversation (not found|unavailable)|unable to load conversation/i.test(text))
    return { outcome: "skipped", message: "原会话无权访问、已删除或无法加载，已自动跳过" };
  if (/session (has )?expired|please (log|sign) in|登录已过期|登录失效|请重新登录/i.test(text))
    return { outcome: "attention", message: "ChatGPT 登录已失效，请登录后继续队列" };
  return undefined;
}

export function readBatchPageIssue(document: Document): BatchPageIssue | undefined {
  const candidates = document.querySelectorAll('[role="alert"], [role="status"], [data-sonner-toast], [data-testid*="toast"], h1, h2');
  let skipped: BatchPageIssue | undefined;
  for (const element of candidates) {
    if (!sourceUi(element, document)) continue;
    const issue = classifyBatchNotice((element.textContent ?? "").slice(0, 1500));
    if (issue?.outcome === "attention") return issue;
    skipped ??= issue;
  }
  if (Array.from(document.querySelectorAll('iframe[src*="challenges.cloudflare.com"], #challenge-running, #challenge-stage')).some(element => sourceUi(element, document)))
    return { outcome: "attention", message: "ChatGPT 需要完成安全验证，请处理后继续队列" };
  if (Array.from(document.querySelectorAll('[data-testid="login-button"], a[href^="/auth/login"], button[data-testid="login-button"]')).some(element => sourceUi(element, document)))
    return { outcome: "attention", message: "ChatGPT 需要登录，请登录后继续队列" };
  return skipped;
}

export function batchDiagnosticIssue(diagnostic: NativeConversationReadDiagnostic): BatchPageIssue | undefined {
  if (diagnostic.code === "rate_limited" || diagnostic.httpStatus === 429)
    return { outcome: "attention", message: "ChatGPT 暂时限流，队列已暂停；稍后继续" };
  if (diagnostic.httpStatus === 401 || diagnostic.code === "session_unavailable" ||
      diagnostic.httpStatus === 403)
    return { outcome: "attention", message: "ChatGPT 登录失效或需要验证，请检查后继续队列" };
  if (diagnostic.stage === "conversation" && [404, 410].includes(diagnostic.httpStatus ?? 0))
    return { outcome: "skipped", message: `原会话不可访问（HTTP ${diagnostic.httpStatus}），已自动跳过` };
  return undefined;
}
