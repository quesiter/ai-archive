ALTER TABLE conversation_revisions
  ALTER COLUMN search_text SET DEFAULT '',
  ADD COLUMN presentation_message_count integer,
  ADD COLUMN stored_message_count integer,
  ADD COLUMN source_content_pending boolean,
  ADD COLUMN archive_review jsonb;
--> statement-breakpoint
DROP INDEX IF EXISTS conversation_revision_search_trgm_idx;
--> statement-breakpoint
UPDATE conversation_revisions SET search_text = '' WHERE search_text <> '';
--> statement-breakpoint
CREATE INDEX conversations_active_updated_idx ON conversations(updated_at DESC, id DESC)
  WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE INDEX conversations_title_trgm_idx ON conversations USING gin(title gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX conversation_revision_current_idx ON conversation_revisions
  (conversation_id, is_accumulated DESC, (completeness = 'complete') DESC, captured_at DESC, created_at DESC, id DESC);
--> statement-breakpoint
CREATE INDEX conversation_revision_read_model_pending_idx ON conversation_revisions(id)
  WHERE presentation_message_count IS NULL;
--> statement-breakpoint
CREATE TABLE conversation_revision_presentation (
  revision_id uuid NOT NULL REFERENCES conversation_revisions(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  stored_ordinal integer,
  variant_index integer,
  PRIMARY KEY (revision_id, ordinal),
  CHECK (stored_ordinal IS NOT NULL OR variant_index IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE conversation_revision_observations (
  revision_id uuid NOT NULL REFERENCES conversation_revisions(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('inactive', 'resolved', 'unresolved')),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  stored_ordinal integer,
  variant_index integer,
  observation_kind text,
  PRIMARY KEY (revision_id, category, ordinal),
  CHECK (stored_ordinal IS NOT NULL OR variant_index IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE conversation_summaries (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  revision_id uuid NOT NULL,
  message_count integer NOT NULL,
  archived_text_units bigint NOT NULL,
  reasoning_text_units bigint NOT NULL,
  tool_text_units bigint NOT NULL,
  reported_total_tokens bigint,
  reported_reasoning_output_tokens bigint,
  latest_activity_at timestamptz NOT NULL
);
--> statement-breakpoint
CREATE INDEX conversation_summaries_activity_idx ON conversation_summaries(latest_activity_at DESC);
--> statement-breakpoint
-- Refresh only the changed conversation. Ordinary captures have one accumulated
-- snapshot; the recursive arm preserves compatibility with legacy delta backups.
CREATE FUNCTION refresh_conversation_summary(target_id uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM conversations WHERE id = target_id) THEN RETURN; END IF;
  -- Serialize revision edits with conversation metadata updates and repair jobs.
  PERFORM 1 FROM conversations WHERE id = target_id FOR UPDATE;
  WITH RECURSIVE canonical AS (
    SELECT r.* FROM conversation_revisions r WHERE r.conversation_id = target_id
    ORDER BY r.is_accumulated DESC, (r.completeness = 'complete') DESC,
      r.captured_at DESC, r.created_at DESC, r.id DESC LIMIT 1
  ), chain AS (
    SELECT r.id, r.base_revision_id, r.storage_kind, r.archived_text_units,
      r.reasoning_text_units, r.tool_text_units, ARRAY[r.id] AS visited FROM canonical r
    UNION ALL
    SELECT r.id, r.base_revision_id, r.storage_kind, r.archived_text_units,
      r.reasoning_text_units, r.tool_text_units, c.visited || r.id
    FROM chain c JOIN conversation_revisions r ON r.id = c.base_revision_id
      AND r.conversation_id = target_id
    WHERE c.storage_kind = 'delta' AND NOT r.id = ANY(c.visited)
      AND cardinality(c.visited) < 10000
  )
  INSERT INTO conversation_summaries
    (conversation_id, revision_id, message_count, archived_text_units, reasoning_text_units,
      tool_text_units, reported_total_tokens, reported_reasoning_output_tokens, latest_activity_at)
  SELECT target_id, r.id, r.message_count,
    COALESCE((SELECT sum(archived_text_units) FROM chain), 0),
    COALESCE((SELECT sum(reasoning_text_units) FROM chain), 0),
    COALESCE((SELECT sum(tool_text_units) FROM chain), 0),
    r.reported_total_tokens, r.reported_reasoning_output_tokens, greatest(c.updated_at, r.captured_at)
  FROM canonical r JOIN conversations c ON c.id = target_id
  ON CONFLICT (conversation_id) DO UPDATE SET
    revision_id = excluded.revision_id, message_count = excluded.message_count,
    archived_text_units = excluded.archived_text_units,
    reasoning_text_units = excluded.reasoning_text_units, tool_text_units = excluded.tool_text_units,
    reported_total_tokens = excluded.reported_total_tokens,
    reported_reasoning_output_tokens = excluded.reported_reasoning_output_tokens,
    latest_activity_at = excluded.latest_activity_at;
  IF NOT FOUND THEN DELETE FROM conversation_summaries WHERE conversation_id = target_id; END IF;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION conversation_summary_revision_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM refresh_conversation_summary(OLD.conversation_id);
  ELSE
    PERFORM refresh_conversation_summary(NEW.conversation_id);
    IF TG_OP = 'UPDATE' AND OLD.conversation_id <> NEW.conversation_id THEN
      PERFORM refresh_conversation_summary(OLD.conversation_id);
    END IF;
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_summary_revision_changed
  AFTER INSERT OR UPDATE OR DELETE ON conversation_revisions
  FOR EACH ROW EXECUTE FUNCTION conversation_summary_revision_changed();
--> statement-breakpoint
CREATE FUNCTION conversation_summary_activity_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE conversation_summaries SET latest_activity_at = greatest(NEW.updated_at,
    (SELECT captured_at FROM conversation_revisions WHERE id = conversation_summaries.revision_id))
  WHERE conversation_id = NEW.id;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER conversation_summary_activity_changed AFTER UPDATE OF updated_at ON conversations
  FOR EACH ROW EXECUTE FUNCTION conversation_summary_activity_changed();
--> statement-breakpoint
SELECT refresh_conversation_summary(id) FROM conversations;
--> statement-breakpoint
-- Reviewed revisions are backfilled by the migration runner with the same
-- source-review projection used by capture ingestion (one conversation at a time).
UPDATE conversation_revisions SET presentation_message_count = message_count,
  stored_message_count = message_count, source_content_pending = false
WHERE merge_evidence->'sourceReview' IS NULL
  AND jsonb_array_length(coalesce(merge_evidence->'variants', '[]'::jsonb)) = 0;
