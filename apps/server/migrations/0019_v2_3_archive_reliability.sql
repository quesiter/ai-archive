ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pending_totp_secret_encrypted text,
  ADD COLUMN IF NOT EXISTS pending_totp_expires_at timestamptz;

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS client_version text,
  ADD COLUMN IF NOT EXISTS os text,
  ADD COLUMN IF NOT EXISTS last_scan_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_successful_sync_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS tracked_files integer,
  ADD COLUMN IF NOT EXISTS skipped_files integer;

ALTER TABLE conversation_revisions
  ADD COLUMN IF NOT EXISTS captured_title text,
  ADD COLUMN IF NOT EXISTS captured_canonical_url text,
  ADD COLUMN IF NOT EXISTS metadata_captured boolean NOT NULL DEFAULT false;

-- Pre-V2.3 revisions did not preserve title/URL per revision, so those values
-- must remain unknown rather than being incorrectly backfilled with the latest
-- Conversation metadata. New writes use the true default below.
ALTER TABLE conversation_revisions ALTER COLUMN metadata_captured SET DEFAULT true;

ALTER TABLE capture_runs
  ADD COLUMN IF NOT EXISTS adapter_version text,
  ADD COLUMN IF NOT EXISTS message_count integer;

UPDATE capture_runs run
SET
  adapter_version = revision.adapter_version,
  message_count = revision.message_count
FROM conversations conversation, conversation_revisions revision
WHERE conversation.provider = run.provider
  AND conversation.external_session_id = run.external_session_id
  AND revision.conversation_id = conversation.id
  AND revision.snapshot_hash = run.snapshot_hash
  AND (run.adapter_version IS NULL OR run.message_count IS NULL);

ALTER TABLE reports
  ADD COLUMN IF NOT EXISTS email_status text NOT NULL DEFAULT 'not_configured',
  ADD COLUMN IF NOT EXISTS email_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_error text;

CREATE TABLE IF NOT EXISTS restore_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  staged_path text NOT NULL,
  status text NOT NULL,
  progress integer NOT NULL DEFAULT 0,
  phase_message text,
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restore_jobs_status_check CHECK (
    status IN (
      'queued', 'validating', 'validated', 'restoring',
      'rebuilding_search', 'verifying', 'completed', 'failed', 'cancelled'
    )
  ),
  CONSTRAINT restore_jobs_progress_check CHECK (progress BETWEEN 0 AND 100)
);
CREATE INDEX IF NOT EXISTS restore_jobs_status_updated_idx
  ON restore_jobs(status, updated_at);
CREATE INDEX IF NOT EXISTS restore_jobs_created_idx
  ON restore_jobs(created_at);

CREATE INDEX IF NOT EXISTS capture_runs_adapter_health_idx
  ON capture_runs(provider, adapter_version, created_at DESC);
