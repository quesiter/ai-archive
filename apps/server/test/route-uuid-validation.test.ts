import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/services/auth.js", () => ({
  authenticateWebSession: vi.fn(async () => ({
    id: "11111111-1111-1111-1111-111111111111",
    username: "admin",
  })),
  authenticateDevice: vi.fn(async () => null),
  bootstrapAdmin: vi.fn(),
  claimPairingCode: vi.fn(),
  createPairingCode: vi.fn(),
  isInitialized: vi.fn(async () => true),
  login: vi.fn(),
  logout: vi.fn(),
}));

describe("UUID route parameter validation", () => {
  let app: Awaited<ReturnType<typeof import("../src/app.js")["buildApp"]>>;

  beforeAll(async () => {
    const { buildApp } = await import("../src/app.js");
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const invalidRoutes: Array<["GET" | "PATCH" | "DELETE", string]> = [
    ["GET", "/api/v1/reports/not-a-uuid"],
    ["GET", "/api/v1/conversations/not-a-uuid"],
    ["GET", "/api/v1/projects/not-a-uuid/export?format=md"],
    ["PATCH", "/api/v1/devices/not-a-uuid"],
    ["DELETE", "/api/v1/redaction-rules/not-a-uuid"],
  ];

  it.each(invalidRoutes)("returns 400 before invalid %s %s reaches PostgreSQL", async (method, url) => {
    const response = await app.inject({
      method,
      url,
      headers: { origin: "http://localhost:5173" },
      ...(method === "PATCH" ? { payload: { name: "renamed" } } : {}),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Request validation failed" });
  });
});
