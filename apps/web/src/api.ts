export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function retryDelay(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 24 * 60 * 60_000) : undefined;
}

function responseError(status: number, statusText: string, payload: unknown): string {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  for (const value of [record.error, record.message]) {
    if (typeof value === "string" && value.trim() && !/^(?:error|unknown error|\[object Object\])$/i.test(value.trim())) {
      return value.trim();
    }
  }
  const messages: Record<number, string> = {
    401: "登录状态已失效，请重新登录",
    403: "请求被拒绝，请检查登录或访问权限",
    408: "请求超时，请稍后重试",
    429: "请求过于频繁，请稍后重试",
    500: "服务器处理失败，请稍后重试",
    502: "服务器暂时无法连接，请稍后重试",
    503: "服务暂时不可用，请稍后重试",
    504: "服务器响应超时，请稍后重试",
  };
  return `HTTP ${status}：${messages[status] ?? (statusText.trim() || "请求失败")}`;
}

export async function api<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, credentials: "include" });
  } catch (error) {
    if (init.signal?.aborted || (error && typeof error === "object" && "name" in error && error.name === "AbortError")) throw error;
    throw new ApiError("网络连接失败，请检查网络或稍后重试", 0);
  }
  if (!response.ok) {
    const payload: unknown = await response.json().catch(() => null);
    throw new ApiError(responseError(response.status, response.statusText, payload), response.status,
      retryDelay(response.headers.get("Retry-After")));
  }
  if (response.status === 204) return undefined as T;
  try {
    return await response.json() as T;
  } catch {
    throw new ApiError(`服务器响应格式异常（HTTP ${response.status}），请刷新或稍后重试`, response.status);
  }
}

export function jsonBody(value: unknown): Pick<RequestInit, "body"> {
  return { body: JSON.stringify(value) };
}
