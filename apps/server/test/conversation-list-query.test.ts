import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { conversationSearchFilter, conversationTagsFilter, currentConversationRevisionFilter } from "../src/services/conversation-list-query.js";

describe("database-side conversation filters", () => {
  it("keeps English/operator queries on the established chunk GIN path", () => {
    const query = new PgDialect().sqlToQuery(conversationSearchFilter("100%_\\ needle"));
    expect(query.sql).toContain("with recursive direct_matches");
    expect(query.sql).toContain("source.title ilike");
    expect(query.sql).toContain("from conversation_search_chunks chunk");
    expect(query.sql).toContain("chunk.search_vector @@ websearch_to_tsquery");
    expect(query.sql).toContain('matching_tree.id = "conversations"."id"');
    expect(query.sql).toContain("parent.deleted_at is null");
    expect(query.params).toEqual(["%100\\%\\_\\\\ needle%", "%100\\%\\_\\\\ needle%", "100%_\\ needle"]);
  });

  it("matches Chinese short words by indexed term equality without chunk or simple FTS scans", () => {
    const q = new PgDialect().sqlToQuery(conversationSearchFilter("项目"));
    expect(q.sql).toContain("term_hit.term ="); expect(q.sql).not.toContain("strpos");
    expect(q.sql).not.toContain("conversation_search_documents");
    expect(q.sql).not.toContain("conversation_search_chunks"); expect(q.sql).not.toContain("websearch_to_tsquery");
  });

  it("intersects all phrase pairs before checking candidate revision chunks", () => {
    const q = new PgDialect().sqlToQuery(conversationSearchFilter("归档项目"));
    expect(q.params).toContainEqual(["归档", "档项", "项目"]);
    expect(q.sql).toContain("candidate_ids as materialized");
    expect(q.sql).toContain("having count(*) =");
    expect(q.sql).toContain("cross join lateral");
    expect(q.sql).toContain("chunk.revision_id = revision.id");
    expect(q.sql).toContain("chunk.content like");
    expect(q.sql).not.toContain("short_cjk_terms");
    expect(q.sql).toContain("conversation_search_chunks");
    expect(q.sql).toContain("revision.conversation_id = candidate.conversation_id");
    expect(q.sql).toContain("limit 1 offset 0");
    expect(q.sql).not.toContain("conversation_search_documents");
  });

  it("requires every tag on the same descendant and handles duplicate selectors", () => {
    const query = new PgDialect().sqlToQuery(conversationTagsFilter(["tag-a", "tag-b", "tag-a"]));
    expect(query.params).toEqual(["tag-a", "tag-b"]);
    expect(query.sql.match(/tag_link.conversation_id = source.id/g)).toHaveLength(2);
    expect(query.sql).toContain("union");
  });

  it("applies combined revision filters only after selecting the displayed current revision", () => {
    const query = new PgDialect().sqlToQuery(currentConversationRevisionFilter({
      completeness: "partial", captureMode: "append", sourceDevice: "name:Ｄｅｖｉｃｅ",
    })!);
    expect(query.params).toEqual(["partial", "append", "name:device"]);
    expect(query.sql).toContain("revision.is_accumulated desc");
    expect(query.sql).toContain("limit 1");
    expect(query.sql).not.toContain("row_number");
    expect(query.sql).toContain("current_revision.completeness");
  });
});
