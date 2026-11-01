import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db.js";
import { conversations } from "../schema.js";
import { persistConversationParent } from "./conversation-lineage.js";

export const CodexHistoryLineageSchema = z.object({
  relations: z.array(z.object({
    sessionId: z.string().min(1).max(1_024),
    parentSessionId: z.string().min(1).max(1_024),
  }).refine((value) => value.sessionId !== value.parentSessionId, "A session cannot parent itself")).min(1).max(500),
});

/** Repair organization metadata only; never creates or restores conversations. */
export async function backfillCodexHistoryLineage(raw: unknown) {
  const input = CodexHistoryLineageSchema.parse(raw);
  return db.transaction(async (tx) => {
    // Ingest locks the conversation before its row and the lineage graph.
    // Keep that order, sorting the whole batch so overlapping repairs agree.
    for (const sessionId of [...new Set(input.relations.map((relation) => relation.sessionId))].sort()) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`conversation:codex:${sessionId}`}, 0))`);
    }
    const result = { updated: 0, unchanged: 0, notFound: 0, rejected: 0 };
    for (const relation of input.relations) {
      const [conversation] = await tx.select({
        id: conversations.id,
        parent: conversations.parentExternalSessionId,
      }).from(conversations).where(and(
        eq(conversations.provider, "codex"),
        eq(conversations.externalSessionId, relation.sessionId),
      )).limit(1);
      if (!conversation) { result.notFound += 1; continue; }
      if (conversation.parent === relation.parentSessionId) { result.unchanged += 1; continue; }
      await persistConversationParent(tx, conversation.id, { provider: "codex", ...relation });
      const [saved] = await tx.select({ parent: conversations.parentExternalSessionId })
        .from(conversations).where(eq(conversations.id, conversation.id)).limit(1);
      if (saved?.parent === relation.parentSessionId) result.updated += 1;
      else result.rejected += 1;
    }
    return result;
  });
}
