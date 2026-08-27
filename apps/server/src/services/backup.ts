import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { createGzip, gunzip, gzip } from "node:zlib";
import { eq, sql } from "drizzle-orm";
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
  conversationTags,
  conversations,
  devices,
  importJobs,
  messageSegments,
  messages,
  operationLogs,
  projects,
  redactionRules,
  reports,
  restoreJobs,
  savedSearches,
  settings,
  tags,
} from "../schema.js";
import { APP_VERSION } from "../version.js";
import {
  compileCustomRedactionRules,
  redactSensitiveTextForStorage,
  redactSensitiveUrlForStorage,
} from "./redaction.js";
import { rebuildConversationSearchChunks } from "./search-chunks.js";
import { normalizeProjectName } from "./projects.js";

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
type BackupSqlClient = Pick<typeof sqlClient, "unsafe">;

interface TableSpec {
  key: string;
  table: PgTable;
  dateFields: string[];
}

const tableSpecs = [
  { key: "devices", table: devices, dateFields: ["lastSeenAt", "lastScanAt", "lastSuccessfulSyncAt", "lastErrorAt", "revokedAt", "createdAt"] },
  { key: "conversations", table: conversations, dateFields: ["updatedAt", "deletedAt", "createdAt"] },
  { key: "conversationRevisions", table: conversationRevisions, dateFields: ["capturedAt", "createdAt"] },
  { key: "messages", table: messages, dateFields: ["sourceCreatedAt", "createdAt"] },
  { key: "messageSegments", table: messageSegments, dateFields: ["createdAt"] },
  { key: "captureRuns", table: captureRuns, dateFields: ["capturedAt", "createdAt"] },
  { key: "projects", table: projects, dateFields: ["updatedAt", "createdAt"] },
  { key: "conversationProjects", table: conversationProjects, dateFields: ["updatedAt"] },
  { key: "tags", table: tags, dateFields: ["updatedAt", "createdAt"] },
  { key: "conversationTags", table: conversationTags, dateFields: ["updatedAt", "createdAt"] },
  { key: "analysisRuns", table: analysisRuns, dateFields: ["windowStart", "windowEnd", "completedAt", "updatedAt", "createdAt"] },
  { key: "backgroundTasks", table: backgroundTasks, dateFields: ["completedAt", "updatedAt", "createdAt"] },
  { key: "reports", table: reports, dateFields: ["periodStart", "periodEnd", "emailSentAt", "createdAt"] },
  { key: "savedSearches", table: savedSearches, dateFields: ["updatedAt", "createdAt"] },
  { key: "settings", table: settings, dateFields: ["updatedAt"] },
  { key: "redactionRules", table: redactionRules, dateFields: ["createdAt"] },
  { key: "importJobs", table: importJobs, dateFields: ["lastRetryAt", "completedAt", "updatedAt", "createdAt"] },
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
  const legacyIgnoredTables = new Set(["knowledgeItems", "knowledge_items"]);
  for (const key of Object.keys(value.tables)) {
    if (!allowedTables.has(key) && !legacyIgnoredTables.has(key)) {
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

export type BackupPhase =
  | "validating"
  | "validated"
  | "restoring"
  | "rebuilding_search"
  | "verifying";

export type BackupVerificationResult = {
  ok: boolean;
  format: string;
  schemaVersion: number;
  exportedAt: string;
  sourceAppVersion: string | null;
  masterKeyMatches: boolean | null;
  counts: Record<string, number>;
  errors: string[];
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

async function exportTables(client: BackupSqlClient): Promise<BackupTables> {
  const entries: Array<readonly [string, BackupRow[]]> = [];
  for (const spec of tableSpecs) {
    const rows = await client.unsafe(selectRowsSql(spec.table));
    entries.push([spec.key, [...rows] as BackupRow[]] as const);
  }
  return Object.fromEntries(entries) as BackupTables;
}

async function exportCounts(client: BackupSqlClient): Promise<Record<string, number>> {
  const entries: Array<readonly [string, number]> = [];
  for (const spec of tableSpecs) {
    const rows = await client.unsafe(
      `select count(*)::int as count from ${quotedTableName(spec.table)}`,
    );
    const first = rows[0] as { count?: unknown } | undefined;
    entries.push([spec.key, Number(first?.count ?? 0)] as const);
  }
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

async function* streamBackupJson(
  client: Awaited<ReturnType<typeof sqlClient.reserve>>,
): AsyncGenerator<string> {
  let completed = false;
  try {
    yield `{"format":${JSON.stringify(BACKUP_FORMAT)}`;
    yield `,"schemaVersion":${BACKUP_SCHEMA_VERSION}`;
    yield `,"exportedAt":${JSON.stringify(new Date().toISOString())}`;
    yield `,"metadata":${JSON.stringify({
      appVersion: appVersion(),
      masterKeyFingerprint: masterKeyFingerprint(),
      snapshotIsolation: "repeatable read",
    })}`;
    yield ',"tables":{';

    for (const [tableIndex, spec] of tableSpecs.entries()) {
      if (tableIndex > 0) yield ",";
      yield `${JSON.stringify(spec.key)}:[`;
      let rowIndex = 0;
      const cursor = client
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
    completed = true;
  } finally {
    await client.unsafe(completed ? "commit" : "rollback").catch(() => undefined);
    client.release();
  }
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
    conversationRevisions: ["searchText", "completenessReason", "capturedTitle"],
    messageSegments: ["content"],
    captureRuns: ["error"],
    projects: ["name", "description"],
    conversationProjects: ["suggestedName"],
    tags: ["name", "normalizedName"],
    analysisRuns: ["error"],
    backgroundTasks: ["message", "error"],
    reports: ["title", "summary", "bodyMarkdown", "emailError"],
    savedSearches: ["name", "normalizedName"],
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
  sanitized.conversationRevisions = (sanitized.conversationRevisions ?? []).map((row) => ({
    ...row,
    ...(typeof row.capturedCanonicalUrl === "string"
      ? { capturedCanonicalUrl: redactSensitiveUrlForStorage(row.capturedCanonicalUrl, customRules).text }
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
  sanitized.savedSearches = (sanitized.savedSearches ?? []).map((row) => ({
    ...row,
    ...(row.query !== undefined
      ? { query: sanitizeBackupValue(row.query, customRules) }
      : {}),
  }));
  sanitized.importJobs = (sanitized.importJobs ?? []).map((row) => ({
    ...row,
    ...(row.stats !== undefined
      ? { stats: sanitizeBackupValue(row.stats, customRules) }
      : {}),
  }));

  const originalRevisionById = new Map(
    (tables.conversationRevisions ?? []).flatMap((row) =>
      typeof row.id === "string" ? [[row.id, row] as const] : [],
    ),
  );
  const messageRevisionById = new Map(
    (tables.messages ?? []).flatMap((row) =>
      typeof row.id === "string" && typeof row.revisionId === "string"
        ? [[row.id, row.revisionId] as const]
        : [],
    ),
  );
  const invalidatedRevisionIds = new Set<string>();
  for (const [index, row] of (sanitized.messageSegments ?? []).entries()) {
    const before = (tables.messageSegments ?? [])[index];
    if (before && (before.content !== row.content || before.href !== row.href)) {
      const revisionId = typeof row.messageId === "string"
        ? messageRevisionById.get(row.messageId)
        : undefined;
      if (revisionId) invalidatedRevisionIds.add(revisionId);
    }
  }
  sanitized.conversationRevisions = (sanitized.conversationRevisions ?? []).map((row) => {
    const before = typeof row.id === "string" ? originalRevisionById.get(row.id) : undefined;
    const changed = before && (
      before.completenessReason !== row.completenessReason ||
      before.capturedTitle !== row.capturedTitle ||
      before.capturedCanonicalUrl !== row.capturedCanonicalUrl
    );
    if ((typeof row.id === "string" && invalidatedRevisionIds.has(row.id)) || changed) {
      return { ...row, contentIntegrityHash: null };
    }
    return row;
  });
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
  const client = await sqlClient.reserve();
  let tables: BackupTables;
  try {
    await client.unsafe("begin isolation level repeatable read read only");
    tables = await exportTables(client);
    await client.unsafe("commit");
  } catch (error) {
    await client.unsafe("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
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
      snapshotIsolation: "repeatable read",
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
  const client = await sqlClient.reserve();
  try {
    await client.unsafe("begin isolation level repeatable read read only");
  } catch (error) {
    client.release();
    throw error;
  }
  let counts: Record<string, number>;
  try {
    counts = await exportCounts(client);
  } catch (error) {
    await client.unsafe("rollback").catch(() => undefined);
    client.release();
    throw error;
  }
  const stream = Readable.from(streamBackupJson(client), { encoding: "utf8" }).pipe(
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

function backupIdSet(tables: BackupTables, key: string): Set<string> {
  return new Set((tables[key] ?? []).flatMap((row) => typeof row.id === "string" ? [row.id] : []));
}

export async function verifyBackupArchive(
  filename: string,
  buffer: Buffer,
): Promise<BackupVerificationResult> {
  const backup = await parseBackupArchive(filename, buffer);
  const prepared = prepareRestoredBackupTables(backup.tables);
  const tables = prepared.tables;
  const errors: string[] = [];
  const warnings = [...prepared.warnings];
  const missingTables = tableSpecs
    .map((spec) => spec.key)
    .filter((key) => !Object.prototype.hasOwnProperty.call(tables, key));
  if (missingTables.length) errors.push(`缺少业务表：${missingTables.join(", ")}`);

  const conversationIds = backupIdSet(tables, "conversations");
  const revisionIds = backupIdSet(tables, "conversationRevisions");
  const messageIds = backupIdSet(tables, "messages");
  const deviceIds = backupIdSet(tables, "devices");
  const projectIds = backupIdSet(tables, "projects");
  const tagIds = backupIdSet(tables, "tags");
  const revisionConversation = new Map(
    (tables.conversationRevisions ?? []).flatMap((row) =>
      typeof row.id === "string" && typeof row.conversationId === "string"
        ? [[row.id, row.conversationId] as const]
        : [],
    ),
  );
  const checkReference = (
    table: string,
    field: string,
    targets: Set<string>,
    nullable = false,
  ) => {
    for (const [index, row] of (tables[table] ?? []).entries()) {
      const value = row[field];
      if (nullable && (value === null || value === undefined)) continue;
      if (typeof value !== "string" || !targets.has(value)) {
        errors.push(`${table}[${index}].${field} 引用不存在`);
        if (errors.length >= 100) return;
      }
    }
  };
  checkReference("conversationRevisions", "conversationId", conversationIds);
  checkReference("messages", "revisionId", revisionIds);
  checkReference("messageSegments", "messageId", messageIds);
  checkReference("captureRuns", "deviceId", deviceIds, true);
  checkReference("conversationProjects", "conversationId", conversationIds);
  checkReference("conversationProjects", "projectId", projectIds, true);
  checkReference("conversationTags", "conversationId", conversationIds);
  checkReference("conversationTags", "tagId", tagIds);
  checkReference("reports", "projectId", projectIds, true);

  for (const [index, row] of (tables.conversationRevisions ?? []).entries()) {
    if (row.storageKind !== "delta") continue;
    const baseId = row.baseRevisionId;
    if (typeof baseId !== "string" || !revisionIds.has(baseId)) {
      errors.push(`conversationRevisions[${index}] 的增量基线不存在`);
      continue;
    }
    if (revisionConversation.get(baseId) !== row.conversationId) {
      errors.push(`conversationRevisions[${index}] 的增量基线跨会话`);
    }
  }
  const counts = Object.fromEntries(
    tableSpecs.map((spec) => [spec.key, tables[spec.key]?.length ?? 0]),
  );
  const sourceFingerprint = backup.metadata.masterKeyFingerprint;
  const masterKeyMatches = sourceFingerprint
    ? sourceFingerprint === masterKeyFingerprint()
    : null;
  if (masterKeyMatches === false) {
    warnings.push("备份使用不同 APP_MASTER_KEY；加密设置将在恢复时跳过。");
  }
  return {
    ok: errors.length === 0,
    format: backup.format,
    schemaVersion: backup.schemaVersion,
    exportedAt: backup.exportedAt,
    sourceAppVersion: backup.metadata.appVersion ?? null,
    masterKeyMatches,
    counts,
    errors: errors.slice(0, 100),
    warnings,
  };
}

export function prepareRestoredBackupTables(input: BackupTables): {
  tables: BackupTables;
  warnings: string[];
} {
  const tables: BackupTables = { ...input };
  const warnings: string[] = [];
  const legacyDerivedRowCount =
    (tables.knowledgeItems?.length ?? 0) +
    (tables.knowledge_items?.length ?? 0);
  if (legacyDerivedRowCount > 0) {
    warnings.push(
      `旧版备份包含 ${legacyDerivedRowCount} 条项目知识数据，V2.1 已取消项目知识模块，该部分数据未导入。`,
    );
  }
  delete tables.knowledgeItems;
  delete tables.knowledge_items;
  const usedProjectNames = new Set<string>();
  tables.projects = (tables.projects ?? []).map((row, index) => {
    const original = normalizeProjectName(typeof row.name === "string" ? row.name : "");
    let name = original.name || `未命名项目-${String(row.id ?? index).slice(0, 8)}`;
    let normalized = normalizeProjectName(name);
    let suffix = 2;
    while (usedProjectNames.has(normalized.normalizedName)) {
      normalized = normalizeProjectName(`${name} (${suffix})`);
      suffix += 1;
    }
    usedProjectNames.add(normalized.normalizedName);
    return { ...row, name: normalized.name, normalizedName: normalized.normalizedName };
  });
  const obsoleteBackgroundTaskCount = (tables.backgroundTasks ?? []).filter(
    (row) => row.kind === "knowledge_rebuild",
  ).length;
  if (obsoleteBackgroundTaskCount > 0) {
    tables.backgroundTasks = (tables.backgroundTasks ?? []).filter(
      (row) => row.kind !== "knowledge_rebuild",
    );
    warnings.push(
      `已忽略 ${obsoleteBackgroundTaskCount} 个旧版项目知识后台任务。`,
    );
  }
  tables.conversationRevisions = (tables.conversationRevisions ?? []).map((row) => ({
    ...row,
    metadataCaptured:
      typeof row.metadataCaptured === "boolean" ? row.metadataCaptured : false,
    revisionIdentityHash:
      typeof row.revisionIdentityHash === "string" ? row.revisionIdentityHash : null,
    contentIntegrityHash:
      typeof row.contentIntegrityHash === "string" ? row.contentIntegrityHash : null,
  }));
  return { tables, warnings };
}

export async function restoreBackupArchive(
  filename: string,
  buffer: Buffer,
  options: {
    onPhase?: (phase: BackupPhase, progress: number) => Promise<void>;
    restoreJobId?: string;
  } = {},
): Promise<BackupImportResult> {
  await options.onPhase?.("validating", 10);
  const backup = await parseBackupArchive(filename, buffer);
  const prepared = prepareRestoredBackupTables(backup.tables);
  let tables = prepared.tables;
  const warnings = prepared.warnings;
  const requiredTables = ["conversations", "conversationRevisions", "messages", "messageSegments"];
  const missingRequiredTables = requiredTables.filter(
    (key) => !Object.prototype.hasOwnProperty.call(tables, key),
  );
  if (missingRequiredTables.length) {
    throw new Error(`Backup is incomplete; missing tables: ${missingRequiredTables.join(", ")}`);
  }
  await options.onPhase?.("validated", 25);
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
  await options.onPhase?.("restoring", 35);
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
    if (options.restoreJobId) {
      await tx.update(restoreJobs).set({
        status: "rebuilding_search",
        progress: 75,
        phaseMessage: "事实数据已提交，正在重建全文检索分块",
        counts,
        warnings,
        factsCommittedAt: new Date(),
        completedAt: null,
        updatedAt: new Date(),
      }).where(eq(restoreJobs.id, options.restoreJobId));
    }
  });
  await options.onPhase?.("rebuilding_search", 75);
  const searchChunkCount = await rebuildConversationSearchChunks();
  warnings.push(`已从恢复后的消息重建 ${searchChunkCount} 个全文检索分块。`);

  await options.onPhase?.("verifying", 92);
  return {
    ok: true,
    importedAt: new Date().toISOString(),
    counts,
    warnings,
  };
}
