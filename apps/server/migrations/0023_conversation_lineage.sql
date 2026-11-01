ALTER TABLE conversations ADD COLUMN parent_external_session_id text;
--> statement-breakpoint
CREATE INDEX conversations_parent_session_idx ON conversations (provider, parent_external_session_id);
--> statement-breakpoint
ALTER TABLE conversations ADD CONSTRAINT conversations_parent_not_self CHECK (parent_external_session_id IS NULL OR parent_external_session_id <> external_session_id);
