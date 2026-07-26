-- A user-facing archive deletion is explicit and irreversible. Purge rows
-- left behind by the old soft-delete implementation before new captures can
-- resurrect them.
WITH deleted_conversations AS (
  SELECT id
  FROM conversations
  WHERE deleted_at IS NOT NULL
), rewritten AS (
  SELECT
    k.id,
    COALESCE(
      jsonb_agg(reference) FILTER (
        WHERE reference->>'conversationId' IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM deleted_conversations d
            WHERE d.id::text = reference->>'conversationId'
          )
      ),
      '[]'::jsonb
    ) AS source_references
  FROM knowledge_items k
  CROSS JOIN LATERAL jsonb_array_elements(k.source_references) AS reference
  GROUP BY k.id
)
UPDATE knowledge_items k
SET source_references = rewritten.source_references,
    updated_at = now()
FROM rewritten
WHERE k.id = rewritten.id
  AND k.source_references <> rewritten.source_references;

UPDATE knowledge_items
SET supersedes_id = NULL
WHERE supersedes_id IN (
  SELECT id
  FROM knowledge_items
  WHERE jsonb_array_length(source_references) = 0
);

DELETE FROM knowledge_items
WHERE jsonb_array_length(source_references) = 0;

DELETE FROM capture_runs cr
USING conversations c
WHERE c.deleted_at IS NOT NULL
  AND cr.provider = c.provider
  AND cr.external_session_id = c.external_session_id;

DELETE FROM conversations
WHERE deleted_at IS NOT NULL;
