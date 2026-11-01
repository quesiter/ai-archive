import { and, sql, type SQL } from "drizzle-orm";
import { conversations } from "../schema.js";
import { literalContainsPattern } from "./search-pattern.js";
import { cjkQueryTerms, isShortCjkQuery, usesFullTextSearch } from "./search-documents.js";
import { sourceDeviceQueryKey } from "./source-devices.js";

/** Expand matches to active ancestors inside PostgreSQL; never transfer hit IDs. */
export function matchingConversationTree(predicate: SQL): SQL {
  return sql`exists (
    select 1 from (with recursive matched as (
      select source.id, source.provider, source.parent_external_session_id
      from conversations source where source.deleted_at is null and ${predicate}
      union
      select parent.id, parent.provider, parent.parent_external_session_id
      from matched join conversations parent on parent.provider = matched.provider
        and parent.external_session_id = matched.parent_external_session_id
        and parent.deleted_at is null
    ) select id from matched) matching_tree
    where matching_tree.id = ${conversations.id}
  )`;
}

export function searchChunkPredicate(query: string, alias: SQL): SQL {
  if (!usesFullTextSearch(query)) return sql`strpos(${alias}.content, ${query}) > 0`;
  const literal = sql`${alias}.content ilike ${literalContainsPattern(query)}`;
  return usesFullTextSearch(query) ? sql`(${literal} or ${alias}.search_vector @@ websearch_to_tsquery('simple', ${query}))` : literal;
}

/** Long CJK phrases have useful trigrams. Let the existing index combine
 * with the revision restriction; short words must keep the bounded scan. */
function matchingRevisionChunks(query: string, revisionId: SQL): SQL {
  if (!usesFullTextSearch(query) && !isShortCjkQuery(query)) return sql`
    select chunk.message_id, chunk.content from conversation_search_chunks chunk
    where chunk.revision_id = ${revisionId} and chunk.content like ${literalContainsPattern(query)}
    limit 1 offset 0`;
  return sql`select chunk.message_id, chunk.content from (
    select * from conversation_search_chunks where revision_id = ${revisionId} offset 0
  ) chunk where ${searchChunkPredicate(query, sql`chunk`)} limit 1 offset 0`;
}

function indexedCjkMatches(query: string): SQL {
  if (isShortCjkQuery(query)) return sql`select term_hit.conversation_id as id
    from conversation_search_terms term_hit where term_hit.term = ${query}`;
  const terms = cjkQueryTerms(query);
  return sql`with candidate_ids as materialized (
    select term_hit.conversation_id from conversation_search_terms term_hit
    where term_hit.term = any(${sql.param(terms)}::text[])
    group by term_hit.conversation_id having count(*) = ${terms.length}
  ) select candidate.conversation_id as id from candidate_ids candidate
    cross join lateral (
      select 1 from conversation_revisions revision cross join lateral (
        ${matchingRevisionChunks(query, sql`revision.id`)}
      ) hit where revision.conversation_id = candidate.conversation_id limit 1 offset 0
    ) verified`;
}

export function conversationSearchFilter(query: string): SQL {
  // English/operator queries keep the established chunk GIN path. Chinese
  // queries seed this same ancestor expansion from indexed exact term hits.
  const bodyMatches = usesFullTextSearch(query) ? sql`
    select revision.conversation_id as id from conversation_search_chunks chunk
    join conversation_revisions revision on revision.id = chunk.revision_id
    where ${searchChunkPredicate(query, sql`chunk`)}` : sql`select id from (${indexedCjkMatches(query)}) indexed_hit`;
  return sql`exists (
    select 1 from (with recursive direct_matches as (
      select source.id from conversations source where source.deleted_at is null
        and source.title ilike ${literalContainsPattern(query)}
      union
      ${bodyMatches}
    ), matched as (
      select source.id, source.provider, source.parent_external_session_id
      from direct_matches hit join conversations source on source.id = hit.id where source.deleted_at is null
      union
      select parent.id, parent.provider, parent.parent_external_session_id
      from matched join conversations parent on parent.provider = matched.provider
        and parent.external_session_id = matched.parent_external_session_id and parent.deleted_at is null
    ) select id from matched) matching_tree where matching_tree.id = ${conversations.id}
  )`;
}

