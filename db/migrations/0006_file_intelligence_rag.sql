-- File Intelligence: RAG retrieval over file_chunks via pgvector cosine
-- similarity, scoped to the requesting user's own files. Runs through
-- supabaseAdmin (service role, RLS bypassed) so ownership is enforced by
-- the p_user_id filter inside the function, not by RLS.
create or replace function match_file_chunks(
  p_user_id uuid,
  p_query_embedding vector(384),
  p_match_count int default 8
)
returns table (
  file_id uuid,
  filename text,
  chunk_index int,
  chunk_text text,
  similarity float
)
language sql stable
as $$
  select
    fc.file_id,
    f.filename,
    fc.chunk_index,
    fc.chunk_text,
    1 - (fc.embedding <=> p_query_embedding) as similarity
  from file_chunks fc
  join files f on f.id = fc.file_id
  where f.user_id = p_user_id
    and fc.embedding is not null
  order by fc.embedding <=> p_query_embedding
  limit p_match_count;
$$;
