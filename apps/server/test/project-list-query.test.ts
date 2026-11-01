import { describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import { db } from "../src/db.js";
import { projects } from "../src/schema.js";
import {
  buildProjectListQuery,
  buildProjectListFilter,
  buildProjectTotalsQuery,
  buildProjectTimelineConversationQuery,
} from "../src/routes/projects.js";

describe("project list statistics queries", () => {
  it("uses normalized name search for both pagination totals and list results", () => {
    const input = { q: "  Ａｒｃｈｉｖｅ　  E2E  ", archived: false };
    const list = buildProjectListQuery({ ...input, limit: 40, offset: 40 }).toSQL();
    const total = db.select({ total: count() }).from(projects)
      .where(buildProjectListFilter(input)).toSQL();
    for (const query of [list, total]) {
      expect(query.sql).toContain('"projects"."normalized_name" like');
      expect(query.params).toContain("%archive e2e%");
      expect(query.params).toContain(false);
    }
    expect(list.params.slice(-2)).toEqual([40, 40]);
  });

  it("treats percent, underscore and backslash as literal search text", () => {
    const query = buildProjectListQuery({ limit: 40, offset: 0, q: "100%_\\" }).toSQL();
    expect(query.params).toContain("%100\\%\\_\\\\%");
  });

  it("does not add a search predicate for blank queries", () => {
    const query = buildProjectListQuery({ limit: 40, offset: 0, q: "　 \t" }).toSQL();
    expect(query.sql).not.toContain(" like ");
  });

  it("joins project statistics through a fully qualified project id", () => {
    const query = buildProjectListQuery({ limit: 40, offset: 0 }).toSQL();

    expect(query.sql).toContain(
      '"project_conversation_stats"."project_id" = "projects"."id"',
    );
    expect(query.sql).toContain(
      'group by project_memberships.project_id',
    );
    expect(query.sql).toContain('coalesce("conversation_count", 0)::int');
    expect(query.sql).not.toContain('cp.project_id = "id"');
  });

  it("counts active projects from the same live-conversation statistics", () => {
    const query = buildProjectTotalsQuery().toSQL();

    expect(query.sql).toContain(
      'not "projects"."archived" and "project_conversation_stats"."project_id" is not null',
    );
    expect(query.sql).toContain(
      '"project_conversation_stats"."project_id" = "projects"."id"',
    );
    expect(query.sql).not.toContain('cp.project_id = "id"');
  });

  it("uses grouped main memberships and child activity for project counts and growth", () => {
    const query = buildProjectListQuery({ limit: 40, offset: 0 }).toSQL();
    expect(query.sql).toContain("group by ancestry.project_id, ancestry.id");
    expect(query.sql).toContain("project_memberships.conversation_updated_at >= now() - interval '7 days'");
    expect(query.sql).toContain("project_memberships.conversation_updated_at >= now() - interval '30 days'");
    expect(query.sql).toContain('max(greatest(ancestry.conversation_updated_at, "conversations"."updated_at"))');
  });

  it("paginates timeline in SQL and selects only one current revision per conversation", () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    const query = buildProjectTimelineConversationQuery(projectId, { limit: 30, offset: 60 }).toSQL();
    expect(query.params).toEqual([1, projectId, 30, 60]);
    expect(query.sql).toContain("select membership.conversation_id");
    expect(query.sql).toContain("assignment.project_id = $2");
    expect(query.sql).toContain("parent.deleted_at is null");
    expect(query.sql).toContain("inner join lateral");
    expect(query.sql).toContain('"conversation_revisions"."is_accumulated" desc');
    expect(query.sql).toContain('order by "current_revision"."captured_at" desc');
    expect(query.sql).toContain("limit $3 offset $4");
    expect(query.sql).not.toContain("select count(*)::int from conversations child");
  });
});
