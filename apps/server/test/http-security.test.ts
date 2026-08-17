import { describe, expect, it } from "vitest";
import { bearerToken, isAllowedWebMutation } from "../src/http.js";

describe("HTTP request security", () => {
  it("requires an exact same-origin signal for cookie-authenticated writes", () => {
    expect(isAllowedWebMutation({ method: "POST" })).toBe(false);
    expect(
      isAllowedWebMutation({
        method: "POST",
        origin: "https://attacker.example",
        secFetchSite: "cross-site",
      }),
    ).toBe(false);
    expect(
      isAllowedWebMutation({ method: "POST", origin: "http://localhost:5173" }),
    ).toBe(true);
    expect(
      isAllowedWebMutation({
        method: "DELETE",
        referer: "http://localhost:5173/conversations/123",
      }),
    ).toBe(true);
    expect(isAllowedWebMutation({ method: "GET" })).toBe(true);
  });

  it("parses Bearer tokens case-insensitively without accepting extra values", () => {
    const request = (authorization: string) =>
      ({ headers: { authorization } }) as Parameters<typeof bearerToken>[0];
    expect(bearerToken(request("bearer abc-123"))).toBe("abc-123");
    expect(bearerToken(request("Bearer first,second"))).toBeUndefined();
    expect(bearerToken(request("Basic abc-123"))).toBeUndefined();
  });
});
