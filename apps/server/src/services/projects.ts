export function normalizeProjectName(value: string): {
  name: string;
  normalizedName: string;
} {
  const name = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return {
    name,
    normalizedName: name.toLocaleLowerCase("en-US"),
  };
}

export function projectConflictError(): Error & { statusCode: number } {
  return Object.assign(
    new Error("A project with the normalized name already exists"),
    { statusCode: 409 },
  );
}

export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && error.code === "23505") return true;
  // Drizzle wraps PostgreSQL errors in a query error with the original cause.
  return "cause" in error && error.cause !== error && isUniqueViolation(error.cause);
}
