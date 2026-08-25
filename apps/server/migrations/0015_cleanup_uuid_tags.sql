-- Some organization models returned an existing tag's database id in the
-- tag name field. Preserve those assignments by following id references to
-- the final semantic tag, then remove every UUID-shaped tag name.

WITH RECURSIVE tag_paths AS (
  SELECT
    source.id AS source_tag_id,
    target.id AS current_tag_id,
    ARRAY[source.id, target.id]::uuid[] AS visited
  FROM tags AS source
  INNER JOIN tags AS target ON lower(source.name) = target.id::text
  WHERE source.name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND source.id <> target.id

  UNION ALL

  SELECT
    path.source_tag_id,
    next_tag.id AS current_tag_id,
    path.visited || next_tag.id
  FROM tag_paths AS path
  INNER JOIN tags AS current_tag ON current_tag.id = path.current_tag_id
  INNER JOIN tags AS next_tag ON lower(current_tag.name) = next_tag.id::text
  WHERE current_tag.name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND NOT next_tag.id = ANY(path.visited)
),
resolved_targets AS (
  SELECT DISTINCT ON (path.source_tag_id)
    path.source_tag_id,
    path.current_tag_id AS target_tag_id
  FROM tag_paths AS path
  INNER JOIN tags AS target ON target.id = path.current_tag_id
  WHERE target.name !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ORDER BY path.source_tag_id, cardinality(path.visited) DESC
),
merged_links AS (
  SELECT
    link.conversation_id,
    resolved.target_tag_id,
    max(link.confidence) AS confidence,
    CASE WHEN bool_or(link.source = 'manual') THEN 'manual' ELSE 'auto' END AS source,
    bool_or(link.locked_by_user) AS locked_by_user,
    max(link.updated_at) AS updated_at,
    min(link.created_at) AS created_at
  FROM conversation_tags AS link
  INNER JOIN resolved_targets AS resolved ON resolved.source_tag_id = link.tag_id
  GROUP BY link.conversation_id, resolved.target_tag_id
)
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
  merged.conversation_id,
  merged.target_tag_id,
  merged.confidence,
  merged.source,
  merged.locked_by_user,
  merged.updated_at,
  merged.created_at
FROM merged_links AS merged
ON CONFLICT (conversation_id, tag_id) DO UPDATE SET
  confidence = CASE
    WHEN conversation_tags.confidence IS NULL THEN EXCLUDED.confidence
    WHEN EXCLUDED.confidence IS NULL THEN conversation_tags.confidence
    ELSE greatest(conversation_tags.confidence, EXCLUDED.confidence)
  END,
  source = CASE
    WHEN conversation_tags.source = 'manual' OR EXCLUDED.source = 'manual' THEN 'manual'
    ELSE 'auto'
  END,
  locked_by_user = conversation_tags.locked_by_user OR EXCLUDED.locked_by_user,
  updated_at = greatest(conversation_tags.updated_at, EXCLUDED.updated_at),
  created_at = least(conversation_tags.created_at, EXCLUDED.created_at);

DELETE FROM tags
WHERE name ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
