import OpenAI from "openai";
import { fetch } from "undici";
import { z, ZodError } from "zod";
import { getBooleanSetting, getNumberSetting, getSetting } from "./settings.js";
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
export const DEFAULT_AI_REQUEST_INTERVAL_SECONDS = 82;
const MINIMAX_TOKEN_PLAN_LOOKUP_TIMEOUT_MS = 10_000;
const MAX_TOKEN_PLAN_RETRY_DELAY_MS = 8 * 24 * 60 * 60_000;
const MAX_AI_REQUEST_INTERVAL_SECONDS = 60 * 60;

export type AiRequestPriority = "interactive" | "batch";

const aiRequestPacingGates: Record<AiRequestPriority, Promise<void>> = {
  interactive: Promise.resolve(),
  batch: Promise.resolve(),
};
const nextAiRequestStartAt: Record<AiRequestPriority, number> = {
  interactive: 0,
  batch: 0,
};

export function aiRequestPacingDelayMs(
  nextStartAt: number,
  now: number,
): number {
  if (!Number.isFinite(nextStartAt) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.ceil(nextStartAt - now));
}

export function aiRequestIntervalMs(
  priority: AiRequestPriority,
  batchIntervalSeconds: number,
): number {
  if (priority === "interactive") return 0;
  if (!Number.isFinite(batchIntervalSeconds)) return 0;
  return Math.max(0, Math.round(batchIntervalSeconds * 1_000));
}

async function waitForAiRequestPacing(
  priority: AiRequestPriority = "batch",
): Promise<void> {
  const enabled = await getBooleanSetting("ai.pacingEnabled", true);
  if (!enabled) return;
  const intervalSeconds = priority === "interactive"
    ? 0
    : await getNumberSetting(
        "ai.requestIntervalSeconds",
        DEFAULT_AI_REQUEST_INTERVAL_SECONDS,
        { min: 0, max: MAX_AI_REQUEST_INTERVAL_SECONDS },
      );
  const intervalMs = aiRequestIntervalMs(priority, intervalSeconds);
  if (intervalMs <= 0) return;

  let releaseGate: (() => void) | undefined;
  const previousGate = aiRequestPacingGates[priority];
  aiRequestPacingGates[priority] = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  await previousGate;
  try {
    const waitMs = aiRequestPacingDelayMs(nextAiRequestStartAt[priority], Date.now());
    if (waitMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    }
    nextAiRequestStartAt[priority] = Date.now() + intervalMs;
  } finally {
    releaseGate?.();
  }
}

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

function stripReasoningBlocks(value: string): string {
  // Never recover an example from a reasoning block, even if the final answer
  // is malformed or a provider leaves its last reasoning block unclosed.
  return value
    .replace(/<(think|reasoning)>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(?:think|reasoning)>[\s\S]*$/gi, "");
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

function* parsedJsonCandidates(content: string): Generator<unknown> {
  const withoutReasoning = stripReasoningBlocks(content).trim();
  const candidates = [
    withoutReasoning,
    ...Array.from(withoutReasoning.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)).map((match) =>
      match[1]?.trim() ?? "",
    ),
    ...jsonSlices(withoutReasoning),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      yield JSON.parse(candidate);
    } catch {
      // Try the next candidate before reporting the original model output.
    }
  }
}

export function extractJson(content: string): unknown {
  for (const parsed of parsedJsonCandidates(content)) return parsed;
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
  schema: z.ZodType<T, unknown>,
  content: string,
): T {
  let firstSchemaError: ZodError | undefined;
  for (const parsed of parsedJsonCandidates(content)) {
    const result = schema.safeParse(parsed);
    if (result.success) return result.data;
    firstSchemaError ??= result.error;
  }
  throw new Error(firstSchemaError
    ? schemaErrorMessage(firstSchemaError)
    : "Model did not return valid JSON");
}

export interface StructuredResponseDiagnostic {
  /** One-based quality attempt; a response_format fallback shares its attempt. */
  attempt: number;
  model: string;
  responseId?: string;
  requestId?: string;
  finishReason?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  content: string;
  responseChars: number;
  status: "accepted" | "rejected" | "request_failed";
  error?: string;
}

export class StructuredResponseDiagnosticError extends Error {
  constructor(error: unknown) {
    super("Failed to persist structured response diagnostic", { cause: error });
    this.name = "StructuredResponseDiagnosticError";
  }
}

