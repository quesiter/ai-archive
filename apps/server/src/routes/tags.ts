import { and, count, desc, eq, ilike, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db.js";
import { requireWebUser } from "../http.js";
import {
  conversationTags,
  conversations,
  tags,
} from "../schema.js";
import {
  getOrCreateTag,
  isReusableTagName,
  mergeConversationTagState,
  normalizeTagName,
} from "../services/tags.js";
import { writeOperationLog } from "../services/operation-log.js";

const TagNameSchema = z.object({
  name: z.string().min(1).max(100).refine(isReusableTagName, {
    message: "Tag name must be concise and reusable",
  }),
});

export async function tagRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/v1/tags", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const query = z
      .object({ q: z.string().max(100).optional() })
      .parse(request.query);
    const rows = await db
      .select({
        id: tags.id,
        name: tags.name,
        normalizedName: tags.normalizedName,
        createdAt: tags.createdAt,
        updatedAt: tags.updatedAt,
        conversationCount: count(conversationTags.conversationId),
      })
      .from(tags)
      .leftJoin(conversationTags, eq(conversationTags.tagId, tags.id))
      .where(query.q ? ilike(tags.name, `%${query.q}%`) : undefined)
      .groupBy(tags.id)
      .orderBy(desc(count(conversationTags.conversationId)), tags.name);
    return rows.map((row) => ({
      ...row,
      conversationCount: Number(row.conversationCount ?? 0),
    }));
  });

  app.post("/api/v1/tags", async (request, reply) => {
    if (!(await requireWebUser(request, reply))) return;
    const input = TagNameSchema.parse(request.body);
    const tag = await getOrCreateTag(input.name);
    return reply.code(201).send(tag);
  });

  app.patch<{ Params: { id: string } }>(
    "/api/v1/tags/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = TagNameSchema.parse(request.body);
      const normalized = normalizeTagName(input.name);
      const [conflict] = await db
        .select({ id: tags.id })
        .from(tags)
        .where(eq(tags.normalizedName, normalized.normalizedName))
        .limit(1);
      if (conflict && conflict.id !== params.id) {
        return reply.code(409).send({
          error: "A tag with the normalized name already exists; merge the tags instead",
        });
      }
      const [tag] = await db
        .update(tags)
        .set({
          name: normalized.name,
          normalizedName: normalized.normalizedName,
          updatedAt: new Date(),
        })
        .where(eq(tags.id, params.id))
        .returning();
      if (!tag) return reply.code(404).send({ error: "Tag not found" });
      return tag;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/tags/:id/merge",
    async (request, reply) => {
      const user = await requireWebUser(request, reply);
      if (!user) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = z.object({ targetTagId: z.string().uuid() }).parse(request.body);
      if (params.id === input.targetTagId) {
        return reply.code(400).send({ error: "Source and target tags must be different" });
      }
      const [source, target, sourceLinks, targetLinks] = await Promise.all([
        db.select().from(tags).where(eq(tags.id, params.id)).limit(1),
        db.select().from(tags).where(eq(tags.id, input.targetTagId)).limit(1),
        db.select().from(conversationTags).where(eq(conversationTags.tagId, params.id)),
        db.select().from(conversationTags).where(eq(conversationTags.tagId, input.targetTagId)),
      ]);
      if (!source[0] || !target[0]) {
        return reply.code(404).send({ error: "Source or target tag not found" });
      }
      const targetByConversation = new Map(
        targetLinks.map((link) => [link.conversationId, link]),
      );
      await db.transaction(async (tx) => {
        for (const sourceLink of sourceLinks) {
          const existing = targetByConversation.get(sourceLink.conversationId);
          if (existing) {
            const merged = mergeConversationTagState(existing, sourceLink);
            await tx
              .update(conversationTags)
              .set({
                ...merged,
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(conversationTags.conversationId, sourceLink.conversationId),
                  eq(conversationTags.tagId, input.targetTagId),
                ),
              );
          } else {
            await tx.insert(conversationTags).values({
              ...sourceLink,
              tagId: input.targetTagId,
              updatedAt: new Date(),
            });
          }
        }
        await tx.delete(tags).where(eq(tags.id, params.id));
        await tx
          .update(tags)
          .set({ updatedAt: new Date() })
          .where(eq(tags.id, input.targetTagId));
      });
      const result = {
        sourceTagId: params.id,
        sourceTagName: source[0].name,
        targetTagId: input.targetTagId,
        targetTagName: target[0].name,
        movedConversationCount: sourceLinks.length,
      };
      await writeOperationLog({
        scope: "classification",
        message: `标签“${source[0].name}”已合并到“${target[0].name}”`,
        status: "completed",
        entityType: "tag",
        entityId: input.targetTagId,
        metadata: { ...result, userId: user.id },
      });
      return result;
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/tags/:id",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const [tag] = await db
        .delete(tags)
        .where(eq(tags.id, params.id))
        .returning();
      if (!tag) return reply.code(404).send({ error: "Tag not found" });
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/conversations/:id/tags",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = TagNameSchema.extend({
        lockedByUser: z.boolean().default(true),
      }).parse(request.body);
      const [conversation] = await db
        .select({ id: conversations.id })
        .from(conversations)
        .where(and(eq(conversations.id, params.id), isNull(conversations.deletedAt)))
        .limit(1);
      if (!conversation) {
        return reply.code(404).send({ error: "Conversation not found" });
      }
      const tag = await getOrCreateTag(input.name);
      const [link] = await db
        .insert(conversationTags)
        .values({
          conversationId: params.id,
          tagId: tag.id,
          confidence: 1,
          source: "manual",
          lockedByUser: input.lockedByUser,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [conversationTags.conversationId, conversationTags.tagId],
          set: {
            confidence: 1,
            source: "manual",
            lockedByUser: input.lockedByUser,
            updatedAt: new Date(),
          },
        })
        .returning();
      return reply.code(201).send({ ...tag, ...link });
    },
  );

  app.patch<{ Params: { id: string; tagId: string } }>(
    "/api/v1/conversations/:id/tags/:tagId",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z
        .object({ id: z.string().uuid(), tagId: z.string().uuid() })
        .parse(request.params);
      const input = z.object({ lockedByUser: z.boolean() }).parse(request.body);
      const [link] = await db
        .update(conversationTags)
        .set({ lockedByUser: input.lockedByUser, updatedAt: new Date() })
        .where(
          and(
            eq(conversationTags.conversationId, params.id),
            eq(conversationTags.tagId, params.tagId),
          ),
        )
        .returning();
      if (!link) return reply.code(404).send({ error: "Conversation tag not found" });
      return link;
    },
  );

  app.delete<{ Params: { id: string; tagId: string } }>(
    "/api/v1/conversations/:id/tags/:tagId",
    async (request, reply) => {
      if (!(await requireWebUser(request, reply))) return;
      const params = z
        .object({ id: z.string().uuid(), tagId: z.string().uuid() })
        .parse(request.params);
      const [link] = await db
        .delete(conversationTags)
        .where(
          and(
            eq(conversationTags.conversationId, params.id),
            eq(conversationTags.tagId, params.tagId),
          ),
        )
        .returning();
      if (!link) return reply.code(404).send({ error: "Conversation tag not found" });
      return reply.code(204).send();
    },
  );
}
