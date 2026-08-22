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
import {
  SECURITY_RULE_PACK,
  redactForCloud,
  redactForStorage,
  validateCustomRedactionPattern,
} from "../services/redaction.js";
import {
  createBackgroundTask,
  failBackgroundTask,
  failStaleBackgroundTasks,
  getLatestBackgroundTask,
} from "../services/background-tasks.js";
import { enqueueStorageRedaction } from "../services/queue.js";

const ALLOWED_SETTINGS = new Set([
  "llm.baseUrl",
  "llm.apiKey",
  "llm.model",
  "ai.pacingEnabled",
  "ai.requestIntervalSeconds",
  "ai.nightlyMaintenanceEnabled",
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
      redactionRules: (await db
        .select()
        .from(redactionRules)
        .orderBy(asc(redactionRules.createdAt))).map((rule) => ({
          ...rule,
          name:
            SECURITY_RULE_PACK.find((template) => template.pattern === rule.pattern)
              ?.name ?? null,
        })),
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
      validateCustomRedactionPattern(input.pattern);
    } catch (error) {
      return reply.code(400).send({
        error:
          error instanceof Error && error.message.includes("too complex")
            ? "正则表达式过于复杂"
            : "无效的正则表达式",
      });
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

  app.post("/api/v1/redaction-rules/test", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z
      .object({
        text: z.string().min(1).max(20_000),
        target: z.enum(["storage", "cloud"]).default("storage"),
      })
      .parse(request.body ?? {});
    const result =
      input.target === "cloud"
        ? await redactForCloud(input.text)
        : await redactForStorage(input.text);
    return { ok: true, ...result };
  });

  async function queueStorageCleanup() {
    await failStaleBackgroundTasks("storage_redaction", 24 * 60 * 60_000);
    const active = await getLatestBackgroundTask("storage_redaction", [
      "queued",
      "running",
    ]);
    if (active) return { task: active, jobId: null, reused: true };
    const task = await createBackgroundTask(
      "storage_redaction",
      "已有归档敏感信息清理已入队",
    );
    const jobId = await enqueueStorageRedaction(task.id);
    if (!jobId) {
      await failBackgroundTask(task.id, "敏感信息清理任务入队失败");
      throw new Error("敏感信息清理任务入队失败");
    }
    return { task, jobId, reused: false };
  }

  app.post("/api/v1/redaction-rules/security-pack", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    for (const template of SECURITY_RULE_PACK) {
      validateCustomRedactionPattern(template.pattern);
    }
    const existing = await db.select().from(redactionRules);
    let added = 0;
    let enabled = 0;
    for (const template of SECURITY_RULE_PACK) {
      const match = existing.find((rule) => rule.pattern === template.pattern);
      if (match) {
        await db
          .update(redactionRules)
          .set({ enabled: true, replacement: template.replacement })
          .where(eq(redactionRules.id, match.id));
        enabled += 1;
      } else {
        await db.insert(redactionRules).values({
          pattern: template.pattern,
          replacement: template.replacement,
          enabled: true,
        });
        added += 1;
      }
    }
    const cleanup = await queueStorageCleanup();
    return reply.code(202).send({
      ok: true,
      added,
      enabled,
      total: SECURITY_RULE_PACK.length,
      cleanup,
    });
  });

  app.post("/api/v1/redaction/storage-cleanup", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return reply.code(202).send(await queueStorageCleanup());
  });

  app.get("/api/v1/redaction/storage-cleanup", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    await failStaleBackgroundTasks("storage_redaction", 24 * 60 * 60_000);
    return {
      task: await getLatestBackgroundTask("storage_redaction"),
    };
  });
}
