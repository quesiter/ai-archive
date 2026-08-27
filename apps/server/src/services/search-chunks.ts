import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { conversationSearchChunks } from "../schema.js";

export const SEARCH_CHUNK_SIZE = 4_000;

export function chunkSearchContent(content: string, size = SEARCH_CHUNK_SIZE): string[] {
  const normalized = content.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < normalized.length; offset += size) {
    chunks.push(normalized.slice(offset, offset + size));
  }
  return chunks;
}

export async function rebuildConversationSearchChunks(): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(847231955)`);
    await tx.delete(conversationSearchChunks);
    const result = await tx.execute<{ count: number }>(sql`
      with inserted as (
        insert into conversation_search_chunks(revision_id, message_id, chunk_index, content)
        select
          message_text.revision_id,
          message_text.message_id,
          chunks.chunk_index,
          substring(message_text.content from chunks.chunk_index * ${SEARCH_CHUNK_SIZE} + 1 for ${SEARCH_CHUNK_SIZE})
        from (
          select
            messages.revision_id,
            messages.id as message_id,
            string_agg(message_segments.content, E'\\n' order by message_segments.ordinal) as content
          from messages
          inner join message_segments on message_segments.message_id = messages.id
          group by messages.revision_id, messages.id
        ) as message_text
        cross join lateral generate_series(
          0,
          greatest(ceil(length(message_text.content)::numeric / ${SEARCH_CHUNK_SIZE})::integer - 1, 0)
        ) as chunks(chunk_index)
        returning 1
      )
      select count(*)::int as count from inserted
    `);
    return Number(result[0]?.count ?? 0);
  });
}
