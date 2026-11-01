import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { RecaptureItem, RecaptureJob, RecaptureNext, RecaptureReport } from "@ai-archive/contracts";
import { sqlClient } from "../db.js";

const fail = (message: string, statusCode = 409): never => { throw Object.assign(new Error(message), { statusCode }); };
const LEASE_SECONDS = 120;
const CANCELLED_ITEM_MESSAGE = "任务已终止";
const SAFETY_RESET_EVENT = "recapture_safety_reset";
type JobRow = { id: string; device_id: string; status: RecaptureJob["status"]; message: string | null };
type ItemRow = { id: string; conversation_id: string | null; external_session_id: string; title: string;
  status: RecaptureItem["status"]; attempts: number; lease_token: string | null; lease_expires_at: Date | null;
  started_at: Date | null; capture_id: string | null };

type SafetyRow = { completed_count: number; pending_count: number; last_completed_at: Date | string | null;
  now_at: Date | string; recent_statuses: RecaptureItem["status"][] };

/** Persisted completion times make pacing apply to old clients and restarts. */
export function recaptureCooldownMs(completed: number, lastCompletedAt: Date | string | null, now: Date | string): number {
  if (!completed || !lastCompletedAt) return 0;
  const interval = completed % 10 === 0 ? 10 * 60_000 : 60_000;
  return Math.max(0, new Date(lastCompletedAt).getTime() + interval - new Date(now).getTime());
}

export function shouldPauseRecapture(status: RecaptureItem["status"], recent: RecaptureItem["status"][]): boolean {
  return (status === "skipped" || status === "failed") && recent.length >= 2
    && recent.slice(0, 2).every(value => value === "skipped" || value === "failed");
}

async function recaptureSafety(tx: TransactionSql, jobId: string): Promise<SafetyRow> {
  const [state] = await tx<SafetyRow[]>`with attempted_results as materialized (
    select status,completed_at,id from recapture_items where job_id=${jobId} and attempts>0
      and status in ('complete','partial','failed','skipped') and completed_at is not null
      and (status not in ('complete','partial') or capture_id is not null)
      and not (status='skipped' and coalesce(message,'')=${CANCELLED_ITEM_MESSAGE})
  ), reset as (
    select max(created_at) as at from operation_logs where scope='capture'
      and entity_type='recapture_job' and entity_id=${jobId} and metadata->>'event'=${SAFETY_RESET_EVENT}
  ) select (select count(*)::int from attempted_results) as completed_count,
    (select count(*)::int from recapture_items where job_id=${jobId} and status='pending') as pending_count,
    (select max(completed_at) from attempted_results) as last_completed_at,now() as now_at,
    array(select status from attempted_results where completed_at>coalesce((select at from reset),'-infinity'::timestamptz)
      order by completed_at desc,id desc limit 2) as recent_statuses`;
  return state!;
}

async function resetRecaptureSafety(tx: TransactionSql, jobId: string, action: string) {
  // Only a validated web action reaches this path. Polls and report retries can
  // never reset the failure streak; the reset shares the job-action transaction.
  await tx`insert into operation_logs(scope,level,message,status,entity_type,entity_id,metadata)
    values('capture','info','已由人工操作重置补采连续失败计数','running','recapture_job',${jobId},
      ${JSON.stringify({ event: SAFETY_RESET_EVENT, action })}::jsonb)`;
}

async function locked<T>(deviceId: string, operation: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return await sqlClient.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock_shared(847231955)`;
    await tx`select pg_advisory_xact_lock(hashtextextended(${`recapture:${deviceId}`},0))`;
    return operation(tx);
  }) as T;
}

export function recaptureUrl(sessionId: string): string {
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(sessionId)) fail("会话编号无法用于安全补采", 400);
  return `https://chatgpt.com/c/${sessionId}`;
}

async function finishIfDone(tx: TransactionSql, jobId: string) {
  await tx`update recapture_jobs set status='completed',message='补采队列已完成',updated_at=now()
    where id=${jobId} and status in ('running','paused') and not exists
    (select 1 from recapture_items where job_id=${jobId} and status in ('pending','running'))`;
}

