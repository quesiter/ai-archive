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

vi.mock("../src/services/restore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/services/restore.js")>()),
  maintenanceRestoreJob: vi.fn(async () => null),
}));

vi.mock("../src/services/device-components.js", () => ({
  discoverDeviceComponents: vi.fn(async () => []),
  publicDeviceComponent: vi.fn((component) => component),
  resolveDeviceComponent: vi.fn(async () => null),
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

  const invalidRoutes: Array<["GET" | "POST" | "PUT" | "PATCH" | "DELETE", string]> = [
    ["PATCH", "/api/v1/tags/not-a-uuid"],
    ["POST", "/api/v1/tags/not-a-uuid/merge"],
    ["DELETE", "/api/v1/tags/not-a-uuid"],
    ["POST", "/api/v1/conversations/not-a-uuid/tags"],
    ["POST", "/api/v1/imports/not-a-uuid/retry"],
    ["PATCH", "/api/v1/redaction-rules/not-a-uuid"],
    ["DELETE", "/api/v1/redaction-rules/not-a-uuid"],
    ["DELETE", "/api/v1/saved-searches/not-a-uuid"],
    ["PATCH", "/api/v1/devices/not-a-uuid"],
    ["DELETE", "/api/v1/devices/not-a-uuid"],
    ["GET", "/api/v1/reports/not-a-uuid"],
    ["GET", "/api/v1/reports/not-a-uuid/download"],
    ["POST", "/api/v1/reports/not-a-uuid/email/retry"],
    ["DELETE", "/api/v1/auth/sessions/not-a-uuid"],
    ["GET", "/api/v1/backups/restores/not-a-uuid"],
    ["DELETE", "/api/v1/backups/restores/not-a-uuid"],
    ["DELETE", "/api/v1/backups/restores/not-a-uuid/staged-file"],
    ["POST", "/api/v1/backups/restores/not-a-uuid/retry"],
    ["GET", "/api/v1/conversations/not-a-uuid"],
    ["GET", "/api/v1/conversations/not-a-uuid/revisions/not-a-uuid/diff"],
    ["GET", "/api/v1/conversations/not-a-uuid/export?format=md"],
    ["DELETE", "/api/v1/conversations/not-a-uuid"],
    ["POST", "/api/v1/conversations/not-a-uuid/restore"],
    ["DELETE", "/api/v1/conversations/not-a-uuid/permanent"],
    ["PATCH", "/api/v1/projects/not-a-uuid"],
    ["GET", "/api/v1/projects/not-a-uuid/export?format=md"],
    ["POST", "/api/v1/projects/not-a-uuid/context"],
    ["GET", "/api/v1/projects/not-a-uuid/timeline"],
    ["POST", "/api/v1/projects/not-a-uuid/merge"],
    ["PUT", "/api/v1/conversations/not-a-uuid/project"],
    ["GET", "/api/v1/classification/tasks/not-a-uuid"],
  ];

  it.each(invalidRoutes)("returns 400 before invalid %s %s reaches PostgreSQL", async (method, url) => {
    const response = await app.inject({
      method,
      url,
      headers: { origin: "http://localhost:5173" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Request validation failed" });
  });

  it("does not apply UUID validation to enumerated device component IDs", async () => {
    const validComponentResponse = await app.inject({
      method: "GET",
      url: "/api/v1/device-components/chrome/download",
      headers: { origin: "http://localhost:5173" },
    });
    expect(validComponentResponse.statusCode).toBe(404);
    expect(validComponentResponse.json()).toEqual({
      error: "Device component is not available",
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/device-components/not-supported/download",
      headers: { origin: "http://localhost:5173" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: "Request validation failed",
      issues: [
        expect.objectContaining({
          path: ["componentId"],
        }),
      ],
    });
    expect(response.json().issues).not.toContainEqual(
      expect.objectContaining({ message: "Invalid UUID" }),
    );
  });

  it.each([
    ["DELETE", "/api/v1/conversations/11111111-1111-1111-1111-111111111111/tags/not-a-uuid"],
    ["GET", "/api/v1/conversations/11111111-1111-1111-1111-111111111111/revisions/not-a-uuid/diff"],
  ] as const)("validates secondary UUID path parameters for %s %s", async (method, url) => {
    const response = await app.inject({
      method,
      url,
      headers: { origin: "http://localhost:5173" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: "Request validation failed" });
  });
});
