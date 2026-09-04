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
--
-- A first attempt at this migration failed CREATE-time validation with
-- "relation file_chunks does not exist", even though public.file_chunks
-- obviously exists — live-caught: whatever role/session applies this
-- migration does not carry this database's normal default search_path
-- ("$user", public, extensions), and Postgres validates a SQL function's
-- body against the session's ACTIVE search_path at creation time, not the
-- function's own SET search_path clause (that only takes effect once the
-- function later runs). Confirmed via list_extensions that the failed
-- attempt rolled back cleanly (migrations run in one transaction) — vector
-- was still in public afterward, nothing was left half-moved. Fixed two
-- ways at once, deliberately redundant: an explicit SET search_path for
-- this migration's own session (so nothing later in this file depends on
-- ambient state), AND schema-qualifying every table reference in
-- match_file_chunks's body below regardless.
set search_path = public, extensions;

alter extension vector set schema extensions;

-- Table references schema-qualified explicitly (public.file_chunks,
-- public.files) as a second, independent layer — even with the SET above,
-- there's no reason to leave this function's correctness resting on
-- session state at all when qualifying costs nothing.
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
  from public.file_chunks fc
  join public.files f on f.id = fc.file_id
  where f.user_id = p_user_id
    and fc.embedding is not null
  order by fc.embedding <=> p_query_embedding
  limit p_match_count;
$$;
