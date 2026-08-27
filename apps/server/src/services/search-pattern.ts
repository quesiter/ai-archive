/** Escape user text for a literal PostgreSQL LIKE/ILIKE contains search. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

export function literalContainsPattern(value: string): string {
  return `%${escapeLikePattern(value)}%`;
}
