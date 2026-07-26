import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { z } from "zod";

for (const candidate of [
  resolve(process.cwd(), ".env"),
  resolve(process.cwd(), "../../.env"),
]) {
  if (existsSync(candidate)) {
    loadEnvFile(candidate);
    break;
  }
}

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().positive().default(8080),
    DATABASE_URL: z
      .string()
      .min(1)
      .default("postgres://archive:archive@localhost:5432/archive"),
    APP_ORIGIN: z.string().url().default("http://localhost:5173"),
    APP_MASTER_KEY: z.string().optional(),
    COOKIE_SECURE: z
      .string()
      .optional()
      .transform((value) => value === "true"),
    IMPORT_INBOX: z.string().default("./data/imports/inbox"),
    IMPORT_PROCESSED: z.string().default("./data/imports/processed"),
    IMPORT_FAILED: z.string().default("./data/imports/failed"),
    TZ: z.string().default("Asia/Shanghai"),
    LOG_LEVEL: z.string().default("info"),
    WEB_DIST: z.string().default("../web/dist"),
  })
  .superRefine((value, context) => {
    const origin = new URL(value.APP_ORIGIN);
    if (
      value.NODE_ENV === "production" &&
      origin.protocol !== "https:" &&
      !["localhost", "127.0.0.1", "::1"].includes(origin.hostname)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["APP_ORIGIN"],
        message: "APP_ORIGIN must use HTTPS in production",
      });
    }
  });

const env = EnvSchema.parse(process.env);

function resolveMasterKey(): Buffer {
  if (env.APP_MASTER_KEY) {
    const decoded = Buffer.from(env.APP_MASTER_KEY, "base64");
    if (decoded.length !== 32) {
      throw new Error("APP_MASTER_KEY must be exactly 32 bytes encoded as base64");
    }
    return decoded;
  }
  if (env.NODE_ENV === "production") {
    throw new Error("APP_MASTER_KEY is required in production");
  }
  return createHash("sha256").update("ai-archive-development-only-key").digest();
}

export const config = {
  ...env,
  masterKey: resolveMasterKey(),
  cookieSecure: env.COOKIE_SECURE || env.NODE_ENV === "production",
};
