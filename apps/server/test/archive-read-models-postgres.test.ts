import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CaptureMessage, CaptureSnapshotV1 } from "@ai-archive/contracts";
import * as schema from "../src/schema.js";

const state = vi.hoisted(() => ({ database: undefined as any }));
vi.mock("../src/db.js", () => ({ db: new Proxy({}, { get: (_target, key) => {
  const value = state.database[key];
  return typeof value === "function" ? value.bind(state.database) : value;
} }) }));
vi.mock("../src/http.js", async original => ({ ...await original<typeof import("../src/http.js")>(),
  requireWebUser: async () => true }));

import { ingestCapture, writeAccumulatedRevision } from "../src/services/capture.js";
import { backfillArchiveReadModels, buildArchiveReadModel } from "../src/services/archive-read-models.js";
import { sourceReviewBodyHash } from "../src/services/source-review.js";
import { dashboardOrganizationQuery, dashboardTextStatsQuery } from "../src/routes/dashboard.js";
import { conversationRoutes } from "../src/routes/conversations.js";
import { projectRoutes } from "../src/routes/projects.js";

const executedQueries: Array<{query: string; params: unknown[]}> = [];
const pg = new PGlite({ extensions: { pg_trgm, pgcrypto } });
// Production uses postgres-js, whose execute() returns rows directly. Reuse the
// real Drizzle query builders and PostgreSQL executor with that return shape.
function adaptDatabase(database: any): any {
  return new Proxy(database, { get: (target, key) => {
    if (key === "execute") return async (statement: unknown) => (await target.execute(statement)).rows;
    if (key === "transaction") return (fn: (tx: any) => unknown, config: unknown) => target.transaction((tx: any) => fn(adaptDatabase(tx)), config);
    const value = target[key];
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function snapshot(sessionId = randomUUID(), length = 120): CaptureSnapshotV1 {
  return { schemaVersion: 1, provider: "chatgpt", sessionId, branchFingerprint: "main-branch", title: `Read model ${sessionId}`,
    canonicalUrl: `https://chatgpt.com/c/${sessionId}`, adapterVersion: "test-v1", captureMode: "full",
    capturedAt: "2026-11-01T00:00:00Z", completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
    messages: Array.from({ length }, (_, ordinal) => ({ ordinal, externalMessageId: `message-${ordinal}`,
      role: ordinal % 2 ? "assistant" : "user", segments: [{ type: "text", content: `Body ${ordinal} 中文😀` }] })) };
}

beforeAll(async () => {
  const journal = JSON.parse(await readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"));
  for (const entry of journal.entries) {
    await pg.exec(await readFile(new URL(`../migrations/${entry.tag}.sql`, import.meta.url), "utf8"));
  }
  state.database = adaptDatabase(drizzle(pg, { schema, logger: {logQuery(query, params) {executedQueries.push({query, params});}} }));
}, 30_000);
afterAll(async () => { await pg.close(); });

describe("archive read models on PostgreSQL", () => {
  it("updates summary atomically, keeps search_text empty, and pages actual message rows", async () => {
    const source = snapshot();
    const receipt = await ingestCapture(source, null);
    const db = state.database;
    const [summary] = await db.select().from(schema.conversationSummaries).where(eq(schema.conversationSummaries.conversationId, receipt.conversationId));
    expect(summary.messageCount).toBe(120);
    expect(summary.archivedTextUnits).toBe(source.messages.reduce((sum, message) => sum + Array.from(message.segments[0]!.content).length, 0));
    const [revision] = await db.select().from(schema.conversationRevisions).where(eq(schema.conversationRevisions.id, receipt.revisionId));
    expect(revision).toMatchObject({ searchText: "", presentationMessageCount: 120, storedMessageCount: 120, sourceContentPending: false });
    const app = Fastify();
    await conversationRoutes(app);
    const page = await app.inject(`/api/v1/conversations/${receipt.conversationId}?messageLimit=10&messageOffset=50`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().messages).toHaveLength(10);
    expect(page.json().messages[0].ordinal).toBe(50);
    expect(page.json().messagePagination).toMatchObject({ total: 120, limit: 10, offset: 50, hasMore: true });
    const hit = await app.inject(`/api/v1/conversations/${receipt.conversationId}?messageLimit=10&messageOrdinal=83`);
    expect(hit.statusCode, hit.body).toBe(200);
    expect(hit.json().messages.some((message: any) => message.ordinal === 83)).toBe(true);
    await app.close();
    await db.update(schema.conversations).set({ deletedAt: new Date() }).where(eq(schema.conversations.id, receipt.conversationId));
    const [totals] = await db.execute(dashboardTextStatsQuery());
    expect(Number(totals.latest_revision_count)).toBe(0);
    await db.delete(schema.conversations).where(eq(schema.conversations.id, receipt.conversationId));
    expect(await db.select().from(schema.conversationSummaries)).toHaveLength(0);
  });

  it("persists reviewed order and exact variant references without duplicating body text", async () => {
    const source = snapshot(randomUUID(), 5);
    const receipt = await ingestCapture(source, null);
    const db = state.database;
    const [revision] = await db.select().from(schema.conversationRevisions).where(eq(schema.conversationRevisions.id, receipt.revisionId));
    const replacement = { ...source.messages[2]!, segments: [{ type: "text" as const, content: "Reviewed replacement" }] };
    const selected = [replacement, source.messages[0]!, source.messages[3]!, source.messages[4]!];
    const reference = (message: CaptureMessage) => ({ messageId: message.externalMessageId!, bodyHash: sourceReviewBodyHash(message) });
    const evidence: schema.MergeEvidence = { variants: [replacement], warnings: [], sourceReview: {
      version: 1, source: "chatgpt_source_ui", contentComplete: false, captureComplete: false,
      sessionId: source.sessionId, verifiedAt: "2026-11-01T01:00:00Z", sourceUrl: source.canonicalUrl!,
      currentMessageIds: selected.map(message => message.externalMessageId!),
      inactiveMessages: [{ messageId: "message-1", replacedByMessageId: "message-2" }],
      selectedBodies: selected.map(reference), reviewedBodies: [source.messages[1]!, source.messages[2]!].map(message => ({ ...reference(message), kind: "source_text" })),
    } };
    await db.transaction((tx: any) => writeAccumulatedRevision(tx, { conversationId: receipt.conversationId,
      snapshot: source, existing: revision, mergeEvidence: evidence, deviceId: null, replaceBody: true }));
    const refs = await db.select().from(schema.conversationRevisionPresentation).where(eq(schema.conversationRevisionPresentation.revisionId, receipt.revisionId));
    expect(refs).toHaveLength(4);
    expect(refs.find((row: any) => row.ordinal === 0)).toMatchObject({ storedOrdinal: 2, variantIndex: 0 });
    const [updated] = await db.select().from(schema.conversationRevisions).where(eq(schema.conversationRevisions.id, receipt.revisionId));
    expect(updated).toMatchObject({ presentationMessageCount: 4, storedMessageCount: 5, sourceContentPending: true });
    expect(updated.archiveReview).not.toHaveProperty("inactiveMessages");
    const app = Fastify();
    await conversationRoutes(app);
    const page = await app.inject(`/api/v1/conversations/${receipt.conversationId}?messageLimit=2`);
    expect(page.statusCode, page.body).toBe(200);
    expect(page.json().messages.map((message: any) => message.segments[0].content)).toEqual([replacement.segments[0]!.content, source.messages[0]!.segments[0]!.content]);
    const history = await app.inject(`/api/v1/conversations/${receipt.conversationId}/evidence?limit=1`);
    expect(history.statusCode, history.body).toBe(200);
    expect(history.json().items).toHaveLength(1);
    const selectedVariant = await app.inject(`/api/v1/conversations/${receipt.conversationId}?messageLimit=1&messageOrdinal=2`);
    expect(selectedVariant.statusCode, selectedVariant.body).toBe(200);
    expect(selectedVariant.json().messagePagination.offset).toBe(0);
    expect(selectedVariant.json().messages[0]).toMatchObject({ ordinal: 0, storedOrdinal: 2,
      externalMessageId: "message-2", segments: [{ content: "Reviewed replacement" }] });
    const originalBody = await app.inject(`/api/v1/conversations/${receipt.conversationId}/evidence?limit=1&q=${encodeURIComponent("Body 2")}&messageOrdinal=2`);
    expect(originalBody.statusCode, originalBody.body).toBe(200);
    expect(originalBody.json().pagination.offset).toBe(1);
    expect(originalBody.json().items[0].message.segments[0].content).toBe(source.messages[2]!.segments[0]!.content);
    await app.close();
    await db.update(schema.conversationRevisions).set({ presentationMessageCount: null }).where(eq(schema.conversationRevisions.id, receipt.revisionId));
    await db.delete(schema.conversationRevisionPresentation).where(eq(schema.conversationRevisionPresentation.revisionId, receipt.revisionId));
    expect(await backfillArchiveReadModels()).toBe(1);
    expect(await db.select().from(schema.conversationRevisionPresentation).where(eq(schema.conversationRevisionPresentation.revisionId, receipt.revisionId))).toHaveLength(4);
    evidence.sourceReview!.captureComplete = true;
    expect(buildArchiveReadModel({ sessionId: source.sessionId, provider: source.provider, messages: source.messages, evidence }).sourceContentPending).toBe(false);
    await db.delete(schema.conversations).where(eq(schema.conversations.id, receipt.conversationId));
  });

  it("maintains legacy delta-chain totals and returns grouped organization rows", async () => {
    const db = state.database;
    const source = snapshot(randomUUID(), 1);
    const receipt = await ingestCapture(source, null);
    const [base] = await db.select().from(schema.conversationRevisions).where(eq(schema.conversationRevisions.id, receipt.revisionId));
    await db.update(schema.conversationRevisions).set({ isAccumulated: false }).where(eq(schema.conversationRevisions.id, base.id));
    const deltaId = randomUUID();
    await db.insert(schema.conversationRevisions).values({ ...base, id: deltaId, isAccumulated: false,
      snapshotHash: "delta", revisionIdentityHash: "delta", baseRevisionId: base.id, storageKind: "delta", baseMessageCount: 1,
      capturedAt: new Date("2026-11-01T02:00:00Z"), messageCount: 2,
      presentationMessageCount: null, storedMessageCount: null,
      archivedTextUnits: 7, reasoningTextUnits: 2, toolTextUnits: 1 });
    const [deltaMessage] = await db.insert(schema.messages).values({ revisionId: deltaId,
      ordinal: 1, externalMessageId: "delta-message", role: "assistant" }).returning();
    await db.insert(schema.messageSegments).values({ messageId: deltaMessage.id, ordinal: 0, type: "text", content: "deltaXX" });
    expect(await backfillArchiveReadModels()).toBe(1);
    const app = Fastify(); await conversationRoutes(app);
    const chainPage = await app.inject(`/api/v1/conversations/${receipt.conversationId}?messageLimit=1&messageOffset=1`);
    expect(chainPage.statusCode, chainPage.body).toBe(200);
    expect(chainPage.json().messages[0]).toMatchObject({ ordinal: 1, segments: [{ content: "deltaXX" }] });
    expect(chainPage.json().messagePagination).toEqual({ total: 2, limit: 1, offset: 1, hasMore: false });
    const prefix = await app.inject(`/api/v1/conversations/${receipt.conversationId}?messageLimit=1`);
    expect(prefix.json().messages[0].segments[0].content).toBe(source.messages[0]!.segments[0]!.content);
    const beyondTail = await app.inject(`/api/v1/conversations/${receipt.conversationId}?messageLimit=1&messageOffset=200`);
    expect(beyondTail.json().messagePagination.offset).toBe(1);
    expect(beyondTail.json().messages).toHaveLength(1);
    await app.close();
    let [summary] = await db.select().from(schema.conversationSummaries).where(eq(schema.conversationSummaries.conversationId, receipt.conversationId));
    expect(summary.archivedTextUnits).toBe(base.archivedTextUnits + 7);
    await db.delete(schema.conversationRevisions).where(eq(schema.conversationRevisions.id, deltaId));
    [summary] = await db.select().from(schema.conversationSummaries).where(eq(schema.conversationSummaries.conversationId, receipt.conversationId));
    expect(summary.archivedTextUnits).toBe(base.archivedTextUnits);
    const [project] = await db.insert(schema.projects).values({ name: "Read model project", normalizedName: "read model project", description: "test" }).returning();
    await db.insert(schema.conversationProjects).values({ conversationId: receipt.conversationId, projectId: project.id, source: "manual" });
    const [organization] = await db.execute(dashboardOrganizationQuery(new Date("2026-10-25T00:00:00Z")));
    expect(organization.categoryStats).toHaveLength(1);
    expect(organization.categoryStats[0]).toMatchObject({ projectId: project.id, conversationCount: 1, growth7d: 1 });
    expect(organization.categoryTotals).toMatchObject({ categorizedConversationCount: 1, activeCategoryCount: 1 });
    await db.delete(schema.conversations).where(eq(schema.conversations.id, receipt.conversationId));
    await db.delete(schema.projects).where(eq(schema.projects.id, project.id));
  });

  it("searches and filters current rows in SQL while preserving child matches and tag intersections", async () => {
    const db = state.database;
    const [device] = await db.insert(schema.devices).values({ name: "  Ｍｙ Device  ", kind: "chrome_extension", tokenHash: randomUUID() }).returning();
    const root = snapshot(randomUUID(), 3); root.title = "Literal 100%_needle title";
    root.messages[0]!.segments[0]!.content = "unique-body-needle";
    root.completeness.status = "partial"; root.completeness.topReached = false;
    const parent = await ingestCapture(root, device.id);
    const childSource = snapshot(randomUUID(), 2);
    childSource.parentSessionId = root.sessionId;
    childSource.messages[0]!.segments[0]!.content = "child-only-needle";
    const child = await ingestCapture(childSource, null);
    const other = await ingestCapture(snapshot(randomUUID(), 2), null);
    const [tagA, tagB] = await db.insert(schema.tags).values([
      { name: "Filter A", normalizedName: "filter a" }, { name: "Filter B", normalizedName: "filter b" },
    ]).returning();
    await db.insert(schema.conversationTags).values([
      { conversationId: child.conversationId, tagId: tagA.id, source: "manual" },
      { conversationId: child.conversationId, tagId: tagB.id, source: "manual" },
      { conversationId: other.conversationId, tagId: tagA.id, source: "manual" },
    ]);
    await db.update(schema.conversationRevisions).set({ captureMode: "import" }).where(eq(schema.conversationRevisions.id, parent.revisionId));
    const [current] = await db.select().from(schema.conversationRevisions).where(eq(schema.conversationRevisions.id, parent.revisionId));
    await db.insert(schema.conversationRevisions).values({ ...current, id: randomUUID(), isAccumulated: false,
      snapshotHash: "legacy-filter-row", revisionIdentityHash: "legacy-filter-row", completeness: "complete",
      captureMode: "full", capturedAt: new Date("2026-11-02T00:00:00Z") });
    const app = Fastify(); await conversationRoutes(app);
    try {
      for (const query of [
        "q=" + encodeURIComponent("100%_needle"),
        "q=unique-body-needle",
        "q=child-only-needle",
        `tagIds=${tagA.id},${tagB.id}`,
        "completeness=partial&captureMode=import&sourceDevice=" + encodeURIComponent("name:my device"),
      ]) {
        const response = await app.inject(`/api/v1/conversations?limit=1&${query}`);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().items.map((row: any) => row.id), query).toEqual([parent.conversationId]);
        expect(response.json().pagination.total).toBe(1);
        expect(response.json().items[0].childCount).toBe(1);
        expect(response.json().items[0].latestRevision.id).toBe(parent.revisionId);
      }
      const hit = await app.inject("/api/v1/conversations?q=unique-body-needle");
      expect(hit.json().items[0].searchHit).toMatchObject({ messageOrdinal: 0, revisionId: parent.revisionId });
      const childHit = await app.inject("/api/v1/conversations?q=child-only-needle");
      expect(childHit.json().items[0].searchHit.reason).toBe("子代理命中");
      const empty = await app.inject("/api/v1/conversations?q=nonexistent-body-needle");
      expect(empty.json().items).toEqual([]);
      const devices = await app.inject("/api/v1/conversations/source-devices");
      expect(devices.statusCode, devices.body).toBe(200);
      expect(devices.json().some((row: any) => row.key === "name:my device" && row.count === 1)).toBe(true);
    } finally { await app.close(); }
    for (const receipt of [child, parent, other]) await db.delete(schema.conversations).where(eq(schema.conversations.id, receipt.conversationId));
    for (const tag of [tagA, tagB]) await db.delete(schema.tags).where(eq(schema.tags.id, tag.id));
    await db.delete(schema.devices).where(eq(schema.devices.id, device.id));
  });

  it("orders a project timeline by each conversation's current revision and pages before loading tags", async () => {
    const db = state.database;
    const [project] = await db.insert(schema.projects).values({ name: "Timeline fixture", normalizedName: "timeline fixture" }).returning();
    const receipts = [];
    for (let index = 0; index < 3; index++) {
      const source = snapshot(randomUUID(), 1);
      source.capturedAt = `2026-11-01T0${index}:00:00Z`;
      const receipt = await ingestCapture(source, null); receipts.push(receipt);
      await db.insert(schema.conversationProjects).values({ conversationId: receipt.conversationId, projectId: project.id });
    }
    // A newer historical complete row must not replace the accumulated archive.
    const [current] = await db.select().from(schema.conversationRevisions).where(eq(schema.conversationRevisions.id, receipts[0]!.revisionId));
    await db.insert(schema.conversationRevisions).values({ ...current, id: randomUUID(), isAccumulated: false,
      snapshotHash: "legacy-timeline-row", revisionIdentityHash: "legacy-timeline-row", capturedAt: new Date("2026-11-03T00:00:00Z") });
    const app = Fastify(); await projectRoutes(app);
    try {
      const response = await app.inject(`/api/v1/projects/${project.id}/timeline?limit=1&offset=1`);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().pagination).toEqual({ total: 3, limit: 1, offset: 1, hasMore: true });
      expect(response.json().items[0]).toMatchObject({ conversationId: receipts[1]!.conversationId, revisionId: receipts[1]!.revisionId });
      const last = await app.inject(`/api/v1/projects/${project.id}/timeline?limit=1&offset=2`);
      expect(last.json().items[0].conversationId).toBe(receipts[0]!.conversationId);
      expect(last.json().pagination.hasMore).toBe(false);
      const empty = await app.inject(`/api/v1/projects/${project.id}/timeline?limit=1&offset=3`);
      expect(empty.json().items).toEqual([]);
      expect(empty.json().pagination.total).toBe(3);
    } finally { await app.close(); }
    for (const receipt of receipts) await db.delete(schema.conversations).where(eq(schema.conversations.id, receipt.conversationId));
    await db.delete(schema.projects).where(eq(schema.projects.id, project.id));
  });

  it("maintains compact search documents, English search semantics, variants, and rebuilds", async () => {
    const {rebuildConversationSearchDocuments} = await import("../src/services/search-documents.js");
    const source = snapshot(randomUUID(), 2);
    source.messages[0]!.segments[0]!.content = "项目 alpha separated beta";
    const receipt = await ingestCapture(source, null); const db = state.database;
    const app = Fastify(); await conversationRoutes(app);
    for (const q of ["项目", "alpha beta"]) {
      const response = await app.inject(`/api/v1/conversations?q=${encodeURIComponent(q)}`);
      expect(response.statusCode,response.body).toBe(200);
      expect(response.json().items.map((row:any)=>row.id)).toEqual([receipt.conversationId]);
      expect(response.json().items[0].searchHit.messageOrdinal).toBe(0);
    }
    const [revision] = await db.select().from(schema.conversationRevisions).where(eq(schema.conversationRevisions.id, receipt.revisionId));
    await db.transaction((tx:any) => writeAccumulatedRevision(tx, {conversationId: receipt.conversationId, snapshot:source,
      existing:revision,deviceId:null, replaceBody:true,mergeEvidence:{warnings:[],variants:[{...source.messages[0]!,segments:[{type:"text",content:"历史差异测试"}]}]}}));
    let hits = await app.inject(`/api/v1/conversations?q=${encodeURIComponent("差异")}`);
    expect(hits.json().pagination.total).toBe(1);
    await db.transaction((tx:any)=>rebuildConversationSearchDocuments(tx));
    hits = await app.inject(`/api/v1/conversations?q=${encodeURIComponent("差异")}`);
    expect(hits.json().pagination.total).toBe(1);
    await db.update(schema.conversations).set({deletedAt:new Date()}).where(eq(schema.conversations.id,receipt.conversationId));
    hits = await app.inject(`/api/v1/conversations?q=${encodeURIComponent("差异")}`);
    expect(hits.json().pagination.total).toBe(0);
    await app.close(); await db.delete(schema.conversations).where(eq(schema.conversations.id,receipt.conversationId));
    expect(await db.select().from(schema.conversationSearchDocuments).where(eq(schema.conversationSearchDocuments.conversationId,receipt.conversationId))).toHaveLength(0);
  });

  it("intersects Chinese terms then verifies adjacency, preserving child matches and exact Unicode", async () => {
    const db = state.database;
    const parentSource = snapshot(randomUUID(), 1);
    const parent = await ingestCapture(parentSource, null);
    const childSource = snapshot(randomUUID(), 1); childSource.parentSessionId = parentSource.sessionId;
    childSource.messages[0]!.segments[0]!.content = "归档项目 𠀀项目 项目项目";
    const child = await ingestCapture(childSource, null);
    const scattered = snapshot(randomUUID(), 1);
    scattered.messages[0]!.segments[0]!.content = "归档，档项，项目，𠀀，项";
    const falsePositive = await ingestCapture(scattered, null);
    const titleOnly = snapshot(randomUUID(), 1); titleOnly.title = "归档项目";
    const title = await ingestCapture(titleOnly, null);
    const app = Fastify(); await conversationRoutes(app);
    try {
      for (const query of ["归档项目", "𠀀项目", "项目项目"]) {
        const response = await app.inject(`/api/v1/conversations?q=${encodeURIComponent(query)}`);
        expect(response.statusCode, response.body).toBe(200);
        expect(new Set(response.json().items.map((row: any) => row.id))).toEqual(new Set(
          query === "归档项目" ? [parent.conversationId, title.conversationId] : [parent.conversationId]));
      }
      const single = await app.inject(`/api/v1/conversations?q=${encodeURIComponent("𠀀")}`);
      expect(single.json().pagination.total).toBe(2);
      const tail = await app.inject(`/api/v1/conversations?q=${encodeURIComponent("归档项目")}&offset=99`);
      expect(tail.json().pagination.total).toBe(2); expect(tail.json().items).toEqual([]);
    } finally {
      await app.close();
      for (const item of [child, parent, falsePositive, title]) await db.delete(schema.conversations).where(eq(schema.conversations.id, item.conversationId));
    }
  });

  it("changes only affected postings and rolls document and postings back together", async () => {
    const {storeConversationSearchTerms, extractCjkTerms} = await import("../src/services/search-documents.js");
    const source = snapshot(randomUUID(), 1); source.messages[0]!.segments[0]!.content = "归档项目 𠀀项目";
    const receipt = await ingestCapture(source, null); const db = state.database;
    const postings = () => db.select().from(schema.conversationSearchTerms).where(eq(schema.conversationSearchTerms.conversationId, receipt.conversationId));
    const tuple = () => db.execute(sql`select ctid::text as tuple from conversation_search_terms where conversation_id = ${receipt.conversationId} and term = '项目'`);
    const [before] = await tuple();
    await db.transaction((tx: any) => storeConversationSearchTerms(tx, receipt.conversationId, extractCjkTerms("归档项目 新增")));
    expect((await tuple())[0]).toEqual(before);
    expect((await postings()).map((row: any) => row.term)).toContain("新增");
    expect((await postings()).map((row: any) => row.term)).not.toContain("𠀀项");
    await expect(db.transaction(async (tx: any) => {
      await storeConversationSearchTerms(tx, receipt.conversationId, extractCjkTerms("回滚"));
      throw new Error("rollback probe");
    })).rejects.toThrow("rollback probe");
    expect((await postings()).map((row: any) => row.term)).toContain("项目");
    expect((await postings()).map((row: any) => row.term)).not.toContain("回滚");
    await db.transaction((tx: any) => storeConversationSearchTerms(tx, receipt.conversationId, extractCjkTerms("English only")));
    expect(await postings()).toHaveLength(0);
    await db.delete(schema.conversations).where(eq(schema.conversations.id, receipt.conversationId));
  });

  it("upgrades packed terms inside SQL and backfills only documents missing legacy terms", async () => {
    const {backfillSearchDocumentTerms} = await import("../src/services/search-documents.js");
    const migration = await readFile(new URL("../migrations/0029_indexed_cjk_terms.sql", import.meta.url), "utf8");
    await pg.exec(`create schema term_upgrade_probe; set search_path = term_upgrade_probe;
      create table conversation_search_documents(conversation_id uuid primary key, content text not null, short_cjk_terms text);
      create index conversation_search_documents_pending_idx on conversation_search_documents(conversation_id) where short_cjk_terms is null;`);
    try {
      const legacy = randomUUID(), missing = randomUUID(), empty = randomUUID();
      await pg.query("insert into conversation_search_documents values ($1, $2, $3), ($4, $5, null), ($6, '', '')",
        [legacy, "Do not re-tokenize this content", "项\u0001项目\u0001目", missing, "𠀀项目", empty]);
      await pg.exec(migration);
      expect((await pg.query("select term from conversation_search_terms where conversation_id = $1 order by term", [legacy])).rows).toEqual([{term:"目"},{term:"项"},{term:"项目"}]);
      await pg.exec(`create table conversation_revisions(id uuid primary key, conversation_id uuid);
        create table conversation_search_chunks(id uuid primary key, revision_id uuid, content text);
        create index conversation_search_chunks_revision_idx on conversation_search_chunks(revision_id);`);
      const revisionId = randomUUID();
      await pg.query("insert into conversation_revisions values ($1,$2)",[revisionId,missing]);
      await pg.query("insert into conversation_search_chunks values ($1,$2,$3)",[randomUUID(),revisionId,"𠀀项目"]);
      await pg.exec(await readFile(new URL("../migrations/0030_streamed_search_terms.sql", import.meta.url), "utf8"));
      await backfillSearchDocumentTerms();
      expect((await pg.query("select term from conversation_search_terms where conversation_id = $1 and term = '𠀀项'", [missing])).rows).toHaveLength(1);
      expect((await pg.query("select 1 from conversation_search_documents where not terms_ready")).rows).toHaveLength(0);
      expect((await pg.query("select 1 from conversation_search_terms where conversation_id = $1", [empty])).rows).toHaveLength(0);
    } finally { await pg.exec("set search_path = public; drop schema term_upgrade_probe cascade;"); }
  });

  it("indexes only appended chunks and leaves old postings untouched; metadata does not touch terms", async () => {
    const db = state.database;
    const source = snapshot(randomUUID(), 300);
    for (const message of source.messages) message.segments[0]!.content = "历史归档项目";
    const receipt = await ingestCapture(source, null);
    const [before] = await db.execute(sql`select ctid::text as tuple from conversation_search_terms where conversation_id = ${receipt.conversationId} and term = '历史'`);
    const appended = {...source, capturedAt: "2026-11-01T01:00:00Z", messages: [...source.messages,
      {ordinal:300,externalMessageId:"new-message",role:"assistant" as const,segments:[{type:"text" as const,content:"新增优化𠀀"}]}]};
    executedQueries.length = 0;
    await ingestCapture(appended, null);
    const writes = executedQueries.filter(row => row.query.includes("insert into conversation_search_terms"));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.query).not.toContain("removed");
    expect(writes[0]!.params[0]).toContain("新增");
    expect(writes[0]!.params[0]).not.toContain("历史");
    expect((await db.execute(sql`select ctid::text as tuple from conversation_search_terms where conversation_id = ${receipt.conversationId} and term = '历史'`))[0]).toEqual(before);
    executedQueries.length = 0;
    await ingestCapture({...appended,title:"Metadata-only update",capturedAt:"2026-11-01T02:00:00Z"}, null);
    expect(executedQueries.some(row => /(?:insert into|update|delete from) .?conversation_search_(?:terms|documents)/.test(row.query))).toBe(false);
    await db.delete(schema.conversations).where(eq(schema.conversations.id,receipt.conversationId));
  });

  it("recovers a missing append baseline by paging real chunks, including a second batch", async () => {
    const {backfillSearchDocumentTerms} = await import("../src/services/search-documents.js");
    const db = state.database; const source = snapshot(randomUUID(), 300);
    source.messages[0]!.segments[0]!.content = "首端保留";
    source.messages[299]!.segments[0]!.content = "尾端保留";
    const receipt = await ingestCapture(source, null);
    await db.delete(schema.conversationSearchDocuments).where(eq(schema.conversationSearchDocuments.conversationId,receipt.conversationId));
    const appended = {...source,capturedAt:"2026-11-01T01:00:00Z",messages:[...source.messages,
      {ordinal:300,externalMessageId:"append-after-loss",role:"assistant" as const,segments:[{type:"text" as const,content:"新增词条"}]}]};
    executedQueries.length = 0;
    await ingestCapture(appended, null);
    const indexed = await db.select().from(schema.conversationSearchTerms).where(eq(schema.conversationSearchTerms.conversationId,receipt.conversationId));
    expect(indexed.map((row:any)=>row.term)).toEqual(expect.arrayContaining(["首端","尾端","新增"]));
    expect(executedQueries.some(row=>row.query.includes("and id >") && row.query.includes("limit 256"))).toBe(true);
    await db.delete(schema.conversationSearchTerms).where(eq(schema.conversationSearchTerms.conversationId,receipt.conversationId));
    await db.update(schema.conversationSearchDocuments).set({termsReady:false}).where(eq(schema.conversationSearchDocuments.conversationId,receipt.conversationId));
    await backfillSearchDocumentTerms();
    expect((await db.select().from(schema.conversationSearchTerms).where(eq(schema.conversationSearchTerms.conversationId,receipt.conversationId))).map((row:any)=>row.term)).toEqual(indexed.map((row:any)=>row.term));
    await db.delete(schema.conversations).where(eq(schema.conversations.id,receipt.conversationId));
  });

  it("verifies phrases in historical revisions and never joins separate chunk bodies", async () => {
    const {storeConversationSearchTerms,extractCjkTerms} = await import("../src/services/search-documents.js");
    const db = state.database; const source = snapshot(randomUUID(),1);
    source.messages[0]!.segments[0]!.content = "归档，档项，项目";
    const receipt = await ingestCapture(source,null);
    const [current] = await db.select().from(schema.conversationRevisions).where(eq(schema.conversationRevisions.id,receipt.revisionId));
    const revisionId = randomUUID();
    await db.insert(schema.conversationRevisions).values({...current,id:revisionId,isAccumulated:false,snapshotHash:revisionId,revisionIdentityHash:revisionId});
    const [message] = await db.insert(schema.messages).values({revisionId,ordinal:0,role:"assistant"}).returning();
    await db.insert(schema.conversationSearchChunks).values({revisionId,messageId:message.id,chunkIndex:0,content:"历史归档项目"});
    await db.transaction((tx:any)=>storeConversationSearchTerms(tx,receipt.conversationId,extractCjkTerms("历史归档项目"),true));
    const app = Fastify();await conversationRoutes(app);
    try {
      const response = await app.inject(`/api/v1/conversations?q=${encodeURIComponent("归档项目")}`);
      expect(response.statusCode,response.body).toBe(200);expect(response.json().pagination.total).toBe(1);
      await db.delete(schema.conversationRevisions).where(eq(schema.conversationRevisions.id,revisionId));
      const absent = await app.inject(`/api/v1/conversations?q=${encodeURIComponent("归档项目")}`);
      expect(absent.json().pagination.total).toBe(0);
    } finally {await app.close();await db.delete(schema.conversations).where(eq(schema.conversations.id,receipt.conversationId));}
  });

  it("updates project rollups for late parents, reassignment, soft delete, restore and activity", async () => {
    const db=state.database;
    const [a,b]=await db.insert(schema.projects).values([{name:"Rollup A",normalizedName:"rollup a"},{name:"Rollup B",normalizedName:"rollup b"}]).returning();
    const parentSource=snapshot(randomUUID(),1), childSource=snapshot(randomUUID(),1);
    childSource.parentSessionId=parentSource.sessionId;
    const child=await ingestCapture(childSource,null);
    await db.insert(schema.conversationProjects).values({conversationId:child.conversationId,projectId:a.id});
    const membership=()=>db.select().from(schema.projectConversationRollups).where(eq(schema.projectConversationRollups.sourceConversationId,child.conversationId));
    expect((await membership())[0].conversationId).toBe(child.conversationId);
    const parent=await ingestCapture(parentSource,null);
    expect((await membership())[0].conversationId).toBe(parent.conversationId);
    await db.update(schema.conversationProjects).set({projectId:b.id}).where(eq(schema.conversationProjects.conversationId,child.conversationId));
    expect((await membership())[0].projectId).toBe(b.id);
    await db.update(schema.conversations).set({deletedAt:new Date()}).where(eq(schema.conversations.id,parent.conversationId));
    expect((await membership())[0].conversationId).toBe(child.conversationId);
    await db.update(schema.conversations).set({deletedAt:null,updatedAt:new Date("2026-11-03T00:00:00Z")}).where(eq(schema.conversations.id,parent.conversationId));
    expect((await membership())[0]).toMatchObject({conversationId:parent.conversationId,activityAt:new Date("2026-11-03T00:00:00Z")});
    await db.update(schema.conversationRevisions).set({capturedAt:new Date("2026-11-05T00:00:00Z")}).where(eq(schema.conversationRevisions.id,parent.revisionId));
    expect((await membership())[0].activityAt).toEqual(new Date("2026-11-05T00:00:00Z"));
    await db.update(schema.conversations).set({deletedAt:new Date()}).where(eq(schema.conversations.id,child.conversationId));
    expect(await membership()).toHaveLength(0);
    await db.update(schema.conversations).set({deletedAt:null}).where(eq(schema.conversations.id,child.conversationId));
    expect(await membership()).toHaveLength(1);
    for(const id of [child.conversationId,parent.conversationId])await db.delete(schema.conversations).where(eq(schema.conversations.id,id));
    for(const id of [a.id,b.id])await db.delete(schema.projects).where(eq(schema.projects.id,id));
  });

});
