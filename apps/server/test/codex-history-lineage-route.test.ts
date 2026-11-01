import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateDevice: vi.fn(),
  backfill: vi.fn(),
  ingest: vi.fn(),
  captureFailure: vi.fn(),
  classify: vi.fn(),
  setting: vi.fn(),
  operationLog: vi.fn(),
}));
vi.mock("../src/services/auth.js", () => ({
  authenticateDevice: mocks.authenticateDevice,
  authenticateWebSession: vi.fn(),
}));
vi.mock("../src/services/codex-history-lineage.js", () => ({ backfillCodexHistoryLineage: mocks.backfill }));
vi.mock("../src/services/capture.js", () => ({
  IncrementalBaseMismatchError: class extends Error {},
  ingestCapture: mocks.ingest,
  recordCaptureFailure: mocks.captureFailure,
}));
vi.mock("../src/services/queue.js", () => ({ enqueueConversationClassification: mocks.classify }));
vi.mock("../src/services/settings.js", () => ({ getBooleanSetting: mocks.setting }));
vi.mock("../src/services/operation-log.js", () => ({ writeOperationLog: mocks.operationLog }));

import { captureRoutes } from "../src/routes/captures.js";

const payload = { relations: [{ sessionId: "child", parentSessionId: "parent" }] };
const device = { id: "device-id", name: "QML-PC", kind: "local" };

describe("Codex history lineage route", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.authenticateDevice.mockImplementation(async (token) => token === "valid-device-token" ? device : null);
    app = Fastify();
    await captureRoutes(app);
  });
  afterEach(async () => { await app.close(); });

  it.each([undefined, "invalid-device-token"])("rejects missing or invalid device credentials without writes (%s)", async (token) => {
    const response = await app.inject({
      method: "POST", url: "/api/v1/captures/codex-lineage", payload,
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "Valid device token required" });
    expect(mocks.authenticateDevice).toHaveBeenCalledWith(token);
    for (const write of [mocks.backfill, mocks.operationLog, mocks.ingest, mocks.captureFailure, mocks.classify]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it("passes an authorized request only to metadata backfill and records its summary", async () => {
    const result = { updated: 1, unchanged: 0, notFound: 0, rejected: 0 };
    mocks.backfill.mockResolvedValue(result);
    const response = await app.inject({
      method: "POST", url: "/api/v1/captures/codex-lineage", payload,
      headers: { authorization: "Bearer valid-device-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(mocks.backfill).toHaveBeenCalledExactlyOnceWith(payload);
    expect(mocks.operationLog).toHaveBeenCalledWith(expect.objectContaining({
      scope: "capture", status: "complete", entityType: "device", entityId: device.id, metadata: result,
    }));
    for (const other of [mocks.ingest, mocks.captureFailure, mocks.classify, mocks.setting]) {
      expect(other).not.toHaveBeenCalled();
    }
  });

  it("returns unchanged/missing/rejected counts without logging a new capture", async () => {
    const result = { updated: 0, unchanged: 1, notFound: 1, rejected: 1 };
    mocks.backfill.mockResolvedValue(result);
    const response = await app.inject({
      method: "POST", url: "/api/v1/captures/codex-lineage", payload,
      headers: { authorization: "Bearer valid-device-token" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(result);
    expect(mocks.operationLog).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.classify).not.toHaveBeenCalled();
  });
});
