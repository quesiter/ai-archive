import { db } from "../db.js";
import { conversationSearchDocuments } from "../schema.js";
import { eq, sql } from "drizzle-orm";

export function isShortCjkQuery(query: string): boolean {
  return /^[\p{Script=Han}]{1,2}$/u.test(query);
}

export function extractCjkTerms(content: string): string[] {
  const terms = new Set<string>();
  for (const match of content.matchAll(/[\p{Script=Han}]+/gu)) {
    const characters = Array.from(match[0]);
    for (let i = 0; i < characters.length; i++) {
      terms.add(characters[i]!);
      if (i + 1 < characters.length) terms.add(characters[i]! + characters[i + 1]!);
    }
  }
  return [...terms];
}

/** All overlapping pairs are necessary, but not sufficient, for a phrase. */
export function cjkQueryTerms(query: string): string[] {
  const characters = Array.from(query);
  return characters.length < 2 ? characters : [...new Set(characters.slice(1).map((next, index) => characters[index]! + next))];
}

type SearchDocumentTransaction = Pick<typeof db, "insert" | "update" | "execute">;

async function synchronizeTerms(tx: SearchDocumentTransaction, conversationId: string, terms: readonly string[], appendOnly: boolean) {
  if (appendOnly) {
    if (terms.length) await tx.execute(sql`insert into conversation_search_terms(term, conversation_id)
      select unnest(${sql.param(terms)}::text[]), ${conversationId}::uuid on conflict do nothing`);
    return;
  }
  await tx.execute(sql`with incoming as materialized (
    select unnest(${sql.param(terms)}::text[]) as term
  ), removed as (
    delete from conversation_search_terms old where old.conversation_id = ${conversationId}
      and not exists (select 1 from incoming where incoming.term = old.term)
  ) insert into conversation_search_terms(term, conversation_id)
    select incoming.term, ${conversationId}::uuid from incoming where not exists (
      select 1 from conversation_search_terms old where old.term = incoming.term and old.conversation_id = ${conversationId}
    ) on conflict do nothing`);
}

/** Read real chunks in bounded, indexed batches; never concatenate a chat. */
async function termsFromStoredChunks(tx: SearchDocumentTransaction, conversationId: string): Promise<string[]> {
  const terms = new Set<string>();
  const revisions = await tx.execute<{ id: string }>(sql`select id from conversation_revisions where conversation_id = ${conversationId}`);
  for (const revision of revisions) {
    let cursor: string | undefined;
    while (true) {
      const rows = await tx.execute<{id: string; content: string}>(sql`select id, content from conversation_search_chunks
        where revision_id = ${revision.id} ${cursor ? sql`and id > ${cursor}::uuid` : sql``}
        order by id limit 256`);
      for (const row of rows) for (const term of extractCjkTerms(row.content)) terms.add(term);
      if (rows.length < 256) break;
      cursor = rows.at(-1)!.id;
    }
  }
  return [...terms];
}

export async function storeConversationSearchTerms(tx: SearchDocumentTransaction, conversationId: string,
  incoming: Iterable<string>, appendOnly = false) {
  // This small row is also the lock for recovery/backfill. A missing/incomplete
  // index cannot be treated as an append baseline: rebuild it from real chunks.
  const [previous] = await tx.insert(conversationSearchDocuments).values({conversationId, termsReady: false})
    .onConflictDoUpdate({ target: conversationSearchDocuments.conversationId, set: {conversationId} })
    .returning({termsReady: conversationSearchDocuments.termsReady});
  const terms = appendOnly && !previous?.termsReady ? await termsFromStoredChunks(tx, conversationId) : [...new Set(incoming)];
  await synchronizeTerms(tx, conversationId, terms, appendOnly && Boolean(previous?.termsReady));
  await tx.update(conversationSearchDocuments).set({termsReady: true})
    .where(eq(conversationSearchDocuments.conversationId, conversationId));
}

/** Restore/redaction use the authoritative chunks, not a duplicate full text. */
export async function rebuildConversationSearchDocuments(tx: SearchDocumentTransaction) {
  await tx.execute(sql`delete from conversation_search_documents`);
  await tx.execute(sql`insert into conversation_search_documents(conversation_id)
    select distinct conversation_id from conversation_revisions`);
  await backfillSearchDocumentTerms(tx);
}

export async function backfillSearchDocumentTerms(tx?: SearchDocumentTransaction) {
  const next = async (connection: SearchDocumentTransaction) => {
    const [row] = await connection.execute<{ conversation_id: string }>(sql`
      select conversation_id from conversation_search_documents where not terms_ready limit 1 for update`);
    if (!row) return false;
    await synchronizeTerms(connection, row.conversation_id, await termsFromStoredChunks(connection, row.conversation_id), false);
    await connection.update(conversationSearchDocuments).set({termsReady: true})
      .where(eq(conversationSearchDocuments.conversationId, row.conversation_id));
    return true;
  };
  while (await (tx ? next(tx) : db.transaction(next))) { /* one locked conversation per transaction */ }
}

export function usesFullTextSearch(query: string): boolean {
  return !/^[\p{Script=Han}]+$/u.test(query);
}
