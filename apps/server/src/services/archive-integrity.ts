import { asc } from "drizzle-orm";
import { db, sqlClient } from "../db.js";
import {
  conversationRevisions,
  conversations,
} from "../schema.js";
import { contentIntegrityHash } from "./capture.js";
import {
  completeBackgroundTask,
  failBackgroundTask,
  startBackgroundTask,
  updateBackgroundTask,
} from "./background-tasks.js";
import {
  loadCaptureRevisionMessages,
  loadCaptureRevisionMessagesBatch,
} from "./revision-storage.js";
import { safeStoredError } from "./operation-log.js";

const CHECK_BATCH_SIZE = 100;
const MAX_ERROR_SAMPLES = 50;

export interface ArchiveIntegrityResult {
  ok: boolean;
  checkedAt: string;
  conversations: number;
  revisions: number;
  messages: number;
  segments: number;
  searchChunks: number;
  brokenDeltaChains: number;
  hashMismatches: number;
  unverifiableHashes: number;
  reconstructionFailures: number;
  orphanRows: number;
  missingSearchChunks: number;
  errors: string[];
}

export async function checkArchiveIntegrity(
  onProgress?: (processed: number, total: number) => Promise<void>,
): Promise<ArchiveIntegrityResult> {
  const [conversationRows, revisionRows, [counts], [relational]] = await Promise.all([
    db.select({ id: conversations.id, provider: conversations.provider, externalSessionId: conversations.externalSessionId }).from(conversations),
    db.select().from(conversationRevisions).orderBy(asc(conversationRevisions.createdAt)),
    sqlClient<{
      messages: number;
      segments: number;
      chunks: number;
    }[]>`
      select
        (select count(*)::int from messages) as messages,
        (select count(*)::int from message_segments) as segments,
        (select count(*)::int from conversation_search_chunks) as chunks
    `,
    sqlClient<{
      orphan_rows: number;
      missing_search_chunks: number;
    }[]>`
      select
        (
          (select count(*) from conversation_revisions r left join conversations c on c.id = r.conversation_id where c.id is null) +
          (select count(*) from messages m left join conversation_revisions r on r.id = m.revision_id where r.id is null) +
          (select count(*) from message_segments s left join messages m on m.id = s.message_id where m.id is null) +
          (select count(*) from conversation_projects cp left join conversations c on c.id = cp.conversation_id left join projects p on p.id = cp.project_id where c.id is null or (cp.project_id is not null and p.id is null)) +
          (select count(*) from conversation_tags ct left join conversations c on c.id = ct.conversation_id left join tags t on t.id = ct.tag_id where c.id is null or t.id is null)
        )::int as orphan_rows,
        (
          select count(*)::int
          from messages m
          where exists (select 1 from message_segments s where s.message_id = m.id and length(trim(s.content)) > 0)
            and not exists (select 1 from conversation_search_chunks chunk where chunk.message_id = m.id)
        ) as missing_search_chunks
    `,
  ]);
  const conversationById = new Map(conversationRows.map((row) => [row.id, row]));
  const revisionById = new Map(revisionRows.map((row) => [row.id, row]));
  const errors: string[] = [];
  let brokenDeltaChains = 0;
  let hashMismatches = 0;
  let unverifiableHashes = 0;
  let reconstructionFailures = 0;

  for (let offset = 0; offset < revisionRows.length; offset += CHECK_BATCH_SIZE) {
    const batch = revisionRows.slice(offset, offset + CHECK_BATCH_SIZE);
    const batchMessages = await loadCaptureRevisionMessagesBatch(
      batch.map((revision) => revision.id),
    ).catch(() => null);
    for (const revision of batch) {
      const conversation = conversationById.get(revision.conversationId);
      if (!conversation) continue;
      if (revision.storageKind === "delta") {
        const base = revision.baseRevisionId ? revisionById.get(revision.baseRevisionId) : null;
        if (!base || base.conversationId !== revision.conversationId) {
          brokenDeltaChains += 1;
          if (errors.length < MAX_ERROR_SAMPLES) errors.push(`Revision ${revision.id} has an invalid delta base`);
          continue;
        }
      }
      if (!revision.contentIntegrityHash) {
        unverifiableHashes += 1;
      }
      try {
        const hydrated = batchMessages?.get(revision.id) ??
          await loadCaptureRevisionMessages(revision.id);
        const calculated = revision.contentIntegrityHash ? contentIntegrityHash({
          schemaVersion: 1,
          provider: conversation.provider,
          sessionId: conversation.externalSessionId,
          branchFingerprint: revision.branchFingerprint,
          adapterVersion: revision.adapterVersion,
          capturedAt: revision.capturedAt.toISOString(),
          captureMode: revision.captureMode,
          ...(revision.triggerReason ? { triggerReason: revision.triggerReason } : {}),
          ...(revision.baseRevisionId ? { baseRevisionId: revision.baseRevisionId } : {}),
          ...(revision.baseMessageCount !== null
            ? { baseMessageCount: revision.baseMessageCount }
            : {}),
          ...(revision.capturedTitle !== null ? { title: revision.capturedTitle } : {}),
          ...(revision.capturedCanonicalUrl !== null
            ? { canonicalUrl: revision.capturedCanonicalUrl }
            : {}),
          completeness: {
            status: revision.completeness,
            topReached: revision.topReached,
            bottomReached: revision.bottomReached,
            stable: revision.stable,
            ...(revision.completenessReason ? { reason: revision.completenessReason } : {}),
          },
          messages: hydrated,
        }) : null;
        if (calculated !== null && calculated !== revision.contentIntegrityHash) {
          hashMismatches += 1;
          if (errors.length < MAX_ERROR_SAMPLES) errors.push(`Revision ${revision.id} snapshot hash mismatch`);
        }
      } catch (error) {
        reconstructionFailures += 1;
        if (errors.length < MAX_ERROR_SAMPLES) {
          errors.push(`Revision ${revision.id}: ${safeStoredError(error)}`);
        }
      }
    }
    await onProgress?.(Math.min(offset + batch.length, revisionRows.length), revisionRows.length);
  }
  const orphanRows = Number(relational?.orphan_rows ?? 0);
  const missingSearchChunks = Number(relational?.missing_search_chunks ?? 0);
  const ok = brokenDeltaChains + hashMismatches + reconstructionFailures + orphanRows + missingSearchChunks === 0;
  return {
    ok,
    checkedAt: new Date().toISOString(),
    conversations: conversationRows.length,
    revisions: revisionRows.length,
    messages: Number(counts?.messages ?? 0),
    segments: Number(counts?.segments ?? 0),
    searchChunks: Number(counts?.chunks ?? 0),
    brokenDeltaChains,
    hashMismatches,
    unverifiableHashes,
    reconstructionFailures,
    orphanRows,
    missingSearchChunks,
    errors,
  };
}

export async function runArchiveIntegrityTask(taskId: string): Promise<ArchiveIntegrityResult> {
  await startBackgroundTask(taskId, 0, "正在验证 Revision 链、哈希、消息序号和引用完整性");
  try {
    const result = await checkArchiveIntegrity(async (processed, total) => {
      await updateBackgroundTask(taskId, {
        status: "running",
        totalCount: total,
        processedCount: processed,
        message: `归档完整性检查 ${processed}/${total}`,
      }, { log: false, allowedStatuses: ["running"] });
    });
    await completeBackgroundTask(taskId, {
      totalCount: result.revisions,
      processedCount: result.revisions,
      succeededCount: result.ok ? result.revisions : Math.max(0, result.revisions - result.reconstructionFailures - result.hashMismatches),
      failedCount: result.ok ? 0 : result.reconstructionFailures + result.hashMismatches + result.brokenDeltaChains,
      message: result.ok ? "归档完整性检查通过" : "归档完整性检查发现异常",
      stats: result as unknown as Record<string, unknown>,
    });
    return result;
  } catch (error) {
    await failBackgroundTask(taskId, safeStoredError(error));
    throw error;
  }
}
