import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { describe, expect, it, vi } from "vitest";
vi.mock("../src/services/auth.js", () => ({
  WEB_SESSION_MAX_AGE: 90 * 86400,
  authenticateWebSession: async (_token: string, renew: (expiry: Date) => void) => {
    renew(new Date(Date.now() + 90 * 86400000));
    return { id: "admin", username: "admin" };
  },
  authenticateDevice: vi.fn(),
}));
import { requireWebUser, setWebSessionCookie } from "../src/http.js";
describe("persistent authentication cookie", () => {
  it("persists initial and renewed sessions with HttpOnly, Lax and a 90-day Max-Age", async () => {
    const app = Fastify();
    await app.register(cookie);
    app.get("/login", async (_request, reply) => {
      setWebSessionCookie(reply, "test-token", new Date(Date.now() + 90 * 86400000));
      return { ok: true };
    });
    app.get("/me", async (request, reply) => requireWebUser(request, reply));
    try {
      for (const url of ["/login", "/me"]) {
        const response = await app.inject({ url, headers: { cookie: "archive_session=test-token" } });
        expect(response.statusCode).toBe(200);
        expect(response.headers["set-cookie"]).toContain("Max-Age=7776000");
        expect(response.headers["set-cookie"]).toContain("HttpOnly");
        expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
        expect(response.headers["set-cookie"]).toContain("Expires=");
      }
    } finally { await app.close(); }
  });
});
