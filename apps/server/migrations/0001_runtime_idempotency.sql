ALTER TABLE capture_runs
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS capture_runs_device_idempotency_uidx
  ON capture_runs(device_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS analysis_runs_kind_window_uidx
  ON analysis_runs(kind, window_start, window_end);

CREATE UNIQUE INDEX IF NOT EXISTS reports_kind_period_uidx
  ON reports(kind, period_start, period_end);
