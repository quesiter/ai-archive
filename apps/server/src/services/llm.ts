import OpenAI from "openai";
import { fetch } from "undici";
import { z, ZodError } from "zod";
import { getSetting } from "./settings.js";
import { withPinnedNetworkDispatcher } from "./network-target.js";

export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface LlmConfigInput {
  baseURL?: string | undefined;
  apiKey?: string | undefined;
  model?: string | undefined;
}

const STRUCTURED_COMPLETION_TIMEOUT_MS = 120_000;
const TEST_COMPLETION_TIMEOUT_MS = 30_000;
export const AI_RATE_LIMIT_RETRY_DELAY_MS = 60 * 60_000;
export const MINIMAX_TOKEN_PLAN_RETRY_BUFFER_MS = 10 * 60_000;
const MINIMAX_TOKEN_PLAN_LOOKUP_TIMEOUT_MS = 10_000;
const MAX_TOKEN_PLAN_RETRY_DELAY_MS = 8 * 24 * 60 * 60_000;

export type AiRetryWindow = "five_hour" | "weekly" | "rate_limit";
export type AiRetryScheduleSource =
  | "error_message"
  | "token_plan_api"
  | "fallback";

export interface AiRetrySchedule {
  retryAt: string;
  retryAfterMs: number;
  quotaResetAt: string | null;
  retryBufferMs: number;
  window: AiRetryWindow;
  source: AiRetryScheduleSource;
  currentRemainingPercent?: number;
  weeklyRemainingPercent?: number;
}

const TokenPlanQuotaSchema = z
  .object({
    model_name: z.string().optional(),
    remains_time: z.unknown().optional(),
    weekly_remains_time: z.unknown().optional(),
    current_interval_remaining_percent: z.unknown().optional(),
    current_weekly_remaining_percent: z.unknown().optional(),
    current_interval_used_percent: z.unknown().optional(),
    current_weekly_used_percent: z.unknown().optional(),
  })
  .passthrough();

const TokenPlanRemainsSchema = z
  .object({
    model_remains: z.array(TokenPlanQuotaSchema).optional(),
  })
  .passthrough();

async function loadLlmConfig(input: LlmConfigInput = {}): Promise<LlmConfig> {
  const [baseURL, apiKey, model] = await Promise.all([
    getSetting("llm.baseUrl"),
    getSetting("llm.apiKey"),
    getSetting("llm.model"),
  ]);
  const requestedApiKey = input.apiKey?.trim();
  const resolved = {
    baseURL: input.baseURL?.trim() || baseURL || "",
    apiKey:
      requestedApiKey && requestedApiKey !== "********" ? requestedApiKey : apiKey || "",
    model: input.model?.trim() || model || "",
  };
  if (!resolved.baseURL || !resolved.apiKey || !resolved.model) {
    throw new Error("OpenAI-compatible analysis model is not configured");
  }
  return resolved;
}

function excerpt(value: string, limit = 700): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= limit
    ? normalized
    : `${normalized.slice(0, limit)}...`;
}

function stripClosedReasoningBlocks(value: string): string {
  return value.replace(/<(?:think|reasoning)>[\s\S]*?<\/(?:think|reasoning)>/gi, "");
}

function balancedJsonSliceFrom(value: string, startIndex: number): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let index = startIndex; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }
    if (char !== "{" && char !== "[" && stack.length === 0) return null;
    if (char === "\"") {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
      continue;
    }
    if (char === "}" || char === "]") {
      if (stack.pop() !== char) return null;
      if (stack.length === 0) return value.slice(startIndex, index + 1);
    }
  }
  return null;
}

function jsonSlices(value: string): string[] {
  const slices: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char !== "{" && char !== "[") continue;
    const slice = balancedJsonSliceFrom(value, index);
    if (slice) slices.push(slice);
  }
  return slices;
}

