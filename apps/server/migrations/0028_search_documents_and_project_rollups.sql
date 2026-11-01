CREATE TABLE conversation_search_documents (
  conversation_id uuid PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  content text NOT NULL,
  short_cjk_terms text
);
--> statement-breakpoint
CREATE INDEX conversation_search_documents_pending_idx ON conversation_search_documents(conversation_id) WHERE short_cjk_terms IS NULL;
--> statement-breakpoint
INSERT INTO conversation_search_documents(conversation_id, content)
SELECT revision.conversation_id, string_agg(DISTINCT chunk.content, chr(1))
FROM conversation_revisions revision JOIN conversation_search_chunks chunk ON chunk.revision_id = revision.id
GROUP BY revision.conversation_id;
--> statement-breakpoint
CREATE TABLE project_conversation_rollups (
  source_conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  activity_at timestamptz NOT NULL,
  PRIMARY KEY(source_conversation_id, conversation_id)
);
--> statement-breakpoint
CREATE INDEX project_rollups_project_idx ON project_conversation_rollups(project_id, conversation_id);
--> statement-breakpoint
CREATE INDEX project_rollups_root_idx ON project_conversation_rollups(conversation_id);
--> statement-breakpoint
CREATE FUNCTION refresh_project_source(target uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM project_conversation_rollups WHERE source_conversation_id = target;
  WITH RECURSIVE chain AS (
    SELECT c.id, c.provider, c.external_session_id, c.parent_external_session_id,
      greatest(c.updated_at, (SELECT latest_activity_at FROM conversation_summaries WHERE conversation_id = c.id)) AS updated_at,
      ARRAY[c.id] AS path, false AS cycle
    FROM conversations c WHERE c.id = target AND c.deleted_at IS NULL
    UNION ALL
    SELECT p.id, p.provider, p.external_session_id, p.parent_external_session_id,
      greatest(p.updated_at, (SELECT latest_activity_at FROM conversation_summaries WHERE conversation_id = p.id)),
      chain.path || p.id, p.id = ANY(chain.path)
    FROM chain JOIN conversations p ON p.provider = chain.provider
      AND p.external_session_id = chain.parent_external_session_id AND p.deleted_at IS NULL
    WHERE NOT chain.cycle
  )
  INSERT INTO project_conversation_rollups(source_conversation_id, conversation_id, project_id, activity_at)
  SELECT DISTINCT target, root.id, assignment.project_id,
    greatest(assignment.updated_at, source.updated_at, root.updated_at)
  FROM chain root JOIN conversations source ON source.id = target
  JOIN conversation_projects assignment ON assignment.conversation_id = target
  WHERE assignment.project_id IS NOT NULL AND (
    EXISTS (SELECT 1 FROM chain WHERE cycle) OR NOT EXISTS (
      SELECT 1 FROM conversations parent WHERE parent.provider = root.provider
        AND parent.external_session_id = root.parent_external_session_id AND parent.deleted_at IS NULL
    )
  );
END;
$$;
--> statement-breakpoint
CREATE FUNCTION project_assignment_rollup_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM refresh_project_source(OLD.conversation_id);
  ELSE PERFORM refresh_project_source(NEW.conversation_id); END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_assignment_rollup_changed AFTER INSERT OR UPDATE OR DELETE ON conversation_projects
  FOR EACH ROW EXECUTE FUNCTION project_assignment_rollup_changed();
--> statement-breakpoint
CREATE FUNCTION project_conversation_rollup_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target uuid; target_provider text; target_session text; affected uuid;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.updated_at IS NOT DISTINCT FROM NEW.updated_at
    AND OLD.deleted_at IS NOT DISTINCT FROM NEW.deleted_at
    AND OLD.parent_external_session_id IS NOT DISTINCT FROM NEW.parent_external_session_id
    AND OLD.external_session_id = NEW.external_session_id AND OLD.provider = NEW.provider THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN target := OLD.id; target_provider := OLD.provider; target_session := OLD.external_session_id;
  ELSE target := NEW.id; target_provider := NEW.provider; target_session := NEW.external_session_id; END IF;
  FOR affected IN WITH RECURSIVE descendants AS (
    SELECT id, provider, external_session_id FROM conversations
    WHERE id = target OR (provider = target_provider AND parent_external_session_id = target_session)
    UNION
    SELECT c.id, c.provider, c.external_session_id FROM conversations c JOIN descendants d
      ON c.provider = d.provider AND c.parent_external_session_id = d.external_session_id
  ) SELECT id FROM descendants ORDER BY id LOOP
    PERFORM refresh_project_source(affected);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_conversation_rollup_changed AFTER INSERT OR UPDATE OR DELETE ON conversations
  FOR EACH ROW EXECUTE FUNCTION project_conversation_rollup_changed();
--> statement-breakpoint
CREATE FUNCTION project_summary_activity_changed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected uuid;
BEGIN
  IF NEW.latest_activity_at <= (SELECT updated_at FROM conversations WHERE id = NEW.conversation_id) THEN RETURN NULL; END IF;
  IF TG_OP = 'UPDATE' AND NEW.latest_activity_at IS NOT DISTINCT FROM OLD.latest_activity_at THEN RETURN NULL; END IF;
  FOR affected IN WITH RECURSIVE descendants AS (
    SELECT id, provider, external_session_id FROM conversations WHERE id = NEW.conversation_id
    UNION
    SELECT c.id, c.provider, c.external_session_id FROM conversations c JOIN descendants d
      ON c.provider = d.provider AND c.parent_external_session_id = d.external_session_id
  ) SELECT id FROM descendants ORDER BY id LOOP
    PERFORM refresh_project_source(affected);
  END LOOP;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER project_summary_activity_changed AFTER INSERT OR UPDATE OF latest_activity_at ON conversation_summaries
  FOR EACH ROW EXECUTE FUNCTION project_summary_activity_changed();
--> statement-breakpoint
SELECT refresh_project_source(id) FROM conversations;
