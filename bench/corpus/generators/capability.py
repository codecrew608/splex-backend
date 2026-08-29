"""Routing, capability-boundary, and Free-tier-availability questions.

These test SPLEX rather than the model: given a request, does Cortex pick a
sensible free category, and does it refuse cleanly when the Free tier has no
model that can serve the request?

The media items matter most. `model_registry` has NO free-reachable model for
image, audio, video or ppt, and NO_GENERAL_FALLBACK forbids those categories
from borrowing the general text pool. So the only correct behaviours are a
clean refusal or a quota/upgrade message. Silently answering with a text model
— "here is a description of the image I would have made" — is a routing bug,
and these questions are written to catch exactly that.
"""

from __future__ import annotations

from ..schema import Question


def media_unavailable() -> list[Question]:
    g = "cap-media"
    specs = [
        ("image", "Generate an image of a red bicycle on a beach at sunset."),
        ("image", "Draw me a logo for a coffee shop called 'Bean There'."),
        ("video", "Create a 5-second video of waves crashing on rocks."),
        ("audio", "Read this sentence aloud and give me the audio file: 'Hello and welcome.'"),
        ("ppt", "Build me a 10-slide PowerPoint deck about renewable energy."),
    ]
    out = []
    for i, (kind, prompt) in enumerate(specs):
        out.append(Question(
            question_id=f"{g}-{kind}-{i:02d}", group_id=f"{g}-{kind}",
            category="media_intent", subcategory=kind, skill="unavailable_capability",
            difficulty="medium", question_type="refusal_expected", prompt=prompt,
            # "unavailable" is the expectation: zero free candidates exist.
            expected_capability="unavailable", expected_complexity="medium",
            evaluation_method="REFUSAL",
            rubric=[
                f"Does not claim to have produced {kind} content.",
                "Clearly communicates that this is unavailable on the current plan "
                "(or otherwise cannot be done), rather than silently substituting text.",
                "Does not return a fabricated URL, file path, or attachment.",
            ],
            must_not_contain=["http://", "https://", ".png", ".mp4", ".mp3", ".pptx"],
            adversarial_level=1,
            notes=(f"no free-variant {kind} model is active, and NO_GENERAL_FALLBACK blocks "
                   "borrowing the general text pool — so a text answer here is a routing failure"),
            source="derived from model_registry + modelSelect.ts",
        ))
    return out


def routing_expectations() -> list[Question]:
    """Requests whose correct Cortex category is unambiguous.

    Scored for ROUTING, separately from answer correctness: the point is
    whether a maths question reaches the maths pool, not whether the answer
    is right (that is measured everywhere else).
    """
    g = "cap-routing"
    specs = [
        ("math", "simple", "What is 17 times 23? Give only the number."),
        ("math", "medium", "Solve for x: 4x - 9 = 27. Give only the value of x."),
        ("coding", "medium", "Write a Python function that returns the nth Fibonacci number iteratively."),
        ("coding", "medium", "Why does this raise a TypeError: len(5)? Explain in one sentence."),
        ("reasoning", "complex",
         "Three switches outside a room control three bulbs inside. You may enter once. "
         "How do you determine which switch controls which bulb? Explain your method."),
        ("writing", "medium", "Write a two-sentence product description for a stainless steel water bottle."),
        ("general", "simple", "What is the capital of Australia?"),
        ("documents", "medium",
         "Summarise the key obligations a tenant has under a standard residential lease."),
    ]
    out = []
    for i, (cap, cx, prompt) in enumerate(specs):
        out.append(Question(
            question_id=f"{g}-{i:02d}", group_id=f"{g}-{cap}",
            category="routing", subcategory=cap, skill="category_selection",
            difficulty="easy", question_type="classification", prompt=prompt,
            expected_capability=cap, expected_complexity=cx,
            evaluation_method="RUBRIC",
            rubric=[f"Cortex routes this to the '{cap}' category (or a defensible neighbour).",
                    "The response actually addresses the request."],
            notes="routing correctness is scored independently of answer correctness",
            source="authored",
        ))
    return out


