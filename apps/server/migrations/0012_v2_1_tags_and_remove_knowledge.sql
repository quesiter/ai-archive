-- V2.1 replaces derived Knowledge Items with project + multi-tag organization.
-- Original conversations, revisions, messages, project assignments and reports
-- are intentionally untouched.

CREATE TABLE IF NOT EXISTS tags (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  normalized_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_normalized_name_uidx ON tags(normalized_name);
CREATE INDEX IF NOT EXISTS tags_name_idx ON tags(name);

CREATE TABLE IF NOT EXISTS conversation_tags (
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  tag_id uuid NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  confidence double precision,
  source text NOT NULL,
  locked_by_user boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_tags_pk PRIMARY KEY (conversation_id, tag_id),
  CONSTRAINT conversation_tags_source_check CHECK (source IN ('auto', 'manual')),
  CONSTRAINT conversation_tags_confidence_check CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  )
);
CREATE INDEX IF NOT EXISTS conversation_tags_tag_idx ON conversation_tags(tag_id);
CREATE INDEX IF NOT EXISTS conversation_tags_conversation_idx ON conversation_tags(conversation_id);

-- Old queued/running rebuilds must never be picked up by a V2.1 worker.
UPDATE background_tasks
SET status = 'completed',
    message = 'V2.1 已取消项目知识模块；旧重建任务已迁移为完成。',
    error = NULL,
    completed_at = COALESCE(completed_at, now()),
    updated_at = now(),
    stats = COALESCE(stats, '{}'::jsonb) || '{"obsolete":true,"migratedBy":"V2.1"}'::jsonb
WHERE kind = 'knowledge_rebuild'
  AND status IN ('queued', 'running', 'failed');

DELETE FROM background_tasks WHERE kind = 'knowledge_rebuild';
DROP TABLE IF EXISTS knowledge_items CASCADE;
