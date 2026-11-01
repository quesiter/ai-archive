import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { CapturePayloadV1 } from "@ai-archive/contracts";
import { db } from "../db.js";
import { conversations } from "../schema.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function parentLineageValidationQuery(input: {
  provider: CapturePayloadV1["provider"];
  sessionId: string;
  parentSessionId: string;
}) {
  return sql`
    with recursive ancestry as (
      select external_session_id, parent_external_session_id,
        array[external_session_id]::text[] as path, false as cycle
      from conversations
      where provider = ${input.provider} and external_session_id = ${input.parentSessionId}
      union all
      select parent.external_session_id, parent.parent_external_session_id,
        ancestry.path || parent.external_session_id,
        parent.external_session_id = any(ancestry.path)
      from ancestry
      join conversations parent on parent.provider = ${input.provider}
        and parent.external_session_id = ancestry.parent_external_session_id
      where not ancestry.cycle
    )
    select true as invalid from ancestry
    where external_session_id = ${input.sessionId} or cycle
    limit 1
  `;
}

/** Parent metadata is mutable conversation metadata, not revision content. */
export async function persistConversationParent(
  tx: Transaction,
  conversationId: string,
  payload: Pick<CapturePayloadV1, "provider" | "sessionId" | "parentSessionId">,
): Promise<void> {
  const parentSessionId = payload.parentSessionId;
  if (!parentSessionId || parentSessionId === payload.sessionId) return;

  // Serialize graph changes so simultaneous A -> B and B -> A captures cannot
  // both validate against the pre-update graph. Missing parents are allowed.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`conversation-lineage:${payload.provider}`}, 0))`);
  const [invalid] = await tx.execute<{ invalid: boolean }>(
    parentLineageValidationQuery({ ...payload, parentSessionId }),
  );
  if (invalid) return;
  await tx.update(conversations).set({ parentExternalSessionId: parentSessionId })
    .where(eq(conversations.id, conversationId));
}

/**
 * Orphans remain visible until an active parent is archived. Corrupt imported
 * cycles also remain visible instead of disappearing from every list.
 */
export function mainConversationFilter() {
  return sql`(
    ${conversations.parentExternalSessionId} is null
    or not exists (
      select 1 from conversations parent
      where parent.provider = ${conversations.provider}
        and parent.external_session_id = ${conversations.parentExternalSessionId}
        and parent.deleted_at is null
    )
    or exists (
      with recursive ancestry as (
        select parent.external_session_id, parent.parent_external_session_id,
          array[${conversations.externalSessionId}, parent.external_session_id]::text[] as path,
          parent.external_session_id = ${conversations.externalSessionId} as cycle
        from conversations parent
        where parent.provider = ${conversations.provider}
          and parent.external_session_id = ${conversations.parentExternalSessionId}
          and parent.deleted_at is null
        union all
        select parent.external_session_id, parent.parent_external_session_id,
          ancestry.path || parent.external_session_id,
          parent.external_session_id = any(ancestry.path)
        from ancestry
        join conversations parent on parent.provider = ${conversations.provider}
          and parent.external_session_id = ancestry.parent_external_session_id
          and parent.deleted_at is null
        where not ancestry.cycle
      )
      select 1 from ancestry where cycle
    )
  )`;
}

export function conversationChildCount() {
  // Single-table SELECT projections strip Drizzle Column qualifiers, which
  // would bind these correlated references to the inner child table instead.
  return sql<number>`(
    select count(*)::int from conversations child
    where child.provider = ${sql.identifier("conversations")}.${sql.identifier("provider")}
      and child.parent_external_session_id = ${sql.identifier("conversations")}.${sql.identifier("external_session_id")}
      and child.id <> ${sql.identifier("conversations")}.${sql.identifier("id")}
      and child.deleted_at is null
  )`;
}

/** Include each hit's active ancestors without matching unrelated conversations. */
export function ancestorConversationQuery(ids: readonly string[]) {
  return sql`
    with recursive ancestry as (
      select id, provider, parent_external_session_id from conversations
      where ${inArray(conversations.id, [...ids])} and deleted_at is null
      union
      select parent.id, parent.provider, parent.parent_external_session_id
      from ancestry
      join conversations parent on parent.provider = ancestry.provider
        and parent.external_session_id = ancestry.parent_external_session_id
        and parent.deleted_at is null
    )
    select id from ancestry
  `;
}

export async function includeConversationAncestors(ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db.execute<{ id: string }>(ancestorConversationQuery(ids));
  return rows.map((row) => row.id);
}

export async function loadConversationLineage(conversation: typeof conversations.$inferSelect) {
  const [parentConversation] = conversation.parentExternalSessionId &&
    conversation.parentExternalSessionId !== conversation.externalSessionId
    ? await db.select({
        id: conversations.id,
        title: conversations.title,
        externalSessionId: conversations.externalSessionId,
      }).from(conversations).where(and(
        eq(conversations.provider, conversation.provider),
        eq(conversations.externalSessionId, conversation.parentExternalSessionId),
        isNull(conversations.deletedAt),
      )).limit(1)
    : [];
  const childConversations = await db.select({
    id: conversations.id,
    title: conversations.title,
    externalSessionId: conversations.externalSessionId,
    updatedAt: conversations.updatedAt,
    childCount: conversationChildCount(),
    messageCount: sql<number>`coalesce((
      select revision.message_count from conversation_revisions revision
      where revision.conversation_id = ${sql.identifier("conversations")}.${sql.identifier("id")}
      order by (revision.completeness = 'complete') desc,
        revision.captured_at desc, revision.created_at desc
      limit 1
    ), 0)::int`,
  }).from(conversations).where(and(
    eq(conversations.provider, conversation.provider),
    eq(conversations.parentExternalSessionId, conversation.externalSessionId),
    sql`${conversations.id} <> ${conversation.id}`,
    isNull(conversations.deletedAt),
  )).orderBy(desc(conversations.updatedAt));
  return { parentConversation: parentConversation ?? null, childConversations };
}