/** Count and paginate the same materialized hit set in one snapshot/scan. */
export function conversationSearchPageQuery(filters: readonly (SQL | undefined)[], limit: number, offset: number): SQL {
  return sql`with filtered as materialized (
    select conversations.* from conversations where ${and(...filters)}
  ), page as (
    select c.id, c.provider, c.external_session_id as "externalSessionId", c.title,
      c.canonical_url as "canonicalUrl", c.updated_at as "updatedAt",
      assignment.project_id as "projectId", project.name as "projectName",
      assignment.locked_by_user as "projectLocked", assignment.confidence as "projectConfidence",
      assignment.suggested_name as "suggestedProjectName"
    from filtered c left join conversation_projects assignment on assignment.conversation_id = c.id
    left join projects project on project.id = assignment.project_id
    order by c.updated_at desc, c.id desc limit ${limit} offset ${offset}
  ) select (select count(*)::int from filtered) as total,
    coalesce((select jsonb_agg(to_jsonb(page) order by "updatedAt" desc, id desc) from page), '[]'::jsonb) as rows`;
}

export function conversationPageSnippetsQuery(revisionIds: readonly string[], query: string): SQL {
  return sql`select target.conversation_id as "conversationId", target.id as "revisionId", hit.ordinal, hit.content
    from conversation_revisions target cross join lateral (
      select message.ordinal, matching_chunk.content from (
        ${matchingRevisionChunks(query, sql`target.id`)}
      ) matching_chunk join messages message on message.id = matching_chunk.message_id
    ) hit where target.id = any(${sql.param([...revisionIds])}::uuid[])`;
}

export function conversationTagsFilter(tagIds: readonly string[]): SQL {
  return matchingConversationTree(sql.join([...new Set(tagIds)].map(tagId => sql`exists (
    select 1 from conversation_tags tag_link
    where tag_link.conversation_id = source.id and tag_link.tag_id = ${tagId}
  )`), sql` and `));
}

/** Test the same current row the page displays, using its conversation index. */
export function currentConversationRevisionFilter(input: {
  completeness?: string | undefined;
  sourceDevice?: string | undefined;
  captureMode?: string | undefined;
  source?: string | undefined;
}): SQL | undefined {
  const filters: SQL[] = [];
  if (input.completeness) filters.push(sql`current_revision.completeness = ${input.completeness}`);
  if (input.captureMode) filters.push(sql`current_revision.capture_mode = ${input.captureMode}`);
  if (input.source === "historical_import") filters.push(sql`current_revision.capture_mode = 'import'`);
  if (input.sourceDevice) filters.push(sql`current_revision.source_device_key = ${sourceDeviceQueryKey(input.sourceDevice)}`);
  if (!filters.length) return undefined;
  return sql`exists (
    select 1 from lateral (
      select revision.completeness, revision.capture_mode,
        case when device.name is not null then
          'name:' || lower(btrim(regexp_replace(normalize(device.name, NFKC), '[[:space:]]+', ' ', 'g')))
          when revision.trigger_reason = 'historical_import' or revision.adapter_version = 'chat-memo-text-v1'
            then 'historical_import' else 'unrecorded' end as source_device_key
      from conversation_revisions revision
      left join devices device on device.id = revision.source_device_id
      where revision.conversation_id = ${conversations.id}
      order by revision.is_accumulated desc, (revision.completeness = 'complete') desc,
        revision.captured_at desc, revision.created_at desc, revision.id desc limit 1
    ) current_revision where ${sql.join(filters, sql` and `)}
  )`;
}
