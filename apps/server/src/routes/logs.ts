import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { ProviderSchema } from "@ai-archive/contracts";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import { operationLogs } from "../schema.js";

const LogScopeSchema = z.enum([
  "analysis",
  "capture",
  "classification",
  "device",
  "import",
  "system",
]);

const LogLevelSchema = z.enum(["info", "warning", "error"]);

export async function logRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/logs", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z
      .object({
        limit: z.coerce.number().int().min(1).max(200).default(80),
        scope: LogScopeSchema.optional(),
        level: LogLevelSchema.optional(),
        provider: ProviderSchema.optional(),
        status: z.string().min(1).max(80).optional(),
        q: z.string().min(1).max(200).optional(),
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
      query.status ? eq(operationLogs.status, query.status) : undefined,
      query.q ? ilike(operationLogs.message, `%${query.q}%`) : undefined,
    ].filter(Boolean);

    return {
      items: await db
        .select()
        .from(operationLogs)
        .where(filters.length ? and(...filters) : undefined)
        .orderBy(desc(operationLogs.createdAt))
        .limit(query.limit),
    };
  });
}