export function extractJson(content: string): unknown {
  const trimmed = content.trim();
  const withoutReasoning = stripClosedReasoningBlocks(trimmed).trim();
  const afterReasoning = trimmed.includes("</think>")
    ? trimmed.slice(trimmed.lastIndexOf("</think>") + "</think>".length).trim()
    : "";
  const candidates = [
    trimmed,
    withoutReasoning,
    afterReasoning,
    ...Array.from(trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) =>
      match[1]?.trim() ?? "",
    ),
    ...jsonSlices(withoutReasoning || trimmed),
    ...jsonSlices(trimmed),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next candidate before reporting the original model output.
    }
  }
  throw new Error("Model did not return valid JSON");
}

function schemaErrorMessage(error: ZodError): string {
  const issues = error.issues
    .slice(0, 6)
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "root";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
  return `Model JSON did not match expected schema: ${issues}`;
}

function rateLimitErrorSignals(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (value === null || value === undefined || depth > 4) return;
    if (typeof value === "string" || typeof value === "number") {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Error) {
      parts.push(value.name, value.message);
    }
    const record = value as Record<string, unknown>;
    for (const key of [
      "status",
      "statusCode",
      "status_code",
      "status_msg",
      "code",
      "type",
      "message",
      "error",
      "base_resp",
      "response",
      "data",
      "body",
      "cause",
    ]) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  visit(error, 0);
  if (!parts.length) parts.push(String(error));
  return parts.join(" ").toLowerCase();
}

