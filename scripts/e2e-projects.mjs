import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(new URL("../apps/server/package.json", import.meta.url));
const { TOTP, Secret } = require("otpauth");
const base = (process.env.E2E_BASE_URL ?? "http://127.0.0.1:18081").replace(/\/$/, "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(base).hostname)) {
  throw new Error("Project E2E requires an isolated local server with a fresh database");
}
let cookie = "";
async function request(path, method = "GET", body, extraHeaders = {}) {
  return fetch(`${base}/api/v1${path}`, {
    method,
    headers: { origin: base, cookie, "content-type": "application/json", ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function ok(response) {
  const value = await response.json();
  assert.ok(response.ok, `${response.status} ${response.url}: ${JSON.stringify(value)}`);
  return value;
}
const credentials = { username: "project-e2e-admin", password: "project-e2e-test-password" };
const bootstrap = await ok(await request("/auth/bootstrap", "POST", credentials));
const login = await request("/auth/login", "POST", {
  ...credentials,
  totpCode: new TOTP({ secret: Secret.fromBase32(bootstrap.secret) }).generate(),
});
await ok(login);
cookie = login.headers.get("set-cookie").match(/archive_session=[^;]+/)[0];

const createProject = (name) => request("/projects", "POST", { name }).then(ok);
const sourceA = await createProject("Batch Search 100%_A");
const sourceB = await createProject("Batch Search 100%_B");
const decoy = await createProject("Batch Search 100XXDecoy");
const target = await createProject("保留项目");
await ok(await request(`/projects/${sourceB.id}`, "PATCH", { archived: true }));
const search = (q, extra = {}) => request(`/projects?${new URLSearchParams({ q, ...extra })}`).then(ok);
const page = await search("  ＢＡＴＣＨ Search 100%_", { limit: "1", offset: "1" });
assert.equal(page.pagination.total, 2);
assert.equal(page.pagination.hasMore, false);
assert.deepEqual(page.items.map((item) => item.id), [sourceB.id]);
assert.equal((await search("Batch Search", { archived: "true" })).pagination.total, 1);
assert.equal((await search("Batch Search", { archived: "false" })).pagination.total, 2);
assert.equal((await search("missing-project-needle")).pagination.total, 0);
assert.equal((await search("　 \t")).pagination.total, 4);
assert.equal((await request(`/projects?q=${"a".repeat(201)}`)).status, 400);

const pairing = await ok(await request("/pairing-codes", "POST", { name: "Project E2E", kind: "chrome_extension" }));
const device = await ok(await request("/devices/claim", "POST", { code: pairing.code, kind: "chrome_extension" }));
const capture = await ok(await request("/captures", "POST", {
  schemaVersion: 1,
  branchFingerprint: "project-e2e-branch",
  provider: "deepseek",
  sessionId: "project-e2e-conversation",
  title: "项目合并验收会话",
  canonicalUrl: "https://chat.deepseek.com/a/chat/s/project-e2e-conversation",
  adapterVersion: "deepseek@1",
  capturedAt: new Date().toISOString(),
  completeness: { status: "complete", topReached: true, bottomReached: true, stable: true },
  messages: [{ ordinal: 0, role: "user", segments: [{ type: "text", content: "项目合并时保留会话与人工锁。" }] }],
}, { authorization: `Bearer ${device.token}`, "idempotency-key": randomUUID() }));
await ok(await request(`/conversations/${capture.conversationId}/project`, "PUT", { projectId: sourceA.id }));

const input = { sourceProjectIds: [sourceA.id, sourceB.id], targetProjectId: target.id };
const merge = (body) => request("/projects/merge", "POST", body);
for (const sourceProjectIds of [[], [target.id], ["invalid-uuid"]]) {
  assert.equal((await merge({ ...input, sourceProjectIds })).status, 400);
}
assert.equal((await merge({ ...input, targetName: "　 \t" })).status, 400);
assert.equal((await merge({ ...input, sourceProjectIds: [...input.sourceProjectIds, randomUUID()] })).status, 404);
assert.equal((await merge({ sourceProjectIds: [sourceA.id], targetProjectId: sourceB.id })).status, 404);
assert.equal((await merge({ ...input, targetName: `  ${decoy.name.toUpperCase()}  ` })).status, 409);
const detail = () => request(`/conversations/${capture.conversationId}`).then(ok);
assert.equal((await detail()).projectAssignment.projectId, sourceA.id);
assert.equal((await search("Batch Search 100%_")).pagination.total, 2);

const result = await ok(await merge({
  ...input,
  sourceProjectIds: [...input.sourceProjectIds, sourceA.id],
  targetName: sourceA.name,
}));
assert.deepEqual(result.sourceProjectIds, input.sourceProjectIds);
assert.deepEqual(result.sourceProjectNames, [sourceA.name, sourceB.name]);
assert.equal(result.targetProjectName, sourceA.name);
assert.equal(result.movedConversationCount, 1);
assert.equal((await detail()).projectAssignment.projectId, target.id);
assert.equal((await detail()).projectAssignment.lockedByUser, true);
const remaining = await ok(await request("/projects/options"));
assert.ok(input.sourceProjectIds.every((id) => !remaining.some((project) => project.id === id)));

const legacy = await ok(await request(`/projects/${decoy.id}/merge`, "POST", { targetProjectId: target.id }));
assert.equal(legacy.sourceProjectId, decoy.id);
assert.equal(legacy.targetProjectName, sourceA.name);
console.log("PASS Project search: normalization, literal wildcards, archived filtering, pagination, empty results and clearing");
console.log("PASS Project merge: multiple sources, duplicate IDs, archived source, invalid inputs, missing projects, atomic rollback, source-name reuse, manual locks and legacy API");
