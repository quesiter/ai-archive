import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { conversationTags, tags } from "../schema.js";
import { mergeConversationTagState } from "./tags.js";

export interface TagMergeResult {
  sourceTagId: string;
  sourceTagName: string;
  targetTagId: string;
  targetTagName: string;
  movedConversationCount: number;
}

export async function mergeTagIntoTag(input: {
  sourceTagId: string;
  targetTagId: string;
}): Promise<TagMergeResult | null> {
  if (input.sourceTagId === input.targetTagId) {
    throw new Error("Source and target tags must be different");
  }
  return db.transaction(async (tx) => {
    for (const tagId of [input.sourceTagId, input.targetTagId].sort()) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`tag:${tagId}`}, 0))`,
      );
    }
    const [source] = await tx.select().from(tags).where(eq(tags.id, input.sourceTagId)).limit(1);
    const [target] = await tx.select().from(tags).where(eq(tags.id, input.targetTagId)).limit(1);
    if (!source || !target) return null;

    const [sourceLinks, targetLinks] = await Promise.all([
      tx.select().from(conversationTags).where(eq(conversationTags.tagId, source.id)),
      tx.select().from(conversationTags).where(eq(conversationTags.tagId, target.id)),
    ]);
    const targetByConversation = new Map(
      targetLinks.map((link) => [link.conversationId, link]),
    );
    for (const sourceLink of sourceLinks) {
      const existing = targetByConversation.get(sourceLink.conversationId);
      if (existing) {
        await tx
          .update(conversationTags)
          .set({
            ...mergeConversationTagState(existing, sourceLink),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(conversationTags.conversationId, sourceLink.conversationId),
              eq(conversationTags.tagId, target.id),
            ),
          );
      } else {
        await tx.insert(conversationTags).values({
          ...sourceLink,
          tagId: target.id,
          updatedAt: new Date(),
        });
      }
    }
    await tx.delete(tags).where(eq(tags.id, source.id));
    await tx.update(tags).set({ updatedAt: new Date() }).where(eq(tags.id, target.id));
    return {
      sourceTagId: source.id,
      sourceTagName: source.name,
      targetTagId: target.id,
      targetTagName: target.name,
      movedConversationCount: sourceLinks.length,
    };
  });
}
