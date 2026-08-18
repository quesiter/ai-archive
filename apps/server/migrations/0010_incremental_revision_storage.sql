ALTER TABLE "conversation_revisions"
ADD COLUMN IF NOT EXISTS "storage_kind" text DEFAULT 'snapshot' NOT NULL;

ALTER TABLE "conversation_revisions"
DROP CONSTRAINT IF EXISTS "conversation_revisions_storage_kind_check";

ALTER TABLE "conversation_revisions"
ADD CONSTRAINT "conversation_revisions_storage_kind_check"
CHECK ("storage_kind" IN ('snapshot', 'delta'));

CREATE INDEX IF NOT EXISTS "conversation_revision_base_idx"
ON "conversation_revisions" ("base_revision_id");

-- Existing revisions contain complete snapshots, including historical rows whose
-- capture_mode is 'append'. They intentionally remain snapshots until the
-- separately verified online compactor removes their duplicated prefix rows.
UPDATE "conversation_revisions"
SET "storage_kind" = 'snapshot'
WHERE "storage_kind" IS NULL;