export async function listRecaptureJobs(): Promise<RecaptureJob[]> {
  const jobs = await sqlClient`select j.id,j.device_id as "deviceId",d.name as "deviceName",j.status,j.message,
    j.last_runner_seen_at as "lastRunnerSeenAt",j.created_at as "createdAt"
    from recapture_jobs j join devices d on d.id=j.device_id
    order by (j.status in ('running','paused')) desc,j.created_at desc limit 12`;
  if (!jobs.length) return [];
  const items = await sqlClient`select id,job_id as "jobId",conversation_id as "conversationId",
    external_session_id as "sessionId",title,ordinal,status,attempts,message,message_count as "messageCount"
    from recapture_items where job_id in ${sqlClient(jobs.map(j => j.id))} order by ordinal`;
  return jobs.map((job) => {
    const selected = items.filter(item => item.jobId === job.id) as unknown as RecaptureItem[];
    const counts = { pending: 0, running: 0, complete: 0, partial: 0, failed: 0, skipped: 0 };
    for (const item of selected) counts[item.status]++;
    return { ...job, createdAt: new Date(job.createdAt).toISOString(),
      lastRunnerSeenAt: job.lastRunnerSeenAt ? new Date(job.lastRunnerSeenAt).toISOString() : null, counts, items: selected } as RecaptureJob;
  });
}

export async function createRecaptureJob(deviceId: string, conversationIds?: string[]) {
  return locked(deviceId, async (tx) => {
    const [device] = await tx`select id from devices where id=${deviceId} and kind='chrome_extension' and revoked_at is null`;
    if (!device) fail("请选择尚未撤销的 Chrome 扩展设备", 400);
    const [active] = await tx`select id from recapture_jobs where device_id=${deviceId} and status in ('running','paused')`;
    if (active) fail("该设备已有补采队列，请先完成或取消现有队列");
    const selected = await tx`select c.id,c.external_session_id,c.title from conversations c
      join lateral (select completeness from conversation_revisions r where r.conversation_id=c.id
        order by r.is_accumulated desc,r.captured_at desc,r.created_at desc limit 1) r on true
      where c.provider='chatgpt' and c.deleted_at is null and r.completeness='partial'
        and c.external_session_id ~ '^[a-zA-Z0-9_-]{8,128}$'
        ${conversationIds ? tx`and c.id in ${tx(conversationIds)}` : tx``}
      order by c.updated_at desc,c.id limit 501`;
    if (!selected.length) fail("所选范围内没有可补采的 ChatGPT 不完整会话", 400);
    if (selected.length > 500) fail("一次最多补采 500 条，请先筛选并选择会话", 400);
    const [job] = await tx`insert into recapture_jobs(device_id,message) values(${deviceId},'等待指定 Chrome 扩展连接；请安装最新扩展并保持浏览器打开') returning id`;
    await tx`insert into recapture_items ${tx(selected.map((row, ordinal) => ({
      job_id: job!.id, conversation_id: row.id, external_session_id: row.external_session_id,
      title: row.title ?? "未命名对话", ordinal,
    })))}`;
    return { id: job!.id as string, count: selected.length, excluded: conversationIds ? conversationIds.length - selected.length : 0 };
  });
}

