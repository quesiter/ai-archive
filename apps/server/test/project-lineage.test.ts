import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  projectConversationFilter,
  projectConversationMembershipQuery,
  unclassifiedConversationFilter,
} from "../src/services/project-lineage.js";

const dialect = new PgDialect();

describe("project conversation lineage queries", () => {
  it("promotes assigned descendants only through active parents of the same provider", () => {
    const query = dialect.sqlToQuery(projectConversationMembershipQuery());
    expect(query.params).toEqual([]);
    expect(query.sql).toContain("assignment.project_id is not null and source.deleted_at is null");
    expect(query.sql).toContain("parent.provider = ancestry.provider");
    expect(query.sql).toContain("parent.deleted_at is null");
    expect(query.sql.split("select ancestry.project_id, ancestry.id")[0]).not.toContain("union all");
    expect(query.sql).toContain("select 1 from ancestry where cycle");
  });

  it("keeps one project/main membership while preserving descendant activity", () => {
    const query = dialect.sqlToQuery(projectConversationMembershipQuery());
    expect(query.sql).toContain("group by ancestry.project_id, ancestry.id");
    expect(query.sql).toContain("max(ancestry.assignment_updated_at) as assignment_updated_at");
    expect(query.sql).toContain('max(greatest(ancestry.conversation_updated_at, "conversations"."updated_at"))');
  });

  it("restricts project seeds using a parameter and selects representative conversation ids", () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const query = dialect.sqlToQuery(projectConversationFilter(projectId));
    expect(query.params).toEqual([projectId]);
    expect(query.sql).toContain("assignment.project_id = $1");
    expect(query.sql).toContain('"conversations"."id" in');
    expect(query.sql).toContain("select membership.conversation_id");
  });

  it("treats a main as unclassified only if none of its active tree has a project", () => {
    const query = dialect.sqlToQuery(unclassifiedConversationFilter()!);
    expect(query.sql).toContain('"conversations"."deleted_at" is null');
    expect(query.sql).toContain("not exists");
    expect(query.sql).toContain('membership.conversation_id = "conversations"."id"');
    expect(query.sql).toContain("assignment.project_id is not null and source.deleted_at is null");
  });
});
