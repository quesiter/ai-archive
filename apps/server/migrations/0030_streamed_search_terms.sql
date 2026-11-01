-- Phrase verification now reads candidate revisions' real chunks and stops at
-- the first hit. Existing postings remain valid; no full-content backfill.
ALTER TABLE conversation_search_documents DROP COLUMN content;
--> statement-breakpoint
-- Bounded rebuilds page chunks by revision + ID without sorting a whole chat.
DROP INDEX conversation_search_chunks_revision_idx;
--> statement-breakpoint
CREATE INDEX conversation_search_chunks_revision_idx ON conversation_search_chunks(revision_id, id);
