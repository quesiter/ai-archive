import { asc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import { redactionRules } from "../schema.js";
import {
  getPublicSettings,
  SECRET_SETTING_KEYS,
  setSettings,
} from "../services/settings.js";
import { testLlmConnection } from "../services/llm.js";
import safeRegex from "safe-regex2";

const ALLOWED_SETTINGS = new Set([
  "llm.baseUrl",
  "llm.apiKey",
  "llm.model",
  "smtp.host",
  "smtp.port",
  "smtp.secure",
  "smtp.username",
  "smtp.password",
  "smtp.from",
  "smtp.to",
  "reports.weeklyEnabled",
  "reports.monthlyEnabled",
  "classification.autoOnCapture",
  "classification.autoReclassify",
  "classification.runMode",
  "classification.reuseStable",
  "classification.maxConversationChars",
]);

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/settings", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return {
      settings: await getPublicSettings(),
      redactionRules: await db
        .select()
        .from(redactionRules)
        .orderBy(asc(redactionRules.createdAt)),
    };
  });

  app.put("/api/v1/settings", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z.record(z.string(), z.string().max(20_000)).parse(request.body);
    for (const key of Object.keys(input)) {
      if (!ALLOWED_SETTINGS.has(key)) {
        return reply.code(400).send({ error: `Unsupported setting: ${key}` });
      }
    }
    await setSettings(
      Object.entries(input).filter(
        ([key, value]) => !(SECRET_SETTING_KEYS.has(key) && value === "********"),
      ),
    );
    return { ok: true };
  });

  app.post("/api/v1/settings/llm/test", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z
      .object({
        baseURL: z.string().max(2_000).optional(),
        apiKey: z.string().max(20_000).optional(),
        model: z.string().max(300).optional(),
      })
      .parse(request.body ?? {});
    try {
      const result = await testLlmConnection(input);
      return { ok: true, ...result };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: error instanceof Error ? error.message : "Model test failed",
      });
    }
  });

  app.post("/api/v1/redaction-rules", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z
      .object({
        pattern: z.string().min(1).max(1_000),
        replacement: z.string().min(1).max(200).default("[CUSTOM_REDACTED]"),
      })
      .parse(request.body);
    try {
      new RegExp(input.pattern, "gu");
      if (!safeRegex(input.pattern)) {
        return reply.code(400).send({ error: "Regular expression is too complex" });
      }
    } catch {
      return reply.code(400).send({ error: "Invalid regular expression" });
    }
    const [rule] = await db.insert(redactionRules).values(input).returning();
    return reply.code(201).send(rule);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/redaction-rules/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z
        .object({ enabled: z.boolean() })
        .parse(request.body);
      const [rule] = await db
        .update(redactionRules)
        .set(input)
        .where(eq(redactionRules.id, params.id))
        .returning();
      if (!rule) return reply.code(404).send({ error: "Rule not found" });
      return rule;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/redaction-rules/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      await db.delete(redactionRules).where(eq(redactionRules.id, params.id));
      return reply.code(204).send();
    },
  );
}
