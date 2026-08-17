import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { settings } from "../schema.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { validateNetworkUrl } from "./network-target.js";

export const SECRET_SETTING_KEYS = new Set([
  "llm.apiKey",
  "smtp.password",
]);

const SETTING_LIMITS = {
  "llm.baseUrl": 2_000,
  "llm.apiKey": 20_000,
  "llm.model": 300,
  "smtp.host": 253,
  "smtp.port": 5,
  "smtp.secure": 5,
  "smtp.username": 1_000,
  "smtp.password": 20_000,
  "smtp.from": 1_000,
  "smtp.to": 5_000,
} as const;

export function validateSettingValue(key: string, rawValue: string): string {
  const value = rawValue.trim();
  const limit = SETTING_LIMITS[key as keyof typeof SETTING_LIMITS] ?? 20_000;
  if (rawValue.length > limit) throw new Error(`${key} is too long`);
  if (key === "llm.baseUrl" && value) validateNetworkUrl(value);
  if (key === "smtp.host" && value) {
    if (value.includes("://") || !/^[A-Za-z0-9._:[\]-]+$/.test(value)) {
      throw new Error("SMTP host must be a hostname or IP address without a URL scheme");
    }
  }
  if (key === "smtp.port" && value) {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error("SMTP port must be an integer between 1 and 65535");
    }
  }
  if (key === "smtp.secure" && value && !["true", "false"].includes(value)) {
    throw new Error("smtp.secure must be true or false");
  }
  return value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  value = validateSettingValue(key, value);
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

export async function setSettings(
  values: ReadonlyArray<readonly [string, string]>,
): Promise<void> {
  const prepared = values.map(([key, value]) => {
    const validated = validateSettingValue(key, value);
    const encrypted = SECRET_SETTING_KEYS.has(key);
    return {
      key,
      value: encrypted && validated ? encryptSecret(validated) : validated,
      encrypted,
    };
  });
  await db.transaction(async (tx) => {
    for (const setting of prepared) {
      await tx
        .insert(settings)
        .values({ ...setting, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: settings.key,
          set: {
            value: setting.value,
            encrypted: setting.encrypted,
            updatedAt: new Date(),
          },
        });
    }
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
