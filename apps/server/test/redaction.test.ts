import { describe, expect, it, vi } from "vitest";

vi.mock("../src/db.js", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [],
      }),
    }),
  },
}));

describe("redactForCloud", () => {
  it("redacts common secrets before cloud analysis", async () => {
    const { redactForCloud } = await import("../src/services/redaction.js");
    const result = await redactForCloud(
      "联系 13800138000 或 test@example.com，访问 https://private.example.cn/path，密钥 sk-test_12345678901234567890",
    );
    expect(result.text).not.toContain("13800138000");
    expect(result.text).not.toContain("test@example.com");
    expect(result.text).not.toContain("private.example.cn");
    expect(result.text).not.toContain("12345678901234567890");
    expect(result.replacements).toBeGreaterThanOrEqual(3);
  });
});
