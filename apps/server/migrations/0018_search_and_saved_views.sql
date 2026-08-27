-- This migration can process millions of historical message rows. Keep the
-- session within the PostgreSQL container budget while avoiding the default
-- 4 MiB work areas that cause excessive temporary-file churn on NAS storage.
SET LOCAL work_mem = '64MB';
SET LOCAL maintenance_work_mem = '256MB';

CREATE TABLE IF NOT EXISTS conversation_search_chunks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES conversation_revisions(id) ON DELETE CASCADE,
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  chunk_index integer NOT NULL,
  content text NOT NULL,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_search_chunks_message_chunk_uidx UNIQUE(message_id, chunk_index)
);

-- Backfill the heap before building secondary indexes. Maintaining the GIN
-- index row-by-row made production-shaped upgrades spend most of their time
-- in WALWrite/DataFileWrite waits and greatly amplified Btrfs I/O.
INSERT INTO conversation_search_chunks(revision_id, message_id, chunk_index, content)
SELECT
  message_text.revision_id,
  message_text.message_id,
  chunks.chunk_index,
  substring(message_text.content FROM chunks.chunk_index * 4000 + 1 FOR 4000)
FROM (
  SELECT
    messages.revision_id,
    messages.id AS message_id,
    string_agg(message_segments.content, E'\n' ORDER BY message_segments.ordinal) AS content
  FROM messages
  INNER JOIN message_segments ON message_segments.message_id = messages.id
  GROUP BY messages.revision_id, messages.id
) AS message_text
CROSS JOIN LATERAL generate_series(
  0,
  greatest(ceil(length(message_text.content)::numeric / 4000)::integer - 1, 0)
) AS chunks(chunk_index)
ON CONFLICT (message_id, chunk_index) DO NOTHING;

CREATE INDEX IF NOT EXISTS conversation_search_chunks_revision_idx
  ON conversation_search_chunks(revision_id);
CREATE INDEX IF NOT EXISTS conversation_search_chunks_message_idx
  ON conversation_search_chunks(message_id);
CREATE INDEX IF NOT EXISTS conversation_search_chunks_vector_gin_idx
  ON conversation_search_chunks USING gin(search_vector);

CREATE TABLE IF NOT EXISTS saved_searches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL,
  query jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS saved_searches_normalized_name_uidx
  ON saved_searches(normalized_name);

CREATE INDEX IF NOT EXISTS conversations_deleted_at_idx ON conversations(deleted_at);
