-- FIX: performance/security advisor flagged the `vector` extension (and
-- its 237 owned objects — the vector/halfvec/sparsevec types, every
-- distance operator, the hnsw/ivfflat access methods, avg(vector)/
-- sum(vector) aggregates) living in the `public` schema, where every
-- table/function also lives. Best practice is extensions in a dedicated
-- schema so `public` stays application objects only. Deferred earlier this
-- session as "risky without a dedicated pass" specifically because
-- match_file_chunks() — the one non-extension-owned function that actually
-- uses the vector type — has its search_path hard-pinned to 'public' only
-- (migration 0041's own hardening), and the `<=>` operator lookup is
-- resolved via search_path same as an unqualified function call: moving
-- the extension without also fixing that would have silently broken RAG
-- retrieval in production the next time it ran.
--
-- Supabase's `extensions` schema already exists in this project (pgcrypto,
-- uuid-ossp, pg_stat_statements already live there) and is already part of
-- the database's default search_path ("$user", public, extensions) — this
-- migration only needs to (1) move the extension's 237 objects there in
-- one atomic operation, and (2) extend the one function whose search_path
-- is pinned narrower than the database default.
--
-- What does NOT need to change: file_chunks.embedding's column type (type
-- OIDs are stable across a schema move — only the catalog's schema label
-- changes), the idx_file_chunks_embedding_hnsw index (same reason), and
-- every other 0041-hardened function (grep-verified: none of them
-- reference the vector type or its operators).
alter extension vector set schema extensions;

create or replace function public.match_file_chunks(p_user_id uuid, p_query_embedding vector, p_match_count integer default 8)
returns table(file_id uuid, filename text, chunk_index integer, chunk_text text, similarity double precision)
language sql
stable
set search_path to 'public, extensions'
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
