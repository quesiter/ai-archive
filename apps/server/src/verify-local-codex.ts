import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import { db, closeDatabase } from "./db.js";
import { conversations, conversationRevisions } from "./schema.js";
import { contentIntegrityHash, snapshotHash, storedTokenUsage, normalizeCaptureMessagesForStorage, sanitizeCapturePayloadForStorage } from "./services/capture.js";
import { loadCaptureRevisionMessages } from "./services/revision-storage.js";
import { loadEnabledCustomRedactionRules } from "./services/redaction.js";
const key = (message: CaptureMessage) => JSON.stringify({ role: message.role, model: message.model ?? null,
  createdAt: message.createdAt ? new Date(message.createdAt).toISOString() : null,
  segments: message.segments.map(segment => ({ type: segment.type, content: segment.content,
    href: segment.href ?? null, language: segment.language ?? null })) });
async function main() {
  const directory = process.argv[2]!; const beforeFile = process.argv[3]!;
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as Array<{ sessionId: string; file: string }>;
  const bySession = new Map(manifest.map(entry => [entry.sessionId, entry]));
  const rules = await loadEnabledCustomRedactionRules(); let verified = 0; let preserved = 0;
  for await (const line of createInterface({ input: createReadStream(beforeFile).pipe(createGunzip()), crlfDelay: Infinity })) {
    const before = JSON.parse(line); const entry = bySession.get(before.sessionId);
    if (!entry) throw new Error("Missing source manifest");
    const original = JSON.parse(gunzipSync(await readFile(join(directory, entry.file))).toString());
    const source = sanitizeCapturePayloadForStorage(original.payload, rules) as CaptureSnapshotV1;
    source.messages = normalizeCaptureMessagesForStorage(source.messages);
    await db.transaction(async tx => {
      const [conversation] = await tx.select().from(conversations).where(and(eq(conversations.externalSessionId, entry.sessionId), eq(conversations.provider, source.provider))).limit(1);
      if (!conversation || conversation.provider !== source.provider) throw new Error("Wrong archive provider");
      const rows = await tx.select().from(conversationRevisions).where(eq(conversationRevisions.conversationId, conversation.id));
      if (rows.length !== 1) throw new Error("Unexpected revision count");
      const revision = rows[0]!; const messages = await loadCaptureRevisionMessages(revision.id, tx);
      if (revision.completeness !== "complete" || messages.length !== source.messages.length ||
          messages.some((message, index) => key(message) !== key(source.messages[index]!))) throw new Error("Active source mismatch: " + entry.sessionId);
      const available = new Map<string, number>();
      for (const message of [...messages, ...revision.mergeEvidence.variants]) available.set(key(message), (available.get(key(message)) ?? 0) + 1);
      for (const message of [...before.messages, ...before.revision.merge_evidence.variants]) {
        const identity = key(message); const count = available.get(identity) ?? 0;
        if (!count) throw new Error("Historical observation missing: " + entry.sessionId);
        available.set(identity, count - 1); preserved++;
      }
      const snapshot: CaptureSnapshotV1 = { schemaVersion: 1, provider: source.provider, sessionId: entry.sessionId,
        branchFingerprint: revision.branchFingerprint, adapterVersion: revision.adapterVersion,
        capturedAt: revision.capturedAt.toISOString(), captureMode: revision.captureMode,
        ...(revision.capturedTitle != null ? { title: revision.capturedTitle } : {}),
        ...(revision.capturedCanonicalUrl != null ? { canonicalUrl: revision.capturedCanonicalUrl } : {}),
        ...(revision.triggerReason ? { triggerReason: revision.triggerReason } : {}),
        ...(storedTokenUsage(revision) ? { tokenUsage: storedTokenUsage(revision)! } : {}),
        completeness: { status: revision.completeness, topReached: revision.topReached, bottomReached: revision.bottomReached, stable: revision.stable,
          ...(revision.completenessReason ? { reason: revision.completenessReason } : {}) }, messages };
      if (contentIntegrityHash(snapshot, revision.mergeEvidence) !== revision.contentIntegrityHash || snapshotHash(snapshot) !== revision.snapshotHash) {
        throw new Error("Stored hash mismatch: " + entry.sessionId);
      }
      const [missing] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from messages m
        where m.revision_id = ${revision.id} and not exists (select 1 from conversation_search_chunks s where s.message_id = m.id)`);
      if (missing?.count) throw new Error("Search chunks missing: " + entry.sessionId);
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    verified++;
    console.log(JSON.stringify({ sessionId: entry.sessionId, verified: true }));
  }
  if (verified !== manifest.length) throw new Error("Incomplete verification coverage");
  console.log(JSON.stringify({ verified, preservedHistoricalObservations: preserved, hashesValid: true, searchIndexValid: true }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Verification failed"); process.exitCode = 1; }).finally(() => closeDatabase());
