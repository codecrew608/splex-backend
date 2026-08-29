-- Align the Free plan's image entitlement with what OpenRouter can actually serve.
--
-- BACKGROUND (production incident, 2026-08-28)
--
-- plan_limits grants free/image_generations = 2, so checkMediaQuota admits a
-- Free image request. But migration 0024 deactivated the only free/image
-- registry row (verified: the live catalogue has ZERO :free models that emit
-- images — every image-generation model on OpenRouter is paid), leaving that
-- category with no rows at all.
--
-- selectModelCandidates then fell back to the "general" category and handed
-- back TEXT models — z-ai/glm-5.2:free and minimax/minimax-m2.7:free — which
-- were dispatched to generate a picture and failed 100% of the time, burning
-- two provider round-trips per attempt and surfacing as a generic error.
--
-- The code half of the fix is already in: cortex/modelSelect.ts now refuses
-- to fall back across a capability boundary for image/audio/video/ppt, so an
-- empty pool correctly yields "this capability is temporarily unavailable"
-- with NO provider call. This migration is the data half — stop promising a
-- capability that cannot currently be delivered, so the user is told at the
-- quota gate rather than after a failed routing attempt.
--
-- DELIBERATELY NOT a code-level "image is paid-only" rule. Whether Free ever
-- gets image generation is a pricing decision, not an engineering one, and
-- plan_limits is where that decision belongs — set this back to 2 (or any
-- number) the moment a usable :free image model exists, with no code change.
update public.plan_limits
   set limit_amount = 0
 where plan_tier = 'free'
   and counter_type = 'image_generations';

-- limit_amount = 0 is already the established "capability not included in
-- this plan" encoding — getQuotaState treats it as not-allowed and the UI's
-- UsagePanel deliberately hides 0-limit rows rather than rendering a
-- permanently-full bar (see components/sidebar/UsagePanel.tsx's isDisplayable).
-- So a Free user now gets the plan-level "not available on your plan"
-- message at the quota gate, before any model selection happens.

-- Retire the dead registry row's fallback trap for good: the row is already
-- inactive, this just makes the intent explicit for the next reader.
comment on table public.model_registry is
  'Routing candidates per (category, variant). A category with zero ACTIVE rows is a valid state meaning "capability unavailable" — cortex/modelSelect.ts refuses to substitute a general text model for image/audio/video/ppt, because a text model cannot perform that work and attempting it wastes provider calls and returns a misleading generic error.';
