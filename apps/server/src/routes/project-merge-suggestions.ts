import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireWebUser } from "../http.js";
import {
  analyzeProjectMergeSuggestions,
  dismissProjectMergeSuggestion,
  listIgnoredProjectMergeSuggestions,
  listProjectMergeSuggestions,
  restoreProjectMergeSuggestion,
} from "../services/project-merge-suggestions.js";

const PairInputSchema = z.object({
  projectIds: z.array(z.guid().transform((id) => id.toLowerCase())).min(2).max(20),
}).refine((input) => new Set(input.projectIds).size === input.projectIds.length, { message: "请选择至少两个不同项目，不要重复选择" });

export async function projectMergeSuggestionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/projects/merge-suggestions", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z.object({
      limit: z.coerce.number().int().min(1).max(50).default(8),
      offset: z.coerce.number().int().min(0).default(0),
    }).parse(request.query);
    return listProjectMergeSuggestions(input);
  });

  app.post("/api/v1/projects/merge-suggestions/analyze", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    await analyzeProjectMergeSuggestions();
    return listProjectMergeSuggestions({ limit: 8, offset: 0 });
  });

  app.get("/api/v1/projects/merge-suggestions/ignored", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return { items: await listIgnoredProjectMergeSuggestions() };
  });

  app.post("/api/v1/projects/merge-suggestions/dismiss", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = PairInputSchema.parse(request.body);
    await dismissProjectMergeSuggestion(input.projectIds);
    return { ok: true };
  });

  app.delete("/api/v1/projects/merge-suggestions/dismiss", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = PairInputSchema.parse(request.body);
    await restoreProjectMergeSuggestion(input.projectIds);
    return { ok: true };
  });
}
