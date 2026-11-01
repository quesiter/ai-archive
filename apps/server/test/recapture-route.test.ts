import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { ZodError } from "zod";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ web: vi.fn(), device: vi.fn(), create: vi.fn(), list: vi.fn(), change: vi.fn(), next: vi.fn(), report: vi.fn() }));
vi.mock("../src/services/auth.js", () => ({ authenticateWebSession: mocks.web, authenticateDevice: mocks.device }));
vi.mock("../src/services/recapture.js", () => ({ createRecaptureJob: mocks.create, listRecaptureJobs: mocks.list,
  changeRecaptureJob: mocks.change, nextRecaptureTask: mocks.next, reportRecaptureTask: mocks.report }));
import { recaptureRoutes } from "../src/routes/recapture.js";
import { config } from "../src/config.js";
const id = "11111111-1111-4111-8111-111111111111";
async function app() {
  const server = Fastify(); await server.register(cookie);
  server.setErrorHandler((error, _request, reply) => reply.code(error instanceof ZodError ? 400 : 500).send({ error: error instanceof Error ? error.message : String(error) }));
  await recaptureRoutes(server); return server;
}
afterEach(() => vi.resetAllMocks());
describe("recapture API boundaries", () => {
  it("accepts a skipped result without accepting a client completeness claim", async () => {
    const server = await app(); mocks.device.mockResolvedValue({ id, kind: "chrome_extension" });
    try {
      const payload = { jobId: id, itemId: id, leaseToken: id, outcome: "skipped", message: "Source denied access" };
      mocks.report.mockResolvedValue({ ok: true, status: "skipped" });
      expect((await server.inject({ method: "POST", url: "/api/v1/recapture/report", payload })).statusCode).toBe(200);
      expect(mocks.report).toHaveBeenCalledWith(id, payload);
    } finally { await server.close(); }
  });
  it("requires a web login and same-origin mutation before creating browser work", async () => {
    const server = await app();
    try {
      const request = { method: "POST" as const, url: "/api/v1/recapture/jobs", payload: { deviceId: id, allIncomplete: true } };
      expect((await server.inject(request)).statusCode).toBe(401);
      mocks.web.mockResolvedValue({ id });
      expect((await server.inject({ ...request, headers: { origin: "https://unrelated.example" } })).statusCode).toBe(403);
      expect(mocks.create).not.toHaveBeenCalled();
      mocks.create.mockResolvedValue({ id, count: 1 });
      expect((await server.inject({ ...request, headers: { origin: config.appOrigin } })).statusCode).toBe(200);
      expect(mocks.create).toHaveBeenCalledWith(id, undefined);
    } finally { await server.close(); }
  });
  it("rejects ambiguous scopes and batches over 500 entries", async () => {
    mocks.web.mockResolvedValue({ id }); const server = await app();
    try {
      for (const payload of [{ deviceId: id }, { deviceId: id, allIncomplete: true, conversationIds: [id] },
        { deviceId: id, conversationIds: [] }, { deviceId: id, conversationIds: Array(501).fill(id) }]) {
        expect((await server.inject({ method: "POST", url: "/api/v1/recapture/jobs", headers: { origin: config.appOrigin }, payload })).statusCode).toBe(400);
      }
      expect(mocks.create).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
  it("requires a Chrome device for task leases and rejects client completeness claims", async () => {
    const server = await app();
    try {
      expect((await server.inject({ method: "POST", url: "/api/v1/recapture/next", payload: {} })).statusCode).toBe(401);
      mocks.device.mockResolvedValue({ id, kind: "openclaw_sync" });
      expect((await server.inject({ method: "POST", url: "/api/v1/recapture/next", payload: {} })).statusCode).toBe(403);
      mocks.device.mockResolvedValue({ id, kind: "chrome_extension" });
      expect((await server.inject({ method: "POST", url: "/api/v1/recapture/report", payload: { jobId: id, itemId: id, leaseToken: id, complete: true } })).statusCode).toBe(400);
      expect(mocks.report).not.toHaveBeenCalled();
    } finally { await server.close(); }
  });
});
