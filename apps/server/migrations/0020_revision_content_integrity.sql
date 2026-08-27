ALTER TABLE conversation_revisions
  ADD COLUMN IF NOT EXISTS revision_identity_hash text,
  ADD COLUMN IF NOT EXISTS content_integrity_hash text;

ALTER TABLE capture_runs
  ADD COLUMN IF NOT EXISTS payload_identity_hash text;

DROP INDEX IF EXISTS conversation_revision_snapshot_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS conversation_revision_identity_uidx
  ON conversation_revisions(conversation_id, revision_identity_hash);
CREATE INDEX IF NOT EXISTS conversation_revision_snapshot_idx
  ON conversation_revisions(conversation_id, snapshot_hash);

-- Existing snapshots may have been intentionally transformed by historical
-- redaction or legacy truncation rules. They remain explicitly unverifiable;
-- all new captures persist a hash of the exact reconstructable representation.
-- Revision identity is separate so title/URL-only changes become revisions
-- without breaking legacy snapshot hashes or pre-upgrade idempotency records.
