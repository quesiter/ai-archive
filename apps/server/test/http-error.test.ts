import { afterAll, describe, expect, it } from "vitest";
import { closeDatabase } from "../src/db.js";
import { errorMessage } from "../src/http.js";

afterAll(async () => {
  await closeDatabase();
});

describe("errorMessage", () => {
  it("hides oversized SQL query parameters from client-visible errors", () => {
    const error = Object.assign(
      new Error(`Failed query: insert into "conversation_revisions" values (...)\nparams: ${"x".repeat(50_000)}`),
      { cause: new Error("index row size exceeds maximum") },
    );

    expect(errorMessage(error)).toBe(
      "Database query failed: index row size exceeds maximum",
    );
  });
});
