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

  it("redacts credentials before database storage while retaining ordinary contact data", async () => {
    const { redactSensitiveTextForStorage } = await import(
      "../src/services/redaction.js"
    );
    const input = [
      "联系 13800138000 或 test@example.com",
      "password=DemoOnly_123",
      "192.0.2.50:2288\ndemo/Demo\\@Password123",
      "ssh root@192.0.2.10 -p 22",
      "postgresql://archive:DemoOnly@db.example.com/archive",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");

    const result = redactSensitiveTextForStorage(input);

    expect(result.text).toContain("13800138000");
    expect(result.text).toContain("test@example.com");
    expect(result.text).not.toContain("DemoOnly_123");
    expect(result.text).not.toContain("Demo\\@Password123");
    expect(result.text).not.toContain("root@192.0.2.10");
    expect(result.text).not.toContain("archive:DemoOnly");
    expect(result.text).not.toContain("ZmFrZS1rZXk");
    expect(result.replacements).toBeGreaterThanOrEqual(5);
  });

  it("redacts sensitive URL credentials and query parameters", async () => {
    const { redactSensitiveUrlForStorage } = await import(
      "../src/services/redaction.js"
    );
    const result = redactSensitiveUrlForStorage(
      "https://demo:password@example.com/path?access_token=DemoOnlyToken&view=full",
    );

    expect(result.text).not.toContain("demo:password");
    expect(result.text).not.toContain("DemoOnlyToken");
    expect(result.text).toContain("view=full");
    expect(result.replacements).toBeGreaterThanOrEqual(2);
  });

  it("redacts private keys split across message segments", async () => {
    const { redactSensitiveTextSequenceForStorage } = await import(
      "../src/services/redaction.js"
    );
    const result = redactSensitiveTextSequenceForStorage([
      "before\n-----BEGIN OPENSSH PRIVATE KEY-----",
      "sensitive-private-key-body",
      "-----END OPENSSH PRIVATE KEY-----\nafter",
      "safe",
    ]);

    expect(result.texts).toEqual([
      "before\n[PRIVATE_KEY]",
      "[PRIVATE_KEY]",
      "[PRIVATE_KEY]\nafter",
      "safe",
    ]);
    expect(result.replacements).toBe(3);
  });

  it("keeps every one-click security rule compatible with the safe regex policy", async () => {
    const { SECURITY_RULE_PACK, validateCustomRedactionPattern } = await import(
      "../src/services/redaction.js"
    );
    for (const rule of SECURITY_RULE_PACK) {
      expect(() => validateCustomRedactionPattern(rule.pattern)).not.toThrow();
    }
  });
});
