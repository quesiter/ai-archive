ALTER TABLE projects ADD COLUMN IF NOT EXISTS normalized_name text;

UPDATE projects
SET name = regexp_replace(btrim(normalize(name, NFKC)), '\s+', ' ', 'g');

UPDATE projects
SET name = '未命名项目-' || left(id::text, 8)
WHERE name = '';

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY lower(regexp_replace(btrim(normalize(name, NFKC)), '\s+', ' ', 'g'))
      ORDER BY created_at, id
    ) AS duplicate_number
  FROM projects
)
UPDATE projects AS project
SET name = project.name || ' (' || ranked.duplicate_number::text || ')'
FROM ranked
WHERE project.id = ranked.id
  AND ranked.duplicate_number > 1;

UPDATE projects
SET normalized_name = lower(
  regexp_replace(btrim(normalize(name, NFKC)), '\s+', ' ', 'g')
);

ALTER TABLE projects ALTER COLUMN normalized_name SET NOT NULL;
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS projects_normalized_name_uidx
  ON projects(normalized_name);
CREATE INDEX IF NOT EXISTS projects_name_idx ON projects(name);
