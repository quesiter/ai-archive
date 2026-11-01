import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { CaptureSnapshotV1, RecaptureTask } from "@ai-archive/contracts";
import { sqlClient as sql, closeDatabase } from "../apps/server/src/db.js";
import { createRecaptureJob, listRecaptureJobs, nextRecaptureTask, changeRecaptureJob, reportRecaptureTask } from "../apps/server/src/services/recapture.js";
import { ingestCapture, BatchCaptureExpiredError } from "../apps/server/src/services/capture.js";

async function main() {
const target = new URL(process.env.DATABASE_URL!);
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "Only a loopback disposable test database may be used");
assert.match(target.pathname, /^\/archive_recapture_test_[0-9]+$/, "Only a disposable test database may be used");
let checks = 0;
async function check(name: string, operation: () => Promise<void>) { await operation(); checks++; console.log(`PASS ${name}`); }
// Advance only synthetic completion timestamps; never wait a real minute or
// weaken the production service's pacing to make an integration test pass.
async function ageCompletedAttempts(jobId: string, seconds = 61) {
  await sql`update recapture_items set completed_at=now()-${seconds}*interval '1 second'
    where job_id=${jobId} and attempts>0 and completed_at is not null`;
}
const d1 = randomUUID(), d2 = randomUUID();
await sql`insert into devices(id,name,kind,token_hash) values(${d1},'Synthetic Chrome A','chrome_extension',${randomUUID()}),(${d2},'Synthetic Chrome B','chrome_extension',${randomUUID()})`;
function payload(sessionId: string, complete = false, provider: "chatgpt" | "deepseek" = "chatgpt"): CaptureSnapshotV1 {
  return { schemaVersion: 1, provider, sessionId, title: `Synthetic ${sessionId}`, canonicalUrl: `https://chatgpt.com/c/${sessionId}`,
    adapterVersion: "1.2.16", captureMode: "full", triggerReason: "manual_retry", branchFingerprint: `branch-${sessionId}`,
    capturedAt: new Date().toISOString(), completeness: { status: complete ? "complete" : "partial", topReached: complete, bottomReached: true, stable: true },
    messages: [{ ordinal: 0, externalMessageId: `${sessionId}-user`, role: "user", segments: [{ type: "text", content: "Synthetic question" }] },
      { ordinal: 1, externalMessageId: `${sessionId}-assistant`, role: "assistant", segments: [{ type: "text", content: "Synthetic response" }] }] };
}
const sessions = Array.from({ length: 4 }, () => randomUUID());
const receipts = [];
for (let i = 0; i < 4; i++) receipts.push(await ingestCapture(payload(sessions[i]!, i === 2, i === 3 ? "deepseek" : "chatgpt"), d1, `seed-${i}`));
let job!: { id: string; count: number; excluded: number };
await check("selection excludes complete archives and unsupported providers", async () => {
  job = await createRecaptureJob(d1, receipts.map(r => r.conversationId));
  assert.equal(job.count, 2); assert.equal(job.excluded, 2);
});
await check("one active queue per device", async () => { await assert.rejects(() => createRecaptureJob(d1), /已有补采队列/); });
let task!: RecaptureTask;
await check("concurrent runners receive only one lease", async () => {
  const results = await Promise.all([nextRecaptureTask(d1), nextRecaptureTask(d1)]);
  assert.equal(results.filter(r => r.task).length, 1); assert.equal(results.filter(r => r.busy).length, 1);
  task = results.find(r => r.task)!.task!;
});
await check("pause renews the current lease without claiming another item", async () => {
  await changeRecaptureJob(job.id, "pause");
  const next = await nextRecaptureTask(d1, task.leaseToken); assert.equal(next.task?.itemId, task.itemId); assert.equal(next.job?.status, "paused");
});
const report = () => ({ jobId: task.jobId, itemId: task.itemId, leaseToken: task.leaseToken });
await check("rejects another device and unrelated old receipts", async () => {
  await assert.rejects(() => reportRecaptureTask(d2, { ...report(), outcome: "failed" }));
  await assert.rejects(() => reportRecaptureTask(d1, { ...report(), captureId: "seed-0" }));
});
await check("verifies a newly ingested complete snapshot against its exact task", async () => {
  const key = `recapture:${task.itemId}:${task.leaseToken}:${"a".repeat(64)}`;
  const result = await ingestCapture(payload(task.sessionId, true), d1, key);
  assert.equal(result.archiveCompleteness, "complete");
  assert.equal((await reportRecaptureTask(d1, { ...report(), captureId: key })).status, "complete");
  assert.equal((await reportRecaptureTask(d1, { ...report(), captureId: key })).status, "complete");
  assert.equal((await nextRecaptureTask(d1)).task, null);
});
await check("resume advances sequentially and failed entries can be retried", async () => {
  await changeRecaptureJob(job.id, "resume"); await ageCompletedAttempts(job.id);
  task = (await nextRecaptureTask(d1)).task!; assert.ok(task);
  await reportRecaptureTask(d1, { ...report(), outcome: "failed", message: "Synthetic failure" });
  let jobs = await listRecaptureJobs(); assert.equal(jobs[0]!.status, "completed"); assert.equal(jobs[0]!.counts.failed, 1);
  await changeRecaptureJob(job.id, "retry_failed"); task = (await nextRecaptureTask(d1)).task!;
  assert.ok(task); jobs = await listRecaptureJobs(); assert.equal(jobs[0]!.counts.running, 1);
});
await check("attention pauses the queue and report retries are idempotent", async () => {
  const attention = { ...report(), outcome: "attention" as const, message: "Synthetic login required" };
  await reportRecaptureTask(d1, attention); await reportRecaptureTask(d1, attention);
  const next = await nextRecaptureTask(d1, task.leaseToken); assert.equal(next.job?.status, "paused"); assert.equal(next.task, null);
});
await check("expired leases are replaced and stale reports cannot finish the new attempt", async () => {
  await changeRecaptureJob(job.id, "resume"); task = (await nextRecaptureTask(d1)).task!;
  const stale = report();
  await sql`update recapture_items set lease_expires_at=now()-interval '1 second' where id=${task.itemId}`;
  task = (await nextRecaptureTask(d1)).task!; assert.notEqual(task.leaseToken, stale.leaseToken);
  await assert.rejects(() => reportRecaptureTask(d1, { ...stale, outcome: "failed" }));
});
await check("repeated lost browsers eventually fail instead of looping forever", async () => {
  await sql`update recapture_items set attempts=3,lease_expires_at=now()-interval '1 second' where id=${task.itemId}`;
  assert.equal((await nextRecaptureTask(d1)).task, null);
  const result = (await listRecaptureJobs())[0]!; assert.equal(result.status, "completed"); assert.equal(result.counts.failed, 1);
});
await check("deleted pending archives are skipped without resurrection", async () => {
  const p = payload(randomUUID()); const receipt = await ingestCapture(p, d1);
  const nextJob = await createRecaptureJob(d1, [receipt.conversationId]);
  await sql`delete from conversations where id=${receipt.conversationId}`;
  assert.equal((await nextRecaptureTask(d1)).task, null);
  const result = (await listRecaptureJobs()).find(j => j.id === nextJob.id)!;
  assert.equal(result.counts.skipped, 1);
});
await check("a running batch cannot restore an archive deleted during its scan", async () => {
  const p = payload(randomUUID()); const receipt = await ingestCapture(p, d1);
  await createRecaptureJob(d1, [receipt.conversationId]); task = (await nextRecaptureTask(d1)).task!;
  await sql`update conversations set deleted_at=now() where id=${receipt.conversationId}`;
  const key = `recapture:${task.itemId}:${task.leaseToken}:${"b".repeat(64)}`;
  await assert.rejects(() => ingestCapture({ ...p, capturedAt: new Date().toISOString() }, d1, key), BatchCaptureExpiredError);
  const [row] = await sql`select deleted_at from conversations where id=${receipt.conversationId}`; assert.ok(row!.deleted_at);
  await changeRecaptureJob(task.jobId, "cancel");
});
await check("cancellation rejects delayed uploads and retains historical archives", async () => {
  const p = payload(randomUUID()); const receipt = await ingestCapture(p, d1);
  const job = await createRecaptureJob(d1, [receipt.conversationId]); task = (await nextRecaptureTask(d1)).task!;
  await changeRecaptureJob(job.id, "cancel");
  const key = `recapture:${task.itemId}:${task.leaseToken}:${"c".repeat(64)}`;
  await assert.rejects(() => ingestCapture(p, d1, key), BatchCaptureExpiredError);
  const [row] = await sql`select id from conversations where id=${receipt.conversationId}`; assert.ok(row);
});
await check("still-partial receipts remain partial and have a dedicated retry", async () => {
  const p = payload(randomUUID()); const receipt = await ingestCapture(p, d1);
  const job = await createRecaptureJob(d1, [receipt.conversationId]); task = (await nextRecaptureTask(d1)).task!;
  const key = `recapture:${task.itemId}:${task.leaseToken}:${"d".repeat(64)}`;
  await ingestCapture({ ...p, capturedAt: new Date().toISOString() }, d1, key);
  assert.equal((await reportRecaptureTask(d1, { ...report(), captureId: key })).status, "partial");
  await changeRecaptureJob(job.id, "retry_partial"); assert.ok((await nextRecaptureTask(d1)).task);
  await changeRecaptureJob(job.id, "cancel");
});
await check("inaccessible items skip automatically and the same queue advances", async () => {
  const rows = [];
  for (let i=0; i<3; i++) rows.push(await ingestCapture(payload(randomUUID()), d1));
  const job = await createRecaptureJob(d1, rows.map(r => r.conversationId));
  task = (await nextRecaptureTask(d1)).task!;
  const skippedItem = task.itemId;
  const skip = { ...report(), outcome: "skipped" as const, message: "Synthetic source denied access" };
  assert.equal((await reportRecaptureTask(d1, skip)).status, "skipped");
  assert.equal((await reportRecaptureTask(d1, skip)).status, "skipped");
  await ageCompletedAttempts(job.id);
  task = (await nextRecaptureTask(d1)).task!; assert.notEqual(task.itemId, skippedItem);
  let result = (await listRecaptureJobs()).find(j => j.id === job.id)!;
  assert.equal(result.status, "running"); assert.equal(result.counts.skipped, 1);
  await assert.rejects(() => changeRecaptureJob(job.id, "skip_current"));
  await reportRecaptureTask(d1, { ...report(), outcome: "attention", message: "Synthetic old-client pause" });
  await changeRecaptureJob(job.id, "skip_current");
  await ageCompletedAttempts(job.id);
  task = (await nextRecaptureTask(d1)).task!;
  result = (await listRecaptureJobs()).find(j => j.id === job.id)!;
  assert.equal(result.counts.skipped, 2); assert.equal(result.status, "running");
  await reportRecaptureTask(d1, { ...report(), outcome: "skipped" });
  result = (await listRecaptureJobs()).find(j => j.id === job.id)!;
  assert.equal(result.status, "completed"); assert.equal(result.counts.skipped, 3);
  await changeRecaptureJob(job.id, "retry_skipped");
  result = (await listRecaptureJobs()).find(j => j.id === job.id)!;
  assert.equal(result.counts.pending, 3); assert.equal(result.counts.skipped, 0);
  await changeRecaptureJob(job.id, "cancel");
  for (const row of rows) assert.ok((await sql`select id from conversations where id=${row.conversationId}`)[0]);
});