export async function changeRecaptureJob(jobId: string, action: "pause" | "resume" | "cancel" | "retry_failed" | "retry_partial" | "retry_skipped" | "skip_current") {
  const [found] = await sqlClient`select device_id from recapture_jobs where id=${jobId}`;
  if (!found) fail("补采队列不存在", 404);
  return locked(found!.device_id, async (tx) => {
    const [job] = await tx<JobRow[]>`select * from recapture_jobs where id=${jobId} for update`;
    if (!job) fail("补采队列不存在", 404);
    if (action === "cancel") {
      await tx`update recapture_items set status='skipped',message='任务已终止',completed_at=now(),lease_expires_at=null
        where job_id=${jobId} and status in ('pending','running')`;
      await tx`update recapture_jobs set status='cancelled',message='任务已终止，已归档内容保留',updated_at=now() where id=${jobId}`;
    } else if (action === "pause") {
      if (job!.status === "running") await tx`update recapture_jobs set status='paused',message='已暂停；当前一条处理完后停止',updated_at=now() where id=${jobId}`;
    } else {
      const [device] = await tx`select id from devices where id=${job!.device_id} and revoked_at is null`;
      if (!device) fail("该设备已撤销，请使用新的 Chrome 设备创建队列");
      const [other] = await tx`select id from recapture_jobs where device_id=${job!.device_id} and id<>${jobId} and status in ('running','paused')`;
      if (other) fail("该设备还有其他队列，请先完成或取消");
      if (action === "resume" && job!.status !== "paused") fail("只有暂停的队列可以继续");
      if (action === "skip_current") {
        if (job!.status !== "paused") fail("只有暂停的队列可以跳过当前条目");
        const [running] = await tx`select id from recapture_items where job_id=${jobId} and status='running' limit 1`;
        if (running) fail("当前条目仍在采集，请等待处理结束");
        const [changed] = await tx`update recapture_items set status='skipped',message='已手动跳过当前无法处理的会话',
          completed_at=now(),lease_token=null,lease_expires_at=null where id=(select id from recapture_items
          where job_id=${jobId} and status='pending' and attempts>0 order by ordinal limit 1) returning id`;
        if (!changed) fail("没有可跳过的暂停条目", 400);
      }
      if (action.startsWith("retry_")) {
        const status = action === "retry_failed" ? "failed" : action === "retry_skipped" ? "skipped" : "partial";
        const changed = await tx`update recapture_items set status='pending',attempts=0,lease_token=null,lease_expires_at=null,
          started_at=null,completed_at=null,capture_id=null,message=null where job_id=${jobId} and status=${status} returning id`;
        if (!changed.length) fail("没有符合重试条件的条目", 400);
      }
      await resetRecaptureSafety(tx, jobId, action);
      await tx`update recapture_jobs set status='running',message='等待指定 Chrome 扩展继续',updated_at=now() where id=${jobId}`;
      await finishIfDone(tx, jobId);
    }
    return { ok: true };
  });
}

export async function nextRecaptureTask(deviceId: string, leaseToken?: string): Promise<RecaptureNext> {
  return locked(deviceId, async (tx) => {
    const [job] = await tx<JobRow[]>`select * from recapture_jobs where device_id=${deviceId} and status in ('running','paused') for update`;
    if (!job) return { job: null, task: null };
    await tx`update recapture_jobs set last_runner_seen_at=now() where id=${job.id}`;
    const summary = { id: job.id, status: job.status, message: job.message };
    let [item] = await tx<ItemRow[]>`select * from recapture_items where job_id=${job.id} and status='running' order by ordinal limit 1`;
    if (item && (Date.now() - new Date(item.started_at!).getTime() > 10 * 60_000 || (new Date(item.lease_expires_at!).getTime() < Date.now() && item.lease_token !== leaseToken))) {
      // Never reclaim an operation while its lease is alive. A resumed browser
      // may renew its own token; every attempt has a hard ten-minute deadline.
      const exhausted = item.attempts >= 3;
      const safety = exhausted ? await recaptureSafety(tx, job.id) : null;
      const pause = exhausted && shouldPauseRecapture("failed", safety!.recent_statuses);
      await tx`update recapture_items set status=${exhausted && !pause ? "failed" : "pending"},lease_token=null,
        lease_expires_at=null,completed_at=${exhausted && !pause ? new Date().toISOString() : null},message='浏览器处理超时，等待重试' where id=${item.id}`;
      if (pause) {
        const message = "连续 3 条无法采集，队列已暂停。最后原因：浏览器处理超时；请检查原页面后人工继续";
        await tx`update recapture_jobs set status='paused',message=${message},updated_at=now() where id=${job.id}`;
        return { job: { ...summary, status: "paused", message }, task: null };
      }
      item = undefined;
    }
    if (item && item.lease_token !== leaseToken) return { job: summary, task: null, busy: true };
    if (!item && job.status === "running") {
      await tx`update recapture_items i set status='skipped',message='会话已删除或已经完整归档',completed_at=now()
        where i.job_id=${job.id} and i.status='pending' and (
          not exists(select 1 from conversations c where c.id=i.conversation_id and c.deleted_at is null)
          or (select r.completeness from conversation_revisions r where r.conversation_id=i.conversation_id
              order by r.is_accumulated desc,r.captured_at desc,r.created_at desc limit 1)='complete')`;
      const safety = await recaptureSafety(tx, job.id);
      const waitMs = recaptureCooldownMs(safety.completed_count, safety.last_completed_at, safety.now_at);
      if (safety.pending_count > 0 && waitMs > 0) {
        const message = `服务端保守补采间隔：${Math.ceil(waitMs / 1_000)} 秒后继续；已保存进度`;
        await tx`update recapture_jobs set message=${message},updated_at=now() where id=${job.id}`;
        return { job: { ...summary, message }, task: null };
      }
      [item] = await tx<ItemRow[]>`update recapture_items set status='running',attempts=attempts+1,
        lease_token=${randomUUID()},started_at=now(),completed_at=null,message='正在打开原会话'
        where id=(select id from recapture_items where job_id=${job.id} and status='pending' order by ordinal limit 1) returning *`;
    }
    if (!item) {
      await finishIfDone(tx, job.id);
      return { job: summary, task: null };
    }
    const [exists] = await tx`select id from conversations where id=${item.conversation_id} and deleted_at is null`;
    if (!exists) {
      await tx`update recapture_items set status='skipped',message='会话已删除',completed_at=now() where id=${item.id}`;
      await finishIfDone(tx, job.id);
      return { job: summary, task: null };
    }
    await tx`update recapture_items set lease_expires_at=now()+${LEASE_SECONDS}*interval '1 second' where id=${item.id}`;
    await tx`update recapture_jobs set message=${`正在补采：${item.title.slice(0,160)}`},updated_at=now() where id=${job.id}`;
    return { job: summary, task: { jobId: job.id, itemId: item.id, leaseToken: item.lease_token!,
      sessionId: item.external_session_id, url: recaptureUrl(item.external_session_id), title: item.title,
      startedAt: new Date(item.started_at!).toISOString() } };
  });
}

