import { asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db.js";
import {
  conversationProjects,
  projects,
  reports,
} from "../schema.js";
import {
  isUniqueViolation,
  normalizeProjectName,
  projectConflictError,
} from "./projects.js";

export interface ProjectMergeResult {
  sourceProjectId: string;
  sourceProjectName: string;
  targetProjectId: string;
  targetProjectName: string;
  movedConversationCount: number;
  movedReportCount: number;
}

export interface ProjectsMergeResult {
  sourceProjectIds: string[];
  sourceProjectNames: string[];
  targetProjectId: string;
  targetProjectName: string;
  movedConversationCount: number;
  movedReportCount: number;
}

export async function mergeProjectIntoProject(input: {
  sourceProjectId: string;
  targetProjectId: string;
  targetProjectName?: string;
}): Promise<ProjectMergeResult | null> {
  const result = await mergeProjectsIntoProject({
    sourceProjectIds: [input.sourceProjectId],
    targetProjectId: input.targetProjectId,
    ...(input.targetProjectName !== undefined
      ? { targetProjectName: input.targetProjectName }
      : {}),
  });
  if (!result) return null;
  return {
    sourceProjectId: result.sourceProjectIds[0]!,
    sourceProjectName: result.sourceProjectNames[0]!,
    targetProjectId: result.targetProjectId,
    targetProjectName: result.targetProjectName,
    movedConversationCount: result.movedConversationCount,
    movedReportCount: result.movedReportCount,
  };
}

export async function mergeProjectsIntoProject(input: {
  sourceProjectIds: string[];
  targetProjectId: string;
  targetProjectName?: string;
}): Promise<ProjectsMergeResult | null> {
  const sourceProjectIds = [...new Set(input.sourceProjectIds.map((id) => id.toLowerCase()))];
  const targetProjectId = input.targetProjectId.toLowerCase();
  if (!sourceProjectIds.length || sourceProjectIds.includes(targetProjectId)) {
    throw Object.assign(new Error("Select at least one source project different from the target"), {
      statusCode: 400,
    });
  }
  return db.transaction(async (tx) => {
    // Lock every participating project in a stable order for overlapping merges.
    const projectIds = [...sourceProjectIds, targetProjectId].sort();
    for (const projectId of projectIds) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`project:${projectId}`}, 0))`,
      );
    }
    const projectRows = await tx
      .select()
      .from(projects)
      .where(inArray(projects.id, projectIds))
      .orderBy(asc(projects.id))
      .for("update");
    const projectsById = new Map(projectRows.map((project) => [project.id, project]));
    const target = projectsById.get(targetProjectId);
    if (projectRows.length !== projectIds.length || !target || target.archived) return null;
    const sourceProjectNames = sourceProjectIds.map(
      (id) => projectsById.get(id)!.name,
    );
    const normalized = normalizeProjectName(input.targetProjectName ?? target.name);
    if (!normalized.name || [...normalized.name].length > 200) {
      throw Object.assign(new Error("Project name must contain 1 to 200 characters after normalization"), {
        statusCode: 400,
      });
    }

    const movedAssignments = await tx
      .update(conversationProjects)
      .set({ projectId: target.id, suggestedName: null, updatedAt: new Date() })
      .where(inArray(conversationProjects.projectId, sourceProjectIds))
      .returning({ conversationId: conversationProjects.conversationId });
    const movedReports = await tx
      .update(reports)
      .set({ projectId: target.id })
      .where(inArray(reports.projectId, sourceProjectIds))
      .returning({ id: reports.id });
    // Delete sources before renaming so the surviving project can reuse a source name.
    await tx.delete(projects).where(inArray(projects.id, sourceProjectIds));
    try {
      await tx
        .update(projects)
        .set({
          name: normalized.name,
          normalizedName: normalized.normalizedName,
          updatedAt: new Date(),
        })
        .where(eq(projects.id, target.id));
    } catch (error) {
      if (isUniqueViolation(error)) throw projectConflictError();
      throw error;
    }

    return {
      sourceProjectIds,
      sourceProjectNames,
      targetProjectId: target.id,
      targetProjectName: normalized.name,
      movedConversationCount: movedAssignments.length,
      movedReportCount: movedReports.length,
    };
  });
}
