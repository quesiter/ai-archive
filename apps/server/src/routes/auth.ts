import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import {
  requireSameOrigin,
  requireWebUser,
  SESSION_COOKIE,
} from "../http.js";
import {
  bootstrapAdmin,
  isInitialized,
  login,
  logout,
} from "../services/auth.js";

const BootstrapSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(12).max(256),
});

const LoginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
  totpCode: z.string().regex(/^\d{6}$/),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/auth/status", async () => ({
    initialized: await isInitialized(),
  }));

  app.post("/api/v1/auth/bootstrap", {
    config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!(await requireSameOrigin(request, reply))) return;
    try {
      const input = BootstrapSchema.parse(request.body);
      const result = await bootstrapAdmin(input);
      return reply.code(201).send(result);
    } catch {
      request.log.warn("administrator bootstrap rejected");
      return reply.code(409).send({ error: "Administrator is already initialized" });
    }
  });

  app.post("/api/v1/auth/login", {
    config: { rateLimit: { max: 5, timeWindow: "5 minutes" } },
  }, async (request, reply) => {
    if (!(await requireSameOrigin(request, reply))) return;
    try {
      const input = LoginSchema.parse(request.body);
      const result = await login(input);
      reply.setCookie(SESSION_COOKIE, result.token, {
        path: "/",
        httpOnly: true,
        secure: config.cookieSecure,
        sameSite: "strict",
        expires: result.expiresAt,
      });
      return { user: { username: input.username }, expiresAt: result.expiresAt };
    } catch {
      request.log.warn("administrator login rejected");
      return reply.code(401).send({ error: "Invalid username, password, or TOTP code" });
    }
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    await logout(request.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/me", async (request, reply) => {
    const user = await requireWebUser(request, reply);
    if (!user) return;
    return { user };
  });
}
