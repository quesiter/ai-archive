import { createGunzip } from "node:zlib";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { config } from "./config.js";
import { sqlClient } from "./db.js";
import { activityRoutes } from "./routes/activity.js";
import { authRoutes } from "./routes/auth.js";
import { backupRoutes } from "./routes/backups.js";
import { captureRoutes } from "./routes/captures.js";
import { conversationRoutes } from "./routes/conversations.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { deviceRoutes } from "./routes/devices.js";
import { importRoutes } from "./routes/imports.js";
import { logRoutes } from "./routes/logs.js";
import { projectRoutes } from "./routes/projects.js";
import { reportRoutes } from "./routes/reports.js";
import { settingsRoutes } from "./routes/settings.js";
import { systemStatusRoutes } from "./routes/system-status.js";
import { tagRoutes } from "./routes/tags.js";
import { APP_VERSION } from "./version.js";

const JSON_BODY_LIMIT = 50 * 1024 * 1024;

function payloadTooLargeError(): Error & { statusCode: number } {
  return Object.assign(new Error("Decompressed request body is too large"), {
    statusCode: 413,
  });
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.LOG_LEVEL },
    bodyLimit: JSON_BODY_LIMIT,
    trustProxy: config.trustProxy,
  });

  await app.register(cookie);
  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      if (
        !origin ||
        origin === config.appOrigin ||
        config.extensionOrigins.has(origin) ||
        (config.NODE_ENV !== "production" && origin.startsWith("http://localhost:"))
      ) {
        callback(null, true);
      } else {
        callback(new Error("Origin not allowed"), false);
      }
    },
  });
  await app.register(rateLimit, {
    max: 300,
    timeWindow: "1 minute",
    ban: 3,
    skipOnError: false,
  });
  await app.register(multipart, {
    limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 },
  });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-AI-Archive-Version", APP_VERSION);
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("X-XSS-Protection", "0");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    reply.header("Cross-Origin-Opener-Policy", "same-origin");
    if (config.NODE_ENV === "production") {
      reply.header("Strict-Transport-Security", "max-age=31536000");
    }
    if (request.url.startsWith("/api/") || request.url === "/healthz") {
      reply.header("Cache-Control", "no-store");
    }
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
    );
  });

  app.addHook("preParsing", async (request, _reply, payload) => {
    const encoding = request.headers["content-encoding"]?.toLowerCase().trim();
    if (!encoding || encoding === "identity") return payload;
    if (encoding !== "gzip") {
      throw Object.assign(new Error("Unsupported Content-Encoding"), {
        statusCode: 415,
      });
    }
    delete request.headers["content-encoding"];
    delete request.headers["content-length"];
    const gunzip = createGunzip();
    let decodedBytes = 0;
    gunzip.on("data", (chunk: Buffer) => {
      decodedBytes += chunk.length;
      if (decodedBytes > JSON_BODY_LIMIT) gunzip.destroy(payloadTooLargeError());
    });
    return payload.pipe(gunzip);
  });

  app.get("/healthz", async (_request, reply) => {
    try {
      await sqlClient`select 1`;
      return { ok: true, version: APP_VERSION, time: new Date().toISOString() };
    } catch {
      return reply.code(503).send({
        ok: false,
        version: APP_VERSION,
        time: new Date().toISOString(),
      });
    }
  });

  // Fastify captures the active error handler when a route is registered.
  // Install this before registering route modules so request-schema errors from
  // every route are consistently returned as 400 responses.
  app.setErrorHandler((error, request, reply) => {
    const unknownError = error as {
      name?: unknown;
      issues?: unknown;
      message?: unknown;
      constructor?: { name?: unknown };
    };
    const zodLike =
      error instanceof ZodError ||
      unknownError.name === "ZodError" ||
      unknownError.constructor?.name === "ZodError" ||
      (typeof unknownError.message === "string" &&
        unknownError.message.trimStart().startsWith("[") &&
        unknownError.message.includes('"code"'));
    const zodIssues = Array.isArray(unknownError.issues)
      ? unknownError.issues
      : zodLike
        ? [{ message: String(unknownError.message ?? "Request validation failed") }]
        : null;
    if (zodLike && zodIssues) {
      return reply.code(400).send({
        error: "Request validation failed",
        issues: zodIssues,
      });
    }
    request.log.error(
      {
        errorName: error instanceof Error ? error.name : "UnknownError",
        statusCode: (error as { statusCode?: number }).statusCode ?? 500,
      },
      "request failed",
    );
    const candidate = error as { statusCode?: number; message?: string };
    const statusCode =
      candidate.statusCode && candidate.statusCode < 500
        ? candidate.statusCode
        : 500;
    return reply.code(statusCode).send({
      error:
        statusCode === 500
          ? "Internal server error"
          : candidate.message ?? "Request failed",
    });
  });

  await authRoutes(app);
  await deviceRoutes(app);
  await captureRoutes(app);
  await conversationRoutes(app);
  await projectRoutes(app);
  await tagRoutes(app);
  await dashboardRoutes(app);
  await activityRoutes(app);
  await logRoutes(app);
  await settingsRoutes(app);
  await systemStatusRoutes(app);
  await importRoutes(app);
  await backupRoutes(app);
  await reportRoutes(app);

  const webRoot = resolve(config.WEB_DIST);
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: "/",
      wildcard: false,
    });
    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/healthz") {
        return reply.code(404).send({ error: "Not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return app;
}
