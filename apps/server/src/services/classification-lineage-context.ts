import { sql } from "drizzle-orm";
import { stripInternalConversationMetadata } from "@ai-archive/contracts";
import { db } from "../db.js";

const MAX_ANCESTRY_DEPTH = 32;
const MAX_USER_REQUEST_CHARS = 600;
const MAX_ASSISTANT_CHARS = 500;
const INTERNAL_BLOCK_PATTERN = "<(environment_context|recommended_plugins|app-context|skills_instructions|permissions instructions|collaboration_mode|multi_agent_mode|apps_instructions|plugins_instructions|INSTRUCTIONS|external_codex_apps_open_page|in-app-browser-context)([[:space:]][^>]*)?>.*?</\\1[[:space:]]*>";
const ATTACHMENT_HEADER_PATTERN = "^[[:space:]]*# Files mentioned by the user:.*?## My request:[[:space:]]*";
const IMAGE_BLOCK_PATTERN = "<image([[:space:]][^>]*)?>.*?</image[[:space:]]*>";

type QueryExecutor = Pick<typeof db, "execute">;

export type ClassificationLineageProject = {
  id: string;
  name: string;
  description: string;
  lockedByUser: boolean;
};

export type ClassificationLineageConversation = {
  conversationId: string;
  title: string;
  assignmentLockedByUser: boolean;
  project: ClassificationLineageProject | null;
  userRequests: string[];
  latestAssistantExcerpt: string | null;
};

export type ClassificationLineageContext = {
  evidenceOnly: true;
  parent: ClassificationLineageConversation;
  /** Null when the parent is itself the root, or the earlier parent is missing. */
  root: ClassificationLineageConversation | null;
  rootIsParent: boolean;
  rootResolution: "complete" | "orphan";
  candidateProjectIds: string[];
};

type AncestorRow = {
  conversationId: string;
  provider: string;
  externalSessionId: string;
  parentExternalSessionId: string | null;
  title: string | null;
  depth: number;
  cycle: boolean;
  hasActiveParent: boolean;
  projectId: string | null;
  projectName: string | null;
  projectDescription: string | null;
  lockedByUser: boolean | null;
};

type ExcerptRow = {
  conversationId: string;
  userRequests: string[] | null;
  latestAssistantExcerpt: string | null;
};

/** Read only active ancestors of this record, never descendants or project peers. */
export function classificationLineageAncestryQuery(conversationId: string) {
  return sql`
    with recursive ancestry as (
      select source.id, source.provider, source.external_session_id,
        source.parent_external_session_id, source.title,
        0 as depth, array[source.id]::uuid[] as path, false as cycle
      from conversations source
      where source.id = ${conversationId} and source.deleted_at is null
      union all
      select parent.id, parent.provider, parent.external_session_id,
        parent.parent_external_session_id, parent.title,
        ancestry.depth + 1, ancestry.path || parent.id,
        parent.id = any(ancestry.path)
      from ancestry
      join conversations parent on parent.provider = ancestry.provider
        and parent.external_session_id = ancestry.parent_external_session_id
        and parent.deleted_at is null
      where not ancestry.cycle and ancestry.depth < ${MAX_ANCESTRY_DEPTH}
    )
    select ancestry.id as "conversationId", ancestry.provider,
      ancestry.external_session_id as "externalSessionId",
      ancestry.parent_external_session_id as "parentExternalSessionId",
      left(ancestry.title, 160) as title, ancestry.depth, ancestry.cycle,
      exists (
        select 1 from conversations parent
        where parent.provider = ancestry.provider
          and parent.external_session_id = ancestry.parent_external_session_id
          and parent.deleted_at is null
      ) as "hasActiveParent",
      project.id as "projectId", left(project.name, 160) as "projectName",
      left(project.description, 300) as "projectDescription",
      assignment.locked_by_user as "lockedByUser"
    from ancestry
    left join conversation_projects assignment on assignment.conversation_id = ancestry.id
    left join projects project on project.id = assignment.project_id and not project.archived
    order by ancestry.depth
  `;
}

