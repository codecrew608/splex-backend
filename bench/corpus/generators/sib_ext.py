"""SIB v1.0 extension set — multilingual, long-context, instruction-following.

The inherited corpus has no multilingual items and only a handful of
long-context and instruction-following ones, so those three SIB categories
would otherwise be unmeasurable. Authored in this session, BEFORE any live
run, and never inspected against SPLEX output before scoring.

Design rule for every item here: the answer must be checkable as a *fact
about the string*, never as a judgement about it. That rules out "translate
this paragraph well" (needs a judge) and rules in "what is 47 + 68, asked in
Spanish" (the answer is a number, and getting it right requires having
understood the Spanish).

Multilingual items deliberately separate two skills:
  - comprehension: the instruction is in another language, the answer is
    language-neutral (a number), so a wrong answer means it did not
    understand the prompt.
  - production: the answer must be a specific word in a specific language.
"""

from __future__ import annotations

from ..schema import Question

GROUP = "sib-ext"


# ---------------------------------------------------------------------------
# Multilingual
# ---------------------------------------------------------------------------

# (language, prompt, gold) — arithmetic phrased natively. The numbers are
# chosen so no two answers collide, so a lucky guess cannot pass.
_ML_ARITH = [
    ("spanish", "¿Cuánto es 47 más 68? Responde únicamente con el número.", 115),
    ("french", "Combien font 84 moins 29 ? Réponds uniquement avec le nombre.", 55),
    ("german", "Was ist 13 mal 7? Antworte nur mit der Zahl.", 91),
    ("portuguese", "Quanto é 144 dividido por 12? Responda apenas com o número.", 12),
    ("italian", "Quanto fa 26 più 39? Rispondi solo con il numero.", 65),
    ("hindi", "23 और 19 का योग क्या है? केवल संख्या में उत्तर दें।", 42),
    ("russian", "Сколько будет 72 минус 35? Ответь только числом.", 37),
    ("japanese", "15かける4はいくつですか。数字だけで答えてください。", 60),
    ("chinese", "96 除以 8 等于多少？只用数字回答。", 12),
    ("arabic", "كم يساوي 58 زائد 27؟ أجب بالرقم فقط.", 85),
]

# (language name in English, a sentence unambiguously in that language)
_ML_IDENT = [
    ("Portuguese", "O gato preto dormiu na cadeira de madeira durante toda a tarde."),
    ("Swedish", "Jag tycker om att dricka kaffe på morgonen innan jag går till jobbet."),
    ("Turkish", "Bugün hava çok güzel olduğu için parkta uzun bir yürüyüş yaptık."),
    ("Vietnamese", "Tôi thích ăn phở vào buổi sáng khi trời còn mát mẻ."),
]


def multilingual() -> list[Question]:
    out: list[Question] = []
    for i, (lang, prompt, gold) in enumerate(_ML_ARITH):
        out.append(Question(
            question_id=f"{GROUP}-ml-arith-{i:02d}",
            group_id=f"{GROUP}-ml-arith",
            category="multilingual", subcategory=lang, skill="cross-lingual comprehension",
            difficulty="medium", question_type="computation",
            prompt=prompt,
            expected_capability="general", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=gold, tolerance=0.0,
            source="computed (arithmetic); prompt authored in-language",
            notes="Answer is language-neutral, so a correct number is evidence the "
                  "non-English instruction was understood.",
        ))
    for i, (lang, sentence) in enumerate(_ML_IDENT):
        out.append(Question(
            question_id=f"{GROUP}-ml-ident-{i:02d}",
            group_id=f"{GROUP}-ml-ident",
            category="multilingual", subcategory=lang.lower(), skill="language identification",
            difficulty="easy", question_type="classification",
            prompt=(f"What language is this sentence written in? Answer with only the "
                    f"English name of the language, nothing else.\n\n{sentence}"),
            expected_capability="general", expected_complexity="simple",
            evaluation_method="EXACT", gold_answer=lang,
            source="authored: sentence composed in the named language",
        ))
    return out


# ---------------------------------------------------------------------------
# Long context
# ---------------------------------------------------------------------------

# NOTE ON WHAT "LONG" CAN MEAN HERE.
# chatBodySchema caps `message` at 8000 characters, so the longest context
# reachable through the normal chat path is ~8000 chars (~2k tokens). That is
# mid-range context, not the 100k+ these models advertise. Testing real long
# context would require the file-upload path, which is a separate capability
# (and a separate SSB item). This limitation is reported with the score
# rather than hidden by calling 2k tokens "long".
_FILLER_SENTENCES = [
    "The logistics team reviewed the quarterly shipping manifests without incident.",
    "Warehouse humidity remained within the tolerances set out in the handbook.",
    "Several pallets were relabelled after the barcode printer was recalibrated.",
    "The night shift reported no deviations from the standard loading procedure.",
    "Maintenance replaced two conveyor belts during the scheduled downtime window.",
    "Inventory counts matched the ledger for the third consecutive audit cycle.",
    "A supplier confirmed the revised delivery schedule by email the same day.",
    "The forklift certification records were filed in the cabinet by the office.",
]


