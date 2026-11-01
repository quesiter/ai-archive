CREATE TABLE recapture_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','paused','completed','cancelled')),
  message text,
  last_runner_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX recapture_jobs_active_device ON recapture_jobs(device_id) WHERE status IN ('running','paused');
CREATE TABLE recapture_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES recapture_jobs(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE SET NULL,
  external_session_id text NOT NULL,
  title text NOT NULL,
  ordinal integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','complete','partial','failed','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  capture_id text,
  message text,
  message_count integer,
  UNIQUE(job_id, ordinal)
);
CREATE INDEX recapture_items_job_status ON recapture_items(job_id,status);
