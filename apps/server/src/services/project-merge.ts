import { and, eq, sql } from "drizzle-orm";
import type { SourceReference } from "@ai-archive/contracts";
import { db } from "../db.js";
import {
  conversationProjects,
  knowledgeItems,
  projects,
  reports,
} from "../schema.js";

export interface ProjectMergeResult {
  sourceProjectId: string;
  sourceProjectName: string;
  targetProjectId: string;
  targetProjectName: string;
  movedConversationCount: number;
  movedKnowledgeCount: number;
  mergedKnowledgeCount: number;
  movedReportCount: number;
}

export function mergeSourceReferences(
  left: SourceReference[],
  right: SourceReference[],
): SourceReference[] {
  const references = new Map<string, SourceReference>();
  for (const reference of [...left, ...right]) {
    references.set(
      `${reference.conversationId}:${reference.revisionId}:${reference.messageOrdinal}`,
      reference,
    );
  }
  return [...references.values()];
}

export async function mergeProjectIntoProject(input: {
  sourceProjectId: string;
  targetProjectId: string;
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
    const sourceKnowledge = await tx
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.projectId, source.id));
    const targetKnowledge = await tx
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.projectId, target.id));
    const sourceReports = await tx
      .select({ id: reports.id })
      .from(reports)
      .where(eq(reports.projectId, source.id));
    const targetByFingerprint = new Map(
      targetKnowledge.map((item) => [item.fingerprint, item]),
    );
    let mergedKnowledgeCount = 0;
    for (const sourceItem of sourceKnowledge) {
      const targetItem = targetByFingerprint.get(sourceItem.fingerprint);
      if (!targetItem) continue;
      const mergedReferences = mergeSourceReferences(
        targetItem.sourceReferences,
        sourceItem.sourceReferences,
      );
      await tx
        .update(knowledgeItems)
        .set({
          confidence: Math.max(targetItem.confidence, sourceItem.confidence),
          sourceReferences: mergedReferences,
          supersedesId:
            targetItem.supersedesId === sourceItem.id
              ? null
              : targetItem.supersedesId,
          updatedAt: new Date(),
        })
        .where(eq(knowledgeItems.id, targetItem.id));
      await tx
        .update(knowledgeItems)
        .set({
          supersedesId:
            targetItem.supersedesId === sourceItem.id ? null : targetItem.id,
        })
        .where(eq(knowledgeItems.supersedesId, sourceItem.id));
      await tx.delete(knowledgeItems).where(eq(knowledgeItems.id, sourceItem.id));
      mergedKnowledgeCount += 1;
    }

    await tx
      .update(conversationProjects)
      .set({ projectId: target.id, updatedAt: new Date() })
      .where(eq(conversationProjects.projectId, source.id));
    await tx
      .update(knowledgeItems)
      .set({ projectId: target.id, updatedAt: new Date() })
      .where(eq(knowledgeItems.projectId, source.id));
    await tx
      .update(reports)
      .set({ projectId: target.id })
      .where(eq(reports.projectId, source.id));
    await tx
      .update(projects)
      .set({ updatedAt: new Date() })
      .where(eq(projects.id, target.id));
    await tx.delete(projects).where(eq(projects.id, source.id));

    return {
      sourceProjectId: source.id,
      sourceProjectName: source.name,
      targetProjectId: target.id,
      targetProjectName: target.name,
      movedConversationCount: sourceAssignments.length,
      movedKnowledgeCount: sourceKnowledge.length - mergedKnowledgeCount,
      mergedKnowledgeCount,
      movedReportCount: sourceReports.length,
    };
  });
}
