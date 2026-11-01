import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { consolidateConversationRevisions } from "./capture.js";

export async function accumulationCandidates(): Promise<Array<{ conversationId: string; revisionCount: number }>> {
  const rows = await db.execute<{ conversation_id: string; revision_count: number }>(sql`
    select conversation_id, count(*)::int as revision_count
    from conversation_revisions
    group by conversation_id
    having count(*) > 1 or not bool_and(is_accumulated)
    order by conversation_id
  `);
  return rows.map((row) => ({ conversationId: row.conversation_id, revisionCount: Number(row.revision_count) }));
}

/** Each conversation commits independently; interrupted runs resume safely. */
export async function consolidateArchiveConversations(
  onProgress?: (value: { processed: number; total: number; removedRevisions: number; conversationId: string; messageCount: number }) => Promise<void>,
): Promise<{ conversations: number; removedRevisions: number }> {
  const candidates = await accumulationCandidates();
  let processed = 0;
  let removedRevisions = 0;
  for (const candidate of candidates) {
    const result = await consolidateConversationRevisions(candidate.conversationId);
    removedRevisions += result.mergedRevisionCount;
    processed++;
    await onProgress?.({ processed, total: candidates.length, removedRevisions,
      conversationId: candidate.conversationId, messageCount: result.messageCount });
  }
  return { conversations: processed, removedRevisions };
}