function numericValue(value: unknown): number | null {
  if (typeof value === "string") {
    value = value.trim().replace(/%$/, "");
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function retryWindowFromMessage(message: string): AiRetryWindow | null {
  if (/weekly|week(?:ly)?\s+usage|周(?:额度|限额|窗口)/i.test(message)) {
    return "weekly";
  }
  if (/5\s*(?:h|hour)|five[\s_-]*hour|current[\s_-]*interval|五\s*小时/i.test(message)) {
    return "five_hour";
  }
  return null;
}

function scheduleFromResetAt(
  resetAtMs: number,
  now: Date,
  window: AiRetryWindow,
  source: AiRetryScheduleSource,
  percentages: {
    currentRemainingPercent?: number;
    weeklyRemainingPercent?: number;
  } = {},
): AiRetrySchedule | null {
  const nowMs = now.getTime();
  if (!Number.isFinite(resetAtMs) || resetAtMs <= nowMs) return null;
  const retryAtMs = resetAtMs + MINIMAX_TOKEN_PLAN_RETRY_BUFFER_MS;
  const retryAfterMs = retryAtMs - nowMs;
  if (retryAfterMs <= 0 || retryAfterMs > MAX_TOKEN_PLAN_RETRY_DELAY_MS) return null;
  return {
    retryAt: new Date(retryAtMs).toISOString(),
    retryAfterMs,
    quotaResetAt: new Date(resetAtMs).toISOString(),
    retryBufferMs: MINIMAX_TOKEN_PLAN_RETRY_BUFFER_MS,
    window,
    source,
    ...percentages,
  };
}

function exactResetScheduleFromError(
  error: unknown,
  now: Date,
): AiRetrySchedule | null {
  const message = rateLimitErrorSignals(error);
  const match = message.match(
    /(?:resets?\s+at|reset(?:s)?\s*[:：]|重置(?:于|时间)?\s*[:：]?)\s*(\d{4}-\d{2}-\d{2}[t\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:z|[+-]\d{2}:?\d{2}))/i,
  );
  if (!match?.[1]) return null;
  const resetAtMs = Date.parse(match[1]);
  return scheduleFromResetAt(
    resetAtMs,
    now,
    retryWindowFromMessage(message) ?? "five_hour",
    "error_message",
  );
}

function remainingPercent(
  remainingValue: unknown,
  usedValue: unknown,
): number | undefined {
  const remaining = numericValue(remainingValue);
  if (remaining !== null) return Math.max(0, Math.min(100, remaining));
  const used = numericValue(usedValue);
  if (used === null) return undefined;
  return Math.max(0, Math.min(100, 100 - used));
}

export function tokenPlanRetryScheduleFromResponse(
  error: unknown,
  response: unknown,
  now = new Date(),
): AiRetrySchedule | null {
  const parsed = TokenPlanRemainsSchema.safeParse(response);
  if (!parsed.success) return null;
  const quotas = parsed.data.model_remains ?? [];
  const textQuotas = quotas.filter(
    (quota) => !/video|image|speech|audio|music/i.test(quota.model_name ?? ""),
  );
  const quota =
    textQuotas.find((item) => item.model_name?.toLowerCase() === "general") ??
    textQuotas[0] ??
    quotas[0];
  if (!quota) return null;

  const currentRemainingPercent = remainingPercent(
    quota.current_interval_remaining_percent,
    quota.current_interval_used_percent,
  );
  const weeklyRemainingPercent = remainingPercent(
    quota.current_weekly_remaining_percent,
    quota.current_weekly_used_percent,
  );
  const currentDelayMs = numericValue(quota.remains_time);
  const weeklyDelayMs = numericValue(quota.weekly_remains_time);
  const message = rateLimitErrorSignals(error);
  const explicitWindow = retryWindowFromMessage(message);
  const candidates: Array<{ window: "five_hour" | "weekly"; delayMs: number }> = [];

  if (
    currentDelayMs !== null &&
    currentDelayMs > 0 &&
    (explicitWindow === "five_hour" || currentRemainingPercent === 0)
  ) {
    candidates.push({ window: "five_hour", delayMs: currentDelayMs });
  }
  if (
    weeklyDelayMs !== null &&
    weeklyDelayMs > 0 &&
    (explicitWindow === "weekly" || weeklyRemainingPercent === 0)
  ) {
    candidates.push({ window: "weekly", delayMs: weeklyDelayMs });
  }
  if (!candidates.length && currentDelayMs !== null && currentDelayMs > 0) {
    candidates.push({ window: "five_hour", delayMs: currentDelayMs });
  }
  if (!candidates.length) return null;

  // If both windows are exhausted, both must recover before the task can run.
  const selected = candidates.reduce((latest, candidate) =>
    candidate.delayMs > latest.delayMs ? candidate : latest,
  );
  return scheduleFromResetAt(
    now.getTime() + selected.delayMs,
    now,
    selected.window,
    "token_plan_api",
    {
      ...(currentRemainingPercent === undefined ? {} : { currentRemainingPercent }),
      ...(weeklyRemainingPercent === undefined ? {} : { weeklyRemainingPercent }),
    },
  );
}

export function fallbackAiRetrySchedule(now = new Date()): AiRetrySchedule {
  const retryAt = new Date(now.getTime() + AI_RATE_LIMIT_RETRY_DELAY_MS);
  return {
    retryAt: retryAt.toISOString(),
    retryAfterMs: AI_RATE_LIMIT_RETRY_DELAY_MS,
    quotaResetAt: null,
    retryBufferMs: 0,
    window: "rate_limit",
    source: "fallback",
  };
}

function minimaxTokenPlanEndpoint(baseURL: string): string | null {
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    if (hostname === "minimaxi.com" || hostname.endsWith(".minimaxi.com")) {
      return "https://www.minimaxi.com/v1/token_plan/remains";
    }
    if (hostname === "minimax.io" || hostname.endsWith(".minimax.io")) {
      return "https://www.minimax.io/v1/token_plan/remains";
    }
  } catch {
    // The configured URL is validated when it is saved; fall back if it changed.
  }
  return null;
}

function isTokenPlanLimitError(error: unknown): boolean {
  const message = rateLimitErrorSignals(error);
  return (
    /(?:^|\D)(?:2056|2062)(?:\D|$)/.test(message) ||
    message.includes("token plan") ||
    message.includes("token_plan") ||
    message.includes("usage limit exceeded")
  );
}

export async function resolveAiRetrySchedule(
  error: unknown,
  now = new Date(),
): Promise<AiRetrySchedule> {
  const exact = exactResetScheduleFromError(error, now);
  if (exact) return exact;
  if (!isTokenPlanLimitError(error)) return fallbackAiRetrySchedule(now);

  try {
    const llm = await loadLlmConfig();
    const endpoint = minimaxTokenPlanEndpoint(llm.baseURL);
    if (!endpoint) return fallbackAiRetrySchedule(now);
    const responseBody = await withPinnedNetworkDispatcher(endpoint, async (dispatcher) => {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${llm.apiKey}`,
          "Content-Type": "application/json",
        },
        dispatcher,
        signal: AbortSignal.timeout(MINIMAX_TOKEN_PLAN_LOOKUP_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      return response.json() as Promise<unknown>;
    });
    return (
      tokenPlanRetryScheduleFromResponse(error, responseBody, now) ??
      fallbackAiRetrySchedule(now)
    );
  } catch {
    return fallbackAiRetrySchedule(now);
  }
}

export class DeferredAiRateLimitError extends Error {
  readonly schedule: AiRetrySchedule;

  constructor(error: unknown, schedule: AiRetrySchedule) {
    super(`AI rate limit deferred until ${schedule.retryAt}`, { cause: error });
    this.name = "DeferredAiRateLimitError";
    this.schedule = schedule;
  }
}

export function deferredAiRetrySchedule(error: unknown): AiRetrySchedule | null {
  return error instanceof DeferredAiRateLimitError ? error.schedule : null;
}

export function isRetryableRateLimitError(error: unknown): boolean {
  const message = rateLimitErrorSignals(error);
  return (
    /(?:^|\D)(?:1002|2056|2062|429)(?:\D|$)/.test(message) ||
    message.includes("token plan") ||
    message.includes("token_plan") ||
    message.includes("usage limit exceeded") ||
    message.includes("resource limit") ||
    message.includes("rate limit") ||
    message.includes("too many requests") ||
    message.includes("insufficient_quota") ||
    message.includes("quota exceeded")
  );
}

function parseStructured<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  content: string,
): T {
  const parsed = extractJson(content);
  try {
    return schema.parse(parsed);
  } catch (error) {
    if (error instanceof ZodError) throw new Error(schemaErrorMessage(error));
    throw error;
  }
}

export async function completeStructured<T>(input: {
  system: string;
  user: string;
  schema: z.ZodType<T, z.ZodTypeDef, unknown>;
}): Promise<T> {
  const llm = await loadLlmConfig();
  return withPinnedNetworkDispatcher(llm.baseURL, async (dispatcher) => {
    const client = new OpenAI({
      apiKey: llm.apiKey,
      baseURL: llm.baseURL,
      fetchOptions: { dispatcher },
    });
    const baseRequest = {
      model: llm.model,
      temperature: 0,
      messages: [
        { role: "system" as const, content: input.system },
        { role: "user" as const, content: input.user },
      ],
    };
    let response;
    try {
      response = await client.chat.completions.create(
        {
          ...baseRequest,
          response_format: { type: "json_object" },
        },
        { timeout: STRUCTURED_COMPLETION_TIMEOUT_MS },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/response_format|json_object|unsupported/i.test(message)) throw error;
      response = await client.chat.completions.create(
        baseRequest,
        { timeout: STRUCTURED_COMPLETION_TIMEOUT_MS },
      );
    }
    const content = response.choices[0]?.message.content;
    if (!content) throw new Error("Model returned an empty response");
    return parseStructured(input.schema, content);
  });
}

export async function testLlmConnection(input: LlmConfigInput = {}): Promise<{
  baseURL: string;
  model: string;
  response: string;
}> {
  const llm = await loadLlmConfig(input);
  return withPinnedNetworkDispatcher(llm.baseURL, async (dispatcher) => {
    const client = new OpenAI({
      apiKey: llm.apiKey,
      baseURL: llm.baseURL,
      fetchOptions: { dispatcher },
    });
    const request = {
      model: llm.model,
      temperature: 0,
      messages: [{ role: "user" as const, content: "Reply with OK." }],
    };
    let response;
    try {
      response = await client.chat.completions.create(
        {
          ...request,
          max_tokens: 8,
        },
        { timeout: TEST_COMPLETION_TIMEOUT_MS },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (!/max_tokens|unsupported|not support/i.test(message)) throw error;
      response = await client.chat.completions.create(
        request,
        { timeout: TEST_COMPLETION_TIMEOUT_MS },
      );
    }
    const content = response.choices[0]?.message.content?.trim();
    if (!content) throw new Error("Model returned an empty response");
    return {
      baseURL: llm.baseURL,
      model: llm.model,
      response: content.slice(0, 200),
    };
  });
}
