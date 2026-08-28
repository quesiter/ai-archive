import { describe, expect, it } from "vitest";
import {
  buildProjectListQuery,
  buildProjectTotalsQuery,
} from "../src/routes/projects.js";

describe("project list statistics queries", () => {
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
