import { describe, expect, it } from "vitest";
import { extractJson, isRetryableRateLimitError } from "../src/services/llm.js";

describe("extractJson", () => {
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
    expect(
      isRetryableRateLimitError(
        new Error("Token Plan 速率限制: 请升级 Token Plan 套餐或切换为按量付费 API 使用. (2062)"),
      ),
    ).toBe(true);
    expect(isRetryableRateLimitError(new Error("model output is malformed"))).toBe(false);
  });
});
