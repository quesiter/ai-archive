CREATE TABLE IF NOT EXISTS "operation_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" text NOT NULL,
  "level" text DEFAULT 'info' NOT NULL,
  "message" text NOT NULL,
  "status" text,
  "entity_type" text,
  "entity_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "operation_logs_scope_created_idx"
ON "operation_logs" USING btree ("scope", "created_at");

CREATE INDEX IF NOT EXISTS "operation_logs_level_created_idx"
ON "operation_logs" USING btree ("level", "created_at");

CREATE INDEX IF NOT EXISTS "operation_logs_entity_idx"
ON "operation_logs" USING btree ("entity_type", "entity_id");
