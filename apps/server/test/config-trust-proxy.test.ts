import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("trusted reverse proxy configuration", () => {
  it.each(["false", "true", "127.0.0.1", "10.0.0.0/8", "loopback, linklocal"])(
    "preserves explicit trusted proxy setting %s", async (value) => {
      vi.stubEnv("TRUST_PROXY", value);
      const { config } = await import("../src/config.js");
      expect(config.trustProxy).toBe(value === "true" ? true : value === "false" ? false : value);
    },
  );

  it.each(["0", "1", "2", "001"])("rejects unsafe hop-only setting %s with migration guidance", async (value) => {
    vi.stubEnv("TRUST_PROXY", value);
    await expect(import("../src/config.js")).rejects.toThrow(/explicit trusted proxy IP addresses\/CIDRs/);
  });
});
