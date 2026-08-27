import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import { savedSearches } from "../schema.js";
import { isUniqueViolation } from "../services/projects.js";

const allowedQueryKeys = new Set([
  "q",
  "provider",
  "source",
  "completeness",
  "captureMode",
  "projectId",
  "tagIds",
  "from",
  "to",
]);

const SavedSearchInputSchema = z.object({
  name: z.string().transform((value, context) => {
    const name = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
    if (!name || [...name].length > 100) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Saved search name must contain 1 to 100 characters" });
      return z.NEVER;
    }
    return name;
  }),
  query: z.record(z.string().max(500)).transform((query) =>
    Object.fromEntries(
      Object.entries(query).filter(([key, value]) => allowedQueryKeys.has(key) && value),
    ),
  ),
});

export async function savedSearchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/saved-searches", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return db.select().from(savedSearches).orderBy(asc(savedSearches.name));
  });

  app.post("/api/v1/saved-searches", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = SavedSearchInputSchema.parse(request.body);
    try {
      const [saved] = await db.insert(savedSearches).values({
        name: input.name,
        normalizedName: input.name.toLocaleLowerCase("en-US"),
        query: input.query,
        updatedAt: new Date(),
      }).returning();
      return reply.code(201).send(saved);
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.code(409).send({ error: "A saved search with this name already exists" });
      }
      throw error;
    }
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/saved-searches/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const [deleted] = await db.delete(savedSearches).where(eq(savedSearches.id, params.id)).returning({ id: savedSearches.id });
      if (!deleted) return reply.code(404).send({ error: "Saved search not found" });
      return reply.code(204).send();
    },
  );
}
