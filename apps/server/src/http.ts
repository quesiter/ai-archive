import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { authenticateDevice, authenticateWebSession } from "./services/auth.js";

export const SESSION_COOKIE = "archive_session";
const SAFE_WEB_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function bearerToken(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  const match = header?.match(/^Bearer[ \t]+([^\s,]+)[ \t]*$/i);
  return match?.[1];
}

function headerOrigin(value: string | string[] | undefined): string | null {
  const source = Array.isArray(value) ? value[0] : value;
  if (!source) return null;
  try {
    const url = new URL(source);
    if (!url.hostname || !["http:", "https:"].includes(url.protocol)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function isAllowedWebMutation(input: {
  method: string;
  origin?: string | string[] | undefined;
  referer?: string | string[] | undefined;
  secFetchSite?: string | string[] | undefined;
}): boolean {
  if (SAFE_WEB_METHODS.has(input.method.toUpperCase())) return true;
  const fetchSite = Array.isArray(input.secFetchSite)
    ? input.secFetchSite[0]
    : input.secFetchSite;
  if (fetchSite === "cross-site") return false;
  const claimedOrigin = headerOrigin(input.origin) ?? headerOrigin(input.referer);
  return claimedOrigin === config.appOrigin;
}

export async function requireSameOrigin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  if (
    isAllowedWebMutation({
      method: request.method,
      origin: request.headers.origin,
      referer: request.headers.referer,
      secFetchSite: request.headers["sec-fetch-site"],
    })
  ) {
    return true;
  }
  await reply.code(403).send({ error: "Same-origin request required" });
  return false;
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
  if (!(await requireSameOrigin(request, reply))) return null;
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
