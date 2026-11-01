import { mkdir, readFile, writeFile } from "node:fs/promises";
import { eq, sql } from "drizzle-orm";
import type { CaptureSnapshotV1 } from "@ai-archive/contracts";
import { db, closeDatabase } from "../apps/server/src/db.js";
import { conversations, conversationRevisions, messages as messageRows } from "../apps/server/src/schema.js";
import { loadCaptureRevisionMessages } from "../apps/server/src/services/revision-storage.js";
import { writeAccumulatedRevision, storedTokenUsage } from "../apps/server/src/services/capture.js";
import { repairAnonymousDuplicates } from "../apps/server/src/services/anonymous-duplicate-repair.js";

const apply = process.argv.includes("--apply");
// Use only after the source UI confirms this conversation contains one user turn.
const verifiedSingleTurn = process.argv.includes("--verified-single-turn");
const fileIndex = process.argv.indexOf("--ids-file");
const ids: string[] = fileIndex >= 0
  ? JSON.parse(await readFile(process.argv[fileIndex + 1]!, "utf8"))
  : process.argv.slice(2).filter(value => value !== "--apply" && value !== "--verified-single-turn");
if (!ids.length || ids.some(id => !/^[0-9a-f-]{36}$/.test(id))) throw new Error("Supply explicit conversation UUIDs; --apply writes after backup");
if (verifiedSingleTurn && (ids.length !== 1 || fileIndex >= 0)) throw new Error("Source verification must target one explicit conversation");
try {
  for (const id of ids) await db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock_shared(847231955)`);
    const [conversation] = await tx.select().from(conversations).where(eq(conversations.id, id));
    if (!conversation) throw new Error("Conversation not found");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`conversation:${conversation.provider}:${conversation.externalSessionId}`}, 0))`);
    const revisions = await tx.select().from(conversationRevisions).where(eq(conversationRevisions.conversationId, id));
    if (revisions.length !== 1 || !revisions[0]!.isAccumulated) throw new Error("Expected one accumulated revision");
    const revision = revisions[0]!;
    const body = await loadCaptureRevisionMessages(revision.id, tx);
    let repaired = repairAnonymousDuplicates(body);
    if (verifiedSingleTurn) {
      const users = body.filter(message => message.role === "user");
      if (conversation.provider !== "chatgpt" || users.length !== 2 ||
        Boolean(users[0]!.externalMessageId) === Boolean(users[1]!.externalMessageId) ||
        JSON.stringify(users[0]!.segments) !== JSON.stringify(users[1]!.segments)) throw new Error("Verified source does not match a unique mixed-ID user pair");
      const anonymous = users.find(message => !message.externalMessageId)!;
      repaired = { messages: body.filter(message => message !== anonymous).map((message,ordinal) => ({ ...message,ordinal })), removed: [anonymous] };
    }
    console.log(JSON.stringify({ conversationId: id, before: body.length, after: repaired.messages.length, duplicates: repaired.removed.length, apply }));
    if (!apply || !repaired.removed.length) return;
    const metadata = await tx.select().from(messageRows).where(eq(messageRows.revisionId, revision.id));
    const backupRoot = "/data/restores/anonymous-duplicate-repair-20261007";
    await mkdir(backupRoot, { recursive: true, mode: 0o700 });
    await writeFile(`${backupRoot}/${id}-${Date.now()}.json`, JSON.stringify({ conversation, revision, messages: body, metadata }), { mode: 0o600, flag: "wx" });
    const snapshot: CaptureSnapshotV1 = {
      schemaVersion: 1, provider: conversation.provider as CaptureSnapshotV1["provider"], sessionId: conversation.externalSessionId,
      branchFingerprint: revision.branchFingerprint, adapterVersion: revision.adapterVersion,
      capturedAt: revision.capturedAt.toISOString(), captureMode: revision.captureMode,
      ...(revision.triggerReason ? { triggerReason: revision.triggerReason } : {}),
      ...(storedTokenUsage(revision) ? { tokenUsage: storedTokenUsage(revision) } : {}),
      ...(conversation.title ? { title: conversation.title } : {}), ...(conversation.canonicalUrl ? { canonicalUrl: conversation.canonicalUrl } : {}),
      completeness: { status: "partial", topReached: revision.topReached, bottomReached: revision.bottomReached, stable: revision.stable, reason: "已修复无 ID 重复观察；历史正文差异仍需核对" },
      messages: repaired.messages,
    };
    await writeAccumulatedRevision(tx, { conversationId: id, existing: revision, snapshot, deviceId: revision.sourceDeviceId,
      mergeEvidence: revision.mergeEvidence, replaceBody: true, messageMetadata: metadata });
  });
} finally { await closeDatabase(); }
