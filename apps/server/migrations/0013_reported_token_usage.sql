ALTER TABLE "conversation_revisions"
ADD COLUMN IF NOT EXISTS "reported_input_tokens" bigint,
ADD COLUMN IF NOT EXISTS "reported_cached_input_tokens" bigint,
ADD COLUMN IF NOT EXISTS "reported_cache_write_input_tokens" bigint,
ADD COLUMN IF NOT EXISTS "reported_output_tokens" bigint,
ADD COLUMN IF NOT EXISTS "reported_reasoning_output_tokens" bigint,
ADD COLUMN IF NOT EXISTS "reported_total_tokens" bigint;

ALTER TABLE "conversation_revisions"
DROP CONSTRAINT IF EXISTS "conversation_revisions_reported_token_usage_nonnegative";

ALTER TABLE "conversation_revisions"
ADD CONSTRAINT "conversation_revisions_reported_token_usage_nonnegative"
CHECK (
  ("reported_input_tokens" IS NULL OR "reported_input_tokens" >= 0) AND
  ("reported_cached_input_tokens" IS NULL OR "reported_cached_input_tokens" >= 0) AND
  ("reported_cache_write_input_tokens" IS NULL OR "reported_cache_write_input_tokens" >= 0) AND
  ("reported_output_tokens" IS NULL OR "reported_output_tokens" >= 0) AND
  ("reported_reasoning_output_tokens" IS NULL OR "reported_reasoning_output_tokens" >= 0) AND
  ("reported_total_tokens" IS NULL OR "reported_total_tokens" >= 0)
);
