import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { createGzip, gunzip, gzip } from "node:zlib";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm/table";
import { getTableColumns } from "drizzle-orm/utils";
import { z } from "zod";
import { config } from "../config.js";
import { db, sqlClient } from "../db.js";
import {
  analysisRuns,
  backgroundTasks,
  captureRuns,
  conversationProjects,
  conversationRevisions,
  conversations,
  devices,
  importJobs,
  knowledgeItems,
  messageSegments,
  messages,
  operationLogs,
  projects,
  redactionRules,
  reports,
  settings,
} from "../schema.js";
import { APP_VERSION } from "../version.js";
import {
  compileCustomRedactionRules,
  redactSensitiveTextForStorage,
  redactSensitiveUrlForStorage,
} from "./redaction.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const BACKUP_FORMAT = "ai-conversation-archive.backup.v1";
const BACKUP_SCHEMA_VERSION = 1;
const EXPORT_CURSOR_BATCH_SIZE = 100;
const INSERT_BATCH_SIZE = 300;
export const MAX_BACKUP_COMPRESSED_BYTES = 512 * 1024 * 1024;
export const MAX_BACKUP_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_BACKUP_ROWS_PER_TABLE = 2_000_000;

type BackupRow = Record<string, unknown>;
type BackupTables = Record<string, BackupRow[]>;

interface TableSpec {
  key: string;
  table: PgTable;
  dateFields: string[];
}

const tableSpecs = [
  { key: "devices", table: devices, dateFields: ["lastSeenAt", "revokedAt", "createdAt"] },
  { key: "conversations", table: conversations, dateFields: ["updatedAt", "deletedAt", "createdAt"] },
  { key: "conversationRevisions", table: conversationRevisions, dateFields: ["capturedAt", "createdAt"] },
  { key: "messages", table: messages, dateFields: ["sourceCreatedAt", "createdAt"] },
  { key: "messageSegments", table: messageSegments, dateFields: ["createdAt"] },
  { key: "captureRuns", table: captureRuns, dateFields: ["capturedAt", "createdAt"] },
  { key: "projects", table: projects, dateFields: ["updatedAt", "createdAt"] },
  { key: "conversationProjects", table: conversationProjects, dateFields: ["updatedAt"] },
  { key: "knowledgeItems", table: knowledgeItems, dateFields: ["updatedAt", "createdAt"] },
  { key: "analysisRuns", table: analysisRuns, dateFields: ["windowStart", "windowEnd", "completedAt", "updatedAt", "createdAt"] },
  { key: "backgroundTasks", table: backgroundTasks, dateFields: ["completedAt", "updatedAt", "createdAt"] },
  { key: "reports", table: reports, dateFields: ["periodStart", "periodEnd", "createdAt"] },
  { key: "settings", table: settings, dateFields: ["updatedAt"] },
  { key: "redactionRules", table: redactionRules, dateFields: ["createdAt"] },
  { key: "importJobs", table: importJobs, dateFields: ["completedAt", "updatedAt", "createdAt"] },
  { key: "operationLogs", table: operationLogs, dateFields: ["createdAt"] },
] satisfies TableSpec[];

const deleteSpecs = [...tableSpecs].reverse();

const BackupEnvelopeSchema = z.object({
  format: z.literal(BACKUP_FORMAT),
  schemaVersion: z.literal(BACKUP_SCHEMA_VERSION),
  exportedAt: z.string(),
  metadata: z.object({
    appVersion: z.string().optional(),
    masterKeyFingerprint: z.string().optional(),
  }).default({}),
  tables: z.record(z.array(z.record(z.unknown())).max(MAX_BACKUP_ROWS_PER_TABLE)),
}).superRefine((value, context) => {
  const allowedTables = new Set(tableSpecs.map((spec) => spec.key));
  for (const key of Object.keys(value.tables)) {
    if (!allowedTables.has(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["tables", key],
        message: "Unknown backup table",
      });
    }
  }
});

export type BackupImportResult = {
  ok: true;
  importedAt: string;
  counts: Record<string, number>;
  warnings: string[];
};

function appVersion(): string {
  return APP_VERSION;
}

function masterKeyFingerprint(): string {
  return createHash("sha256").update(config.masterKey).digest("hex").slice(0, 16);
}

function backupFilename(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `ai-conversation-archive-backup-${stamp}.json.gz`;
}

function* chunks<T>(items: readonly T[], size: number): Iterable<T[]> {
  for (let index = 0; index < items.length; index += size) {
    yield items.slice(index, index + size);
  }
}

