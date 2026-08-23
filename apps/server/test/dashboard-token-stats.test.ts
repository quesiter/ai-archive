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
      usageBackedConversationCount: 3,
      fallbackConversationCount: 7,
    });
  });
});
