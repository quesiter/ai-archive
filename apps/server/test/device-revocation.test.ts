import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ existing: { id: "11111111-1111-4111-8111-111111111111", revokedAt: null as Date | null }, update: vi.fn(), remove: vi.fn(), log: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: {
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [mocks.existing] }) }) }),
  update: () => ({ set: (value: unknown) => ({ where: async () => mocks.update(value) }) }),
  delete: mocks.remove,
} }));
vi.mock("../src/http.js", () => ({ requireWebUser: async () => ({ id: "admin" }), requireDevice: vi.fn(), errorMessage: String }));
vi.mock("../src/services/auth.js", () => ({ claimPairingCode: vi.fn(), createPairingCode: vi.fn() }));
vi.mock("../src/services/operation-log.js", () => ({ writeOperationLog: mocks.log }));
vi.mock("../src/services/device-components.js", () => ({ discoverDeviceComponents: vi.fn(), publicDeviceComponent: vi.fn(), resolveDeviceComponent: vi.fn() }));
import { deviceRoutes } from "../src/routes/devices.js";
afterEach(() => { vi.clearAllMocks(); mocks.existing.revokedAt = null; });
describe("device unpairing preserves historical sources", () => {
  it.each([false, true])("retains the device when already revoked=%s", async (revoked) => {
    mocks.existing.revokedAt = revoked ? new Date("2026-10-07") : null;
    const app = Fastify();
    await app.register(deviceRoutes);
    try {
      const result = await app.inject({ method: "DELETE", url: `/api/v1/devices/${mocks.existing.id}` });
      expect(result.statusCode).toBe(204);
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.update).toHaveBeenCalledTimes(revoked ? 0 : 1);
      if (!revoked) expect(mocks.update).toHaveBeenCalledWith({ revokedAt: expect.any(Date) });
    } finally { await app.close(); }
  });
});