import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const target = new URL(process.env.DATABASE_URL ?? "");
assert.match(target.pathname, /^\/archive_performance_test_[0-9]+$/, "Only a disposable performance test database may be used");
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(target.hostname), "Performance tests require an isolated local database");
const conversationCount = Number(process.env.PERFORMANCE_CONVERSATIONS ?? 10_000);
const repetitions = Number(process.env.PERFORMANCE_REPETITIONS ?? 30);
assert.ok(Number.isInteger(conversationCount) && conversationCount >= 1_000 && conversationCount <= 100_000);
assert.ok(Number.isInteger(repetitions) && repetitions >= 10 && repetitions <= 200);
const messagesPerConversation = 10;
async function run() {
  const { sqlClient: sql, db, closeDatabase } = await import("../apps/server/src/db.js");
  const { buildApp } = await import("../apps/server/src/app.js");
  const { stopBoss } = await import("../apps/server/src/services/queue.js");

  type Trace = { query: string; parameters: unknown[]; jitDisabled: boolean };
  let capturing = false;
  let transactionJitDisabled = false;
  let traces: Trace[] = [];
  sql.options.debug = (_connection, query, parameters) => {
    if (capturing && /^(?:begin|commit|rollback)\b/i.test(query.trim())) transactionJitDisabled = false;
    if (capturing && /^set local jit\s*=\s*off/i.test(query.trim())) transactionJitDisabled = true;
    if (capturing && /^(?:select|with)\b/i.test(query.trim()) && /\b(?:from|join)\s+"?(?:conversations|conversation_revisions|conversation_search_chunks)\b/i.test(query)) {
      traces.push({ query, parameters: [...parameters], jitDisabled: transactionJitDisabled });
    }
  };

  function percentile(values: number[], fraction: number) {
    const ordered = [...values].sort((a, b) => a - b);
    return Number(ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)]!.toFixed(2));
  }

  async function seed() {
    const [existing] = await sql`select count(*)::int as count from conversations`;
    if (Number(existing!.count) > 0) {
      assert.equal(Number(existing!.count), conversationCount, "Existing synthetic dataset scale differs from requested scale");
      const [facts] = await sql`select (select count(*)::int from messages) as messages,
        (select count(*)::int from conversation_search_chunks) as chunks`;
      assert.equal(Number(facts!.messages), conversationCount * messagesPerConversation, "Synthetic seed is incomplete; use a fresh disposable database");
      assert.equal(Number(facts!.chunks), conversationCount * messagesPerConversation, "Synthetic seed is incomplete; use a fresh disposable database");
      return;
    }
    await sql`
      insert into conversations(id,provider,external_session_id,parent_external_session_id,title,updated_at)
      select md5('conversation-'||i)::uuid,case when i<=${conversationCount / 2} then 'chatgpt' else 'codex' end,
        'synthetic-'||i,case when i%20=0 then 'synthetic-'||(i-1) else null end,
        '合成项目 '||i||case when i%500=0 then ' 标题独有' else '' end,
        timestamptz '2026-10-25 00:00:00+00' - i*interval '1 minute'
      from generate_series(1,${conversationCount}::integer) i`;
    await sql`
      insert into conversation_revisions(id,conversation_id,branch_fingerprint,snapshot_hash,is_accumulated,
        completeness,top_reached,bottom_reached,stable,adapter_version,captured_at,message_count,search_text)
      select md5('revision-'||i)::uuid,md5('conversation-'||i)::uuid,'synthetic','synthetic-'||i,true,
        case when i%10=0 then 'partial' else 'complete' end,i%10<>0,true,true,'synthetic',now(),${messagesPerConversation},''
      from generate_series(1,${conversationCount}::integer) i`;
    await sql`
      insert into messages(id,revision_id,external_message_id,ordinal,role)
      select md5('message-'||i)::uuid,md5('revision-'||((i-1)/${messagesPerConversation}+1))::uuid,
        'synthetic-message-'||i,(i-1)%${messagesPerConversation},case when i%2=0 then 'assistant' else 'user' end
      from generate_series(1,${conversationCount * messagesPerConversation}::integer) i`;
    await sql`
      insert into message_segments(message_id,ordinal,type,content)
      select md5('message-'||i)::uuid,0,'text',
        repeat('项目归档性能验证 PostgreSQL API event loop discussion ',5)||' 合成消息 '||i||
        case when i%1000=0 then ' 稀有标记' else '' end
      from generate_series(1,${conversationCount * messagesPerConversation}::integer) i`;
    await sql`
      insert into conversation_search_chunks(revision_id,message_id,chunk_index,content)
      select m.revision_id,m.id,0,s.content from messages m join message_segments s on s.message_id=m.id`;
    await sql.unsafe("analyze");
  }

  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  async function main() {
    const seededAt = performance.now();
    await seed();
    const {rebuildConversationSearchDocuments} = await import("../apps/server/src/services/search-documents.js");
    await db.transaction(tx => rebuildConversationSearchDocuments(tx));
    console.log(`SEEDED ${conversationCount} conversations / ${conversationCount * messagesPerConversation} messages+chunks in ${((performance.now() - seededAt) / 1000).toFixed(2)}s`);
    const token = randomBytes(32).toString("hex");
    const [admin] = await sql`insert into users(singleton_key,username,password_hash,totp_secret_encrypted)
      values(1,'synthetic-performance','unused','unused') on conflict(singleton_key) do update set username=excluded.username returning id`;
    await sql`insert into web_sessions(user_id,token_hash,expires_at) values(${admin!.id},${createHash("sha256").update(token).digest("hex")},now()+interval '90 days')`;
    app = await buildApp();
    const cases = [
      { id: "list-first-page", path: "/api/v1/conversations?limit=50" },
      { id: "list-deep-page", path: `/api/v1/conversations?limit=50&offset=${Math.floor(conversationCount * 0.9)}` },
      { id: "search-rare-chinese", path: `/api/v1/conversations?limit=50&q=${encodeURIComponent("稀有标记")}` },
      { id: "search-common-chinese", path: `/api/v1/conversations?limit=50&q=${encodeURIComponent("项目")}` },
      { id: "search-no-match", path: "/api/v1/conversations?limit=50&q=absentneedlexyz" },
    ];
    const results = [];
    for (const [caseIndex, item] of cases.entries()) {
      const request = () => app!.inject({ method: "GET", url: item.path,
        headers: { cookie: `archive_session=${token}` }, remoteAddress: `127.0.1.${caseIndex + 1}` });
      traces = [];
      capturing = true;
      const first = await request();
      capturing = false;
      assert.equal(first.statusCode, 200, `${item.id} failed: ${first.body.slice(0, 400)}`);
      const body = first.json() as { pagination: { total: number }; items: unknown[] };
      const uniqueQueries = [...new Map(traces.map(trace => [trace.query, trace])).values()];
      const durations: number[] = [];
      for (let iteration = 0; iteration < repetitions; iteration++) {
        const started = performance.now();
        const response = await request();
        durations.push(performance.now() - started);
        assert.equal(response.statusCode, 200, `${item.id} returned ${response.statusCode}`);
        assert.equal(response.json().pagination.total, body.pagination.total);
      }
      const plans = [];
      for (const trace of uniqueQueries) {
        const [plan] = await sql.begin(async (tx) => {
          if (trace.jitDisabled) await tx.unsafe("set local jit = off");
          return tx.unsafe(`explain (analyze,buffers,format json) ${trace.query}`, trace.parameters as never[]);
        });
        plans.push({ ...trace, explain: plan?.["QUERY PLAN"] });
      }
      const metrics = {
        id: item.id, total: body.pagination.total, pageItems: body.items.length, samples: durations.length,
        p50Ms: percentile(durations, 0.5), p95Ms: percentile(durations, 0.95), p99Ms: percentile(durations, 0.99),
        maxMs: Number(Math.max(...durations).toFixed(2)), capturedCoreSelectsPerRequest: traces.length,
      };
      results.push({ ...metrics, durationsMs: durations.map(value => Number(value.toFixed(2))), plans });
      console.log(JSON.stringify(metrics));
    }
    const [scale] = await sql`select
      (select count(*)::int from conversations) as conversations,
      (select count(*)::int from messages) as messages,
      (select count(*)::int from conversation_search_chunks) as chunks,
      pg_database_size(current_database()) as database_bytes`;
    const indexes = await sql`select tablename,indexname,indexdef from pg_indexes where schemaname='public'
      and tablename in ('conversations','conversation_revisions','messages','conversation_search_chunks') order by tablename,indexname`;
    const [database] = await sql`select version(),current_setting('shared_buffers') as shared_buffers,current_setting('work_mem') as work_mem`;
    const output = resolve(process.env.PERFORMANCE_REPORT ?? ".codex-tmp/performance/search-performance.json");
    await writeFile(output, JSON.stringify({ generatedAt: new Date().toISOString(),
      environment: { node: process.version, database, databaseName: target.pathname.slice(1),
        note: "Synthetic disposable PostgreSQL; warm authenticated Fastify inject timings, not production or browser/network performance; no concurrent load." },
      scale, indexes, results }, null, 2));
    console.log(`PERFORMANCE_COMPLETE ${output}`);
  }

  await main().finally(async () => {
    const cleanup = await Promise.allSettled([app?.close(), stopBoss(), closeDatabase()]);
    for (const result of cleanup) {
      if (result.status === "rejected") {
        console.error("Performance test cleanup failed:", result.reason);
        process.exitCode = 1;
      }
    }
  });
}

void run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
