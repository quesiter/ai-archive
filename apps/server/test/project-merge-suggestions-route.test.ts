import Fastify, { type FastifyReply } from "fastify";
import { ZodError } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticated: true,
  list: vi.fn(),
  analyze: vi.fn(),
  ignored: vi.fn(),
  dismiss: vi.fn(),
  restore: vi.fn(),
  merge: vi.fn(),
}));

vi.mock("../src/http.js", () => ({
  requireWebUser: vi.fn(async (_request: unknown, reply: FastifyReply) => {
    if (mocks.authenticated) return { id: "admin", username: "admin" };
    await reply.code(401).send({ error: "Authentication required" });
    return null;
  }),
}));
vi.mock("../src/services/project-merge-suggestions.js", () => ({
  listProjectMergeSuggestions: mocks.list,
  analyzeProjectMergeSuggestions: mocks.analyze,
  listIgnoredProjectMergeSuggestions: mocks.ignored,
  dismissProjectMergeSuggestion: mocks.dismiss,
  restoreProjectMergeSuggestion: mocks.restore,
}));
vi.mock("../src/services/project-merge.js", () => ({
  mergeProjectIntoProject: mocks.merge,
  mergeProjectsIntoProject: mocks.merge,
}));

import { projectMergeSuggestionRoutes } from "../src/routes/project-merge-suggestions.js";

const projectIds = [
  "ABCDEF00-0000-4000-8000-000000000001",
  "ABCDEF00-0000-4000-8000-000000000002",
];
const base = "/api/v1/projects/merge-suggestions";
const payload = {
  items: [{ id: "candidate", reasons: ["同一应用的开发与维护会话"] }],
  ignoredCount: 2,
  scannedProjectCount: 50,
  emptyProjectCount: 12,
  ai: { available: true, cached: false, generatedAt: null, stale: false },
  pagination: { total: 1, limit: 8, offset: 0, hasMore: false },
};
const apps: ReturnType<typeof Fastify>[] = [];

async function createApp() {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Request validation failed" });
    }
    const code = typeof (error as { statusCode?: unknown }).statusCode === "number"
      ? (error as { statusCode: number }).statusCode : 500;
    return reply.code(code).send({ error: error instanceof Error ? error.message : String(error) });
  });
  await projectMergeSuggestionRoutes(app);
  apps.push(app);
  return app;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticated = true;
  mocks.list.mockResolvedValue(payload);
  mocks.analyze.mockResolvedValue(undefined);
  mocks.ignored.mockResolvedValue([]);
  mocks.dismiss.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(undefined);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("project merge suggestion routes", () => {
  it("returns candidates across the catalog with explicit pagination", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: `${base}?limit=4&offset=8` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(payload);
    expect(mocks.list).toHaveBeenCalledWith({ limit: 4, offset: 8 });
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("uses a small default page without requiring query parameters", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: base });
    expect(response.statusCode).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith({ limit: 8, offset: 0 });
  });

  it.each(["limit=0", "limit=51", "limit=no", "offset=-1", "offset=1.2"])(
    "rejects invalid pagination %s before loading the catalog", async (query) => {
      const app = await createApp();
      const response = await app.inject({ method: "GET", url: `${base}?${query}` });
      expect(response.statusCode).toBe(400);
      expect(mocks.list).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["GET", base],
    ["GET", `${base}/ignored`],
    ["POST", `${base}/analyze`],
    ["POST", `${base}/dismiss`],
    ["DELETE", `${base}/dismiss`],
  ] as const)("requires a web user before %s %s reaches any service", async (method, url) => {
    mocks.authenticated = false;
    const app = await createApp();
    const response = await app.inject({ method, url, ...(url.endsWith("dismiss") ? { payload: { projectIds } } : {}) });
    expect(response.statusCode).toBe(401);
    for (const service of [mocks.list, mocks.analyze, mocks.ignored, mocks.dismiss, mocks.restore, mocks.merge]) {
      expect(service).not.toHaveBeenCalled();
    }
  });

  it("runs semantic discovery explicitly and then returns the current candidate page", async () => {
    const app = await createApp();
    const response = await app.inject({ method: "POST", url: `${base}/analyze` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(payload);
    expect(mocks.analyze).toHaveBeenCalledOnce();
    expect(mocks.list).toHaveBeenCalledWith({ limit: 8, offset: 0 });
    expect(mocks.analyze.mock.invocationCallOrder[0]).toBeLessThan(mocks.list.mock.invocationCallOrder[0]!);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("does not report discovery success after an analysis failure", async () => {
    mocks.analyze.mockRejectedValue(Object.assign(new Error("Analysis already running"), { statusCode: 409 }));
    const app = await createApp();
    const response = await app.inject({ method: "POST", url: `${base}/analyze` });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toContain("already running");
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("lists prior keep-separate decisions for later restoration", async () => {
    const ignored = [{ projectIds: projectIds.map((id) => id.toLowerCase()), projectNames: ["主项目", "原候选"] }];
    mocks.ignored.mockResolvedValue(ignored);
    const app = await createApp();
    const response = await app.inject({ method: "GET", url: `${base}/ignored` });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: ignored });
    expect(mocks.ignored).toHaveBeenCalledOnce();
    expect(mocks.list).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"] as const)("%s records only the requested review decision", async (method) => {
    const app = await createApp();
    const response = await app.inject({ method, url: `${base}/dismiss`, payload: { projectIds } });
    expect(response.statusCode).toBe(200);
    const expected = projectIds.map((id) => id.toLowerCase());
    if (method === "POST") {
      expect(mocks.dismiss).toHaveBeenCalledWith(expected);
      expect(mocks.restore).not.toHaveBeenCalled();
    } else {
      expect(mocks.restore).toHaveBeenCalledWith(expected);
      expect(mocks.dismiss).not.toHaveBeenCalled();
    }
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it.each([
    { projectIds: [projectIds[0]] },
    { projectIds: Array.from({ length: 21 }, (_, index) => `abcdef00-0000-4000-8000-${String(index).padStart(12, "0")}`) },
    { projectIds: [...projectIds, projectIds[0]!.toLowerCase()] },
    { projectIds: [projectIds[0], "missing"] },
    { projectIds: [projectIds[0], projectIds[0]!.toLowerCase()] },
    { projectIds: [] },
    {},
  ])("rejects malformed or self-paired review decisions: %j", async (body) => {
    const app = await createApp();
    for (const method of ["POST", "DELETE"] as const) {
      const response = await app.inject({ method, url: `${base}/dismiss`, payload: body });
      expect(response.statusCode).toBe(400);
    }
    expect(mocks.dismiss).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it("preserves a missing-project failure when recording a decision", async () => {
    mocks.dismiss.mockRejectedValue(Object.assign(new Error("Project not found"), { statusCode: 404 }));
    const app = await createApp();
    const response = await app.inject({ method: "POST", url: `${base}/dismiss`, payload: { projectIds } });
    expect(response.statusCode).toBe(404);
    expect(mocks.merge).not.toHaveBeenCalled();
  });

  it.each(["POST", "DELETE"] as const)("%s accepts a whole group without executing a merge", async (method) => {
    const app = await createApp();
    const group = [...projectIds, "ABCDEF00-0000-4000-8000-000000000003"];
    const response = await app.inject({ method, url: `${base}/dismiss`, payload: { projectIds: group } });
    expect(response.statusCode).toBe(200);
    expect(method === "POST" ? mocks.dismiss : mocks.restore).toHaveBeenCalledWith(group.map((id) => id.toLowerCase()));
    expect(mocks.merge).not.toHaveBeenCalled();
  });
});
