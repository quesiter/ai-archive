import { randomUUID } from "node:crypto";
import { getTableColumns, getTableName, SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { vi } from "vitest";
import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import { captureRuns, conversationRevisions, conversations, messages, messageSegments, conversationSearchChunks, devices,
  conversationSearchDocuments, conversationRevisionPresentation, conversationRevisionObservations } from "../src/schema.js";
import { contentIntegrityHash, revisionIdentityHash, snapshotHash } from "../src/services/capture.js";

// Transactional in-memory fixture for the real ingest/merge code. Query filters
// are taken from Drizzle's generated SQL so assertions inspect resulting rows,
// rather than depending on the sequence of internal SELECT calls.
export function captureStore(mocks: { transaction: ReturnType<typeof vi.fn>; loadBatch: ReturnType<typeof vi.fn>; loadMessages: ReturnType<typeof vi.fn> }) {
  const tables = [conversations, conversationRevisions, messages, messageSegments, conversationSearchChunks, captureRuns, devices,
    conversationSearchDocuments, conversationRevisionPresentation, conversationRevisionObservations];
  let data = new Map<string, any[]>(tables.map((table) => [getTableName(table), []]));
  const rows = (table: any) => data.get(getTableName(table))!;
  const dialect = new PgDialect();
  const predicate = (table: any, condition?: SQL) => {
    if (!condition) return (_row: any) => true;
    const query = dialect.sqlToQuery(condition);
    const fields = new Map(Object.entries(getTableColumns(table)).map(([field, column]: [string, any]) => [column.name, field]));
    const tests: Array<(row: any) => boolean> = [];
    for (const match of query.sql.matchAll(/"[^"]+"\."([^"]+)"\s*(=|<>)\s*\$(\d+)/g)) {
      const field = fields.get(match[1]!); const value = query.params[Number(match[3]) - 1];
      tests.push((row) => match[2] === "=" ? row[field!] === value : row[field!] !== value);
    }
    for (const match of query.sql.matchAll(/"[^"]+"\."([^"]+)" in \(([^)]+)\)/g)) {
      const values = [...match[2]!.matchAll(/\$(\d+)/g)].map((item) => query.params[Number(item[1]) - 1]);
      tests.push((row) => values.includes(row[fields.get(match[1]!)!]));
    }
    return (row: any) => tests.every((test) => test(row));
  };
  const evaluate = (value: any, previous: any) => {
    if (!(value instanceof SQL)) return value;
    const query = dialect.sqlToQuery(value);
    if (query.sql.includes("greatest")) return new Date(Math.max(new Date(previous).getTime(), new Date(query.params[0] as string).getTime()));
    return previous;
  };
  const defaults = (table: any, value: any) => ({
    id: randomUUID(), createdAt: new Date(),
    ...(table === conversations ? { deletedAt: null, title: null, canonicalUrl: null, parentExternalSessionId: null, updatedAt: new Date() } : {}),
    ...(table === conversationRevisions ? { capturedTitle: null, capturedCanonicalUrl: null, completenessReason: null,
      sourceDeviceId: null, storageKind: "snapshot", isAccumulated: false, mergeEvidence: { variants: [], warnings: [] },
      baseRevisionId: null, baseMessageCount: null, metadataCaptured: true, triggerReason: null,
      reportedInputTokens: null, reportedCachedInputTokens: null, reportedCacheWriteInputTokens: null,
      reportedOutputTokens: null, reportedReasoningOutputTokens: null, reportedTotalTokens: null,
      archivedTextUnits: 0, reasoningTextUnits: 0, toolTextUnits: 0 } : {}),
    ...(table === messages ? { externalMessageId: null, model: null, sourceCreatedAt: null } : {}),
    ...(table === messageSegments ? { href: null, language: null } : {}),
    ...value,
  });
  const deleteRows = (table: any, condition?: SQL) => {
    const selected = rows(table).filter(predicate(table, condition));
    const ids = new Set(selected.map((row) => row.id));
    data.set(getTableName(table), rows(table).filter((row) => !ids.has(row.id)));
    if (table === conversationRevisions) {
      const messageIds = new Set(rows(messages).filter((row) => ids.has(row.revisionId)).map((row) => row.id));
      data.set(getTableName(messages), rows(messages).filter((row) => !messageIds.has(row.id)));
      data.set(getTableName(messageSegments), rows(messageSegments).filter((row) => !messageIds.has(row.messageId)));
      data.set(getTableName(conversationSearchChunks), rows(conversationSearchChunks).filter((row) => !ids.has(row.revisionId)));
    }
    if (table === messages) {
      data.set(getTableName(messageSegments), rows(messageSegments).filter((row) => !ids.has(row.messageId)));
      data.set(getTableName(conversationSearchChunks), rows(conversationSearchChunks).filter((row) => !ids.has(row.messageId)));
    }
    return selected;
  };
  const tx = {
    execute: vi.fn(async () => []),
    select: vi.fn(() => {
      let table: any; let condition: SQL | undefined; let limit = Infinity; let ordered = false;
      const execute = () => {
        const selected = rows(table).filter(predicate(table, condition));
        if (ordered && table === conversationRevisions) selected.sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime());
        return selected.slice(0, limit);
      };
      const query: any = { from: (value: any) => { table = value; return query; },
        where: (value: SQL) => { condition = value; return query; },
        orderBy: () => { ordered = true; return query; }, limit: (value: number) => { limit = value; return query; },
        then: (resolve: any, reject: any) => Promise.resolve().then(execute).then(resolve, reject) };
      return query;
    }),
    insert: vi.fn((table: any) => ({ values: (input: any) => {
      let result: any[] | undefined; let upsert = false; let ignore = false; let updateSet: any;
      const execute = () => result ??= (Array.isArray(input) ? input : [input]).flatMap((value) => {
        if (table === conversationSearchDocuments && upsert) {
          const old = rows(table).find(row => row.conversationId === value.conversationId);
          if (old) { Object.assign(old, updateSet ?? value); return [old]; }
        }
        if (table === conversations && upsert) {
          const old = rows(table).find((row) => row.provider === value.provider && row.externalSessionId === value.externalSessionId);
          if (old) { Object.assign(old, { title: value.title ?? old.title, canonicalUrl: value.canonicalUrl ?? old.canonicalUrl,
            updatedAt: new Date(Math.max(old.updatedAt.getTime(), value.updatedAt.getTime())), deletedAt: null }); return [old]; }
        }
        if (ignore && table === captureRuns && value.idempotencyKey && rows(table).some((row) => row.deviceId === value.deviceId && row.idempotencyKey === value.idempotencyKey)) return [];
        const row = defaults(table, value);
        if (rows(table).some((old) => old.id === row.id)) throw new Error("Duplicate durable row ID");
        if (table === conversationRevisions && row.isAccumulated && rows(table).some((old) => old.isAccumulated && old.conversationId === row.conversationId)) throw new Error("Duplicate canonical revision");
        rows(table).push(row); return [row];
      });
      const query: any = { returning: () => Promise.resolve().then(execute), onConflictDoUpdate: (options: any) => { upsert = true; updateSet = options?.set; return query; },
        onConflictDoNothing: () => { ignore = true; return query; }, then: (resolve: any, reject: any) => Promise.resolve().then(execute).then(resolve, reject) };
      return query;
    } })),
    update: vi.fn((table: any) => ({ set: (values: any) => ({ where: (condition: SQL) => {
      let result: any[] | undefined;
      const execute = () => result ??= rows(table).filter(predicate(table, condition)).map((row) => {
        for (const [key, value] of Object.entries(values)) row[key] = evaluate(value, row[key]);
        return row;
      });
      return { returning: () => Promise.resolve().then(execute), then: (resolve: any, reject: any) => Promise.resolve().then(execute).then(resolve, reject) };
    } }) })),
    delete: vi.fn((table: any) => ({ where: (condition: SQL) => Promise.resolve().then(() => deleteRows(table, condition)) })),
  };
  const hydrate = (revisionId: string): CaptureMessage[] => {
    const row = rows(conversationRevisions).find((revision) => revision.id === revisionId);
    if (!row) throw new Error("Revision missing");
    const body = new Map<number, CaptureMessage>((row.storageKind === "delta" ? hydrate(row.baseRevisionId) : []).map((message) => [message.ordinal, message]));
    for (const message of rows(messages).filter((message) => message.revisionId === revisionId)) body.set(message.ordinal, {
      ordinal: message.ordinal, role: message.role,
      ...(message.externalMessageId ? { externalMessageId: message.externalMessageId } : {}),
      ...(message.model ? { model: message.model } : {}),
      ...(message.sourceCreatedAt ? { createdAt: message.sourceCreatedAt.toISOString() } : {}),
      segments: rows(messageSegments).filter((segment) => segment.messageId === message.id).sort((a, b) => a.ordinal - b.ordinal).map((segment) => ({
        type: segment.type, content: segment.content, ...(segment.href ? { href: segment.href } : {}), ...(segment.language ? { language: segment.language } : {}),
      })),
    });
    const result = [...body.values()].sort((a, b) => a.ordinal - b.ordinal);
    if (result.length !== row.messageCount) throw new Error("Broken storage chain");
    return result;
  };
  mocks.loadMessages.mockImplementation(async (id: string) => hydrate(id));
  mocks.loadBatch.mockImplementation(async (ids: string[]) => new Map(ids.map((id) => [id, hydrate(id)])));
  mocks.transaction.mockImplementation(async (callback: (tx: unknown) => unknown) => {
    const before = structuredClone(data);
    try { return await callback(tx); } catch (error) { data = before; throw error; }
  });
  const seedSnapshot = (snapshot: CaptureSnapshotV1, extra: Record<string, any> = {}) => {
    let conversation = rows(conversations).find((row) => row.provider === snapshot.provider && row.externalSessionId === snapshot.sessionId);
    if (!conversation) { conversation = defaults(conversations, { provider: snapshot.provider, externalSessionId: snapshot.sessionId, title: snapshot.title ?? null }); rows(conversations).push(conversation); }
    const revision = defaults(conversationRevisions, { conversationId: conversation.id, branchFingerprint: snapshot.branchFingerprint,
      snapshotHash: snapshotHash(snapshot), revisionIdentityHash: revisionIdentityHash(snapshot),
      contentIntegrityHash: contentIntegrityHash(snapshot, extra.isAccumulated ? extra.mergeEvidence ?? { variants: [], warnings: [] } : undefined),
      completeness: snapshot.completeness.status, topReached: snapshot.completeness.topReached,
      bottomReached: snapshot.completeness.bottomReached, stable: snapshot.completeness.stable,
      completenessReason: snapshot.completeness.reason ?? null, captureMode: snapshot.captureMode,
      capturedTitle: snapshot.title ?? null, capturedCanonicalUrl: snapshot.canonicalUrl ?? null,
      adapterVersion: snapshot.adapterVersion, capturedAt: new Date(snapshot.capturedAt),
      createdAt: new Date(snapshot.capturedAt), messageCount: snapshot.messages.length, ...extra });
    rows(conversationRevisions).push(revision);
    for (const message of snapshot.messages.filter((message) => revision.storageKind !== "delta" || message.ordinal >= revision.baseMessageCount)) {
      const stored = defaults(messages, { revisionId: revision.id, ordinal: message.ordinal, externalMessageId: message.externalMessageId ?? null,
        role: message.role, model: message.model ?? null, sourceCreatedAt: message.createdAt ? new Date(message.createdAt) : null, createdAt: new Date(snapshot.capturedAt) });
      rows(messages).push(stored);
      message.segments.forEach((segment, ordinal) => rows(messageSegments).push(defaults(messageSegments, { messageId: stored.id, ordinal, ...segment })));
    }
    return revision;
  };
  return { rows, tx, seedSnapshot, hydrate };
}
