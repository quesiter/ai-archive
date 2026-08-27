ALTER TABLE restore_jobs
  ADD COLUMN IF NOT EXISTS facts_committed_at timestamptz,
  ADD COLUMN IF NOT EXISTS staged_deleted_at timestamptz;

ALTER TABLE restore_jobs
  DROP CONSTRAINT IF EXISTS restore_jobs_status_check;

ALTER TABLE restore_jobs
  ADD CONSTRAINT restore_jobs_status_check CHECK (
    status IN (
      'queued', 'validating', 'validated', 'restoring',
      'rebuilding_search', 'verifying', 'recovery_required',
      'completed', 'failed', 'cancelled'
    )
  );

CREATE INDEX IF NOT EXISTS restore_jobs_staging_cleanup_idx
  ON restore_jobs(status, staged_deleted_at, completed_at);
