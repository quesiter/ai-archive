import type { FastifyInstance } from "fastify";
import { sqlClient } from "../db.js";
import { requireWebUser } from "../http.js";
import {
  createBackgroundTask,
  failBackgroundTask,
  getLatestBackgroundTask,
} from "../services/background-tasks.js";
import { enqueueArchiveIntegrity } from "../services/queue.js";

function numeric(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

export async function reliabilityRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/reliability/integrity", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    return { task: await getLatestBackgroundTask("archive_integrity") };
  });

  app.post("/api/v1/reliability/integrity/run", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const active = await getLatestBackgroundTask("archive_integrity", ["queued", "running"]);
    if (active) return reply.code(202).send({ task: active, reused: true });
    const task = await createBackgroundTask("archive_integrity", "归档完整性检查等待执行");
    const jobId = await enqueueArchiveIntegrity(task.id);
    if (!jobId) {
      await failBackgroundTask(task.id, "归档完整性检查未成功进入队列");
      return reply.code(503).send({ error: "Archive integrity check was not enqueued", task });
    }
    return reply.code(202).send({ task, jobId });
  });

  app.get("/api/v1/reliability/adapters", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const rows = await sqlClient<{
      provider: string;
      adapter_version: string;
      last_capture_at: Date;
      last_complete_at: Date | null;
      total_24h: number;
      complete_24h: number;
      partial_24h: number;
      failed_24h: number;
      total_7d: number;
      complete_7d: number;
      partial_7d: number;
      failed_7d: number;
      average_messages_24h: number | null;
      average_messages_7d: number | null;
    }[]>`
      select
        provider,
        coalesce(adapter_version, 'unknown') as adapter_version,
        max(created_at) as last_capture_at,
        max(created_at) filter (where status = 'complete') as last_complete_at,
        count(*) filter (where created_at >= now() - interval '24 hours')::int as total_24h,
        count(*) filter (where created_at >= now() - interval '24 hours' and status = 'complete')::int as complete_24h,
        count(*) filter (where created_at >= now() - interval '24 hours' and status = 'partial')::int as partial_24h,
        count(*) filter (where created_at >= now() - interval '24 hours' and status = 'failed')::int as failed_24h,
        count(*) filter (where created_at >= now() - interval '7 days')::int as total_7d,
        count(*) filter (where created_at >= now() - interval '7 days' and status = 'complete')::int as complete_7d,
        count(*) filter (where created_at >= now() - interval '7 days' and status = 'partial')::int as partial_7d,
        count(*) filter (where created_at >= now() - interval '7 days' and status = 'failed')::int as failed_7d,
        avg(message_count) filter (where created_at >= now() - interval '24 hours') as average_messages_24h,
        avg(message_count) filter (where created_at >= now() - interval '7 days') as average_messages_7d
      from capture_runs
      where created_at >= now() - interval '30 days'
      group by provider, coalesce(adapter_version, 'unknown')
      order by max(created_at) desc
    `;
    const recent = await sqlClient<{
      provider: string;
      adapter_version: string;
      status: string;
    }[]>`
      select provider, coalesce(adapter_version, 'unknown') as adapter_version, status
      from capture_runs
      where created_at >= now() - interval '7 days'
      order by provider, coalesce(adapter_version, 'unknown'), created_at desc
    `;
    const consecutive = new Map<string, number>();
    const stopped = new Set<string>();
    for (const item of recent) {
      const key = `${item.provider}\u0000${item.adapter_version}`;
      if (stopped.has(key)) continue;
      if (item.status === "failed") consecutive.set(key, (consecutive.get(key) ?? 0) + 1);
      else stopped.add(key);
    }
    return rows.map((row) => {
      const key = `${row.provider}\u0000${row.adapter_version}`;
      const total24h = numeric(row.total_24h);
      const partialRate24h = total24h
        ? numeric(row.partial_24h) / total24h
        : 0;
      const failedRate24h = total24h ? numeric(row.failed_24h) / total24h : 0;
      const consecutiveFailures = consecutive.get(key) ?? 0;
      const age = Date.now() - new Date(row.last_capture_at).getTime();
      const status = consecutiveFailures >= 3 || (total24h >= 3 && partialRate24h > 0.3)
        ? "degraded"
        : age > 24 * 60 * 60_000
          ? "stale"
          : "healthy";
      return {
        provider: row.provider,
        adapterVersion: row.adapter_version,
        lastCaptureAt: row.last_capture_at,
        lastCompleteAt: row.last_complete_at,
        status,
        consecutiveFailures,
        rates24h: {
          success: total24h ? numeric(row.complete_24h) / total24h : 0,
          partial: partialRate24h,
          failed: failedRate24h,
        },
        counts24h: {
          total: total24h,
          complete: numeric(row.complete_24h),
          partial: numeric(row.partial_24h),
          failed: numeric(row.failed_24h),
        },
        rates7d: {
          success: numeric(row.total_7d) ? numeric(row.complete_7d) / numeric(row.total_7d) : 0,
          partial: numeric(row.total_7d) ? numeric(row.partial_7d) / numeric(row.total_7d) : 0,
          failed: numeric(row.total_7d) ? numeric(row.failed_7d) / numeric(row.total_7d) : 0,
        },
        averageMessageCount24h: row.average_messages_24h === null ? null : numeric(row.average_messages_24h),
        averageMessageCount7d: row.average_messages_7d === null ? null : numeric(row.average_messages_7d),
      };
    });
  });

  app.get("/api/v1/reliability/summary", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const [row] = await sqlClient<{
      incomplete_conversations: number;
      recent_capture_failures: number;
      overdue_capture_failures: number;
      offline_devices: number;
      failed_imports: number;
    }[]>`
      with latest_revisions as (
        select distinct on (conversation_revisions.conversation_id)
          conversation_revisions.conversation_id,
          conversation_revisions.completeness
        from conversation_revisions
        inner join conversations
          on conversations.id = conversation_revisions.conversation_id
        where conversations.deleted_at is null
        order by
          conversation_revisions.conversation_id,
          (conversation_revisions.completeness = 'complete') desc,
          conversation_revisions.captured_at desc,
          conversation_revisions.created_at desc
      )
      select
        (select count(*)::int from latest_revisions where completeness = 'partial')
          as incomplete_conversations,
        (select count(*)::int from capture_runs
          where status = 'failed' and created_at >= now() - interval '24 hours')
          as recent_capture_failures,
        (select count(*)::int from capture_runs failed
          where failed.status = 'failed'
            and failed.created_at < now() - interval '24 hours'
            and not exists (
              select 1 from capture_runs recovered
              where recovered.provider = failed.provider
                and recovered.external_session_id = failed.external_session_id
                and recovered.status = 'complete'
                and recovered.created_at > failed.created_at
            )) as overdue_capture_failures,
        (select count(*)::int from devices
          where revoked_at is null
            and coalesce(last_seen_at, created_at) < now() - interval '24 hours')
          as offline_devices,
        (select count(*)::int from import_jobs where status in ('failed', 'partial'))
          as failed_imports
    `;
    const items = [
      {
        key: "incompleteConversations",
        label: "不完整会话",
        count: numeric(row?.incomplete_conversations),
        href: "/conversations?completeness=partial",
        severity: "warning",
      },
      {
        key: "recentCaptureFailures",
        label: "最近 24 小时采集失败",
        count: numeric(row?.recent_capture_failures),
        href: "/logs?scope=capture&status=failed",
        severity: "error",
      },
      {
        key: "overdueCaptureFailures",
        label: "超过 24 小时未恢复",
        count: numeric(row?.overdue_capture_failures),
        href: "/logs?scope=capture&status=failed",
        severity: "error",
      },
      {
        key: "offlineDevices",
        label: "设备离线超过 24 小时",
        count: numeric(row?.offline_devices),
        href: "/devices",
        severity: "warning",
      },
      {
        key: "failedImports",
        label: "导入失败或部分完成",
        count: numeric(row?.failed_imports),
        href: "/imports",
        severity: "error",
      },
    ];
    return {
      generatedAt: new Date().toISOString(),
      needsAttention: items.reduce((total, item) => total + item.count, 0),
      items,
    };
  });
}
