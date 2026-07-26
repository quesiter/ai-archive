ALTER TABLE "conversation_revisions"
ADD COLUMN IF NOT EXISTS "capture_mode" text DEFAULT 'full' NOT NULL,
ADD COLUMN IF NOT EXISTS "trigger_reason" text,
ADD COLUMN IF NOT EXISTS "base_revision_id" uuid,
ADD COLUMN IF NOT EXISTS "base_message_count" integer;

ALTER TABLE "capture_runs"
ADD COLUMN IF NOT EXISTS "capture_mode" text DEFAULT 'full' NOT NULL,
ADD COLUMN IF NOT EXISTS "trigger_reason" text,
ADD COLUMN IF NOT EXISTS "base_revision_id" uuid,
ADD COLUMN IF NOT EXISTS "base_message_count" integer;

