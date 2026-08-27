#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { closeDatabase, sqlClient } from "./db.js";

const queries = (process.env.SEARCH_BENCHMARK_QUERIES ?? "项目,归档,API,PostgreSQL,AI 对话")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const repetitions = Math.max(1, Math.min(100, Number(process.env.SEARCH_BENCHMARK_REPETITIONS ?? 10)));

function percentile(values: number[], percentileValue: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentileValue))] ?? 0;
}

async function main() {
  const [scale] = await sqlClient<{
    conversations: number;
    messages: number;
    chunks: number;
  }[]>`
    select
      (select count(*)::int from conversations where deleted_at is null) as conversations,
      (select count(*)::int from messages) as messages,
      (select count(*)::int from conversation_search_chunks) as chunks
  `;
  const cases = [];
  for (const query of queries) {
    const durations: number[] = [];
    let explain: unknown = null;
    for (let attempt = 0; attempt < repetitions; attempt += 1) {
      const started = performance.now();
      await sqlClient`
        select distinct revision.conversation_id
        from conversation_search_chunks chunk
        inner join conversation_revisions revision on revision.id = chunk.revision_id
        where chunk.content ilike ${`%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`} escape '\\'
           or chunk.search_vector @@ websearch_to_tsquery('simple', ${query})
        limit 100
      `;
      durations.push(performance.now() - started);
    }
    const [plan] = await sqlClient.unsafe(
      `explain (analyze, buffers, format json)
       select distinct revision.conversation_id
       from conversation_search_chunks chunk
       inner join conversation_revisions revision on revision.id = chunk.revision_id
       where chunk.content ilike $1 escape '\\'
          or chunk.search_vector @@ websearch_to_tsquery('simple', $2)
       limit 100`,
      [`%${query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`, query],
    );
    explain = plan?.["QUERY PLAN"] ?? null;
    cases.push({
      query,
      repetitions,
      p50Ms: Number(percentile(durations, 0.5).toFixed(2)),
      p95Ms: Number(percentile(durations, 0.95).toFixed(2)),
      p99Ms: Number(percentile(durations, 0.99).toFixed(2)),
      maxMs: Number(Math.max(...durations).toFixed(2)),
      explain,
    });
  }
  const report = {
    generatedAt: new Date().toISOString(),
    scale,
    queries: cases,
    note: "请分别在 10k/100k、50k/1M、100k/3M 会话/消息数据级别执行并归档结果。",
  };
  const output = process.env.SEARCH_BENCHMARK_REPORT;
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(() => closeDatabase());
