ALTER TABLE "conversation_revisions"
ADD COLUMN IF NOT EXISTS "archived_text_units" bigint NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "reasoning_text_units" bigint NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS "tool_text_units" bigint NOT NULL DEFAULT 0;

WITH revision_stats AS (
  SELECT
    message.revision_id,
    COALESCE(sum(char_length(segment.content)), 0) AS archived_text_units,
    COALESCE(sum(
      CASE WHEN segment.type = 'reasoning'
        THEN char_length(segment.content) ELSE 0 END
    ), 0) AS reasoning_text_units,
    COALESCE(sum(
      CASE WHEN segment.type = 'tool_status' OR message.role = 'tool'
        THEN char_length(segment.content) ELSE 0 END
    ), 0) AS tool_text_units
  FROM messages message
  INNER JOIN message_segments segment ON segment.message_id = message.id
  GROUP BY message.revision_id
)
UPDATE conversation_revisions revision
SET
  archived_text_units = stats.archived_text_units,
  reasoning_text_units = stats.reasoning_text_units,
  tool_text_units = stats.tool_text_units
FROM revision_stats stats
WHERE stats.revision_id = revision.id;

ALTER TABLE "conversation_revisions"
DROP CONSTRAINT IF EXISTS "conversation_revisions_text_units_nonnegative";

ALTER TABLE "conversation_revisions"
ADD CONSTRAINT "conversation_revisions_text_units_nonnegative"
CHECK (
  "archived_text_units" >= 0 AND
  "reasoning_text_units" >= 0 AND
  "tool_text_units" >= 0
);
