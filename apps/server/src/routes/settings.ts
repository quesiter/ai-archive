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
import { testReportEmail } from "../services/email.js";
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
import { safeStoredError } from "../services/operation-log.js";

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

const BooleanSettingSchema = z.enum(["true", "false"]);
const settingSchemas: Record<string, z.ZodType<string>> = {
  "ai.pacingEnabled": BooleanSettingSchema,
  "ai.requestIntervalSeconds": z.string().regex(/^\d+$/).refine(
    (value) => Number(value) >= 0 && Number(value) <= 3600,
    "Must be an integer from 0 to 3600",
  ),
  "ai.nightlyMaintenanceEnabled": BooleanSettingSchema,
  "smtp.port": z.string().refine(
    (value) => value === "" || (/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 65_535),
    "Must be empty or an integer from 1 to 65535",
  ),
  "smtp.secure": BooleanSettingSchema,
  "reports.weeklyEnabled": BooleanSettingSchema,
  "reports.monthlyEnabled": BooleanSettingSchema,
  "classification.autoOnCapture": BooleanSettingSchema,
  "classification.autoReclassify": BooleanSettingSchema,
  "classification.runMode": z.enum(["economy", "full"]),
  "classification.reuseStable": BooleanSettingSchema,
  "classification.maxConversationChars": z.string().regex(/^\d+$/).refine(
    (value) => Number(value) >= 2_000 && Number(value) <= 40_000,
    "Must be an integer from 2000 to 40000",
  ),
};

export function securityPackStatus(
  rules: Array<{ pattern: string; enabled: boolean }>,
): { total: number; installed: number; enabled: number; fullyEnabled: boolean } {
  const matches = SECURITY_RULE_PACK.map((template) =>
    rules.find((rule) => rule.pattern === template.pattern),
  );
  return {
    total: SECURITY_RULE_PACK.length,
    installed: matches.filter(Boolean).length,
    enabled: matches.filter((rule) => rule?.enabled).length,
    fullyEnabled: matches.every((rule) => rule?.enabled === true),
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/settings", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const storedRedactionRules = await db
      .select()
      .from(redactionRules)
      .orderBy(asc(redactionRules.createdAt));
    return {
      settings: await getPublicSettings(),
      redactionRules: storedRedactionRules.map((rule) => ({
          ...rule,
          name:
            SECURITY_RULE_PACK.find((template) => template.pattern === rule.pattern)
              ?.name ?? null,
        })),
      securityPack: securityPackStatus(storedRedactionRules),
    };
  });

  app.put("/api/v1/settings", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z.record(z.string(), z.string().max(20_000)).parse(request.body);
    for (const key of Object.keys(input)) {
      if (!ALLOWED_SETTINGS.has(key)) {
        return reply.code(400).send({ error: `Unsupported setting: ${key}` });
      }
      const schema = settingSchemas[key];
      if (schema) {
        const validated = schema.safeParse(input[key]);
        if (!validated.success) {
          return reply.code(400).send({
            error: `Invalid setting: ${key}`,
            issues: validated.error.issues,
          });
        }
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
        error: safeStoredError(error),
      });
    }
  });

  app.post("/api/v1/settings/email/test", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = z.object({
      host: z.string().max(253).default(""),
      port: z.string().max(5).default(""),
      secure: z.enum(["true", "false"]).default("false"),
      username: z.string().max(1_000).default(""),
      password: z.string().max(20_000).default(""),
      from: z.string().max(1_000).default(""),
      to: z.string().max(5_000).default(""),
    }).parse(request.body ?? {});
    try {
      return { ok: true, ...(await testReportEmail(input)) };
    } catch (error) {
      return reply.code(400).send({
        ok: false,
        error: safeStoredError(error),
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
      "历史归档敏感信息脱敏已入队",
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
