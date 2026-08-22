import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
import { strToU8, zipSync } from "../apps/server/node_modules/fflate/esm/index.mjs";

const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:18081").replace(/\/$/, "");
const target = new URL(base);
if (
  !["localhost", "127.0.0.1", "::1"].includes(target.hostname) &&
  process.env.E2E_ALLOW_REMOTE !== "true"
) {
  throw new Error("E2E test refuses a remote server unless E2E_ALLOW_REMOTE=true");
}

async function responseBody(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function expectOk(response) {
  const value = await responseBody(response);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.url}: ${JSON.stringify(value)}`);
  }
  return value;
}

function currentTotp(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const character of secret.replace(/=+$/g, "").toUpperCase()) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("Invalid Base32 TOTP secret");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 15;
  const binary =
    ((digest[offset] & 127) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];
  return String(binary % 1_000_000).padStart(6, "0");
}

for (let attempt = 0; attempt < 30; attempt += 1) {
  try {
    if ((await fetch(`${base}/healthz`)).ok) break;
  } catch {
    // The container can still be applying migrations.
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const health = await expectOk(await fetch(`${base}/healthz`));
const expectedVersion = process.env.E2E_EXPECTED_VERSION ?? "V2.0.2";
if (health.version !== expectedVersion) {
  throw new Error(`Expected server ${expectedVersion}, received ${String(health.version)}`);
}

const bootstrap = await expectOk(
  await fetch(`${base}/api/v1/auth/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({
      username: "archive-admin",
      password: "correct horse battery staple",
    }),
  }),
);
const loginResponse = await fetch(`${base}/api/v1/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json", origin: base },
  body: JSON.stringify({
    username: "archive-admin",
    password: "correct horse battery staple",
    totpCode: currentTotp(bootstrap.secret),
  }),
});
await expectOk(loginResponse);
const cookie = (loginResponse.headers.get("set-cookie") ?? "").match(
  /archive_session=[^;]+/,
)?.[0];
if (!cookie) throw new Error("Login cookie missing");
const webHeaders = { "content-type": "application/json", cookie, origin: base };

const pairing = await expectOk(
  await fetch(`${base}/api/v1/pairing-codes`, {
    method: "POST",
    headers: webHeaders,
    body: JSON.stringify({ name: "E2E Chrome", kind: "chrome_extension" }),
  }),
);
const claimed = await expectOk(
  await fetch(`${base}/api/v1/devices/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: pairing.code,
      kind: "chrome_extension",
    }),
  }),
);

const snapshot = {
  schemaVersion: 1,
  provider: "deepseek",
  sessionId: "e2e-session-001",
  branchFingerprint: "branch-e2e-001",
  title: "TitleOnlyNeedle project discussion",
  canonicalUrl: "https://chat.deepseek.com/a/chat/s/e2e-session-001",
  adapterVersion: "deepseek@1",
  capturedAt: new Date().toISOString(),
  completeness: {
    status: "complete",
    topReached: true,
    bottomReached: true,
    stable: true,
  },
  messages: [
    {
      ordinal: 0,
      role: "user",
      segments: [{ type: "text", content: "How should the archive deduplicate sessions?" }],
    },
    {
      ordinal: 1,
      role: "assistant",
      model: "DeepSeek-V3",
      segments: [
        { type: "reasoning", content: "Visible reasoning summary" },
        { type: "tool_status", content: "Search completed" },
        {
          type: "text",
          content: "Use provider and external session ID, then hash each revision.",
        },
        { type: "code", content: "unique(provider, session_id)", language: "sql" },
        {
          type: "citation",
          content: "PostgreSQL indexes",
          href: "https://www.postgresql.org/docs/current/indexes-unique.html",
        },
      ],
    },
  ],
};

