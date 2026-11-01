CREATE TABLE conversation_search_terms (
  term text COLLATE "C" NOT NULL,
  conversation_id uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE conversation_search_documents ADD COLUMN terms_ready boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Upgrade existing packed terms entirely inside PostgreSQL, without reading
-- every full document into Node. Empty documents legitimately have no terms.
INSERT INTO conversation_search_terms(term, conversation_id)
SELECT term, document.conversation_id
FROM conversation_search_documents document
CROSS JOIN LATERAL string_to_table(document.short_cjk_terms, chr(1)) AS tokens(term)
WHERE term <> '';
--> statement-breakpoint
-- Build indexes and validate references once after the bulk load, rather than
-- inserting millions of rows into live indexes and checking the FK per row.
ALTER TABLE conversation_search_terms ADD PRIMARY KEY(term, conversation_id);
--> statement-breakpoint
CREATE INDEX conversation_search_terms_conversation_idx ON conversation_search_terms(conversation_id);
--> statement-breakpoint
ALTER TABLE conversation_search_terms ADD CONSTRAINT conversation_search_terms_conversation_id_fkey
  FOREIGN KEY(conversation_id) REFERENCES conversation_search_documents(conversation_id) ON DELETE CASCADE;
--> statement-breakpoint
UPDATE conversation_search_documents SET terms_ready = true WHERE short_cjk_terms IS NOT NULL;
--> statement-breakpoint
DROP INDEX conversation_search_documents_pending_idx;
--> statement-breakpoint
ALTER TABLE conversation_search_documents DROP COLUMN short_cjk_terms;
--> statement-breakpoint
CREATE INDEX conversation_search_documents_pending_idx ON conversation_search_documents(conversation_id) WHERE NOT terms_ready;
