-- ============================================================================
-- SPLEX — Migration 0013: video generation model
-- ============================================================================
-- Everything else video needs already exists from migration 0012:
-- plan_limits already has ('free','video_generations',0) and
-- ('pro','video_generations',2), and generated_media already has status/
-- provider_job_id/storage_path columns shaped for an async job (queued ->
-- processing -> completed/failed) — this migration only adds the model
-- itself.
--
-- google/veo-3.1-lite (verified live against
-- openrouter.ai/api/v1/models?output_modalities=video and OpenRouter's own
-- video-generation announcement as of this migration): 720p/1080p from a
-- text prompt with native synchronized audio, 4-8s clips, at under half
-- the cost of the "fast" tier — the cheapest well-known-provider option
-- that comfortably fits under the product's <=10s v1 duration cap (see
-- apps/backend/src/video/generate.ts, which requests 8s). No 'free'
-- variant row, same reasoning as audio in migration 0012: Pro-only in V1
-- (free's video_generations limit is 0, so a free-tier row would be
-- structurally unreachable). cost_per_million_input/output are 0 and
-- unused — video is priced per-job via the real usd cost OpenRouter
-- reports on job completion (`usage.cost`), not token-rate math.
--
-- NOT EXISTS-guarded rather than a bare INSERT, consistent with 0012 after
-- its 55P04 fix — model_registry has no unique constraint to hang an
-- ON CONFLICT off of, so this stays safe to re-run.
insert into public.model_registry (category, openrouter_model_id, variant, capability_score, context_length, cost_per_million_input, cost_per_million_output, is_active, priority)
select 'video', 'google/veo-3.1-lite', 'paid', 85, 8192, 0, 0, true, 10
where not exists (
  select 1 from public.model_registry where category = 'video' and openrouter_model_id = 'google/veo-3.1-lite' and variant = 'paid'
);

-- Video is the first async media kind: the model is selected at job-
-- submission time (routes/chat.ts) but real billing only happens later,
-- at completion time (routes/media.ts's status poll) — a separate HTTP
-- request, with no in-memory state carried over from submission. Without
-- persisting which model was actually used, completion-time billing would
-- have no correct value for messages.routed_model/consume_credits'
-- p_openrouter_model_id short of re-running model selection (which could
-- legitimately pick a *different* model than the one that actually ran,
-- e.g. if the registry changed in between) or hand-waving a placeholder —
-- neither is acceptable for a ledger column the rest of the app treats as
-- the real internal record of what ran.
alter table public.generated_media add column if not exists openrouter_model_id text;