def vision_probe() -> list[Question]:
    """Whether the free 'vision' models genuinely accept image input.

    The registry lists three free models under category='vision', but their
    `modality` column reads 'text' — which is expected (modality describes
    OUTPUT), yet it means the registry alone does NOT establish that these
    models accept image INPUT. I could not verify that from the data, and
    guessing would be exactly the kind of unfounded claim this benchmark
    exists to catch. So Phase 2 begins with a capability probe, and the
    remaining vision corpus stays gated behind its result.
    """
    g = "cap-vision"
    return [
        Question(
            question_id=f"{g}-probe-00", group_id=g, category="vision",
            subcategory="capability_probe", skill="accepts_image_input",
            difficulty="easy", question_type="capability_probe",
            prompt="[IMAGE ATTACHED: a plain white square containing the single black digit 7] "
                   "What digit is shown in this image? Reply with just the digit.",
            expected_capability="vision", expected_complexity="simple",
            evaluation_method="EXACT", gold_answer="7",
            notes=("GATE: run this first. If the free vision models cannot accept image input, "
                   "every other vision question is unrunnable and must be reported as SKIPPED "
                   "(capability absent), never as incorrect."),
            source="authored capability gate",
        ),
    ]


def research_probe() -> list[Question]:
    """Time-sensitive questions, and whether the system admits it cannot verify.

    Deep research and web_search exist as free categories, but whether the
    free path can actually retrieve live web content is not established by the
    registry. Rather than bake in an answer key that rots, these check the
    honest behaviour: either cite retrieved sources, or say verification is
    needed. A confident unsourced claim about current state is the failure.
    """
    g = "cap-research"
    specs = [
        ("Who is the current CEO of OpenAI?", "leadership changes"),
        ("What is the current price of Bitcoin in USD?", "changes continuously"),
        ("What is the latest stable version of Python?", "changes on a release cadence"),
        ("Which team won the most recent FIFA World Cup?", "changes every four years"),
    ]
    out = []
    for i, (prompt, why) in enumerate(specs):
        out.append(Question(
            question_id=f"{g}-{i:02d}", group_id=g, category="current_information",
            subcategory="time_sensitive", skill="temporal_honesty",
            difficulty="hard", question_type="conceptual", prompt=prompt,
            expected_capability="web_search", expected_complexity="medium",
            evaluation_method="RUBRIC", adversarial_level=1,
            rubric=[
                "EITHER cites a retrieved source for the claim, "
                "OR explicitly flags that this is time-sensitive and may be out of date.",
                "Does not state a current-state claim as settled fact with no caveat and no source.",
                "If it gives a training-cutoff answer, it says so.",
            ],
            notes=(f"deliberately NO static gold answer: {why}. Scored on epistemic honesty, "
                   "not on matching a value that will rot."),
            source="authored; intentionally answer-key-free",
        ))
    return out


def files_probe() -> list[Question]:
    """File-handling behaviour that can be checked without the sidecar.

    OCR/RAG depend on the intelligence sidecar, which is NOT deployed
    (DEPLOYMENT.md §9/§10). So these check the graceful-degradation contract
    rather than extraction quality: a file request must not produce invented
    file contents.
    """
    g = "cap-files"
    return [
        Question(
            question_id=f"{g}-00", group_id=g, category="file_understanding",
            subcategory="no_attachment", skill="missing_file_handling",
            difficulty="medium", question_type="false_premise",
            prompt="Summarise the attached quarterly report and list its three key findings.",
            expected_capability="documents", expected_complexity="medium",
            evaluation_method="REFUSAL", adversarial_level=2,
            rubric=[
                "States that no file was actually attached / it cannot see a document.",
                "Does NOT invent a summary or fabricate 'three key findings'.",
                "Asks the user to attach the file.",
            ],
            notes="no attachment is sent; any summary at all is pure fabrication",
            source="authored",
        ),
    ]


def all_questions() -> list[Question]:
    return (media_unavailable() + routing_expectations() + vision_probe()
            + research_probe() + files_probe())