async function capture(value, key) {
  return fetch(`${base}/api/v1/captures`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${claimed.token}`,
      "content-type": "application/json",
      "content-encoding": "gzip",
      "idempotency-key": key,
    },
    body: gzipSync(Buffer.from(JSON.stringify(value))),
  });
}

const firstResponse = await capture(snapshot, "capture:e2e-001");
const first = await expectOk(firstResponse);
const repeatResponse = await capture(snapshot, "capture:e2e-001");
const repeat = await expectOk(repeatResponse);

// A provider title may appear after the original message capture. Replaying
// the same content and idempotency key must repair metadata without creating a
// new revision or being discarded as a no-op.
const replayMetadata = structuredClone(snapshot);
replayMetadata.title = "Title repaired through idempotent replay";
replayMetadata.capturedAt = new Date(Date.now() + 500).toISOString();
const replayMetadataResponse = await capture(replayMetadata, "capture:e2e-001");
const replayMetadataResult = await expectOk(replayMetadataResponse);
const replayMetadataDetail = await expectOk(
  await fetch(`${base}/api/v1/conversations/${first.conversationId}`, {
    headers: { cookie },
  }),
);

const changed = structuredClone(snapshot);
changed.branchFingerprint = "branch-e2e-002";
changed.capturedAt = new Date(Date.now() + 1_000).toISOString();
changed.messages[1].segments[2].content =
  "Changed branch answer retained as a second revision.";
const conflictResponse = await capture(changed, "capture:e2e-001");
const conflict = await responseBody(conflictResponse);
const changedResponse = await capture(changed, "capture:e2e-002");
const changedResult = await expectOk(changedResponse);

const metadataOnly = structuredClone(snapshot);
metadataOnly.title = "TitleOnlyNeedle · 狐狸的私人医生";
metadataOnly.messages[1].model = "DeepSeek-V4";
metadataOnly.messages[1].createdAt = new Date(Date.now() + 2_000).toISOString();
const metadataOnlyResponse = await capture(metadataOnly, "capture:e2e-metadata");
const metadataOnlyResult = await expectOk(metadataOnlyResponse);

const partial = {
  ...structuredClone(snapshot),
  sessionId: "partial-session",
  branchFingerprint: "partial-branch-001",
  title: "Partial capture",
  capturedAt: new Date().toISOString(),
  completeness: {
    status: "partial",
    topReached: false,
    bottomReached: true,
    stable: true,
    reason: "first turn not proven",
  },
};
await expectOk(await capture(partial, "capture:partial-001"));
const invalid = {
  ...structuredClone(snapshot),
  sessionId: "invalid-session",
  branchFingerprint: "invalid-branch-001",
  capturedAt: new Date().toISOString(),
  completeness: {
    status: "complete",
    topReached: false,
    bottomReached: true,
    stable: true,
  },
};
const invalidResponse = await capture(invalid, "capture:invalid-001");
const invalidBody = await responseBody(invalidResponse);

const titleSearch = await expectOk(
  await fetch(`${base}/api/v1/conversations?q=TitleOnlyNeedle`, { headers: { cookie } }),
);
const bodySearch = await expectOk(
  await fetch(
    `${base}/api/v1/conversations?q=${encodeURIComponent("external session ID")}`,
    { headers: { cookie } },
  ),
);
const invalidProviderResponse = await fetch(
  `${base}/api/v1/conversations?provider=not-a-provider`,
  { headers: { cookie } },
);
await responseBody(invalidProviderResponse);
const detailBefore = await expectOk(
  await fetch(`${base}/api/v1/conversations/${first.conversationId}`, {
    headers: { cookie },
  }),
);

const project = await expectOk(
  await fetch(`${base}/api/v1/projects`, {
    method: "POST",
    headers: webHeaders,
    body: JSON.stringify({ name: "Archive E2E", description: "Project lock test" }),
  }),
);
await expectOk(
  await fetch(`${base}/api/v1/conversations/${first.conversationId}/project`, {
    method: "PUT",
    headers: webHeaders,
    body: JSON.stringify({ projectId: project.id }),
  }),
);
const detailAfter = await expectOk(
  await fetch(`${base}/api/v1/conversations/${first.conversationId}`, {
    headers: { cookie },
  }),
);

const deleteConversationResponse = await fetch(
  `${base}/api/v1/conversations/${first.conversationId}`,
  {
    method: "DELETE",
    headers: { cookie, origin: base },
  },
);
await expectOk(deleteConversationResponse);
const deletedConversationResponse = await fetch(
  `${base}/api/v1/conversations/${first.conversationId}`,
  { headers: { cookie } },
);
await responseBody(deletedConversationResponse);

// Reuse the original deterministic idempotency key. A permanent deletion must
// clear the old run and create a fresh conversation with only this snapshot.
const recapturedSnapshot = structuredClone(snapshot);
recapturedSnapshot.capturedAt = new Date(Date.now() + 3_000).toISOString();
const recapturedResponse = await capture(recapturedSnapshot, "capture:e2e-001");
const recaptured = await expectOk(recapturedResponse);
const recapturedDetail = await expectOk(
  await fetch(`${base}/api/v1/conversations/${recaptured.conversationId}`, {
    headers: { cookie },
  }),
);

await expectOk(
  await fetch(`${base}/api/v1/settings`, {
    method: "PUT",
    headers: webHeaders,
    body: JSON.stringify({
      "llm.baseUrl": "https://llm.example.com/v1",
      "llm.apiKey": "secret-e2e-api-key-123456",
      "llm.model": "test-model",
    }),
  }),
);
const publicSettings = await expectOk(
  await fetch(`${base}/api/v1/settings`, { headers: { cookie } }),
);

const exportData = [
  {
    id: "imported-chatgpt-session",
    title: "Imported official archive",
    update_time: 1_700_000_000,
    mapping: {
      u: {
        id: "u",
        parent: null,
        children: ["a"],
        message: {
          id: "iu",
          author: { role: "user" },
          content: { parts: ["Imported question"] },
        },
      },
      a: {
        id: "a",
        parent: "u",
        children: [],
        message: {
          id: "ia",
          author: { role: "assistant" },
          content: { parts: ["Imported answer"] },
        },
      },
    },
  },
];
const zip = zipSync({
  "conversations.json": strToU8(JSON.stringify(exportData)),
});
async function uploadZip() {
  const form = new FormData();
  form.append(
    "file",
    new Blob([zip], { type: "application/zip" }),
    "chatgpt-export.zip",
  );
  return fetch(`${base}/api/v1/imports`, {
    method: "POST",
    headers: { cookie, origin: base },
    body: form,
  });
}

const importResponse = await uploadZip();
const importAccepted = await expectOk(importResponse);
let completedImport = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const jobs = await expectOk(
    await fetch(`${base}/api/v1/imports`, { headers: { cookie } }),
  );
  completedImport = jobs.find((job) => job.id === importAccepted.job.id);
  if (completedImport?.status === "completed") break;
  if (completedImport?.status === "failed") {
    throw new Error(`Import failed: ${completedImport.error}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const duplicateImport = await expectOk(await uploadZip());
const allConversations = await expectOk(
  await fetch(`${base}/api/v1/conversations`, { headers: { cookie } }),
);
const dashboard = await expectOk(
  await fetch(`${base}/api/v1/dashboard`, { headers: { cookie } }),
);
const systemStatus = await expectOk(
  await fetch(`${base}/api/v1/system/status`, { headers: { cookie } }),
);
const rootResponse = await fetch(base);
const rootHtml = await rootResponse.text();

await expectOk(
  await fetch(`${base}/api/v1/devices/${claimed.deviceId}`, {
    method: "DELETE",
    headers: { cookie, origin: base },
  }),
);
const revokedResponse = await capture(snapshot, "capture:after-revoke");
await responseBody(revokedResponse);

const summary = {
  firstStatus: firstResponse.status,
  firstUnchanged: first.unchanged,
  repeatStatus: repeatResponse.status,
  repeatUnchanged: repeat.unchanged,
  replayMetadataStatus: replayMetadataResponse.status,
  replayMetadataUnchanged: replayMetadataResult.unchanged,
  replayMetadataUpdated:
    replayMetadataDetail.conversation.title === replayMetadata.title &&
    replayMetadataDetail.revisions.length === 1,
  conflictStatus: conflictResponse.status,
  conflictError: conflict.error,
  changedStatus: changedResponse.status,
  changedUnchanged: changedResult.unchanged,
  metadataOnlyStatus: metadataOnlyResponse.status,
  metadataOnlyUnchanged: metadataOnlyResult.unchanged,
  invalidCompletenessStatus: invalidResponse.status,
  invalidIssue: Boolean(invalidBody.issues?.length),
  titleSearch: titleSearch.length,
  bodySearch: bodySearch.length,
  invalidProviderStatus: invalidProviderResponse.status,
  revisions: detailBefore.revisions.length,
  titleUpdatedWithoutRevision: detailBefore.conversation.title === metadataOnly.title,
  projectLocked: detailAfter.projectAssignment?.lockedByUser,
  deleteStatus: deleteConversationResponse.status,
  deletedDetailStatus: deletedConversationResponse.status,
  recapturedStatus: recapturedResponse.status,
  recapturedConversationIsNew: recaptured.conversationId !== first.conversationId,
  recapturedRevisions: recapturedDetail.revisions.length,
  maskedSecret: publicSettings.settings["llm.apiKey"],
  importStatus: completedImport?.status,
  duplicateImport: duplicateImport.duplicate,
  conversations: allConversations.length,
  dashboard: dashboard.counts,
  systemStatus: {
    app: systemStatus.services?.app?.online,
    postgres: systemStatus.services?.postgres?.online,
    hostMonitor: systemStatus.services?.hostMonitor?.online,
    projectStorageBytes: systemStatus.projectStorage?.usedBytes,
    projectStorageBudget: systemStatus.projectStorage?.budgetBytes,
  },
  webServed: rootResponse.status === 200 && rootHtml.includes("知言归藏"),
  revokedStatus: revokedResponse.status,
};
console.log(JSON.stringify(summary, null, 2));

if (
  firstResponse.status !== 201 ||
  first.unchanged ||
  repeatResponse.status !== 200 ||
  !repeat.unchanged ||
  replayMetadataResponse.status !== 200 ||
  !replayMetadataResult.unchanged ||
  replayMetadataDetail.conversation.title !== replayMetadata.title ||
  replayMetadataDetail.revisions.length !== 1 ||
  conflictResponse.status !== 400 ||
  changedResponse.status !== 201 ||
  changedResult.unchanged ||
  metadataOnlyResponse.status !== 200 ||
  !metadataOnlyResult.unchanged ||
  invalidResponse.status !== 400 ||
  titleSearch.length !== 1 ||
  bodySearch.length < 1 ||
  invalidProviderResponse.status !== 400 ||
  detailBefore.revisions.length !== 2 ||
  detailBefore.conversation.title !== metadataOnly.title ||
  !detailAfter.projectAssignment?.lockedByUser ||
  deleteConversationResponse.status !== 204 ||
  deletedConversationResponse.status !== 404 ||
  recapturedResponse.status !== 201 ||
  recaptured.unchanged ||
  recaptured.conversationId === first.conversationId ||
  recapturedDetail.revisions.length !== 1 ||
  publicSettings.settings["llm.apiKey"] !== "********" ||
  completedImport?.status !== "completed" ||
  !duplicateImport.duplicate ||
  allConversations.length !== 3 ||
  systemStatus.services?.app?.online !== true ||
  systemStatus.services?.postgres?.online !== true ||
  !Number.isFinite(systemStatus.projectStorage?.usedBytes) ||
  systemStatus.projectStorage.usedBytes < systemStatus.database.sizeBytes ||
  !summary.webServed ||
  revokedResponse.status !== 401
) {
  process.exitCode = 2;
}
