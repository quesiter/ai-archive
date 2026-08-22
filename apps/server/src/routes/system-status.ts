import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { sqlClient } from "../db.js";
import { requireWebUser } from "../http.js";
import { measureImportStorage, type DirectoryUsage } from "../services/project-storage.js";
import { projectStorageAlert, systemAlerts } from "../services/system-status.js";
import { APP_VERSION } from "../version.js";

const ResourceSchema = z.object({
  totalBytes: z.number().nonnegative(),
  usedBytes: z.number().nonnegative(),
  availableBytes: z.number().nonnegative(),
  percent: z.number().min(0).max(100),
});

const HostPayloadSchema = z.object({
  ok: z.literal(true),
  host: z.object({
    collectedAt: z.string().datetime(),
    cpuPercent: z.number().min(0).max(100),
    memory: ResourceSchema,
    swap: ResourceSchema,
  }),
  history: z.array(z.object({
    collectedAt: z.string().datetime(),
    cpuPercent: z.number().min(0).max(100),
    memoryPercent: z.number().min(0).max(100),
  })).max(120),
});

let importStorageCache: { measuredAt: number; usage: DirectoryUsage } | null = null;
let importStoragePending: Promise<DirectoryUsage> | null = null;

async function importStorageStatus(): Promise<DirectoryUsage> {
  if (importStorageCache && Date.now() - importStorageCache.measuredAt < 60_000) {
    return importStorageCache.usage;
  }
  if (importStoragePending) return importStoragePending;
  importStoragePending = measureImportStorage([
    config.IMPORT_INBOX,
    config.IMPORT_PROCESSED,
    config.IMPORT_FAILED,
  ]).then((usage) => {
    importStorageCache = { measuredAt: Date.now(), usage };
    return usage;
  }).finally(() => {
    importStoragePending = null;
  });
  return importStoragePending;
}

async function hostStatus() {
  if (!config.HOST_MONITOR_URL) {
    return { available: false as const, error: "项目容器监测未配置" };
  }
  try {
    const response = await fetch(`${config.HOST_MONITOR_URL.replace(/\/$/, "")}/metrics`, {
      signal: AbortSignal.timeout(3_000),
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`monitor returned HTTP ${response.status}`);
    const payload = HostPayloadSchema.parse(await response.json());
    return {
      available: true as const,
      ...payload.host,
      history: payload.history,
      alerts: systemAlerts(payload.host),
    };
  } catch {
    return { available: false as const, error: "项目容器监测暂不可用" };
  }
}

async function databaseStatus() {
  const [database] = await sqlClient<{
    size_bytes: string;
    connections: number;
    active_connections: number;
    max_connections: number;
    uptime_seconds: string;
    longest_query_seconds: number;
  }[]>`
    select
      pg_database_size(current_database())::bigint as size_bytes,
      (select count(*)::int from pg_stat_activity where datname = current_database()) as connections,
      (select count(*)::int from pg_stat_activity where datname = current_database() and state = 'active') as active_connections,
      current_setting('max_connections')::int as max_connections,
      extract(epoch from now() - pg_postmaster_start_time())::bigint as uptime_seconds,
      coalesce((
        select max(extract(epoch from now() - query_start))::double precision
        from pg_stat_activity
        where datname = current_database()
          and state = 'active'
          and pid <> pg_backend_pid()
      ), 0) as longest_query_seconds
  `;
  const [backup] = await sqlClient<{
    last_backup_at: Date | null;
    last_backup_failure_at: Date | null;
  }[]>`
    select
      max(created_at) filter (where status = 'completed') as last_backup_at,
      max(created_at) filter (where status = 'failed') as last_backup_failure_at
    from operation_logs
    where entity_type = 'backup'
  `;
  return {
    online: true,
    sizeBytes: Number(database?.size_bytes ?? 0),
    connections: Number(database?.connections ?? 0),
    activeConnections: Number(database?.active_connections ?? 0),
    maxConnections: Number(database?.max_connections ?? 0),
    uptimeSeconds: Number(database?.uptime_seconds ?? 0),
    longestQuerySeconds: Number(database?.longest_query_seconds ?? 0),
    lastBackupAt: backup?.last_backup_at ?? null,
    lastBackupFailureAt: backup?.last_backup_failure_at ?? null,
  };
}

export async function systemStatusRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/system/status", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const [host, database, imports] = await Promise.all([
      hostStatus(),
      databaseStatus(),
      importStorageStatus(),
    ]);
    const storageUsedBytes = database.sizeBytes + imports.bytes;
    const storageBudgetBytes = config.ARCHIVE_STORAGE_BUDGET_GB
      ? Math.round(config.ARCHIVE_STORAGE_BUDGET_GB * 1024 ** 3)
      : null;
    const storagePercent = storageBudgetBytes
      ? Math.min(100, Math.round((storageUsedBytes / storageBudgetBytes) * 1_000) / 10)
      : null;
    return {
      collectedAt: new Date().toISOString(),
      services: {
        app: { online: true, version: APP_VERSION, uptimeSeconds: Math.round(process.uptime()) },
        hostMonitor: { online: host.available },
        postgres: { online: true },
      },
      host,
      projectStorage: {
        usedBytes: storageUsedBytes,
        databaseBytes: database.sizeBytes,
        importBytes: imports.bytes,
        importFiles: imports.files,
        budgetBytes: storageBudgetBytes,
        availableBytes: storageBudgetBytes === null
          ? null
          : Math.max(0, storageBudgetBytes - storageUsedBytes),
        percent: storagePercent,
        incomplete: imports.incomplete,
        alert: projectStorageAlert(storagePercent),
      },
      database,
    };
  });
}