export async function reportRecaptureTask(deviceId: string, report: RecaptureReport) {
  return locked(deviceId, async (tx) => {
    const [job] = await tx<JobRow[]>`select * from recapture_jobs where id=${report.jobId} and device_id=${deviceId} for update`;
    const [item] = await tx<ItemRow[]>`select * from recapture_items where id=${report.itemId} and job_id=${report.jobId}`;
    if (!job || !item || item.lease_token !== report.leaseToken) fail("补采任务已失效，请重新获取队列");
    if (item!.status !== "running") return { ok: true, status: item!.status };
    if (job!.status === "cancelled") fail("补采队列已取消");
    let status: RecaptureItem["status"] = "failed";
    let message = report.message?.slice(0,500) ?? "本条补采失败";
    let messageCount: number | null = null;
    if (report.captureId) {
      const [run] = await tx`select receipt from capture_runs where device_id=${deviceId}
        and idempotency_key=${report.captureId} and provider='chatgpt' and external_session_id=${item!.external_session_id}
        and capture_mode='full' and created_at>=${new Date(item!.started_at!).toISOString()}`;
      if (!run?.receipt || run.receipt.conversationId !== item!.conversation_id) fail("采集尚未入库或与本条任务不匹配");
      status = run!.receipt.archiveCompleteness === "complete" ? "complete" : "partial";
      messageCount = run!.receipt.archiveMessageCount;
      message = status === "complete" ? "已完整归档" : "已保存；仍有缺失内容或差异待核对";
    } else if (report.outcome === "skipped") {
      status = "skipped";
    } else if (report.outcome === "attention") {
      status = "pending";
      await tx`update recapture_jobs set status='paused',message=${message},updated_at=now() where id=${job!.id}`;
    }
    // The cancellation marker is server-owned so a client-supplied message
    // cannot make a failed attempt disappear from the safety accounting.
    if (message === CANCELLED_ITEM_MESSAGE) message = `本条处理结果：${message}`;
    if (status === "failed" || status === "skipped") {
      const safety = await recaptureSafety(tx, job!.id);
      if (shouldPauseRecapture(status, safety.recent_statuses)) {
        status = "pending";
        message = `连续 3 条无法采集，队列已暂停。最后原因：${message}`.slice(0, 500);
        await tx`update recapture_jobs set status='paused',message=${message},updated_at=now() where id=${job!.id}`;
      }
    }
    await tx`update recapture_items set status=${status},message=${message},message_count=${messageCount},
      capture_id=${report.captureId ?? null},completed_at=${status === "pending" ? null : new Date().toISOString()},
      lease_expires_at=null where id=${item!.id}`;
    await finishIfDone(tx, job!.id);
    return { ok: true, status };
  });
}
