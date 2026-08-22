import { describe, expect, it } from "vitest";
import {
  AI_RATE_LIMIT_RETRY_DELAY_MS,
  DEFAULT_AI_REQUEST_INTERVAL_SECONDS,
  MINIMAX_TOKEN_PLAN_RETRY_BUFFER_MS,
  aiRequestPacingDelayMs,
  aiRequestIntervalMs,
  extractJson,
  fallbackAiRetrySchedule,
  isRetryableRateLimitError,
  resolveAiRetrySchedule,
  tokenPlanRetryScheduleFromResponse,
} from "../src/services/llm.js";

describe("extractJson", () => {
  it("paces the observed workload across five and a half hours", () => {
    expect(DEFAULT_AI_REQUEST_INTERVAL_SECONDS).toBe(82);
    expect((244 - 1) * DEFAULT_AI_REQUEST_INTERVAL_SECONDS).toBeGreaterThanOrEqual(
      5.5 * 60 * 60,
    );
    expect(aiRequestPacingDelayMs(182_000, 100_000)).toBe(82_000);
    expect(aiRequestPacingDelayMs(100_000, 182_000)).toBe(0);
    expect(aiRequestIntervalMs("batch", 82)).toBe(82_000);
    expect(aiRequestIntervalMs("interactive", 82)).toBe(0);
  });

  it("parses fenced JSON responses", () => {
    expect(extractJson("```json\n{\"ok\":true}\n```")).toEqual({ ok: true });
  });

  it("parses the first balanced JSON value from explanatory text", () => {
    expect(extractJson('result: {"suggestion":{"confidence":"80%"}}. please review')).toEqual({
      suggestion: { confidence: "80%" },
    });
  });

  it("skips reasoning blocks and keeps scanning after malformed braces", () => {
    expect(
      extractJson(
        '<think>candidate shape: {"suggestion": maybe later</think>\n{"suggestion":{"suggestedName":"food","confidence":0.71}}',
      ),
    ).toEqual({
      suggestion: { suggestedName: "food", confidence: 0.71 },
    });
  });

  it("finds a later JSON object when the first brace cannot be balanced", () => {
    expect(
      extractJson(
        'draft {not json\nfinal answer: {"statusUpdates":[],"report":{"title":"ok","summary":"ok","bodyMarkdown":"ok"}}',
      ),
    ).toEqual({
      statusUpdates: [],
      report: { title: "ok", summary: "ok", bodyMarkdown: "ok" },
    });
  });

  it("reports a useful excerpt when JSON is missing", () => {
    expect(() => extractJson("I think this should belong to project A")).toThrow(
      /Model did not return valid JSON/,
    );
  });
  it("treats Token Plan rate limits as retryable", () => {
    expect(AI_RATE_LIMIT_RETRY_DELAY_MS).toBe(60 * 60_000);
    expect(
      isRetryableRateLimitError({
        status: 429,
        error: { code: 2056, message: "超出Token Plan资源限制" },
      }),
    ).toBe(true);
    expect(
      isRetryableRateLimitError({
        base_resp: { status_code: 2056, status_msg: "超出Token Plan资源限制" },
      }),
    ).toBe(true);
    expect(
      isRetryableRateLimitError(
        new Error("Token Plan 速率限制: 请升级 Token Plan 套餐或切换为按量付费 API 使用. (2062)"),
      ),
    ).toBe(true);
    expect(isRetryableRateLimitError({ error: { code: 1002 } })).toBe(true);
    expect(isRetryableRateLimitError({ error: { code: 1039 } })).toBe(false);
    expect(isRetryableRateLimitError({ error: { code: 1008 } })).toBe(false);
    expect(isRetryableRateLimitError(new Error("insufficient_quota"))).toBe(true);
    expect(isRetryableRateLimitError(new Error("quota exceeded"))).toBe(true);
    expect(isRetryableRateLimitError(new Error("model output is malformed"))).toBe(false);
  });

  it("adds a ten-minute buffer to an exact reset timestamp in the error", async () => {
    const now = new Date("2026-08-22T00:00:00.000Z");
    const schedule = await resolveAiRetrySchedule(
      {
        base_resp: {
          status_code: 2056,
          status_msg:
            "weekly usage limit reached, resets at 2026-08-22T02:00:00+00:00",
        },
      },
      now,
    );

    expect(MINIMAX_TOKEN_PLAN_RETRY_BUFFER_MS).toBe(10 * 60_000);
    expect(schedule).toMatchObject({
      retryAt: "2026-08-22T02:10:00.000Z",
      retryAfterMs: 130 * 60_000,
      quotaResetAt: "2026-08-22T02:00:00.000Z",
      retryBufferMs: 10 * 60_000,
      window: "weekly",
      source: "error_message",
    });
  });

  it("uses the Token Plan countdown and waits for every exhausted window", () => {
    const now = new Date("2026-08-22T00:00:00.000Z");
    const schedule = tokenPlanRetryScheduleFromResponse(
      { base_resp: { status_code: 2056, status_msg: "usage limit exceeded" } },
      {
        model_remains: [
          {
            model_name: "general",
            remains_time: 60 * 60_000,
            weekly_remains_time: 2 * 24 * 60 * 60_000,
            current_interval_remaining_percent: 0,
            current_weekly_remaining_percent: 0,
          },
        ],
      },
      now,
    );

    expect(schedule).toMatchObject({
      retryAt: "2026-08-24T00:10:00.000Z",
      retryAfterMs: 2 * 24 * 60 * 60_000 + 10 * 60_000,
      window: "weekly",
      source: "token_plan_api",
      currentRemainingPercent: 0,
      weeklyRemainingPercent: 0,
    });
  });

  it("keeps the one-hour fallback when quota timing is unavailable", () => {
    const now = new Date("2026-08-22T00:00:00.000Z");
    expect(fallbackAiRetrySchedule(now)).toMatchObject({
      retryAt: "2026-08-22T01:00:00.000Z",
      retryAfterMs: AI_RATE_LIMIT_RETRY_DELAY_MS,
      window: "rate_limit",
      source: "fallback",
    });
  });
});