function diagnosticErrorMessage(error: unknown, apiKey: string): string {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const status = typeof record.status === "number" ? `HTTP ${record.status}: ` : "";
  const message = error instanceof Error
    ? error.message
    : typeof record.message === "string" ? record.message : String(error);
  // Do not serialize error objects: SDK errors may carry request headers.
  const sanitized = message
    .split(apiKey).join("[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|access_token)=)[^\s&#]+/gi, "$1[REDACTED]");
  return `${status}${excerpt(sanitized, 1_200)}`;
}

function errorRequestId(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const record = error as Record<string, unknown>;
  return typeof record.request_id === "string" ? record.request_id : undefined;
}

function supportsResponseFormatFallback(error: unknown): boolean {
  if (isRetryableRateLimitError(error)) return false;
  const status = error && typeof error === "object"
    ? (error as Record<string, unknown>).status
    : undefined;
  if (status === 401 || status === 403) return false;
  const message = error instanceof Error ? error.message : "";
  return /response_format|json_object|unsupported/i.test(message);
}

export async function completeStructured<T>(input: {
  system: string;
  user: string;
  schema: z.ZodType<T, unknown>;
  priority?: AiRequestPriority;
  maxAttempts?: number;
  timeoutMs?: number;
  onDiagnostic?: (diagnostic: StructuredResponseDiagnostic) => Promise<void> | void;
}): Promise<T> {
  const llm = await loadLlmConfig();
  const maxAttempts = Number.isFinite(input.maxAttempts)
    ? Math.max(1, Math.min(3, Math.trunc(input.maxAttempts!)))
    : 1;
  const recordDiagnostic = async (diagnostic: StructuredResponseDiagnostic): Promise<void> => {
    try {
      await input.onDiagnostic?.(diagnostic);
    } catch (error) {
      throw new StructuredResponseDiagnosticError(error);
    }
  };
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
    let useResponseFormat = true;
    let correction: string | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const request = {
        ...baseRequest,
        messages: [
          ...baseRequest.messages,
          ...(correction ? [{ role: "user" as const, content: correction }] : []),
        ],
      };
      const sendRequest = async () => {
        try {
          await waitForAiRequestPacing(input.priority);
          return await client.chat.completions.create(
            { ...request, ...(useResponseFormat ? { response_format: { type: "json_object" as const } } : {}) },
            { timeout: input.timeoutMs ?? STRUCTURED_COMPLETION_TIMEOUT_MS, maxRetries: input.timeoutMs ? 0 : 2 },
          );
        } catch (error) {
          const requestId = errorRequestId(error);
          await recordDiagnostic({
            attempt,
            model: llm.model,
            ...(requestId ? { requestId } : {}),
            content: "",
            responseChars: 0,
            status: "request_failed",
            error: diagnosticErrorMessage(error, llm.apiKey),
          });
          throw error;
        }
      };
      let response;
      try {
        response = await sendRequest();
      } catch (error) {
        if (error instanceof StructuredResponseDiagnosticError || !useResponseFormat || !supportsResponseFormatFallback(error)) throw error;
        useResponseFormat = false;
        response = await sendRequest();
      }
      const choice = response?.choices?.[0];
      const rawContent = choice?.message?.content;
      const content = typeof rawContent === "string" ? rawContent : "";
      const metadata = {
        attempt,
        model: response?.model || llm.model,
        ...(response?.id ? { responseId: response.id } : {}),
        ...(response?._request_id ? { requestId: response._request_id } : {}),
        ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}),
        ...(response?.usage ? { usage: {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        } } : {}),
        content,
        responseChars: content.length,
      };
      let result: T;
      try {
        if (choice?.finish_reason && choice.finish_reason !== "stop") {
          throw new Error(`Model response was incomplete (finish_reason=${choice.finish_reason}); return a complete JSON object without truncation`);
        }
        if (!content.trim()) throw new Error("Model returned an empty response");
        result = parseStructured(input.schema, content);
      } catch (error) {
        const message = diagnosticErrorMessage(error, llm.apiKey);
        await recordDiagnostic({ ...metadata, status: "rejected", error: message });
        if (attempt >= maxAttempts) throw error;
        correction = `The previous response failed validation: ${message}\nGenerate the entire response again using the original source material and requirements. Return exactly one complete JSON object matching the required schema. Include all required sections and substantive content. Do not return placeholders, ellipses, a sample object, or an explanation of the JSON. Do not invent facts to fill missing information.`;
        continue;
      }
      // Kept outside the validation catch so storage failures cannot be retried
      // or misreported as model quality failures.
      await recordDiagnostic({ ...metadata, status: "accepted" });
      return result;
    }
    throw new Error("Structured response attempts exhausted");
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
      await waitForAiRequestPacing("interactive");
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
      await waitForAiRequestPacing("interactive");
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
