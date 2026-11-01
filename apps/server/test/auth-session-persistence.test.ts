import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ rows: [] as any[], renewed: [] as any[], set: vi.fn() }));
vi.mock("../src/db.js", () => ({ db: {
  select: () => ({ from: () => ({ innerJoin: () => ({ where: () => ({ limit: async () => mocks.rows }) }) }) }),
  update: () => ({ set: (value: unknown) => { mocks.set(value); return { where: () => ({ returning: async () => mocks.renewed }) }; } }),
} }));
import { authenticateWebSession, WEB_SESSION_MAX_AGE } from "../src/services/auth.js";
describe("persistent web sessions", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.rows = []; mocks.renewed = [{ id: "session" }]; });
  it("does not revive expired or revoked sessions", async () => {
    const renew = vi.fn();
    expect(await authenticateWebSession("token", renew)).toBeNull();
    expect(await authenticateWebSession(undefined, renew)).toBeNull();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
  });
  it("extends existing sessions to 90 days and refreshes the browser expiry", async () => {
    mocks.rows = [{ id: "admin", username: "admin", sessionId: "session", expiresAt: new Date(Date.now() + 30 * 86400000) }];
    const renew = vi.fn();
    expect(await authenticateWebSession("token", renew)).toEqual({ id: "admin", username: "admin" });
    const expiry = mocks.set.mock.calls[0]![0].expiresAt as Date;
    expect(expiry.getTime() - Date.now()).toBeGreaterThan(WEB_SESSION_MAX_AGE * 1000 - 1000);
    expect(renew).toHaveBeenCalledWith(expiry);
  });
  it("limits renewal writes to once per day", async () => {
    mocks.rows = [{ id: "admin", username: "admin", sessionId: "session", expiresAt: new Date(Date.now() + WEB_SESSION_MAX_AGE * 1000) }];
    const renew = vi.fn();
    await authenticateWebSession("token", renew);
    expect(mocks.set).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
  });
  it("does not restore a session revoked during renewal", async () => {
    mocks.rows = [{ id: "admin", username: "admin", sessionId: "session", expiresAt: new Date(Date.now() + 86400000) }];
    mocks.renewed = [];
    const renew = vi.fn();
    expect(await authenticateWebSession("token", renew)).toBeNull();
    expect(renew).not.toHaveBeenCalled();
  });
});
