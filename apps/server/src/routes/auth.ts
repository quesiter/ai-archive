import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { errorMessage, requireWebUser, SESSION_COOKIE } from "../http.js";
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

  app.post("/api/v1/auth/bootstrap", async (request, reply) => {
    try {
      const input = BootstrapSchema.parse(request.body);
      const result = await bootstrapAdmin(input);
      return reply.code(201).send(result);
    } catch (error) {
      return reply.code(400).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/v1/auth/login", async (request, reply) => {
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
    } catch (error) {
      return reply.code(401).send({ error: errorMessage(error) });
    }
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
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
