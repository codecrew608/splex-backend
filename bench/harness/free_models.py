"""Free-model inventory and the hard paid-call guard.

The single most important property of this benchmark: it must be incapable
of spending paid OpenRouter credits. Everything else here is secondary.

The inventory below is a SNAPSHOT of production `model_registry`, taken
2026-08-29 with:

    select category, openrouter_model_id, variant, is_active,
           free_tier_allowed, priority, capability_score, context_length,
           modality, provider
    from public.model_registry
    where variant='free' and is_active and free_tier_allowed
    order by category, priority;

It is checked in so the corpus and its expectations are reproducible. It is
NOT the authority at run time — `verify_inventory_matches_live()` re-reads
the database before any execution and refuses to run if the two disagree,
because a snapshot that has silently drifted is worse than no snapshot.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class FreeModel:
    model_id: str
    provider: str | None
    category: str
    priority: int
    capability_score: int
    context_length: int
    modality: str


# variant='free' AND is_active AND free_tier_allowed — the exact three
# conditions queryModelRegistry() applies for a Free user.
FREE_MODELS: list[FreeModel] = [
    FreeModel("cohere/north-mini-code:free", "cohere", "coding", 10, 82, 256_000, "text"),
    FreeModel("poolside/laguna-s-2.1:free", "poolside", "coding", 20, 80, 262_144, "text"),
    FreeModel("z-ai/glm-5.2:free", "z-ai", "coding", 30, 76, 256_000, "text"),

    FreeModel("minimax/minimax-m3:free", "minimax", "documents", 10, 76, 1_048_576, "text"),
    FreeModel("google/gemma-4-31b-it:free", "google", "documents", 20, 75, 262_144, "text"),
    FreeModel("thinkingmachines/inkling-small:free", "thinkingmachines", "documents", 30, 72, 1_048_576, "text"),

    FreeModel("google/gemma-4-31b-it:free", "google", "general", 10, 75, 262_144, "text"),
    FreeModel("z-ai/glm-5.2:free", "z-ai", "general", 20, 78, 256_000, "text"),
    FreeModel("minimax/minimax-m2.7:free", "minimax", "general", 40, 72, 196_608, "text"),

    FreeModel("nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", "nvidia", "math", 10, 80, 256_000, "text"),
    FreeModel("nvidia/nemotron-3-super-120b-a12b:free", "nvidia", "math", 20, 82, 262_144, "text"),
    FreeModel("z-ai/glm-5.2:free", "z-ai", "math", 30, 74, 256_000, "text"),

    FreeModel("nvidia/nemotron-3-super-120b-a12b:free", "nvidia", "reasoning", 10, 82, 262_144, "text"),
    FreeModel("poolside/laguna-s-2.1:free", "poolside", "reasoning", 20, 78, 262_144, "text"),
    FreeModel("nvidia/nemotron-3-ultra-550b-a55b:free", "nvidia", "reasoning", 30, 86, 1_000_000, "text"),

    FreeModel("google/gemma-4-31b-it:free", "google", "vision", 10, 75, 262_144, "text"),
    FreeModel("minimax/minimax-m3:free", "minimax", "vision", 20, 76, 1_048_576, "text"),
    FreeModel("thinkingmachines/inkling:free", "thinkingmachines", "vision", 30, 74, 1_048_576, "text"),

    FreeModel("google/gemma-4-31b-it:free", None, "web_search", 10, 75, 262_144, "text"),
    FreeModel("z-ai/glm-5.2:free", "z-ai", "web_search", 20, 74, 256_000, "text"),

    FreeModel("google/gemma-4-26b-a4b-it:free", "google", "writing", 10, 74, 262_144, "text"),
    FreeModel("poolside/laguna-xs-2.1:free", "poolside", "writing", 20, 70, 262_144, "text"),
    FreeModel("z-ai/glm-5.2:free", "z-ai", "writing", 30, 74, 256_000, "text"),
]

# Categories a Free user can actually be routed into.
FREE_CATEGORIES = sorted({m.category for m in FREE_MODELS})

# Categories that exist in the registry but have NO free-reachable model.
# selectModelCandidates() returns [] for these on a Free request, and
# NO_GENERAL_FALLBACK additionally forbids them from borrowing the general
# pool — so the correct observable behaviour is a clean refusal/quota
# message, never a text model pretending to generate media.
FREE_UNAVAILABLE_CATEGORIES = ["audio", "image", "ppt", "video"]

DISTINCT_FREE_MODEL_IDS = sorted({m.model_id for m in FREE_MODELS})


class PaidCallBlocked(RuntimeError):
    """Raised instead of allowing a request that could bill paid credits."""


def is_free_model_id(model_id: str) -> bool:
    """A model is free ONLY if it is a `:free` variant AND appears in the
    snapshot. The suffix alone is not enough: an unknown `:free` id is
    something this benchmark has not audited, so it is refused too."""
    return model_id.endswith(":free") and model_id in DISTINCT_FREE_MODEL_IDS


def assert_free_model(model_id: str, context: str = "") -> None:
    """Hard gate. Call before anything that could reach a provider."""
    if not is_free_model_id(model_id):
        raise PaidCallBlocked(
            f"BLOCKED: refusing a call to non-free model {model_id!r}"
            f"{f' ({context})' if context else ''}. "
            "This benchmark may only use audited :free models. "
            "No paid OpenRouter credits may be spent."
        )


def assert_free_plan(plan_tier: str) -> None:
    """The benchmark drives SPLEX as a Free user, always. A paid tier would
    route into paid candidates by design, so this is refused up front rather
    than relying on catching the model id later."""
    if plan_tier != "free":
        raise PaidCallBlocked(
            f"BLOCKED: benchmark plan_tier must be 'free', got {plan_tier!r}. "
            "A paid tier routes to paid models by design."
        )


def verify_inventory_matches_live(live_rows: list[dict]) -> list[str]:
    """Compare this snapshot against a live model_registry read.

    Returns a list of human-readable discrepancies; empty means they agree.
    The runner treats any discrepancy as fatal: if the registry has changed,
    the corpus's routing expectations were computed against a world that no
    longer exists, and re-deriving them is a deliberate act, not something
    to paper over at run time.
    """
    snapshot = {(m.category, m.model_id) for m in FREE_MODELS}
    live = {(r["category"], r["openrouter_model_id"]) for r in live_rows}

    problems: list[str] = []
    for cat, mid in sorted(live - snapshot):
        problems.append(f"NEW free model in live registry, absent from snapshot: {cat} / {mid}")
    for cat, mid in sorted(snapshot - live):
        problems.append(f"snapshot lists a free model no longer live: {cat} / {mid}")

    # A live row that is somehow not actually free is a hard stop.
    for r in live_rows:
        if r.get("variant") != "free" or not r.get("is_active") or not r.get("free_tier_allowed"):
            problems.append(
                f"live row is not free-reachable but was returned as one: "
                f"{r.get('category')} / {r.get('openrouter_model_id')}"
            )
    return problems
