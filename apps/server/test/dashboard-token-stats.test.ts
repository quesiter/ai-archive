import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({ db: {} }));

describe("dashboard token stats", () => {
  it("combines provider usage with process-aware fallback estimates", async () => {
    const { dashboardTokenStatsFromRow } = await import(
      "../src/routes/dashboard.js"
    );
    expect(
      dashboardTokenStatsFromRow({
        text_units: "12000",
        reasoning_text_units: "4000",
        tool_text_units: "3000",
        reported_tokens: "900000",
        reported_reasoning_tokens: "80000",
        fallback_estimated_tokens: "50000",
        model_tokens: "950000",
        calibration_factor: "4.2",
        calibration_factor_low: "3.1",
        calibration_factor_high: "5.4",
        calibration_sample_count: "3",
        usage_backed_conversations: "3",
        fallback_conversations: "7",
      }),
    ).toEqual({
      textUnits: 12000,
      reasoningTextUnits: 4000,
      toolTextUnits: 3000,
      reportedTokens: 900000,
      reportedReasoningTokens: 80000,
      fallbackEstimatedTokens: 50000,
      estimatedTokens: 950000,
      calibrationFactor: 4.2,
      calibrationFactorLow: 3.1,
      calibrationFactorHigh: 5.4,
      calibrationSampleCount: 3,
      calibratedFallbackTokens: 210000,
      calibratedEstimatedTokens: 1110000,
      calibratedEstimatedTokensLow: 1055000,
      calibratedEstimatedTokensHigh: 1170000,
      usageBackedConversationCount: 3,
      fallbackConversationCount: 7,
    });
  });

  it("falls back to the uncalibrated estimate without valid usage samples", async () => {
    const { dashboardTokenStatsFromRow } = await import(
      "../src/routes/dashboard.js"
    );
    expect(
      dashboardTokenStatsFromRow({
        reported_tokens: 1000,
        fallback_estimated_tokens: 500,
        model_tokens: 1500,
      }),
    ).toMatchObject({
      estimatedTokens: 1500,
      calibrationFactor: 1,
      calibrationSampleCount: 0,
      calibratedFallbackTokens: 500,
      calibratedEstimatedTokens: 1500,
      calibratedEstimatedTokensLow: 1500,
      calibratedEstimatedTokensHigh: 1500,
    });
  });
});
