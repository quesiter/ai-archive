import { and, count, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ProviderSchema } from "@ai-archive/contracts";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import { devices, operationLogs } from "../schema.js";
import { literalContainsPattern } from "../services/search-pattern.js";
import { parseInstanceDateBoundary } from "../services/timezone.js";

const LogScopeSchema = z.enum([
  "analysis",
  "capture",
  "classification",
  "device",
  "import",
  "system",
]);

const LogLevelSchema = z.enum(["info", "warning", "error"]);

export function operationLogDeviceId(log: {
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
}): string | null {
  const metadata = log.metadata;
  if (typeof metadata?.deviceId === "string") return metadata.deviceId;
  if (typeof metadata?.sourceDeviceId === "string") return metadata.sourceDeviceId;
  if (log.entityType === "device" && typeof log.entityId === "string") {
    return log.entityId;
  }
  return null;
}

export async function logRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/logs", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(80),
        offset: z.coerce.number().int().min(0).default(0),
        scope: LogScopeSchema.optional(),
        level: LogLevelSchema.optional(),
        provider: ProviderSchema.optional(),
        deviceId: z.string().uuid().optional(),
        status: z.string().min(1).max(80).optional(),
        q: z.string().min(1).max(200).optional(),
        from: z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value))).optional(),
        to: z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isNaN(Date.parse(value))).optional(),
        range: z.enum(["1h", "24h", "7d", "30d"]).optional(),
      })
      .parse(request.query);
    const filters = [
      query.scope ? eq(operationLogs.scope, query.scope) : undefined,
      query.level ? eq(operationLogs.level, query.level) : undefined,
      query.provider
        ? or(
            sql`${operationLogs.metadata}->>'provider' = ${query.provider}`,
            sql`${operationLogs.metadata}->>'sourceProvider' = ${query.provider}`,
            sql`${operationLogs.metadata}->>'conversationProvider' = ${query.provider}`,
          )
        : undefined,
      query.deviceId
        ? or(
            sql`${operationLogs.metadata}->>'deviceId' = ${query.deviceId}`,
            sql`${operationLogs.metadata}->>'sourceDeviceId' = ${query.deviceId}`,
            and(
              eq(operationLogs.entityType, "device"),
              eq(operationLogs.entityId, query.deviceId),
            ),
          )
        : undefined,
      query.status ? eq(operationLogs.status, query.status) : undefined,
      query.q ? ilike(operationLogs.message, literalContainsPattern(query.q)) : undefined,
      query.from ? gte(operationLogs.createdAt, parseInstanceDateBoundary(query.from)) : undefined,
      query.to ? lt(operationLogs.createdAt, parseInstanceDateBoundary(query.to, true)) : undefined,
      query.range ? gte(operationLogs.createdAt, new Date(Date.now() - ({ "1h": 1, "24h": 24, "7d": 168, "30d": 720 }[query.range]) * 60 * 60_000)) : undefined,
    ].filter(Boolean);

    const where = filters.length ? and(...filters) : undefined;
    const [[totalRow], items] = await Promise.all([
      db.select({ total: count() }).from(operationLogs).where(where),
      db
        .select()
        .from(operationLogs)
        .where(where)
        .orderBy(desc(operationLogs.createdAt))
        .limit(query.limit)
        .offset(query.offset),
    ]);
    const deviceIds = [...new Set(items.map(operationLogDeviceId).filter(Boolean))] as string[];
    const deviceRows = deviceIds.length
      ? await db
          .select({ id: devices.id, name: devices.name, kind: devices.kind })
          .from(devices)
          .where(inArray(devices.id, deviceIds))
      : [];
    const devicesById = new Map(deviceRows.map((device) => [device.id, device]));
    const total = Number(totalRow?.total ?? 0);
    return {
      items: items.map((item) => ({
        ...item,
        device: devicesById.get(operationLogDeviceId(item) ?? "") ?? null,
      })),
      pagination: {
        total,
        limit: query.limit,
        offset: query.offset,
        hasMore: query.offset + items.length < total,
      },
    };
  });
}
