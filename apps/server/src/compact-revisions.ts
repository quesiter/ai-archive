import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { closeDatabase, db } from "./db.js";
import { conversationRevisions, messages } from "./schema.js";

function integerArgument(name: string, fallback: number): number {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be followed by a positive integer`);
  }
  return value;
}

const execute = process.argv.includes("--execute");
const limit = integerArgument("--limit", execute ? 100 : 25);

type Candidate = Pick<
  typeof conversationRevisions.$inferSelect,
  "id" | "conversationId" | "baseRevisionId" | "baseMessageCount" | "messageCount"
>;

class RevisionNotCompactableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RevisionNotCompactableError";
  }
}

async function candidates(): Promise<Candidate[]> {
  return db
    .select({
      id: conversationRevisions.id,
      conversationId: conversationRevisions.conversationId,
      baseRevisionId: conversationRevisions.baseRevisionId,
      baseMessageCount: conversationRevisions.baseMessageCount,
      messageCount: conversationRevisions.messageCount,
    })
    .from(conversationRevisions)
    .where(
      and(
        eq(conversationRevisions.captureMode, "append"),
        eq(conversationRevisions.storageKind, "snapshot"),
        isNotNull(conversationRevisions.baseRevisionId),
        isNotNull(conversationRevisions.baseMessageCount),
      ),
    )
    // Newest/largest snapshots are compacted first so their direct base is
    // still a self-contained legacy snapshot during byte-for-byte validation.
    .orderBy(desc(conversationRevisions.baseMessageCount), desc(conversationRevisions.capturedAt))
    .limit(limit);
}

async function compactCandidate(candidate: Candidate): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`revision-compaction:${candidate.conversationId}`}, 0))`,
    );
    const [revision] = await tx
      .select()
      .from(conversationRevisions)
      .where(eq(conversationRevisions.id, candidate.id))
      .limit(1);
    if (!revision || revision.storageKind !== "snapshot") return 0;
    if (!revision.baseRevisionId || revision.baseMessageCount === null) {
      throw new RevisionNotCompactableError(
        `Revision ${revision.id} is missing its compaction base metadata`,
      );
    }
    const [base] = await tx
      .select()
      .from(conversationRevisions)
      .where(eq(conversationRevisions.id, revision.baseRevisionId))
      .limit(1);
    if (
      !base ||
      base.conversationId !== revision.conversationId ||
      base.storageKind !== "snapshot" ||
      base.messageCount !== revision.baseMessageCount
    ) {
      throw new RevisionNotCompactableError(
        `Revision ${revision.id} does not have a compactable snapshot base`,
      );
    }

    const validation = await tx.execute(sql`
      with target_messages as (
        select * from messages
        where revision_id = ${revision.id}
      ),
      base_messages as (
        select * from messages
        where revision_id = ${base.id}
      )
      select
        (select count(*) from target_messages) = ${revision.messageCount} and
        (select count(*) from base_messages) = ${base.messageCount} and
        (select count(*) from target_messages where ordinal < ${base.messageCount}) = ${base.messageCount} and
        not exists (
          select 1
          from target_messages target
          full join base_messages base using (ordinal)
          where target.ordinal < ${base.messageCount}
            and (
              target.id is null or base.id is null or
              row(
                target.external_message_id,
                target.role,
                target.model,
                target.source_created_at
              ) is distinct from row(
                base.external_message_id,
                base.role,
                base.model,
                base.source_created_at
              ) or
              exists (
                (select ordinal, type, content, href, language
                 from message_segments where message_id = target.id
                 except
                 select ordinal, type, content, href, language
                 from message_segments where message_id = base.id)
                union all
                (select ordinal, type, content, href, language
                 from message_segments where message_id = base.id
                 except
                 select ordinal, type, content, href, language
                 from message_segments where message_id = target.id)
              )
            )
        ) as valid
    `);
    const valid = Boolean((validation[0] as { valid?: boolean } | undefined)?.valid);
    if (!valid) {
      throw new RevisionNotCompactableError(
        `Revision ${revision.id} prefix differs from its declared base snapshot`,
      );
    }
    if (!execute) return base.messageCount;

    const deleted = await tx.execute(sql`
      with deleted as (
        delete from ${messages}
        where ${messages.revisionId} = ${revision.id}
          and ${messages.ordinal} < ${base.messageCount}
        returning 1
      )
      select count(*)::integer as count from deleted
    `);
    const deletedCount = Number((deleted[0] as { count?: number } | undefined)?.count ?? 0);
    if (deletedCount !== base.messageCount) {
      throw new Error(
        `Revision ${revision.id} deleted ${deletedCount} prefix rows; expected ${base.messageCount}`,
      );
    }
    await tx
      .update(conversationRevisions)
      .set({ storageKind: "delta" })
      .where(eq(conversationRevisions.id, revision.id));
    return deletedCount;
  });
}

let validated = 0;
let deletedMessages = 0;
let skipped = 0;
try {
  const rows = await candidates();
  for (const [index, candidate] of rows.entries()) {
    try {
      const compacted = await compactCandidate(candidate);
      validated += 1;
      deletedMessages += compacted;
      console.log(
        `${execute ? "compacted" : "validated"} ${index + 1}/${rows.length} revision=${candidate.id} prefixMessages=${compacted}`,
      );
    } catch (error) {
      if (!(error instanceof RevisionNotCompactableError)) throw error;
      skipped += 1;
      console.warn(
        `skipped ${index + 1}/${rows.length} revision=${candidate.id} reason=${error.message}`,
      );
    }
  }
  console.log(
    JSON.stringify({
      mode: execute ? "execute" : "dry-run",
      revisions: validated,
      skipped,
      prefixMessages: deletedMessages,
    }),
  );
} finally {
  await closeDatabase();
}
