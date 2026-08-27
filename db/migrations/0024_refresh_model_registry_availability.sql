-- Retires every model_registry row whose OpenRouter model no longer
-- exists, and restocks the categories that would otherwise be left with
-- zero candidates.
--
-- Audited on 2026-08-27 against the live https://openrouter.ai/api/v1/models
-- catalogue (418 models, 18 of them :free). Ten ACTIVE rows referenced
-- models OpenRouter no longer serves:
--
--   free/coding      openai/gpt-oss-20b:free
--   free/documents   nvidia/nemotron-nano-12b-v2-vl:free
--   free/documents   openai/gpt-oss-20b:free
--   free/general     nvidia/nemotron-nano-9b-v2:free   <-- the live 404
--   free/image       black-forest-labs/flux.2-klein-4b
--   free/math        openai/gpt-oss-20b:free
--   free/vision      nvidia/nemotron-nano-12b-v2-vl:free
--   free/web_search  nvidia/nemotron-nano-9b-v2:free
--   paid/audio       mistralai/voxtral-mini-tts-2603
--   paid/video       google/veo-3.1-lite
--
-- The production symptom: Free "general" held exactly two rows, and Cortex
-- v1 (what Free tier resolves to) returns two candidates — so the dead
-- nemotron row was ALWAYS the fallback. When the primary hit a transient
-- error the chain went straight to a model that 404s, and the request died
-- with a generic error while other usable Free models sat unlisted.
--
-- Deactivated, never deleted: scores, curated priority and health history
-- all survive, so restoring a model that comes back is a one-column flip.
update public.model_registry set is_active = false, updated_at = now()
where is_active = true and openrouter_model_id in (
  'openai/gpt-oss-20b:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-nano-9b-v2:free',
  'black-forest-labs/flux.2-klein-4b',
  'mistralai/voxtral-mini-tts-2603',
  'google/veo-3.1-lite'
);

-- Restock. Every id below was verified present in the live catalogue, and
-- every one carrying an image/vision role was verified to advertise image
-- input in architecture.input_modalities — not assumed from the name.
--
-- Depth is the point, not just replacement: each text category ends with
-- at least three active Free rows so one model failing can never exhaust
-- the chain again (Cortex v1 only asks for two candidates, so two live
-- rows was the real fragility, and one dead row made it one).
insert into public.model_registry (
  category, openrouter_model_id, variant, provider, modality,
  capability_score, context_length, cost_per_million_input, cost_per_million_output,
  quality_score, coding_score, reasoning_score, latency_score, reliability_score,
  is_active, priority, free_tier_allowed, pro_tier_allowed
) values
  -- general: text workhorses, largest-context first
  ('general','z-ai/glm-5.2:free','free','z-ai','text',              78, 256000,0,0, 78,72,76,70,70, true,20,true,true),
  ('general','nvidia/nemotron-3.5-lightning:free','free','nvidia','text', 74,1000000,0,0, 74,68,72,85,70, true,30,true,true),
  ('general','minimax/minimax-m2.7:free','free','minimax','text',   72, 196608,0,0, 72,68,70,75,70, true,40,true,true),

  -- coding
  ('coding','poolside/laguna-s-2.1:free','free','poolside','text',  80, 262144,0,0, 80,84,76,70,70, true,20,true,true),
  ('coding','z-ai/glm-5.2:free','free','z-ai','text',               76, 256000,0,0, 76,78,74,70,70, true,30,true,true),

  -- math / reasoning
  ('math','nvidia/nemotron-3-super-120b-a12b:free','free','nvidia','text', 82,262144,0,0, 82,74,86,60,70, true,20,true,true),
  ('math','z-ai/glm-5.2:free','free','z-ai','text',                 74, 256000,0,0, 74,72,78,70,70, true,30,true,true),
  ('reasoning','nvidia/nemotron-3-ultra-550b-a55b:free','free','nvidia','text', 86,1000000,0,0, 86,78,90,50,70, true,30,true,true),

  -- writing
  ('writing','z-ai/glm-5.2:free','free','z-ai','text',              74, 256000,0,0, 74,66,72,70,70, true,30,true,true),

  -- vision / documents: image-input verified via input_modalities
  ('vision','google/gemma-4-31b-it:free','free','google','text',    75, 262144,0,0, 75,66,72,70,70, true,10,true,true),
  ('vision','minimax/minimax-m3:free','free','minimax','text',      76,1048576,0,0, 76,70,74,70,70, true,20,true,true),
  ('vision','thinkingmachines/inkling:free','free','thinkingmachines','text', 74,1048576,0,0, 74,68,72,70,70, true,30,true,true),
  ('documents','minimax/minimax-m3:free','free','minimax','text',   76,1048576,0,0, 76,70,74,70,70, true,10,true,true),
  ('documents','google/gemma-4-31b-it:free','free','google','text', 75, 262144,0,0, 75,66,72,70,70, true,20,true,true),
  ('documents','thinkingmachines/inkling-small:free','free','thinkingmachines','text', 72,1048576,0,0, 72,66,70,75,70, true,30,true,true),

  -- web_search
  ('web_search','z-ai/glm-5.2:free','free','z-ai','text',           74, 256000,0,0, 74,68,72,70,70, true,20,true,true),

  -- paid/audio: real TTS replacements (audio in output_modalities).
  -- pro_tier_allowed only — audio has never been a Free capability.
  ('audio','openai/gpt-audio-mini','paid','openai','audio',         80, 128000,0.6,0, 80,50,60,80,70, true,10,false,true),
  ('audio','openai/gpt-audio','paid','openai','audio',              88, 128000,2.5,0, 88,50,60,70,70, true,20,false,true),

  -- paid/image: the audit found this category sitting on a SINGLE active
  -- row — precisely the shape that produced the Free-tier outage (one
  -- model retired upstream = category dead, no fallback). Both additions
  -- were verified to advertise image in architecture.output_modalities.
  ('image','google/gemini-3.1-flash-image','paid','google','image', 86, 32768,0,0, 86,50,60,80,70, true,20,false,true),
  ('image','openai/gpt-5-image-mini','paid','openai','image',       82, 32768,0,0, 82,50,60,75,70, true,30,false,true);

-- NOT restocked, deliberately, because no substitute exists upstream:
--
--   paid/video  — the live catalogue currently has ZERO models advertising
--                 video in output_modalities. Inventing a row would just
--                 move the 404 rather than fix it.
--   free/image  — likewise zero :free models with image output; every
--                 image-generation model on OpenRouter is paid.
--
-- Both now correctly hit selectModelCandidates' empty-pool path, which
-- already returns the honest "This capability is temporarily unavailable"
-- instead of a generic failure. Flagged in the report as a product
-- decision, not silently papered over.
