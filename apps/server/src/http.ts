import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { authenticateDevice, authenticateWebSession } from "./services/auth.js";

export const SESSION_COOKIE = "archive_session";

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

export async function requireWebUser(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ id: string; username: string } | null> {
  const user = await authenticateWebSession(request.cookies[SESSION_COOKIE]);
  if (!user) {
    await reply.code(401).send({ error: "Authentication required" });
    return null;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.origin;
    if (origin && origin !== config.APP_ORIGIN) {
      await reply.code(403).send({ error: "Origin is not allowed" });
      return null;
    }
  }
  return user;
}

export async function requireDevice(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<{ id: string; name: string; kind: string } | null> {
  const device = await authenticateDevice(bearerToken(request));
  if (!device) {
    await reply.code(401).send({ error: "Valid device token required" });
    return null;
  }
  return device;
}

export function errorMessage(error: unknown): string {
  const record =
    typeof error === "object" && error ? (error as Record<string, unknown>) : {};
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const normalized = message.replace(/\s+/g, " ").trim();
  if (/^Failed query:/i.test(normalized) || normalized.includes(" params: ")) {
    const cause = record.cause;
    const causeMessage =
      cause && cause !== error ? errorMessage(cause) : "database rejected the query";
    return `Database query failed: ${causeMessage}`;
  }
  const fallback = normalized || "Unknown error";
  return fallback.length <= 1_000 ? fallback : `${fallback.slice(0, 1_000)}...`;
}
