import { and, isNull, sql } from "drizzle-orm";
import { conversations } from "../schema.js";
import { mainConversationFilter } from "./conversation-lineage.js";

/**
 * A project contains a visible main conversation when that conversation or any
 * active descendant is assigned to it. Keep one membership per project/main,
 * with activity from all contributing records, without changing assignments.
 */
export function projectConversationMembershipQuery(projectId?: string) {
  return sql`
    with recursive project_ancestry as (
      select assignment.project_id, source.id, source.provider,
        source.parent_external_session_id,
        assignment.updated_at as assignment_updated_at,
        source.updated_at as conversation_updated_at
      from conversation_projects assignment
      join conversations source on source.id = assignment.conversation_id
      where assignment.project_id is not null and source.deleted_at is null
        ${projectId ? sql`and assignment.project_id = ${projectId}` : sql``}
      union
      select ancestry.project_id, parent.id, parent.provider,
        parent.parent_external_session_id,
        ancestry.assignment_updated_at, ancestry.conversation_updated_at
      from project_ancestry ancestry
      join conversations parent on parent.provider = ancestry.provider
        and parent.external_session_id = ancestry.parent_external_session_id
        and parent.deleted_at is null
    )
    select ancestry.project_id, ancestry.id as conversation_id,
      max(ancestry.assignment_updated_at) as assignment_updated_at,
      max(greatest(ancestry.conversation_updated_at, ${conversations.updatedAt})) as conversation_updated_at
    from project_ancestry ancestry
    join conversations on ${conversations.id} = ancestry.id
    where ${mainConversationFilter()}
    group by ancestry.project_id, ancestry.id
  `;
}

export function projectConversationFilter(projectId: string) {
  return sql`${conversations.id} in (
    select membership.conversation_id
    from (${projectConversationMembershipQuery(projectId)}) membership
  )`;
}

/** A main conversation is unclassified only when its whole active tree is. */
export function unclassifiedConversationFilter() {
  return and(
    isNull(conversations.deletedAt),
    mainConversationFilter(),
    sql`not exists (
      select 1 from (${projectConversationMembershipQuery()}) membership
      where membership.conversation_id = ${conversations.id}
    )`,
  );
}
