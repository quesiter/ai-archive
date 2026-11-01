import { desc, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import type { CaptureMessage } from "@ai-archive/contracts";
import { db } from "../db.js";
import { conversationRevisions, type ArchiveReviewSummary } from "../schema.js";
import { literalContainsPattern } from "./search-pattern.js";

type PageQuery = { messageLimit: number; messageOffset: number; messageOrdinal?: number | undefined };
type Entry = {
  ordinal: number; storedOrdinal: number | null; category?: string; observationKind?: string | null;
  physical: Record<string, unknown> | null; variant: CaptureMessage | null;
  segments: Array<Record<string, unknown>>;
};

/** Walk metadata only. Message bodies are read after the page has been selected. */
function storageChain(revisionId: string): SQL {
  return sql`storage_chain as (
    select id, conversation_id, base_revision_id, storage_kind, 0 as depth, array[id] as path
    from conversation_revisions where id = ${revisionId}
    union all
    select base.id, base.conversation_id, base.base_revision_id, base.storage_kind,
      child.depth + 1, child.path || base.id
    from storage_chain child join conversation_revisions base on base.id = child.base_revision_id
      and base.conversation_id = child.conversation_id
    where child.storage_kind = 'delta' and not base.id = any(child.path) and child.depth < 10000
  )`;
}

function hydrateEntry(entry: Entry, revisionId: string, projected: boolean) {
  const physical = entry.physical;
  const variant = entry.variant;
  const ordinal = projected ? Number(entry.ordinal) : Number(physical?.ordinal ?? variant?.ordinal ?? entry.ordinal);
  const id = String(physical?.id ?? `${revisionId}:review:${entry.ordinal}`);
  return {
    id, revisionId: String(physical?.revision_id ?? revisionId), ordinal,
    storedOrdinal: entry.storedOrdinal,
    externalMessageId: variant?.externalMessageId ?? physical?.external_message_id ?? null,
    role: variant?.role ?? physical?.role,
    model: variant?.model ?? physical?.model ?? null,
    sourceCreatedAt: variant?.createdAt ?? physical?.source_created_at ?? null,
    createdAt: physical?.created_at ?? null,
    segments: variant ? variant.segments.map((segment, index) => ({
      ...segment, id: `${id}:review:${index}`, messageId: id, ordinal: index,
      href: segment.href ?? null, language: segment.language ?? null,
    })) : entry.segments.map(segment => ({
      id: segment.id, messageId: segment.message_id, ordinal: segment.ordinal,
      type: segment.type, content: segment.content, href: segment.href,
      language: segment.language, createdAt: segment.created_at,
    })),
  };
}

function referencedEntries(revisionId: string, entries: SQL): SQL {
  return sql`with recursive ${storageChain(revisionId)}, page_entries as (${entries}),
    physical_messages as (
      select distinct on (message.ordinal) message.*
      from messages message join storage_chain chain on chain.id = message.revision_id
      where message.ordinal in (select stored_ordinal from page_entries where stored_ordinal is not null)
      order by message.ordinal, chain.depth
    )
    select entry.ordinal, entry.stored_ordinal as "storedOrdinal",
      entry.category, entry.observation_kind as "observationKind",
      to_jsonb(physical) as physical,
      case when entry.variant_index is not null
        then revision.merge_evidence -> 'variants' -> entry.variant_index else null end as variant,
      coalesce((select jsonb_agg(to_jsonb(segment) order by segment.ordinal)
        from message_segments segment where segment.message_id = physical.id), '[]'::jsonb) as segments
    from page_entries entry
    join conversation_revisions revision on revision.id = ${revisionId}
    left join physical_messages physical on physical.ordinal = entry.stored_ordinal
    order by entry.ordinal`;
}

export async function loadCurrentConversationPage(conversationId: string, query: PageQuery) {
  return db.transaction(async tx => {
    // Large historical evidence belongs to the separately paginated endpoint.
    const { searchText: _searchText, mergeEvidence: _mergeEvidence, archiveReview: _archiveReview, ...columns } = getTableColumns(conversationRevisions);
    const [revision] = await tx.select({
      ...columns,
      mergeEvidence: sql<Record<string, unknown>>`(${conversationRevisions.mergeEvidence} - 'variants' - 'sourceReview' - 'warnings') || '{"variants":[],"warnings":[]}'::jsonb`,
      archiveReview: sql<ArchiveReviewSummary | null>`(${conversationRevisions.archiveReview} - 'unresolvedWarnings') ||
        jsonb_build_object('unresolvedWarnings', '[]'::jsonb,
          'unresolvedWarningCount', jsonb_array_length(coalesce(${conversationRevisions.archiveReview} -> 'unresolvedWarnings', '[]'::jsonb)))`,
    }).from(conversationRevisions).where(eq(conversationRevisions.conversationId, conversationId))
      .orderBy(desc(conversationRevisions.isAccumulated), desc(sql`(${conversationRevisions.completeness} = 'complete')`),
        desc(conversationRevisions.capturedAt), desc(conversationRevisions.createdAt), desc(conversationRevisions.id)).limit(1);
    if (!revision) return null;
    const projected = revision.archiveReview !== null;
    const total = Number(revision.presentationMessageCount ?? revision.messageCount);
    let offset = query.messageOffset;
    if (query.messageOrdinal !== undefined) {
      let targetOrdinal = query.messageOrdinal;
      if (projected) {
        const [target] = await tx.execute<{ ordinal: number }>(sql`
          select ordinal from conversation_revision_presentation
          where revision_id = ${revision.id} and stored_ordinal = ${query.messageOrdinal}
          order by ordinal limit 1
        `);
        if (target) targetOrdinal = Number(target.ordinal);
      }
      offset = Math.floor(targetOrdinal / query.messageLimit) * query.messageLimit;
    }
    if (offset >= total && total > 0) offset = Math.floor((total - 1) / query.messageLimit) * query.messageLimit;
    const entries = projected ? sql`
      select ordinal, stored_ordinal, variant_index, null::text as category, null::text as observation_kind
      from conversation_revision_presentation where revision_id = ${revision.id}
      order by ordinal limit ${query.messageLimit} offset ${offset}
    ` : sql`
      select ordinal, ordinal as stored_ordinal, null::int as variant_index,
        null::text as category, null::text as observation_kind
      from generate_series(${offset}::int, ${Math.min(total, offset + query.messageLimit) - 1}::int) ordinal
    `;
    const rows = total ? await tx.execute<Entry>(referencedEntries(revision.id, entries)) : [];
    const messages = rows.filter(entry => entry.physical || entry.variant)
      .map(entry => hydrateEntry(entry, revision.id, true));
    return {
      revision, messages, ...(revision.archiveReview ? { archiveReview: revision.archiveReview } : {}),
      messagePagination: { total, limit: query.messageLimit, offset,
        hasMore: offset + messages.length < total },
    };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}

export async function loadConversationEvidencePage(conversationId: string, input: {
  limit: number; offset: number; messageOrdinal?: number | undefined; q?: string | undefined;
}) {
  return db.transaction(async tx => {
    const [revision] = await tx.select({ id: conversationRevisions.id })
      .from(conversationRevisions).where(eq(conversationRevisions.conversationId, conversationId))
      .orderBy(desc(conversationRevisions.isAccumulated), desc(sql`(${conversationRevisions.completeness} = 'complete')`),
        desc(conversationRevisions.capturedAt), desc(conversationRevisions.createdAt), desc(conversationRevisions.id)).limit(1);
    if (!revision) return { items: [], pagination: { total: 0, ...input, hasMore: false }, warnings: [] };
    const order = sql`case category when 'inactive' then 0 when 'resolved' then 1 else 2 end, ordinal`;
    const observationRows = sql`select *, (row_number() over (order by ${order}) - 1)::int as page_ordinal
      from conversation_revision_observations where revision_id = ${revision.id}`;
    const targetMatch = input.q ? sql`exists (
      select 1 from (select case when observation.variant_index is not null then (
        select string_agg(segment.value ->> 'content', E'\n' order by segment.ordinality)
        from jsonb_array_elements(coalesce(revision.merge_evidence -> 'variants' -> observation.variant_index -> 'segments', '[]'::jsonb))
          with ordinality segment(value, ordinality)
      ) else (
        select string_agg(segment.content, E'\n' order by segment.ordinal)
        from message_segments segment where segment.message_id = (
          select message.id from messages message join storage_chain chain on chain.id = message.revision_id
          where message.ordinal = observation.stored_ordinal order by chain.depth limit 1
        )
      ) end as content) actual_body
      where actual_body.content ilike ${literalContainsPattern(input.q)}
        or to_tsvector('simple', actual_body.content) @@ websearch_to_tsquery('simple', ${input.q})
    )` : sql`(observation.stored_ordinal = ${input.messageOrdinal ?? -1}
      or (revision.merge_evidence -> 'variants' -> observation.variant_index ->> 'ordinal')::int = ${input.messageOrdinal ?? -1})`;
    const [statistics] = await tx.execute<{ total: number; target: number | null }>(sql`
      with recursive ${storageChain(revision.id)}
      select count(*)::int as total,
        min(observation.page_ordinal) filter (where ${targetMatch}) as target
      from (${observationRows}) observation
      join conversation_revisions revision on revision.id = observation.revision_id
    `);
    const total = Number(statistics?.total ?? 0);
    const offset = (input.messageOrdinal !== undefined || input.q) && statistics?.target != null
      ? Math.floor(Number(statistics.target) / input.limit) * input.limit : input.offset;
    const entries = sql`select page_ordinal as ordinal, stored_ordinal, variant_index, category, observation_kind
      from (${observationRows}) observation order by page_ordinal limit ${input.limit} offset ${offset}`;
    const rows = total ? await tx.execute<Entry>(referencedEntries(revision.id, entries)) : [];
    const items = rows.filter(entry => entry.physical || entry.variant).map(entry => ({
      kind: entry.category === "inactive" ? "inactive" : entry.category === "resolved" ? "resolved" : "variant",
      message: hydrateEntry(entry, revision.id, false),
      ...(entry.observationKind ? { reviewKind: entry.observationKind } : {}),
    }));
    const [warningRow] = await tx.execute<{ warnings: unknown[]; warningCount: number }>(sql`
      select coalesce(jsonb_agg(value), '[]'::jsonb) as warnings,
        (select jsonb_array_length(coalesce(archive_review -> 'unresolvedWarnings', merge_evidence -> 'warnings', '[]'::jsonb))
          from conversation_revisions where id = ${revision.id})::int as "warningCount"
      from (select warning.value from conversation_revisions revision,
        lateral jsonb_array_elements(coalesce(revision.archive_review -> 'unresolvedWarnings', revision.merge_evidence -> 'warnings', '[]'::jsonb)) warning(value)
        where revision.id = ${revision.id} limit ${input.limit} offset ${offset}) warning_page
    `);
    return { items, pagination: { total, limit: input.limit, offset, hasMore: offset + items.length < total },
      warnings: warningRow?.warnings ?? [], warningCount: Number(warningRow?.warningCount ?? 0) };
  }, { isolationLevel: "repeatable read", accessMode: "read only" });
}
