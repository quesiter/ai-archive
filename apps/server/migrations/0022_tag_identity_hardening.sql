-- Make visually equivalent Han/Latin tag spellings share one durable identity.
-- The target is the tag with the most conversation links; ties keep the oldest tag.
CREATE TEMP TABLE tag_identity_map AS
WITH normalized AS (
  SELECT
    tag.id,
    tag.created_at,
    regexp_replace(
      regexp_replace(
        regexp_replace(btrim(normalize(tag.name, NFKC)), '\s+', ' ', 'g'),
        '([A-Za-z0-9])\s+([一-龥])', '\1\2', 'g'
      ),
      '([一-龥])\s+([A-Za-z0-9])', '\1\2', 'g'
    ) AS canonical_name,
    count(link.conversation_id) AS relation_count
  FROM tags AS tag
  LEFT JOIN conversation_tags AS link ON link.tag_id = tag.id
  GROUP BY tag.id, tag.created_at, tag.name
), ranked AS (
  SELECT
    normalized.*,
    first_value(id) OVER (
      PARTITION BY lower(canonical_name)
      ORDER BY relation_count DESC, created_at, id
    ) AS target_id
  FROM normalized
)
SELECT id AS source_id, target_id, canonical_name
FROM ranked;

INSERT INTO conversation_tags (
  conversation_id,
  tag_id,
  confidence,
  source,
  locked_by_user,
  updated_at,
  created_at
)
SELECT
  link.conversation_id,
  identity.target_id,
  max(link.confidence),
  CASE WHEN bool_or(link.source = 'manual') THEN 'manual' ELSE 'auto' END,
  bool_or(link.locked_by_user),
  max(link.updated_at),
  min(link.created_at)
FROM conversation_tags AS link
INNER JOIN tag_identity_map AS identity ON identity.source_id = link.tag_id
GROUP BY link.conversation_id, identity.target_id
ON CONFLICT (conversation_id, tag_id) DO UPDATE SET
  confidence = greatest(conversation_tags.confidence, excluded.confidence),
  source = CASE
    WHEN conversation_tags.source = 'manual' OR excluded.source = 'manual' THEN 'manual'
    ELSE 'auto'
  END,
  locked_by_user = conversation_tags.locked_by_user OR excluded.locked_by_user,
  updated_at = greatest(conversation_tags.updated_at, excluded.updated_at);

DELETE FROM tags AS tag
USING tag_identity_map AS identity
WHERE tag.id = identity.source_id
  AND identity.source_id <> identity.target_id;

UPDATE tags AS tag
SET
  name = identity.canonical_name,
  normalized_name = lower(identity.canonical_name),
  updated_at = now()
FROM tag_identity_map AS identity
WHERE identity.source_id = identity.target_id
  AND tag.id = identity.target_id;

DROP TABLE tag_identity_map;