async function exportTables(): Promise<BackupTables> {
  const entries = await Promise.all(
    tableSpecs.map(async (spec) => [spec.key, await db.select().from(spec.table)] as const),
  );
  return Object.fromEntries(entries) as BackupTables;
}

async function exportCounts(): Promise<Record<string, number>> {
  const entries = await Promise.all(
    tableSpecs.map(async (spec) => {
      const rows = await sqlClient.unsafe(
        `select count(*)::int as count from ${quotedTableName(spec.table)}`,
      );
      const first = rows[0] as { count?: unknown } | undefined;
      return [spec.key, Number(first?.count ?? 0)] as const;
    }),
  );
  return Object.fromEntries(entries);
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

function quotedTableName(table: PgTable): string {
  return quoteIdentifier(getTableName(table));
}

function selectRowsSql(table: PgTable): string {
  const columns = Object.entries(getTableColumns(table)) as Array<
    [string, { name: string }]
  >;
  const selectList = columns
    .map(([fieldName, column]) =>
      `${quoteIdentifier(column.name)} as ${quoteIdentifier(fieldName)}`,
    )
    .join(", ");
  return `select ${selectList} from ${quotedTableName(table)}`;
}

async function* streamBackupJson(): AsyncGenerator<string> {
  yield `{"format":${JSON.stringify(BACKUP_FORMAT)}`;
  yield `,"schemaVersion":${BACKUP_SCHEMA_VERSION}`;
  yield `,"exportedAt":${JSON.stringify(new Date().toISOString())}`;
  yield `,"metadata":${JSON.stringify({
    appVersion: appVersion(),
    masterKeyFingerprint: masterKeyFingerprint(),
  })}`;
  yield ',"tables":{';

  for (const [tableIndex, spec] of tableSpecs.entries()) {
    if (tableIndex > 0) yield ",";
    yield `${JSON.stringify(spec.key)}:[`;
    let rowIndex = 0;
    const cursor = sqlClient
      .unsafe(selectRowsSql(spec.table))
      .cursor(EXPORT_CURSOR_BATCH_SIZE) as AsyncIterable<BackupRow[]>;
    for await (const batch of cursor) {
      for (const row of batch) {
        if (rowIndex > 0) yield ",";
        yield JSON.stringify(row);
        rowIndex += 1;
      }
    }
    yield "]";
  }

  yield "}}";
}

function reviveDates(row: BackupRow, fields: string[]): BackupRow {
  const revived = { ...row };
  for (const field of fields) {
    const value = revived[field];
    if (typeof value === "string" && value) {
      revived[field] = new Date(value);
    }
  }
  return revived;
}

function sanitizeBackupValue(
  value: unknown,
  rules: ReturnType<typeof compileCustomRedactionRules>,
): unknown {
  if (typeof value === "string") {
    return redactSensitiveTextForStorage(value, rules).text;
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeBackupValue(item, rules));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeBackupValue(item, rules)]),
    );
  }
  return value;
}

export function sanitizeRestoredBackupTables(tables: BackupTables): BackupTables {
  const customRules = compileCustomRedactionRules(
    (tables.redactionRules ?? []).flatMap((row) =>
      typeof row.pattern === "string" && typeof row.replacement === "string"
        ? [{
            pattern: row.pattern,
            replacement: row.replacement,
            enabled: row.enabled !== false,
          }]
        : [],
    ),
  );
  const sanitized: BackupTables = { ...tables };
  const textFields: Record<string, string[]> = {
    conversations: ["title"],
    conversationRevisions: ["searchText", "completenessReason"],
    messageSegments: ["content"],
    captureRuns: ["error"],
    projects: ["name", "description"],
    conversationProjects: ["suggestedName"],
    knowledgeItems: ["title", "body"],
    analysisRuns: ["error"],
    backgroundTasks: ["message", "error"],
    reports: ["title", "summary", "bodyMarkdown"],
    importJobs: ["error"],
    operationLogs: ["message"],
  };
  for (const [table, fields] of Object.entries(textFields)) {
    sanitized[table] = (tables[table] ?? []).map((row) => {
      const next = { ...row };
      for (const field of fields) {
        if (typeof next[field] === "string") {
          next[field] = redactSensitiveTextForStorage(next[field], customRules).text;
        }
      }
      return next;
    });
  }
  sanitized.conversations = (sanitized.conversations ?? []).map((row) => ({
    ...row,
    ...(typeof row.canonicalUrl === "string"
      ? { canonicalUrl: redactSensitiveUrlForStorage(row.canonicalUrl, customRules).text }
      : {}),
  }));
  sanitized.messageSegments = (sanitized.messageSegments ?? []).map((row) => ({
    ...row,
    ...(typeof row.href === "string"
      ? { href: redactSensitiveUrlForStorage(row.href, customRules).text }
      : {}),
  }));
  for (const table of ["analysisRuns", "backgroundTasks", "operationLogs"]) {
    sanitized[table] = (sanitized[table] ?? []).map((row) => ({
      ...row,
      ...(row.stats !== undefined
        ? { stats: sanitizeBackupValue(row.stats, customRules) }
        : {}),
      ...(row.metadata !== undefined
        ? { metadata: sanitizeBackupValue(row.metadata, customRules) }
        : {}),
    }));
  }
  return sanitized;
}

