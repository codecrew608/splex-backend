import type { ComplexityLevel } from "@splex/shared-types";
import type { CortexVersion } from "./version.js";

// Curated openrouter_model_id -> user-facing display name, checked against
// the live model_registry (24 distinct active ids, confirmed via direct
// query on 2026-08-22 — see this file's own generic fallback below for any
// id added after this map was written). Deliberately hand-picked rather
// than derived-only: a mechanical transform of "qwen/qwen3-coder" reads
// worse than "Qwen3 Coder". Never edit this to include a raw provider
// slug, version-control tag, or size/parameter suffix a user wouldn't
// recognize — see this file's header rule.
//
// HARD RULE (same as shared-types' own): the STRING VALUES here are the
// only thing ever sent to a client. The KEYS (real openrouter_model_id
// values) must never themselves reach an SSE payload, log line visible to
// a client, or any apps/web code path.
const FRIENDLY_MODEL_NAMES: Record<string, string> = {
  "black-forest-labs/flux.2-klein-4b": "FLUX.2 Klein",
  "cohere/north-mini-code:free": "Cohere North Mini",
  "deepseek/deepseek-r1": "DeepSeek R1",
  "deepseek/deepseek-v4-flash-0731": "DeepSeek V4 Flash",
  "deepseek/deepseek-v4-pro-0813": "DeepSeek V4 Pro",
  "google/gemini-2.5-flash-image": "Gemini 2.5 Flash",
  "google/gemini-3.7-flash": "Gemini 3.7 Flash",
  "google/gemma-4-26b-a4b-it:free": "Gemma 4",
  "google/gemma-4-31b-it:free": "Gemma 4",
  "google/veo-3.1-lite": "Veo 3.1",
  "meta-llama/llama-3.3-70b-instruct": "Llama 3.3",
  "mistralai/voxtral-mini-tts-2603": "Voxtral Mini",
  "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": "Nemotron 3 Nano",
  "nvidia/nemotron-3-super-120b-a12b:free": "Nemotron 3 Super",
  "nvidia/nemotron-nano-12b-v2-vl:free": "Nemotron Nano",
  "nvidia/nemotron-nano-9b-v2:free": "Nemotron Nano",
  "openai/gpt-oss-20b": "GPT-OSS 20B",
  "openai/gpt-oss-20b:free": "GPT-OSS 20B",
  "poolside/laguna-s-2.1:free": "Laguna S",
  "poolside/laguna-xs-2.1:free": "Laguna XS",
  "qwen/qwen-2.5-72b-instruct": "Qwen 2.5",
  "qwen/qwen2.5-vl-72b-instruct": "Qwen 2.5 VL",
  "qwen/qwen3-coder": "Qwen3 Coder",
  "qwen/qwen3.8-27b": "Qwen3.8",
};

// Safety net for any model_registry row added after the map above was
// last updated — never leaks the raw id (drops the provider prefix and
// the `:free` suffix, which is the part that would otherwise read as an
// internal implementation detail), just produces a plausible generic name
// instead of crashing or falling back to the raw slug.
function genericFriendlyName(modelId: string): string {
  const afterSlash = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  const stripped = afterSlash.replace(/:free$/, "");
  return stripped
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(" ");
}

export function friendlyModelName(modelId: string): string {
  return FRIENDLY_MODEL_NAMES[modelId] ?? genericFriendlyName(modelId);
}

// Deterministic, non-LLM "why this model" line for the Cortex Routing
// disclosure panel — one call per completed turn, no network/inference
// cost. Category-primary, with a complexity override for the
// general/chat category specifically (the only one the reference mockups
// exercise a complexity-driven wording change for). v1 wording stays
// generic/fast-oriented; v1.5 wording reflects the fuller quality/cost/
// health-aware routing it actually runs (see routing.ts) — never invents
// a claim v1's simpler scoring doesn't back up.
const CATEGORY_REASONS: Record<string, { v1: string; v15: string }> = {
  general: { v1: "Best fit for a fast response", v15: "Balanced choice for quality and speed" },
  chat: { v1: "Best fit for a fast response", v15: "Balanced choice for quality and speed" },
  coding: { v1: "Good fit for a coding request", v15: "Strong coding capability for this request" },
  reasoning: { v1: "Good fit for a reasoning task", v15: "Selected for stronger reasoning depth" },
  math: { v1: "Good fit for a math request", v15: "Selected for stronger reasoning depth" },
  vision: { v1: "Good fit for understanding an image", v15: "Selected for strong image understanding" },
  image: { v1: "Good fit for image generation", v15: "Selected for image generation quality" },
  audio: { v1: "Good fit for audio generation", v15: "Selected for audio generation quality" },
  video: { v1: "Good fit for video generation", v15: "Selected for video generation quality" },
  ppt: { v1: "Good fit for building a presentation", v15: "Selected for presentation quality" },
  web_search: { v1: "Good fit for a web search", v15: "Selected for grounded, up-to-date answers" },
  deep_research: { v1: "Good fit for research", v15: "Selected for in-depth research quality" },
};
const DEFAULT_REASON = { v1: "Best fit for this request", v15: "Best overall fit for this request" };
const COMPLEX_GENERAL_REASON = { v1: "Selected to keep this reliable", v15: "Selected for stronger overall quality" };

export function explainModelSelection(category: string, complexity: ComplexityLevel, cortexVersion: CortexVersion): string {
  const isGeneral = category === "general" || category === "chat";
  const entry = isGeneral && complexity === "complex" ? COMPLEX_GENERAL_REASON : (CATEGORY_REASONS[category] ?? DEFAULT_REASON);
  return cortexVersion === "v1" ? entry.v1 : entry.v15;
}
