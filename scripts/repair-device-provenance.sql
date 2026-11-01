-- Restore historical source attribution from successful capture audit events.
-- Default is a read-only preview. Run with psql -v apply=true after a backup.
-- No conversation bodies, content hashes, capture times or live credentials change.
\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply false
\endif

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('archive-device-provenance-repair', 0));

CREATE TEMP TABLE source_repair_plan ON COMMIT DROP AS
WITH ranked AS (
  SELECT c.id AS conversation_id, c.provider, c.external_session_id,
    r.id AS revision_id, r.source_device_id, r.snapshot_hash, r.captured_at,
    r.adapter_version, r.trigger_reason,
    row_number() OVER (PARTITION BY c.id ORDER BY
      (r.completeness = 'complete') DESC, r.captured_at DESC, r.created_at DESC) AS revision_rank
  FROM conversations c JOIN conversation_revisions r ON r.conversation_id = c.id
  WHERE c.deleted_at IS NULL
), candidates AS (
  SELECT * FROM ranked
  WHERE revision_rank = 1 AND source_device_id IS NULL
    AND provider IN ('chatgpt', 'gemini', 'grok', 'yuanbao', 'doubao', 'minimax_agent', 'deepseek', 'qianwen', 'kimi')
    AND adapter_version <> 'chat-memo-text-v1'
    AND trigger_reason IS DISTINCT FROM 'historical_import'
)
SELECT c.conversation_id, c.revision_id, c.snapshot_hash, c.captured_at,
  evidence.id AS evidence_log_id, evidence.created_at AS evidence_at,
  (evidence.metadata->>'deviceId')::uuid AS device_id
FROM candidates c
JOIN LATERAL (
  SELECT l.id, l.metadata, l.created_at
  FROM operation_logs l
  WHERE l.scope = 'capture' AND l.entity_type = 'conversation'
    AND l.entity_id = c.conversation_id::text AND l.status IN ('complete', 'partial')
    AND l.metadata->>'provider' = c.provider
    AND l.metadata->>'sessionId' = c.external_session_id
    AND l.metadata->>'deviceId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ORDER BY l.created_at DESC, l.id DESC LIMIT 1
) evidence ON true;

CREATE TEMP TABLE source_device_restore_plan ON COMMIT DROP AS
SELECT ids.device_id, named.name, paired.kind, paired.created_at,
  revoked.revoked_at, seen.last_seen_at
FROM (SELECT DISTINCT device_id FROM source_repair_plan) ids
LEFT JOIN devices d ON d.id = ids.device_id
JOIN LATERAL (
  SELECT l.metadata->>'name' AS name FROM operation_logs l
  WHERE l.scope = 'device' AND l.entity_type = 'device' AND l.entity_id = ids.device_id::text
    AND nullif(btrim(l.metadata->>'name'), '') IS NOT NULL
  ORDER BY l.created_at DESC, l.id DESC LIMIT 1
) named ON true
JOIN LATERAL (
  SELECT l.metadata->>'kind' AS kind, l.created_at FROM operation_logs l
  WHERE l.scope = 'device' AND l.entity_type = 'device' AND l.entity_id = ids.device_id::text
    AND l.metadata->>'kind' IN ('chrome_extension', 'openclaw_sync')
  ORDER BY l.created_at, l.id LIMIT 1
) paired ON true
JOIN LATERAL (
  SELECT min(l.created_at) AS revoked_at FROM operation_logs l
  WHERE l.scope = 'device' AND l.entity_type = 'device' AND l.entity_id = ids.device_id::text
    AND l.status IN ('revoked', 'deleted')
  HAVING count(*) > 0
) revoked ON true
LEFT JOIN LATERAL (
  SELECT max(l.created_at) AS last_seen_at FROM operation_logs l
  WHERE l.scope = 'capture' AND l.status IN ('complete', 'partial')
    AND l.metadata->>'deviceId' = ids.device_id::text
) seen ON true
WHERE d.id IS NULL;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM source_repair_plan p
    LEFT JOIN devices d ON d.id = p.device_id
    LEFT JOIN source_device_restore_plan r ON r.device_id = p.device_id
    WHERE d.id IS NULL AND r.device_id IS NULL
  ) THEN
    RAISE EXCEPTION 'A source device has no verified identity or revocation history';
  END IF;
END $$;

SELECT json_build_object('phase', 'plan', 'conversations', (SELECT count(*) FROM source_repair_plan),
  'historicalDevices', (SELECT count(*) FROM source_device_restore_plan),
  'sources', (SELECT json_agg(row_to_json(s)) FROM (
    SELECT coalesce(d.name, r.name) AS name, count(*) AS conversations
    FROM source_repair_plan p LEFT JOIN devices d ON d.id = p.device_id
    LEFT JOIN source_device_restore_plan r ON r.device_id = p.device_id
    GROUP BY coalesce(d.name, r.name) ORDER BY conversations DESC
  ) s));

\if :apply
  INSERT INTO devices (id, name, kind, token_hash, created_at, revoked_at, last_seen_at)
  SELECT device_id, name, kind,
    encode(sha256((gen_random_uuid()::text || gen_random_uuid()::text)::bytea), 'hex'),
    created_at, revoked_at, last_seen_at FROM source_device_restore_plan;

  CREATE TEMP TABLE source_repair_applied ON COMMIT DROP AS
  WITH changed AS (
    UPDATE conversation_revisions r SET source_device_id = p.device_id
    FROM source_repair_plan p
    WHERE r.id = p.revision_id AND r.source_device_id IS NULL
      AND r.snapshot_hash = p.snapshot_hash AND r.captured_at = p.captured_at
    RETURNING r.id
  ) SELECT p.* FROM source_repair_plan p JOIN changed c ON c.id = p.revision_id;

  DO $$ BEGIN
    IF (SELECT count(*) FROM source_repair_applied) <> (SELECT count(*) FROM source_repair_plan) THEN
      RAISE EXCEPTION 'Conversation sources changed during repair; retry from a fresh preview';
    END IF;
    IF EXISTS (SELECT 1 FROM source_device_restore_plan p JOIN devices d ON d.id = p.device_id WHERE d.revoked_at IS NULL) THEN
      RAISE EXCEPTION 'A restored historical device must remain revoked';
    END IF;
  END $$;

  INSERT INTO operation_logs (scope, level, message, status, entity_type, entity_id, metadata)
  SELECT 'device', 'info', '已根据历史采集日志补回会话来源', 'complete', 'conversation', conversation_id::text,
    jsonb_build_object('repair', 'historical_device_provenance', 'revisionId', revision_id,
      'deviceId', device_id, 'previousSourceDeviceId', NULL, 'evidenceLogId', evidence_log_id,
      'evidenceAt', evidence_at, 'selection', 'latest_successful_capture')
  FROM source_repair_applied;

  SELECT json_build_object('phase', 'applied', 'conversations', (SELECT count(*) FROM source_repair_applied),
    'restoredDevicesStillRevoked', (SELECT count(*) FROM source_device_restore_plan p
      JOIN devices d ON d.id = p.device_id WHERE d.revoked_at IS NOT NULL));
  COMMIT;
\else
  ROLLBACK;
\endif
