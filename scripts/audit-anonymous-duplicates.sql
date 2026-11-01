WITH bodies AS (
 SELECT m.revision_id,m.external_message_id,m.ordinal,m.role,jsonb_agg(jsonb_build_object('type',s.type,'content',s.content,'href',s.href,'language',s.language) ORDER BY s.ordinal) segments
 FROM messages m JOIN message_segments s ON s.message_id=m.id GROUP BY m.id
), matches AS (
 SELECT revision_id,role,md5(segments::text) body_hash,count(*) FILTER(WHERE external_message_id IS NULL) anonymous,count(DISTINCT external_message_id) identified,array_agg(ordinal ORDER BY ordinal) positions
 FROM bodies GROUP BY revision_id,role,segments HAVING count(*) FILTER(WHERE external_message_id IS NULL)>0 AND count(external_message_id)>0
)
SELECT jsonb_build_object(
 'candidateConversations',count(DISTINCT c.id),
 'matchingBodyGroups',count(*),
 'anonymousObservations',coalesce(sum(a.anonymous),0),
 'matches',coalesce(jsonb_agg(jsonb_build_object('conversationId',c.id,'title',c.title,'provider',c.provider,'role',a.role,'bodyHash',a.body_hash,'anonymous',a.anonymous,'distinctIdentifiedIds',a.identified,'ordinals',a.positions) ORDER BY c.provider,c.id,a.positions),'[]'::jsonb)
) FROM matches a JOIN conversation_revisions r ON r.id=a.revision_id JOIN conversations c ON c.id=r.conversation_id;