async function syntheticJob(count: number) {
  const rows = [];
  for (let i = 0; i < count; i++) rows.push(await ingestCapture(payload(randomUUID()), d1));
  return await createRecaptureJob(d1, rows.map(row => row.conversationId));
}
async function safetyResets(jobId: string) {
  return await sql`select metadata from operation_logs where scope='capture' and entity_type='recapture_job'
    and entity_id=${jobId} and metadata->>'event'='recapture_safety_reset' order by created_at,id`;
}
await check("old clients cannot bypass the one-minute database cooldown with next/report polling", async () => {
  const job = await syntheticJob(2); task = (await nextRecaptureTask(d1)).task!;
  const failed = { ...report(), outcome: "failed" as const, message: "Synthetic source timeout" };
  assert.equal((await reportRecaptureTask(d1, failed)).status, "failed");
  assert.equal((await reportRecaptureTask(d1, failed)).status, "failed");
  for (let i = 0; i < 3; i++) {
    const next = await nextRecaptureTask(d1); assert.equal(next.task, null);
    assert.equal(next.job?.status, "running"); assert.match(next.job?.message ?? "", /服务端保守补采间隔/);
  }
  assert.equal((await safetyResets(job.id)).length, 0);
  await ageCompletedAttempts(job.id);
  task = (await nextRecaptureTask(d1)).task!; assert.ok(task);
  // Reintroduce a recent completed result after this lease has been claimed.
  await sql`update recapture_items set completed_at=now() where job_id=${job.id} and status='failed'`;
  assert.equal((await nextRecaptureTask(d1, task.leaseToken)).task?.leaseToken, task.leaseToken);
  const key = `recapture:${task.itemId}:${task.leaseToken}:${"e".repeat(64)}`;
  await ingestCapture(payload(task.sessionId, true), d1, key);
  assert.equal((await reportRecaptureTask(d1, { ...report(), captureId: key })).status, "complete");
  assert.equal((await reportRecaptureTask(d1, { ...report(), captureId: key })).status, "complete");
});
await check("third consecutive source failure stays pending and pauses an old runner without losing its reason", async () => {
  const job = await syntheticJob(4);
  for (const outcome of ["skipped", "failed"] as const) {
    task = (await nextRecaptureTask(d1)).task!; assert.ok(task);
    assert.equal((await reportRecaptureTask(d1, { ...report(), outcome, message: "Synthetic source unavailable" })).status, outcome);
    await ageCompletedAttempts(job.id);
  }
  task = (await nextRecaptureTask(d1)).task!;
  const third = { ...report(), outcome: "skipped" as const, message: "Synthetic access denied" };
  assert.equal((await reportRecaptureTask(d1, third)).status, "pending");
  assert.equal((await reportRecaptureTask(d1, third)).status, "pending");
  let state = (await listRecaptureJobs()).find(j => j.id === job.id)!;
  assert.equal(state.status, "paused"); assert.equal(state.counts.pending, 2); assert.equal(state.counts.skipped, 1); assert.equal(state.counts.failed, 1);
  const pausedItem = state.items.find(i => i.id === task.itemId)!;
  assert.match(pausedItem.message ?? "", /连续 3 条/); assert.match(pausedItem.message ?? "", /Synthetic access denied/);
  const [stored] = await sql`select completed_at from recapture_items where id=${task.itemId}`; assert.equal(stored!.completed_at, null);
  assert.equal((await nextRecaptureTask(d1, task.leaseToken)).task, null);
  assert.equal((await safetyResets(job.id)).length, 0);
  const stale = third;
  await changeRecaptureJob(job.id, "resume");
  const resets = await safetyResets(job.id); assert.equal(resets.length, 1); assert.equal(resets[0]!.metadata.action, "resume");
  task = (await nextRecaptureTask(d1)).task!; assert.ok(task); assert.equal(task.itemId, pausedItem.id);
  await assert.rejects(() => reportRecaptureTask(d1, stale), /已失效/);
  // Explicit human resume starts a fresh failure streak, while preserving all
  // prior skipped/failed records and their timestamps in the same job.
  assert.equal((await reportRecaptureTask(d1, { ...report(), outcome: "failed", message: "Synthetic fresh failure" })).status, "failed");
  state = (await listRecaptureJobs()).find(j => j.id === job.id)!;
  assert.equal(state.status, "running"); assert.equal(state.counts.failed, 2); assert.equal(state.counts.pending, 1);
  assert.equal((await nextRecaptureTask(d1)).task, null);
  await changeRecaptureJob(job.id, "cancel");
});
await check("every tenth real completion requires ten minutes across repeated server calls", async () => {
  const job = await syntheticJob(11);
  for (let i = 0; i < 10; i++) {
    task = (await nextRecaptureTask(d1)).task!; assert.ok(task);
    const key = `recapture:${task.itemId}:${task.leaseToken}:${"f".repeat(64)}`;
    await ingestCapture(payload(task.sessionId, true), d1, key);
    await reportRecaptureTask(d1, { ...report(), captureId: key });
    if (i < 9) await ageCompletedAttempts(job.id);
  }
  assert.equal((await nextRecaptureTask(d1)).task, null);
  await ageCompletedAttempts(job.id, 61);
  assert.equal((await nextRecaptureTask(d1)).task, null);
  await ageCompletedAttempts(job.id, 601);
  task = (await nextRecaptureTask(d1)).task!; assert.ok(task);
  await changeRecaptureJob(job.id, "cancel");
});
await check("automatic skips, cancelled leftovers and manual completion without receipts do not impose cooldown", async () => {
  const job = await syntheticJob(4);
  const items = await sql`select id from recapture_items where job_id=${job.id} order by ordinal`;
  await sql`update recapture_items set status='skipped',attempts=0,completed_at=now(),message='会话已删除或已经完整归档' where id=${items[0]!.id}`;
  await sql`update recapture_items set status='skipped',attempts=1,completed_at=now(),message='任务已终止' where id=${items[1]!.id}`;
  await sql`update recapture_items set status='complete',attempts=1,completed_at=now(),capture_id=null,message='人工确认完整：用户接受现有归档，原会话无法访问；不再补采' where id=${items[2]!.id}`;
  task = (await nextRecaptureTask(d1)).task!; assert.ok(task); assert.equal(task.itemId, items[3]!.id);
  await changeRecaptureJob(job.id, "cancel");
});
await check("clients cannot spoof the server cancellation marker to evade pacing", async () => {
  const job = await syntheticJob(2); task = (await nextRecaptureTask(d1)).task!;
  await reportRecaptureTask(d1, { ...report(), outcome: "skipped", message: "任务已终止" });
  const [stored] = await sql`select message from recapture_items where id=${task.itemId}`;
  assert.equal(stored!.message, "本条处理结果：任务已终止");
  assert.equal((await nextRecaptureTask(d1)).task, null);
  await changeRecaptureJob(job.id, "cancel");
});
await check("rejected human actions do not create a safety reset baseline", async () => {
  const job = await syntheticJob(1);
  await assert.rejects(() => changeRecaptureJob(job.id, "resume"));
  await assert.rejects(() => changeRecaptureJob(job.id, "retry_failed"));
  assert.equal((await safetyResets(job.id)).length, 0);
  task = (await nextRecaptureTask(d1)).task!;
  await reportRecaptureTask(d1, { ...report(), outcome: "attention", message: "Synthetic manual inspection" });
  const before = await sql`select md5(j::text) as job_hash,(select md5(string_agg(i::text,'|' order by i.id))
    from recapture_items i where i.job_id=j.id) as item_hash from recapture_jobs j where j.id=${job.id}`;
  // Force a failure after the baseline INSERT to verify that both the log and
  // every item/job mutation are rolled back by the real transaction boundary.
  await sql.unsafe(`create function test_recapture_action_rollback() returns trigger language plpgsql as $$
    begin raise exception 'Synthetic action rollback sentinel'; end $$`);
  await sql.unsafe(`create trigger test_recapture_action_rollback before update on recapture_jobs
    for each row when (new.message='等待指定 Chrome 扩展继续') execute function test_recapture_action_rollback()`);
  try {
    await assert.rejects(() => changeRecaptureJob(job.id, "resume"), /Synthetic action rollback sentinel/);
    assert.equal((await safetyResets(job.id)).length, 0);
    const after = await sql`select md5(j::text) as job_hash,(select md5(string_agg(i::text,'|' order by i.id))
      from recapture_items i where i.job_id=j.id) as item_hash from recapture_jobs j where j.id=${job.id}`;
    assert.deepEqual([...after], [...before]);
  } finally {
    await sql.unsafe("drop trigger test_recapture_action_rollback on recapture_jobs");
    await sql.unsafe("drop function test_recapture_action_rollback()");
  }
  await changeRecaptureJob(job.id, "skip_current");
  const resets = await safetyResets(job.id); assert.equal(resets.length, 1); assert.equal(resets[0]!.metadata.action, "skip_current");
  const [baseline] = await sql`select jsonb_typeof(l.metadata) as metadata_type,l.created_at=j.updated_at as same_transaction_clock
    from operation_logs l join recapture_jobs j on j.id=l.entity_id::uuid where j.id=${job.id}
      and l.metadata->>'event'='recapture_safety_reset'`;
  assert.equal(baseline!.metadata_type, "object"); assert.equal(baseline!.same_transaction_clock, true);
});
console.log(`INTEGRATION_COMPLETE ${checks} checks`);
}
void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => closeDatabase());
