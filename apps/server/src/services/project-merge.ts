import { and, eq, sql } from "drizzle-orm";
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

export async function mergeProjectIntoProject(input: {
  sourceProjectId: string;
  targetProjectId: string;
  targetProjectName?: string;
}): Promise<ProjectMergeResult | null> {
  if (input.sourceProjectId === input.targetProjectId) {
    throw new Error("Source and target projects must be different");
  }
  return db.transaction(async (tx) => {
    // Lock both project IDs in a stable order so overlapping merges cannot race.
    for (const projectId of [
      input.sourceProjectId,
      input.targetProjectId,
    ].sort()) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`project:${projectId}`}, 0))`,
      );
    }
    const [source] = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, input.sourceProjectId))
      .limit(1);
    const [target] = await tx
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, input.targetProjectId),
          eq(projects.archived, false),
        ),
      )
      .limit(1);
    if (!source || !target) return null;

    const sourceAssignments = await tx
      .select({ conversationId: conversationProjects.conversationId })
      .from(conversationProjects)
      .where(eq(conversationProjects.projectId, source.id));
    const sourceReports = await tx
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.projectId, source.id));
    await tx
      .update(conversationProjects)
      .set({ projectId: target.id, suggestedName: null, updatedAt: new Date() })
      .where(eq(conversationProjects.projectId, source.id));
    await tx
      .update(reports)
      .set({ projectId: target.id })
      .where(eq(reports.projectId, source.id));
    await tx.delete(projects).where(eq(projects.id, source.id));
    const normalized = normalizeProjectName(input.targetProjectName ?? target.name);
    if (!normalized.name) throw new Error("Project name cannot be empty");
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
      sourceProjectId: source.id,
      sourceProjectName: source.name,
      targetProjectId: target.id,
      targetProjectName: normalized.name,
      movedConversationCount: sourceAssignments.length,
      movedReportCount: sourceReports.length,
    };
  });
}
