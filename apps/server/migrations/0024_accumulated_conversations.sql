alter table conversation_revisions add column is_accumulated boolean not null default false;
--> statement-breakpoint
alter table conversation_revisions add column merge_evidence jsonb not null default '{"variants":[],"warnings":[]}';
--> statement-breakpoint
create unique index conversation_accumulated_revision_uidx on conversation_revisions(conversation_id) where is_accumulated;
--> statement-breakpoint
alter table capture_runs add column request_hash text;
--> statement-breakpoint
alter table capture_runs add column receipt jsonb;
