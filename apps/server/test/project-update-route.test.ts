import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
const projectId = "00000000-0000-4000-8000-000000000001";

vi.mock("../src/http.js", () => ({ requireWebUser: vi.fn(async () => true) }));
vi.mock("../src/db.js", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.values = values;
        return { where: () => ({ returning: async () => [{
          id: "00000000-0000-4000-8000-000000000001",
          name: "Existing project", description: "Keep this description", archived: false, ...values,
        }] }) };
      },
    }),
  },
}));
vi.mock("../src/services/settings.js", () => ({ getBooleanSetting: vi.fn(async () => false) }));

import { projectRoutes } from "../src/routes/projects.js";

beforeEach(() => { mocks.values = {}; });

describe("partial project updates", () => {
  it.each([{ archived: true }, { name: " Renamed project " }])("preserves an omitted description for %j", async (payload) => {
    const app = Fastify();
    await projectRoutes(app);
    try {
      const response = await app.inject({ method: "PATCH", url: `/api/v1/projects/${projectId}`, payload });
      expect(response.statusCode).toBe(200);
      expect(response.json().description).toBe("Keep this description");
      expect(mocks.values).not.toHaveProperty("description");
      if ("name" in payload) expect(mocks.values.name).toBe("Renamed project");
    } finally { await app.close(); }
  });

  it("allows an explicitly empty description to clear the saved value", async () => {
    const app = Fastify();
    await projectRoutes(app);
    try {
      const response = await app.inject({ method: "PATCH", url: `/api/v1/projects/${projectId}`, payload: { description: "" } });
      expect(response.statusCode).toBe(200);
      expect(response.json().description).toBe("");
      expect(mocks.values.description).toBe("");
    } finally { await app.close(); }
  });
});
