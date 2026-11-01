import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {isNull} from "../apps/server/node_modules/drizzle-orm/index.js";
import type {CaptureSnapshotV1} from "@ai-archive/contracts";

// This script intentionally restores and redacts its entire disposable DB.
const target = new URL(process.env.DATABASE_URL ?? "");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname));
assert.match(target.pathname, /^\/archive_e2e_search_\d+$/);

async function main() {
  const {db, sqlClient: sql, closeDatabase} = await import("../apps/server/src/db.js");
  const {ingestCapture} = await import("../apps/server/src/services/capture.js");
  const {createBackupArchive, restoreBackupArchive, parseBackupArchive} = await import("../apps/server/src/services/backup.js");
  const {redactStoredArchive} = await import("../apps/server/src/services/storage-redaction.js");
  const {stopBoss} = await import("../apps/server/src/services/queue.js");
  const {conversations} = await import("../apps/server/src/schema.js");
  const {mainConversationFilter} = await import("../apps/server/src/services/conversation-lineage.js");
  const {conversationSearchFilter, conversationSearchPageQuery} = await import("../apps/server/src/services/conversation-list-query.js");
  const hits = async (q: string) => {
    const [row] = await db.execute<{total: number}>(conversationSearchPageQuery(
      [isNull(conversations.deletedAt), mainConversationFilter(), conversationSearchFilter(q)], 50, 0));
    return row!.total;
  };
  const trace: Array<{query: string; params: unknown[]}> = [];
  sql.options.debug = (_id, query, params) => {trace.push({query, params: [...params]});};
  try {
    const source: CaptureSnapshotV1 = {schemaVersion:1, provider:"chatgpt", sessionId:randomUUID(), title:"Lifecycle fixture",
      branchFingerprint:"main-branch", adapterVersion:"lifecycle-test", captureMode:"full", capturedAt:"2026-11-01T00:00:00Z",
      completeness:{status:"complete",topReached:true,bottomReached:true,stable:true},
      messages:Array.from({length:300},(_,ordinal)=>({ordinal,externalMessageId:`m-${ordinal}`,role:"assistant",
        segments:[{type:"text",content:ordinal === 299 ? "归档项目 秘甲乙丙" : `历史词条 ${ordinal}`}]}))};
    const receipt = await ingestCapture(source,null);
    assert.equal(await hits("项目"),1); assert.equal(await hits("归档项目"),1);
    const [tuple] = await sql`select ctid::text as tuple from conversation_search_terms where conversation_id=${receipt.conversationId} and term='历史'`;
    const appended: CaptureSnapshotV1 = {...source,capturedAt:"2026-11-01T01:00:00Z",messages:[...source.messages,
      {ordinal:300,externalMessageId:"new",role:"assistant",segments:[{type:"text",content:"追加优化"}]}]};
    trace.length = 0;
    await ingestCapture(appended,null);
    const postings = trace.filter(row=>row.query.includes("insert into conversation_search_terms"));
    assert.equal(postings.length,1); assert.ok(!postings[0]!.query.includes("removed"));
    assert.ok(!JSON.stringify(postings[0]!.params).includes("历史"));
    assert.deepEqual((await sql`select ctid::text as tuple from conversation_search_terms where conversation_id=${receipt.conversationId} and term='历史'`)[0],tuple);
    assert.equal(await hits("追加优化"),1);
    console.log("PASS append sends only new terms and preserves old posting tuples");

    const backup = await createBackupArchive();
    const parsed = await parseBackupArchive(backup.filename,backup.buffer);
    assert.ok(!["conversationSearchChunks","conversationSearchDocuments","conversationSearchTerms"].some(key=>key in parsed.tables),"Derived search data must not enter business backups");
    const before = await sql`select term,conversation_id from conversation_search_terms order by term collate "C",conversation_id`;
    const restored = await restoreBackupArchive(backup.filename,backup.buffer);
    assert.equal(restored.ok,true);
    assert.deepEqual(await sql`select term,conversation_id from conversation_search_terms order by term collate "C",conversation_id`,before);
    assert.equal(await hits("归档项目"),1); assert.equal(await hits("追加优化"),1);
    console.log("PASS backup restore rebuilds identical terms and phrase hits from authoritative chunks");

    await sql`insert into redaction_rules(pattern,replacement) values('秘甲乙丙','[REMOVED]')`;
    const [task] = await sql`insert into background_tasks(kind,status) values('storage_redaction','queued') returning id`;
    await redactStoredArchive(task!.id);
    assert.equal(await hits("秘甲乙丙"),0); assert.equal(await hits("秘甲"),0);
    assert.equal(await hits("归档项目"),1);
    assert.equal((await sql`select count(*)::int as count from conversation_search_chunks where content like '%秘甲乙丙%'`)[0]!.count,0);
    assert.equal((await sql`select count(*)::int as count from conversation_search_documents where not terms_ready`)[0]!.count,0);
    console.log("PASS storage redaction rebuilds terms without retaining removed words");

    await sql`delete from conversations where id=${receipt.conversationId}`;
    assert.equal((await sql`select count(*)::int as count from conversation_search_terms`)[0]!.count,0);
    console.log("PASS permanent deletion cascades search metadata and postings");
    const columns = await sql`select column_name from information_schema.columns where table_name='conversation_search_documents'`;
    assert.ok(!columns.some(row=>row.column_name === "content" || row.column_name === "short_cjk_terms"));
    console.log("PASS no duplicate full-text or packed-term column remains");
  } finally {await stopBoss(); await closeDatabase();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
