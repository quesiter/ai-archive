ALTER TABLE "analysis_runs"
ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;

CREATE INDEX IF NOT EXISTS "analysis_runs_status_updated_idx"
ON "analysis_runs" USING btree ("status", "updated_at");
