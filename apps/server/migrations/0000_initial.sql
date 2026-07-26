CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  totp_secret_encrypted text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS web_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_sessions_user_idx ON web_sessions(user_id);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  kind text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pairing_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash text NOT NULL UNIQUE,
  requested_name text NOT NULL,
  requested_kind text NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_session_id text NOT NULL,
  title text,
  canonical_url text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conversations_provider_session_uidx ON conversations(provider, external_session_id);
CREATE INDEX IF NOT EXISTS conversations_updated_idx ON conversations(updated_at);

CREATE TABLE IF NOT EXISTS conversation_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  branch_fingerprint text NOT NULL,
  snapshot_hash text NOT NULL,
  completeness text NOT NULL,
  top_reached boolean NOT NULL,
  bottom_reached boolean NOT NULL,
  stable boolean NOT NULL,
  completeness_reason text,
  adapter_version text NOT NULL,
  source_device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL,
  message_count integer NOT NULL,
  search_text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_revision_snapshot_uidx ON conversation_revisions(conversation_id, snapshot_hash);
CREATE INDEX IF NOT EXISTS conversation_revision_conversation_idx ON conversation_revisions(conversation_id);
CREATE INDEX IF NOT EXISTS conversation_revision_captured_idx ON conversation_revisions(captured_at);
CREATE INDEX IF NOT EXISTS conversation_revision_search_trgm_idx ON conversation_revisions USING gin(search_text gin_trgm_ops);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES conversation_revisions(id) ON DELETE CASCADE,
  external_message_id text,
  ordinal integer NOT NULL,
  role text NOT NULL,
  model text,
  source_created_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_revision_ordinal_uidx ON messages(revision_id, ordinal);

CREATE TABLE IF NOT EXISTS message_segments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal integer NOT NULL,
  type text NOT NULL,
  content text NOT NULL,
  href text,
  language text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS message_segments_message_ordinal_uidx ON message_segments(message_id, ordinal);

CREATE TABLE IF NOT EXISTS capture_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id uuid REFERENCES devices(id) ON DELETE SET NULL,
  provider text NOT NULL,
  external_session_id text NOT NULL,
  snapshot_hash text,
  status text NOT NULL,
  error text,
  captured_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS capture_runs_created_idx ON capture_runs(created_at);

CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text NOT NULL DEFAULT '',
  archived boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversation_projects (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  confidence double precision,
  locked_by_user boolean NOT NULL DEFAULT false,
  suggested_name text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  confidence double precision NOT NULL,
  source_references jsonb NOT NULL,
  fingerprint text NOT NULL,
  supersedes_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_project_fingerprint_uidx ON knowledge_items(project_id, fingerprint);
CREATE INDEX IF NOT EXISTS knowledge_project_idx ON knowledge_items(project_id);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  status text NOT NULL,
  window_start timestamptz NOT NULL,
  window_end timestamptz NOT NULL,
  error text,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  project_id uuid REFERENCES projects(id) ON DELETE SET NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  title text NOT NULL,
  summary text NOT NULL,
  body_markdown text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reports_period_idx ON reports(period_end);

CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  encrypted boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS redaction_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pattern text NOT NULL,
  replacement text NOT NULL DEFAULT '[CUSTOM_REDACTED]',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filename text NOT NULL,
  file_hash text NOT NULL UNIQUE,
  provider text,
  status text NOT NULL,
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_jobs_created_idx ON import_jobs(created_at);
