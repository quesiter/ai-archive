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

  it("redacts connection URLs, private keys, SSH commands, and quoted passwords", () => {
    const result = redactLogText([
      "postgresql://archive:super-secret@db.example/archive",
      "https://admin:browser-secret@example.com/private",
      "ssh deploy@example.com -p 2222",
      'password="a secret with spaces"',
      "-----BEGIN OPENSSH PRIVATE KEY-----\nprivate-material\n-----END OPENSSH PRIVATE KEY-----",
    ].join("\n"));
    expect(result).not.toContain("super-secret");
    expect(result).not.toContain("browser-secret");
    expect(result).not.toContain("deploy@example.com");
    expect(result).not.toContain("a secret with spaces");
    expect(result).not.toContain("private-material");
    expect(result).toContain("[DATABASE_URL]");
    expect(result).toContain("[AUTHENTICATED_URL]");
    expect(result).toContain("[SSH_LOGIN]");
    expect(result).toContain("[PRIVATE_KEY]");
  });
});