function isGzip(buffer: Buffer, filename: string): boolean {
  return (
    filename.toLowerCase().endsWith(".gz") ||
    (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b)
  );
}

export async function createBackupArchive(): Promise<{
  filename: string;
  buffer: Buffer;
  counts: Record<string, number>;
}> {
  const tables = await exportTables();
  const counts = Object.fromEntries(
    tableSpecs.map((spec) => [spec.key, tables[spec.key]?.length ?? 0]),
  );
  const envelope = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    metadata: {
      appVersion: appVersion(),
      masterKeyFingerprint: masterKeyFingerprint(),
    },
    tables,
  };
  const buffer = await gzipAsync(Buffer.from(JSON.stringify(envelope)));
  return { filename: backupFilename(), buffer, counts };
}

export async function createBackupArchiveStream(): Promise<{
  filename: string;
  stream: Readable;
  counts: Record<string, number>;
}> {
  const counts = await exportCounts();
  const stream = Readable.from(streamBackupJson(), { encoding: "utf8" }).pipe(
    createGzip(),
  );
  return { filename: backupFilename(), stream, counts };
}

export async function parseBackupArchive(
  filename: string,
  buffer: Buffer,
): Promise<z.infer<typeof BackupEnvelopeSchema>> {
  if (buffer.length > MAX_BACKUP_COMPRESSED_BYTES) {
    throw new Error("Backup exceeds the compressed size limit");
  }
  const payload = isGzip(buffer, filename)
    ? await gunzipAsync(buffer, { maxOutputLength: MAX_BACKUP_UNCOMPRESSED_BYTES })
    : buffer;
  if (payload.length > MAX_BACKUP_UNCOMPRESSED_BYTES) {
    throw new Error("Backup expands beyond the allowed size");
  }
  const parsed = JSON.parse(payload.toString("utf8").replace(/^\uFEFF/, ""));
  return BackupEnvelopeSchema.parse(parsed);
}

export async function restoreBackupArchive(
  filename: string,
  buffer: Buffer,
): Promise<BackupImportResult> {
  const backup = await parseBackupArchive(filename, buffer);
  const warnings: string[] = [];
  let tables: BackupTables = { ...backup.tables };
  const requiredTables = ["conversations", "conversationRevisions", "messages", "messageSegments"];
  const missingRequiredTables = requiredTables.filter(
    (key) => !Object.prototype.hasOwnProperty.call(tables, key),
  );
  if (missingRequiredTables.length) {
    throw new Error(`Backup is incomplete; missing tables: ${missingRequiredTables.join(", ")}`);
  }
  const backupMasterKey = backup.metadata.masterKeyFingerprint;
  if (backupMasterKey && backupMasterKey !== masterKeyFingerprint()) {
    const originalSettings = tables.settings ?? [];
    const retainedSettings = originalSettings.filter(
      (row) => row.encrypted !== true,
    );
    const skipped = originalSettings.length - retainedSettings.length;
    tables.settings = retainedSettings;
    if (skipped) {
      warnings.push(
        `备份文件使用了不同的 APP_MASTER_KEY，已跳过 ${skipped} 条加密设置；请在导入后重新填写 API Key/SMTP 密码。`,
      );
    }
  }
  tables = sanitizeRestoredBackupTables(tables);

  const counts: Record<string, number> = {};
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(193481962)`);
    for (const spec of deleteSpecs) {
      await tx.delete(spec.table);
    }
    for (const spec of tableSpecs) {
      const rows = (tables[spec.key] ?? []).map((row) =>
        reviveDates(row, spec.dateFields),
      );
      counts[spec.key] = rows.length;
      for (const batch of chunks(rows, INSERT_BATCH_SIZE)) {
        if (batch.length) await tx.insert(spec.table).values(batch as never);
      }
    }
  });

  return {
    ok: true,
    importedAt: new Date().toISOString(),
    counts,
    warnings,
  };
}
