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
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
}