/** Bound the rows and text read from long root histories before sending context. */
export function classificationLineageExcerptQuery(conversationIds: readonly string[]) {
  const cleanedSegment = sql`regexp_replace(regexp_replace(regexp_replace(segment.content,
    ${INTERNAL_BLOCK_PATTERN}, '', 'gis'), ${ATTACHMENT_HEADER_PATTERN}, '', 'is'),
    ${IMAGE_BLOCK_PATTERN}, '[图片]', 'gis')`;
  return sql`
    select conversation.id as "conversationId",
      requests.bodies as "userRequests", assistant.body as "latestAssistantExcerpt"
    from conversations conversation
    left join lateral (
      select revision.id from conversation_revisions revision
      where revision.conversation_id = conversation.id
      order by revision.is_accumulated desc,
        (revision.completeness = 'complete') desc,
        revision.captured_at desc, revision.created_at desc
      limit 1
    ) revision on true
    left join lateral (
      with picked as (
        (select message.id, message.ordinal from messages message
          where message.revision_id = revision.id and message.role = 'user'
          order by message.ordinal limit 6)
        union
        (select message.id, message.ordinal from messages message
          where message.revision_id = revision.id and message.role = 'user'
          order by message.ordinal desc limit 2)
      ), bodies as (
        select picked.ordinal,
          left(string_agg(${cleanedSegment}, E'\n' order by segment.ordinal),
            ${MAX_USER_REQUEST_CHARS}) as body
        from picked join message_segments segment on segment.message_id = picked.id
          and segment.type = 'text'
        group by picked.id, picked.ordinal
      )
      select array_agg(bodies.body order by bodies.ordinal) as bodies from bodies
    ) requests on true
    left join lateral (
      select left(string_agg(${cleanedSegment}, E'\n' order by segment.ordinal),
        ${MAX_ASSISTANT_CHARS}) as body
      from message_segments segment
      where segment.type = 'text' and segment.message_id = (
        select message.id from messages message
        where message.revision_id = revision.id and message.role = 'assistant'
        order by message.ordinal desc limit 1
      )
    ) assistant on true
    where conversation.deleted_at is null
      and ${conversationIds.length
        ? sql`conversation.id in (${sql.join(conversationIds.map((id) => sql`${id}`), sql`, `)})`
        : sql`false`}
  `;
}

function cleanExcerpt(value: string | null | undefined, limit: number): string {
  return stripInternalConversationMetadata(value ?? "")
    .replace(/<INSTRUCTIONS(?:\s[^>]*)?>[\s\S]*?<\/INSTRUCTIONS\s*>/gi, "")
    .replace(/<external_codex_apps_open_page>[\s\S]*?<\/external_codex_apps_open_page>/gi, "")
    .replace(/<in-app-browser-context(?:\s[^>]*)?>[\s\S]*?<\/in-app-browser-context>/gi, "")
    .replace(/^# AGENTS\.md instructions for [^\n]+\n?/gim, "")
    .replace(/^\s*# Files mentioned by the user:[\s\S]*?## My request:\s*/i, "")
    .replace(/<image(?:\s[^>]*)?>[\s\S]*?<\/image\s*>/gi, "[图片]")
    .trim().slice(0, limit);
}

function compactRequests(values: readonly string[] | null): string[] {
  const requests = [...new Set((values ?? [])
    .map((value) => cleanExcerpt(value, MAX_USER_REQUEST_CHARS)).filter(Boolean))];
  return requests.length <= 3 ? requests : [...requests.slice(0, 2), requests[requests.length - 1]!];
}

/**
 * Parent assignments are evidence, not an inheritance rule. The caller must
 * redact these archived excerpts before any cloud use and keep independent
 * delegated work eligible for its own project.
 */
export async function loadClassificationLineageContext(
  conversationId: string,
  executor: QueryExecutor = db,
): Promise<ClassificationLineageContext | null> {
  const rows = [...await executor.execute<AncestorRow>(classificationLineageAncestryQuery(conversationId))]
    .sort((left, right) => left.depth - right.depth);
  const child = rows[0];
  const parent = rows[1];
  if (!child || child.conversationId !== conversationId || !child.parentExternalSessionId || !parent) return null;
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    const previous = rows[index - 1];
    if (row.cycle || row.depth !== index || seen.has(row.conversationId) ||
        (previous && (row.provider !== previous.provider || row.externalSessionId !== previous.parentExternalSessionId))) {
      return null;
    }
    seen.add(row.conversationId);
  }
  const last = rows[rows.length - 1]!;
  if (last.hasActiveParent) return null; // Bounded traversal did not resolve a root.
  const complete = last.parentExternalSessionId === null;
  const rootIsParent = complete && last.conversationId === parent.conversationId;
  const root = complete && !rootIsParent ? last : null;
  const evidenceRows = root ? [parent, root] : [parent];
  const excerpts = await executor.execute<ExcerptRow>(classificationLineageExcerptQuery(
    evidenceRows.map((row) => row.conversationId),
  ));
  const byId = new Map(excerpts.map((row) => [row.conversationId, row]));
  const material = (row: AncestorRow): ClassificationLineageConversation => {
    const excerpt = byId.get(row.conversationId);
    return {
      conversationId: row.conversationId,
      title: cleanExcerpt(row.title, 160),
      assignmentLockedByUser: row.lockedByUser === true,
      project: row.projectId && row.projectName ? {
        id: row.projectId,
        name: cleanExcerpt(row.projectName, 160),
        description: cleanExcerpt(row.projectDescription, 300),
        lockedByUser: row.lockedByUser === true,
      } : null,
      userRequests: compactRequests(excerpt?.userRequests ?? null),
      latestAssistantExcerpt: cleanExcerpt(excerpt?.latestAssistantExcerpt, MAX_ASSISTANT_CHARS) || null,
    };
  };
  return {
    evidenceOnly: true,
    parent: material(parent),
    root: root ? material(root) : null,
    rootIsParent,
    rootResolution: complete ? "complete" : "orphan",
    candidateProjectIds: [...new Set(evidenceRows.flatMap((row) => row.projectId && row.projectName ? [row.projectId] : []))],
  };
}
