DROP INDEX IF EXISTS conversation_revision_search_trgm_idx;

UPDATE conversation_revisions
SET search_text =
  left(search_text, 1900) ||
  E'\n[search index bounded: legacy search text trimmed by migration]'
WHERE length(search_text) > 2048;

CREATE INDEX IF NOT EXISTS conversation_revision_search_trgm_idx
ON conversation_revisions USING gin(search_text gin_trgm_ops);
