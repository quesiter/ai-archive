-- Literal substring search and token search are combined with OR. Both arms
-- need indexes to avoid scanning every message chunk for selective queries.
-- Bound index-build memory for NAS PostgreSQL containers.
SET LOCAL maintenance_work_mem = '128MB';
CREATE INDEX IF NOT EXISTS conversation_search_chunks_content_trgm_idx
  ON conversation_search_chunks USING gin(content gin_trgm_ops);
