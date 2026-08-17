import { describe, expect, it } from "vitest";
import {
  normalizeLogMetadata,
  redactLogText,
  safeStoredError,
} from "../src/services/operation-log.js";

describe("operation log redaction", () => {
  it("redacts bearer credentials and secret-looking key/value pairs", () => {
    const result = redactLogText(
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz api_key=sk-abcdefghijklmnop",
    );
    expect(result).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(result).not.toContain("sk-abcdefghijklmnop");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts nested values whose keys are sensitive", () => {
    expect(
      normalizeLogMetadata({
        provider: "codex",
        token: "device-bearer-token",
        nested: { smtpPassword: "mail-secret", count: 2 },
      }),
    ).toEqual({
      provider: "codex",
      token: "[REDACTED]",
      nested: { smtpPassword: "[REDACTED]", count: 2 },
    });
  });

  it("sanitizes errors before persisting task state", () => {
    expect(safeStoredError(new Error("Bearer abcdefghijklmnopqrstuvwxyz"))).toBe(
      "Bearer [REDACTED]",
    );
  });
});
