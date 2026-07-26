import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { settings } from "../schema.js";
import { decryptSecret, encryptSecret } from "./crypto.js";

export const SECRET_SETTING_KEYS = new Set([
  "llm.apiKey",
  "smtp.password",
]);

export async function setSetting(key: string, value: string): Promise<void> {
  const encrypted = SECRET_SETTING_KEYS.has(key);
  const persistedValue = encrypted && value ? encryptSecret(value) : value;
  await db
    .insert(settings)
    .values({ key, value: persistedValue, encrypted, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: persistedValue, encrypted, updatedAt: new Date() },
    });
}

export async function getSetting(key: string): Promise<string | null> {
  const [setting] = await db
    .select()
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  if (!setting) return null;
  return setting.encrypted ? decryptSecret(setting.value) : setting.value;
}

export async function getBooleanSetting(
  key: string,
  defaultValue: boolean,
): Promise<boolean> {
  const value = await getSetting(key);
  if (value === null || value === "") return defaultValue;
  return value === "true";
}

export async function getNumberSetting(
  key: string,
  defaultValue: number,
  options: { min?: number; max?: number } = {},
): Promise<number> {
  const value = await getSetting(key);
  const parsed = value === null || value === "" ? defaultValue : Number(value);
  const numeric = Number.isFinite(parsed) ? parsed : defaultValue;
  return Math.min(
    options.max ?? Number.POSITIVE_INFINITY,
    Math.max(options.min ?? Number.NEGATIVE_INFINITY, numeric),
  );
}

export async function getPublicSettings(): Promise<Record<string, string>> {
  const rows = await db.select().from(settings);
  return Object.fromEntries(
    rows.map((row) => [
      row.key,
      row.encrypted ? (row.value ? "********" : "") : row.value,
    ]),
  );
}
