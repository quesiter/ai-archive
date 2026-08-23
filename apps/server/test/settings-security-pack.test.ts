import { describe, expect, it } from "vitest";
import { SECURITY_RULE_PACK } from "../src/services/redaction.js";
import { securityPackStatus } from "../src/routes/settings.js";

describe("security pack status", () => {
  it("is fully enabled only when every built-in rule exists and is enabled", () => {
    const enabledRules = SECURITY_RULE_PACK.map((rule) => ({
      pattern: rule.pattern,
      enabled: true,
    }));
    expect(securityPackStatus(enabledRules)).toMatchObject({
      installed: SECURITY_RULE_PACK.length,
      enabled: SECURITY_RULE_PACK.length,
      fullyEnabled: true,
    });

    expect(securityPackStatus(enabledRules.slice(1)).fullyEnabled).toBe(false);
    expect(securityPackStatus([
      ...enabledRules.slice(0, -1),
      { ...enabledRules.at(-1)!, enabled: false },
    ]).fullyEnabled).toBe(false);
  });
});
