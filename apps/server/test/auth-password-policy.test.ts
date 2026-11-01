import Fastify from "fastify";
import { ZodError } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  bootstrapAdmin: vi.fn(async () => ({ secret: "test", otpauthUrl: "test" })),
  changeAdminPassword: vi.fn(async () => undefined),
}));

vi.mock("../src/services/auth.js", () => auth);
vi.mock("../src/http.js", () => ({
  requireSameOrigin: async () => true,
  requireWebUser: async () => ({ id: "admin-id", username: "admin" }),
  SESSION_COOKIE: "session",
}));

import { authRoutes } from "../src/routes/auth.js";

describe("administrator password policy", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["bootstrap", "password"] as const)("accepts 11 characters at %s", async (route) => {
    const app = Fastify();
    await authRoutes(app);
    try {
      const payload = route === "bootstrap"
        ? { username: "admin", password: "abcdefghijk" }
        : { currentPassword: "existing-password", newPassword: "abcdefghijk", totpCode: "123456" };
      const response = await app.inject({ method: "POST", url: `/api/v1/auth/${route}`, payload });
      expect(response.statusCode).toBe(route === "bootstrap" ? 201 : 200);
      expect(route === "bootstrap" ? auth.bootstrapAdmin : auth.changeAdminPassword).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each(["bootstrap", "password"] as const)("rejects 10 characters at %s before changing credentials", async (route) => {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 400 : 500).send());
    await authRoutes(app);
    try {
      const payload = route === "bootstrap"
        ? { username: "admin", password: "abcdefghij" }
        : { currentPassword: "existing-password", newPassword: "abcdefghij", totpCode: "123456" };
      const response = await app.inject({ method: "POST", url: `/api/v1/auth/${route}`, payload });
      expect(response.statusCode).toBe(400);
      expect(auth.bootstrapAdmin).not.toHaveBeenCalled();
      expect(auth.changeAdminPassword).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("still requires a six-digit OTP when changing a password", async () => {
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 400 : 500).send());
    await authRoutes(app);
    try {
      const response = await app.inject({
        method: "POST", url: "/api/v1/auth/password",
        payload: { currentPassword: "existing-password", newPassword: "abcdefghijk" },
      });
      expect(response.statusCode).toBe(400);
      expect(auth.changeAdminPassword).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