def _haystack(needle: str, target_chars: int) -> str:
    """Filler with the needle buried at roughly the midpoint.

    Midpoint on purpose: the start and the end of a context are the easiest
    positions to retrieve from, so putting it there would flatter the result.
    """
    body: list[str] = []
    n = 0
    while n < target_chars // 2:
        s = _FILLER_SENTENCES[len(body) % len(_FILLER_SENTENCES)]
        body.append(s)
        n += len(s) + 1
    body.append(needle)
    while n < target_chars:
        s = _FILLER_SENTENCES[len(body) % len(_FILLER_SENTENCES)]
        body.append(s)
        n += len(s) + 1
    return " ".join(body)


_NEEDLES = [
    ("The authorisation code for bay seventeen is 4829.", "4829", 4829, 2000),
    ("Inspector Halvorsen recorded a pallet temperature of 6 degrees.", "6", 6, 3500),
    ("The replacement part number for the sorter motor is 7314.", "7314", 7314, 5000),
    ("Exactly 238 crates were moved to the annex on Tuesday.", "238", 238, 6800),
]

_NEEDLE_QUESTIONS = [
    "What is the authorisation code for bay seventeen? Answer with only the number.",
    "What pallet temperature, in degrees, did Inspector Halvorsen record? Answer with only the number.",
    "What is the replacement part number for the sorter motor? Answer with only the number.",
    "Exactly how many crates were moved to the annex on Tuesday? Answer with only the number.",
]


def long_context() -> list[Question]:
    out: list[Question] = []
    for i, ((needle, _s, gold, size)) in enumerate(_NEEDLES):
        hay = _haystack(needle, size)
        prompt = (
            "Read the following operations log, then answer the question at the end "
            "using only information from the log.\n\n"
            f"--- LOG ---\n{hay}\n--- END LOG ---\n\n"
            f"{_NEEDLE_QUESTIONS[i]}"
        )
        assert len(prompt) < 8000, "prompt would exceed the API's 8000-char cap"
        out.append(Question(
            question_id=f"{GROUP}-lc-needle-{i:02d}",
            group_id=f"{GROUP}-lc-needle",
            category="long_context", subcategory=f"{size}-char haystack",
            skill="mid-context retrieval",
            difficulty="medium" if size < 5000 else "hard",
            question_type="comprehension",
            prompt=prompt,
            expected_capability="documents", expected_complexity="medium",
            evaluation_method="NUMERIC", gold_answer=gold, tolerance=0.0,
            source="constructed: needle placed at the midpoint of generated filler",
            notes=f"prompt length {len(prompt)} chars; needle at ~50% depth",
        ))
    return out


# ---------------------------------------------------------------------------
# Instruction following
# ---------------------------------------------------------------------------

_INSTRUCTIONS = [
    ("Name the capital city of Japan. Reply with exactly 1 word and no trailing period.",
     ["exactly 1 word", "no trailing period"], "easy"),
    ("List exactly three primary colours as a comma-separated list, all lowercase, "
     "with no spaces after commas and no trailing period.",
     ["three comma-separated", "all lowercase", "no spaces after commas", "no trailing period"], "medium"),
    ("Describe the ocean in exactly 5 words. Do not use a trailing period.",
     ["exactly 5 words", "no trailing period"], "medium"),
    ("Reply with the single word ACKNOWLEDGED in all uppercase. Nothing else.",
     ["exactly 1 word", "all uppercase"], "easy"),
    ("Write one sentence about rain that contains no digits and starts with 'Rain'.",
     ["no digits", "starts with 'Rain'", "exactly one line"], "medium"),
    ("Return a JSON object with a single key \"answer\" whose value is the number 7. "
     "Output valid JSON and nothing else.",
     ["valid json"], "medium"),
    ("Summarise the concept of gravity in at most 12 words, all lowercase.",
     ["at most 12 words", "all lowercase"], "medium"),
    ("Reply with exactly 2 lines. The first line must be 'one' and nothing else; "
     "the second line must be 'two' and nothing else.",
     ["exactly 2 lines", "all lowercase"], "hard"),
    ("Answer this question without using the letter 'e': what is the colour of grass? "
     "Reply in exactly 1 word.",
     ["no letter 'e'", "exactly 1 word"], "hard"),
    ("Name any European river. Your reply must end with 'river' and contain no digits.",
     ["ends with 'river'", "no digits"], "medium"),
]


def instruction_following() -> list[Question]:
    out: list[Question] = []
    for i, (prompt, criteria, difficulty) in enumerate(_INSTRUCTIONS):
        out.append(Question(
            question_id=f"{GROUP}-if-{i:02d}",
            group_id=f"{GROUP}-if",
            category="instruction_following", subcategory="format constraint",
            skill="constraint compliance",
            difficulty=difficulty, question_type="instruction_following",
            prompt=prompt,
            expected_capability="general", expected_complexity="simple",
            evaluation_method="STRUCTURE", rubric=criteria,
            source="authored: every constraint is mechanically checkable",
            notes="Scored on compliance only. Whether the content is also true is "
                  "covered by the knowledge category, not here.",
        ))
    return out


def build() -> list[Question]:
    return multilingual() + long_context() + instruction_following()
