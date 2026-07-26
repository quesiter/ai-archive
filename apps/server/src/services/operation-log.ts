import { and, desc, eq } from "drizzle-orm";
import { db } from "../db.js";
import {
  operationLogs,
  type OperationLogLevel,
  type OperationLogScope,
} from "../schema.js";

const MAX_METADATA_DEPTH = 4;
const MAX_METADATA_ARRAY_ITEMS = 12;
const MAX_METADATA_KEYS = 24;
const MAX_METADATA_STRING_LENGTH = 1_500;

export type OperationLogInput = {
  scope: OperationLogScope;
  level?: OperationLogLevel;
  message: string;
  status?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
};

function truncateText(value: string, limit = MAX_METADATA_STRING_LENGTH): string {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}…[truncated ${value.length - limit} chars]`;
}

export function normalizeLogMetadata(
  value: unknown,
  depth = 0,
): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }
  if (typeof value === "string") return truncateText(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    if (depth >= MAX_METADATA_DEPTH) return `[array:${value.length}]`;
    return value
      .slice(0, MAX_METADATA_ARRAY_ITEMS)
      .map((item) => normalizeLogMetadata(item, depth + 1));
  }
  if (typeof value === "object" && value) {
    if (depth >= MAX_METADATA_DEPTH) return "[object]";
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).slice(0, MAX_METADATA_KEYS);
    return Object.fromEntries(
      entries.map(([key, item]) => [
        truncateText(key, 120),
        normalizeLogMetadata(item, depth + 1),
      ]),
    );
  }
  return String(value);
}

function levelFromStatus(status: string | null | undefined): OperationLogLevel {
  if (status === "failed") return "error";
  if (status === "partial") return "warning";
  return "info";
}

export async function writeOperationLog(input: OperationLogInput): Promise<void> {
  try {
    await db.insert(operationLogs).values({
      scope: input.scope,
      level: input.level ?? levelFromStatus(input.status),
      message: truncateText(input.message, 3_000),
      status: input.status ?? null,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      metadata: normalizeLogMetadata(input.metadata ?? {}) as Record<string, unknown>,
    });
  } catch (error) {
    console.warn(
      "Failed to write operation log:",
      error instanceof Error ? error.message : error,
    );
  }
}

export async function listEntityOperationLogs(input: {
  entityType: string;
  entityId: string;
  limit?: number;
}): Promise<Array<typeof operationLogs.$inferSelect>> {
  return db
    .select()
    .from(operationLogs)
    .where(
      and(
        eq(operationLogs.entityType, input.entityType),
        eq(operationLogs.entityId, input.entityId),
      ),
    )
    .orderBy(desc(operationLogs.createdAt))
    .limit(input.limit ?? 50);
}
