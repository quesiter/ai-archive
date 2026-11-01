import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  buildDashboardConversationCountQuery,
  buildDashboardUnclassifiedCountQuery,
  dashboardCategoryStats,
  dashboardProjectAssignmentsQuery,
} from "../src/routes/dashboard.js";

const old = new Date("2026-08-01T00:00:00Z");
const recent = new Date("2026-09-12T00:00:00Z");
const since7d = new Date("2026-09-06T00:00:00Z");
const project = (id: string) => ({ id, name: id, description: null, updatedAt: old });
const assignment = (projectId: string, conversationId = "main", at = old) => ({
  projectId, conversationId, assignmentUpdatedAt: old, conversationUpdatedAt: at,
});

describe("dashboard main conversation statistics", () => {
  it("uses the same visible main filter as the conversation list", () => {
    const query = buildDashboardConversationCountQuery().toSQL();
    expect(query.sql).toContain('"conversations"."deleted_at" is null');
    expect(query.sql).toContain('"conversations"."parent_external_session_id" is null');
    expect(query.sql).toContain("parent.deleted_at is null");
    expect(query.sql).toContain("select 1 from ancestry where cycle");
  });

  it("treats a parent with classified children as classified", () => {
    const query = buildDashboardUnclassifiedCountQuery().toSQL();
    expect(query.sql).toContain("not exists");
    expect(query.sql).toContain("project_conversation_rollups");

    expect(query.sql).toContain('r.conversation_id = "conversations"."id"');
  });

  it("uses project membership and descendant activity for dashboard project cards", () => {
    const query = new PgDialect().sqlToQuery(dashboardProjectAssignmentsQuery());
    expect(query.sql).toContain('membership.conversation_id as "conversationId"');
    expect(query.sql).toContain('membership.conversation_updated_at as "conversationUpdatedAt"');
    expect(query.sql).toContain("group by ancestry.project_id, ancestry.id");
    expect(query.sql).toContain("where not project.archived");
  });

  it("counts six members of the same main conversation once and preserves child activity", () => {
    const result = dashboardCategoryStats({
      projects: [project("Home Assistant"), project("Empty")],
      assignments: Array.from({ length: 6 }, (_, index) => assignment("Home Assistant", "main", index === 5 ? recent : old)),
      tags: [{ projectId: "Home Assistant", tagId: "a" }, { projectId: "Home Assistant", tagId: "a" }],
      since7d,
    });
    expect(result.categoryStats[0]).toMatchObject({
      projectId: "Home Assistant", conversationCount: 1, growth7d: 1,
      tagCount: 1, latestActivityAt: recent.toISOString(),
    });
    expect(result.categoryTotals).toEqual({
      activeCategoryCount: 1, emptyCategoryCount: 1,
      categorizedConversationCount: 1, growth7d: 1,
    });
  });

  it("counts a main conversation once globally when its children belong to different projects", () => {
    const result = dashboardCategoryStats({
      projects: [project("a"), project("b")],
      assignments: [assignment("a", "main", recent), assignment("b", "main", recent), assignment("b", "second")],
      tags: [], since7d,
    });
    expect(result.categoryStats.map((row) => [row.projectId, row.conversationCount, row.growth7d]))
      .toEqual([["b", 2, 1], ["a", 1, 1]]);
    expect(result.categoryTotals).toMatchObject({ categorizedConversationCount: 2, growth7d: 1 });
  });

  it("does not count assignments for archived/missing projects or unknown activity", () => {
    const result = dashboardCategoryStats({
      projects: [project("active")],
      assignments: [assignment("archived", "main", recent), {
        projectId: "active", conversationId: "orphan", assignmentUpdatedAt: null, conversationUpdatedAt: null,
      }],
      tags: [], since7d,
    });
    expect(result.categoryTotals).toMatchObject({ categorizedConversationCount: 1, growth7d: 0 });
    expect(result.categoryStats[0]).toMatchObject({ conversationCount: 1, latestActivityAt: old.toISOString() });
  });

  it("handles postgres-js raw timestamp strings and offsets with the same category statistics as Date values", () => {
    const expected = dashboardCategoryStats({
      projects: [project("a")], assignments: [assignment("a", "main", recent)], tags: [], since7d,
    });
    const actual = dashboardCategoryStats({
      projects: [{ ...project("a"), updatedAt: "2026-08-01 08:00:00+08" }],
      assignments: [{ projectId: "a", conversationId: "main", assignmentUpdatedAt: "2026-08-01 00:00:00+00",
        conversationUpdatedAt: "2026-09-12 08:00:00+08" }],
      tags: [], since7d,
    });
    expect(actual).toEqual(expected);
  });

  it("keeps counts while ignoring null or invalid activity and falls back to a valid timestamp", () => {
    const result = dashboardCategoryStats({
      projects: [{ ...project("a"), updatedAt: new Date("invalid") }, { ...project("b"), updatedAt: "invalid" }],
      assignments: [
        { projectId: "a", conversationId: "valid", assignmentUpdatedAt: "invalid", conversationUpdatedAt: recent.toISOString() },
        { projectId: "b", conversationId: "unknown", assignmentUpdatedAt: new Date("invalid"), conversationUpdatedAt: null },
      ], tags: [], since7d,
    });
    expect(result.categoryStats).toMatchObject([
      { projectId: "a", conversationCount: 1, growth7d: 1, latestActivityAt: recent.toISOString() },
      { projectId: "b", conversationCount: 1, growth7d: 0, latestActivityAt: null },
    ]);
    expect(result.categoryTotals).toMatchObject({ categorizedConversationCount: 2, growth7d: 1 });
  });
});
