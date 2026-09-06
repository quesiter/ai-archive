import { describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import { db } from "../src/db.js";
import { projects } from "../src/schema.js";
import {
  buildProjectListQuery,
  buildProjectListFilter,
  buildProjectTotalsQuery,
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
      'group by "conversation_projects"."project_id"',
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
});
