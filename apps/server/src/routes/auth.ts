import type { FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { config } from "../config.js";
import {
  requireSameOrigin,
  requireWebUser,
  SESSION_COOKIE,
} from "../http.js";
import {
  bootstrapAdmin,
  cancelAdminTotpReset,
  changeAdminPassword,
  confirmAdminTotpReset,
  isInitialized,
  listWebSessions,
  login,
  logout,
  startAdminTotpReset,
  revokeOtherWebSessions,
  revokeWebSession,
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
    instance: { timezone: config.TZ },
  }));

  app.post("/api/v1/auth/bootstrap", {
    config: { rateLimit: { max: 3, timeWindow: "15 minutes" } },
  }, async (request, reply) => {
    if (!(await requireSameOrigin(request, reply))) return;
    try {
      const input = BootstrapSchema.parse(request.body);
      const result = await bootstrapAdmin(input);
      return reply.code(201).send(result);
    } catch (error) {
      if (error instanceof ZodError) throw error;
      if (!(error instanceof Error) || error.message !== "Administrator already initialized") {
        throw error;
      }
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
    return { user, instance: { timezone: config.TZ } };
  });

  app.post("/api/v1/auth/password", async (request, reply) => {
    const user = await requireWebUser(request, reply);
    if (!user) return;
    const input = z.object({
      currentPassword: z.string().min(1).max(256),
      totpCode: z.string().regex(/^\d{6}$/),
      newPassword: z.string().min(12).max(256),
    }).parse(request.body);
    await changeAdminPassword({ userId: user.id, ...input });
    return { ok: true };
  });

  app.post("/api/v1/auth/totp/reset", async (request, reply) => {
    const user = await requireWebUser(request, reply);
    if (!user) return;
    const input = z.object({
      currentPassword: z.string().min(1).max(256),
      totpCode: z.string().regex(/^\d{6}$/),
    }).parse(request.body);
    return { pending: true, ...(await startAdminTotpReset({ userId: user.id, ...input })) };
  });

  app.post("/api/v1/auth/totp/confirm", async (request, reply) => {
    const user = await requireWebUser(request, reply);
    if (!user) return;
    const input = z.object({ totpCode: z.string().regex(/^\d{6}$/) }).parse(request.body);
    await confirmAdminTotpReset({ userId: user.id, totpCode: input.totpCode });
    return { ok: true };
  });

  app.delete("/api/v1/auth/totp/pending", async (request, reply) => {
    const user = await requireWebUser(request, reply);
    if (!user) return;
    await cancelAdminTotpReset(user.id);
    return reply.code(204).send();
  });

  app.get("/api/v1/auth/sessions", async (request, reply) => {
    const user = await requireWebUser(request, reply);
    if (!user) return;
    return {
      items: await listWebSessions(user.id, request.cookies[SESSION_COOKIE]),
    };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/auth/sessions/:id",
    async (request, reply) => {
      const user = await requireWebUser(request, reply);
      if (!user) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const sessions = await listWebSessions(user.id, request.cookies[SESSION_COOKIE]);
      const target = sessions.find((session) => session.id === params.id);
      if (!target || !(await revokeWebSession(user.id, params.id))) {
        return reply.code(404).send({ error: "Session not found" });
      }
      if (target.current) reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    },
  );

  app.post("/api/v1/auth/sessions/revoke-others", async (request, reply) => {
    const user = await requireWebUser(request, reply);
    if (!user) return;
    const revoked = await revokeOtherWebSessions(user.id, request.cookies[SESSION_COOKIE]);
    return { revoked };
  });
}
