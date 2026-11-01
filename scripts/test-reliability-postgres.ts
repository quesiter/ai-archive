import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CaptureSnapshotV1 } from "@ai-archive/contracts";
import { sqlClient as sql, closeDatabase } from "../apps/server/src/db.js";
import { ingestCapture } from "../apps/server/src/services/capture.js";
import { createBackupArchive, restoreBackupArchive, verifyBackupArchive } from "../apps/server/src/services/backup.js";
import { createRestoreUpload, getRestoreJob, maintenanceRestoreJob, processRestoreJob, failStaleRestoreJobs } from "../apps/server/src/services/restore.js";
import { checkArchiveIntegrity } from "../apps/server/src/services/archive-integrity.js";
import { stopBoss } from "../apps/server/src/services/queue.js";

assert.match(new URL(process.env.DATABASE_URL!).pathname, /^\/archive_reliability_test_\d+$/,
  "Reliability tests require a disposable archive_reliability_test_<digits> database");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(new URL(process.env.DATABASE_URL!).hostname),
  "Reliability tests require a local isolated PostgreSQL instance");
let checks = 0;
async function check(name: string, operation: () => Promise<void>) {
  await operation();
  checks++;
  console.log(`PASS ${name}`);
}
const device = randomUUID();
const session = randomUUID();
const snapshot: CaptureSnapshotV1 = {
  schemaVersion: 1, provider: "codex", sessionId: session, title: "Synthetic reliability fixture",
  adapterVersion: "reliability-test", captureMode: "import", triggerReason: "local_file_rewritten",
  capturedAt: new Date().toISOString(), branchFingerprint: "reliability",
  completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
  messages: [
    { ordinal: 0, externalMessageId: "user-1", role: "user", segments: [{ type: "text", content: "验证项目归档与灾备恢复" }] },
    { ordinal: 1, externalMessageId: "assistant-1", role: "assistant", segments: [{ type: "text", content: "Synthetic answer for PostgreSQL reliability checks" }] },
  ],
};

async function main() {
try {
  await check("all migrations apply to a fresh PostgreSQL database", async () => {
    const [result] = await sql`select count(*)::int as count from drizzle.__drizzle_migrations`;
    const journal = JSON.parse(readFileSync(resolve(process.cwd(), "migrations/meta/_journal.json"), "utf8"));
    assert.equal(result!.count, journal.entries.length);
  });
  await sql`insert into devices(id,name,kind,token_hash) values(${device},'Synthetic reliability device','openclaw_sync',${randomUUID()})`;
  const receipt = await ingestCapture(snapshot, device, "reliability-initial");
  const baseline = await sql`select id,content_integrity_hash from conversation_revisions order by id`;
  const archive = await createBackupArchive();
  await check("consistent backup verifies and has no critical archive errors", async () => {
    assert.equal((await verifyBackupArchive(archive.filename, archive.buffer)).ok, true);
    const integrity = await checkArchiveIntegrity();
    assert.equal(integrity.ok, true, JSON.stringify(integrity.errors));
  });
  const job = await createRestoreUpload(archive.filename);
  await writeFile(job.stagedPath, archive.buffer);
  await check("backup restores facts, rebuilds search and exits maintenance", async () => {
    await processRestoreJob(job.id);
    const finished = await getRestoreJob(job.id);
    assert.equal(finished?.status, "completed", finished?.error ?? "restore did not complete");
    assert.ok(finished?.factsCommittedAt);
    assert.equal(finished?.stagedDeletedAt instanceof Date, true);
    assert.equal(await maintenanceRestoreJob(), null);
    assert.deepEqual(await sql`select id,content_integrity_hash from conversation_revisions order by id`, baseline);
    const [found] = await sql`select count(*)::int as count from conversation_search_chunks where content ilike '%PostgreSQL%'`;
    assert.ok(found!.count > 0);
  });
  await check("pre-commit interruption preserves original facts", async () => {
    await assert.rejects(restoreBackupArchive(archive.filename, archive.buffer, {
      onPhase: async (phase) => { if (phase === "restoring") throw new Error("Synthetic pre-commit interruption"); },
    }), /Synthetic pre-commit interruption/);
    assert.deepEqual(await sql`select id,content_integrity_hash from conversation_revisions order by id`, baseline);
  });
  await check("invalid staged backup fails without opening partial facts or maintenance", async () => {
    const invalid = await createRestoreUpload("invalid.json.gz");
    await writeFile(invalid.stagedPath, Buffer.from("not a valid backup"));
    await assert.rejects(processRestoreJob(invalid.id));
    assert.equal((await getRestoreJob(invalid.id))?.status, "failed");
    assert.equal(await maintenanceRestoreJob(), null);
    assert.deepEqual(await sql`select id,content_integrity_hash from conversation_revisions order by id`, baseline);
  });
  await check("post-commit interruption persists checkpoint and recovery survives missing staging file", async () => {
    const recovery = await createRestoreUpload(archive.filename);
    await writeFile(recovery.stagedPath, archive.buffer);
    await assert.rejects(restoreBackupArchive(archive.filename, archive.buffer, {
      restoreJobId: recovery.id,
      onPhase: async (phase) => { if (phase === "rebuilding_search") throw new Error("Synthetic post-commit interruption"); },
    }), /Synthetic post-commit interruption/);
    const checkpoint = await getRestoreJob(recovery.id);
    assert.ok(checkpoint?.factsCommittedAt);
    assert.equal(checkpoint?.status, "rebuilding_search");
    assert.ok(await maintenanceRestoreJob());
    await sql`update restore_jobs set updated_at=now()-interval '13 hours' where id=${recovery.id}`;
    await failStaleRestoreJobs();
    assert.equal((await getRestoreJob(recovery.id))?.status, "recovery_required");
    await unlink(recovery.stagedPath);
    await processRestoreJob(recovery.id);
    assert.equal((await getRestoreJob(recovery.id))?.status, "completed");
    assert.equal(await maintenanceRestoreJob(), null);
    assert.deepEqual(await sql`select id,content_integrity_hash from conversation_revisions order by id`, baseline);
  });
  await check("archive and immutable capture receipt remain consistent after recovery", async () => {
    const integrity = await checkArchiveIntegrity();
    assert.equal(integrity.ok, true, JSON.stringify(integrity.errors));
    const [run] = await sql`select receipt from capture_runs where idempotency_key='reliability-initial' and device_id=${device}`;
    assert.equal(run?.receipt.conversationId, receipt.conversationId);
  });
  console.log(`PASS ${checks} PostgreSQL reliability scenarios (synthetic data; injected checkpoint interruptions)`);
} finally {
  await stopBoss();
  await closeDatabase();
}
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
