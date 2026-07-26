CREATE TABLE IF NOT EXISTS background_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  status text NOT NULL,
  total_count integer NOT NULL DEFAULT 0,
  processed_count integer NOT NULL DEFAULT 0,
  succeeded_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  message text,
  error text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS background_tasks_kind_created_idx
  ON background_tasks(kind, created_at);

CREATE INDEX IF NOT EXISTS background_tasks_status_updated_idx
  ON background_tasks(status, updated_at);
