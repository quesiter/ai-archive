ALTER TABLE import_jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz;

UPDATE import_jobs
SET updated_at = COALESCE(completed_at, created_at, now())
WHERE updated_at IS NULL;

ALTER TABLE import_jobs ALTER COLUMN updated_at SET DEFAULT now();
ALTER TABLE import_jobs ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS import_jobs_status_updated_idx
  ON import_jobs(status, updated_at);
