"""Science, general knowledge, language, business and LaTeX questions.

Provenance note, stated plainly because it affects how results should be read:
the gold answers in this file come from my own knowledge, not from computation
or a cited authority. That is a weaker basis than the sympy-verified maths or
the executed coding tests, so items here are deliberately restricted to
long-settled, textbook-stable facts (atomic numbers, Newton's laws, SI
definitions) where the risk of my being wrong is lowest — and every one is
marked `source="model-authored: stable textbook fact"` so a reader can weigh
them accordingly. Anything time-sensitive or contested lives in
capability.py's research probes instead, with no answer key at all.
"""

from __future__ import annotations

from ..schema import Question

SRC = "model-authored: stable textbook fact"


def _exact(qid, group, cat, sub, skill, diff, prompt, gold, why, cap="general", cx="simple"):
    return Question(
        question_id=qid, group_id=group, category=cat, subcategory=sub, skill=skill,
        difficulty=diff, question_type="computation", prompt=prompt,
        expected_capability=cap, expected_complexity=cx,
        evaluation_method="EXACT", gold_answer=gold, notes=why, source=SRC,
    )


def chemistry() -> list[Question]:
    g = "chem"
    out = [
        _exact(f"{g}-00", f"{g}-atomic", "chemistry", "atomic_structure", "atomic_number",
               "easy", "What is the atomic number of carbon? Give only the number.", "6",
               "defining property of the element"),
        _exact(f"{g}-01", f"{g}-atomic", "chemistry", "atomic_structure", "atomic_number",
               "easy", "What is the chemical symbol for potassium? Give only the symbol.", "K",
               "symbol derives from 'kalium', a common miss"),
        _exact(f"{g}-02", f"{g}-atomic", "chemistry", "atomic_structure", "subatomic",
               "medium", "How many protons does an atom of oxygen have? Give only the number.", "8",
               "protons = atomic number"),
    ]
    out.append(Question(
        question_id=f"{g}-bal-00", group_id=f"{g}-balancing", category="chemistry",
        subcategory="stoichiometry", skill="balancing", difficulty="hard",
        question_type="computation",
        prompt=("Balance this equation and give the coefficients in order as a comma-separated list "
                "(a,b,c,d):\n  a CH4 + b O2 -> c CO2 + d H2O"),
        expected_capability="math", expected_complexity="medium",
        evaluation_method="EXACT", gold_answer="1,2,1,2",
        notes="verifiable by atom counting: C 1=1, H 4=4, O 4=4", source="verified by atom count",
    ))
    out.append(Question(
        question_id=f"{g}-acid-00", group_id=f"{g}-acids", category="chemistry",
        subcategory="acids_bases", skill="ph_scale", difficulty="medium", question_type="conceptual",
        prompt="A solution has pH 3. Is it acidic, neutral, or basic? Answer with one word.",
        expected_capability="general", expected_complexity="simple",
        evaluation_method="EXACT", gold_answer="acidic",
        notes="pH < 7 is acidic", source=SRC,
    ))
    out.append(Question(
        question_id=f"{g}-acid-01", group_id=f"{g}-acids", category="chemistry",
        subcategory="acids_bases", skill="ph_scale", difficulty="hard", question_type="misconception",
        prompt=("A solution's pH changes from 5 to 3. By what FACTOR does the hydrogen ion "
                "concentration change? Give only the number."),
        expected_capability="math", expected_complexity="medium",
        evaluation_method="NUMERIC", gold_answer=100.0, tolerance=1e-6,
        notes="pH is logarithmic: 2 units = 100x, not 2x", source="10^2 by definition of pH",
        adversarial_level=1,
    ))
    return out


def biology() -> list[Question]:
    g = "bio"
    return [
        _exact(f"{g}-00", f"{g}-cells", "biology", "cell_biology", "organelles", "easy",
               "Which organelle is the primary site of ATP production in eukaryotic cells? "
               "Give only the organelle name.", "mitochondria", "textbook staple"),
        _exact(f"{g}-01", f"{g}-genetics", "biology", "genetics", "dna_bases", "medium",
               "In DNA, which base pairs with adenine? Give only the base name.", "thymine",
               "DNA pairs A-T; the trap is answering uracil (RNA)"),
        _exact(f"{g}-02", f"{g}-genetics", "biology", "genetics", "rna_bases", "medium",
               "In RNA, which base pairs with adenine? Give only the base name.", "uracil",
               "minimal pair with the previous item, catching DNA/RNA conflation"),
        Question(
            question_id=f"{g}-03", group_id=f"{g}-evolution", category="biology",
            subcategory="evolution", skill="natural_selection", difficulty="hard",
            question_type="misconception",
            prompt=("A student says: 'Giraffes developed long necks because they kept stretching to "
                    "reach high leaves, and passed the longer necks to their offspring.' "
                    "Is this correct? Explain briefly."),
            expected_capability="reasoning", expected_complexity="medium",
            evaluation_method="RUBRIC", adversarial_level=1,
            rubric=["States this is incorrect (it describes Lamarckism).",
                    "Explains variation exists first and selection acts on heritable variation.",
                    "Notes acquired characteristics are not inherited this way."],
            notes="Lamarckian misconception", source=SRC,
        ),
    ]


def earth_astronomy() -> list[Question]:
    g = "earth"
    return [
        _exact(f"{g}-00", f"{g}-astronomy", "astronomy", "solar_system", "planets", "easy",
               "Which is the largest planet in our Solar System? Give only the planet name.", "jupiter",
               "stable fact"),
        Question(
            question_id=f"{g}-01", group_id=f"{g}-astronomy", category="astronomy",
            subcategory="seasons", skill="cause_of_seasons", difficulty="hard",
            question_type="misconception",
            prompt="Are Earth's seasons caused by its varying distance from the Sun? Explain briefly.",
            expected_capability="reasoning", expected_complexity="medium",
            evaluation_method="RUBRIC", adversarial_level=2,
            rubric=["States NO.",
                    "Attributes seasons to the tilt of Earth's rotational axis (~23.5 degrees).",
                    "May note the hemispheres have opposite seasons simultaneously, which distance "
                    "cannot explain."],
            notes="the distance explanation is a very common misconception", source=SRC,
        ),
        Question(
            question_id=f"{g}-02", group_id=f"{g}-geology", category="earth_science",
            subcategory="geology", skill="rock_cycle", difficulty="medium", question_type="conceptual",
            prompt="Name the three main rock types in the rock cycle. List them comma-separated.",
            expected_capability="general", expected_complexity="simple",
            evaluation_method="REFERENCE",
            reference_facts=["igneous", "sedimentary", "metamorphic"],
            notes="all three must appear", source=SRC,
        ),
    ]


def general_knowledge() -> list[Question]:
    g = "gk"
    return [
        _exact(f"{g}-00", g, "general_knowledge", "geography", "capitals", "easy",
               "What is the capital of Australia? Give only the city name.", "canberra",
               "Sydney/Melbourne are the classic wrong answers"),
        _exact(f"{g}-01", g, "general_knowledge", "geography", "capitals", "medium",
               "What is the capital of Turkey? Give only the city name.", "ankara",
               "Istanbul is the larger city but not the capital"),
        _exact(f"{g}-02", g, "general_knowledge", "geography", "capitals", "medium",
               "What is the capital of Brazil? Give only the city name.", "brasilia",
               "Rio de Janeiro is the common wrong answer"),
        Question(
            question_id=f"{g}-03", group_id=g, category="general_knowledge", subcategory="units",
            skill="si_definitions", difficulty="medium", question_type="conceptual",
            prompt="What is the SI base unit of electric current? Give only the unit name.",
            expected_capability="general", expected_complexity="simple",
            evaluation_method="EXACT", gold_answer="ampere",
            notes="one of the seven SI base units", source=SRC,
        ),
    ]


def reading_comprehension() -> list[Question]:
    g = "read"
    passage = (
        "The Antikythera mechanism is an ancient Greek device recovered from a shipwreck in 1901. "
        "For decades its purpose was disputed. Modern imaging revealed at least 30 bronze gears, and "
        "researchers concluded it modelled the motions of the Sun and Moon and predicted eclipses. "
        "Nothing of comparable mechanical complexity is known from the following thousand years."
    )
    return [
        Question(
            question_id=f"{g}-00", group_id=g, category="reading_comprehension",
            subcategory="literal", skill="fact_extraction", difficulty="easy",
            question_type="comprehension",
            prompt=f"{passage}\n\nIn what year was the mechanism recovered? Give only the year.",
            expected_capability="documents", expected_complexity="simple",
            evaluation_method="EXACT", gold_answer="1901",
            notes="stated directly in the passage", source="self-contained passage",
        ),
        Question(
            question_id=f"{g}-01", group_id=g, category="reading_comprehension",
            subcategory="inference", skill="inference", difficulty="hard",
            question_type="comprehension",
            prompt=(f"{passage}\n\nBased ONLY on this passage, does it state who built the mechanism? "
                    "Answer yes or no."),
            expected_capability="documents", expected_complexity="simple",
            evaluation_method="EXACT", gold_answer="no", adversarial_level=2,
            notes="the passage never says who built it; outside knowledge must not leak in",
            source="self-contained passage",
        ),
        Question(
            question_id=f"{g}-02", group_id=g, category="reading_comprehension",
            subcategory="inference", skill="unsupported_claim", difficulty="extreme",
            question_type="insufficient_info",
            prompt=(f"{passage}\n\nAccording to the passage, how much did the mechanism weigh?"),
            expected_capability="documents", expected_complexity="simple",
            evaluation_method="REFUSAL", adversarial_level=3,
            rubric=["States the passage does not give a weight.",
                    "Does not invent a figure."],
            notes="tests grounding: the answer is simply absent", source="self-contained passage",
        ),
        Question(
            question_id=f"{g}-03", group_id=g, category="summarization",
            subcategory="faithful_summary", skill="summarization", difficulty="medium",
            question_type="summarization",
            prompt=f"{passage}\n\nSummarise this passage in exactly one sentence.",
            expected_capability="writing", expected_complexity="medium",
            evaluation_method="RUBRIC",
            rubric=["Exactly one sentence.",
                    "Mentions it is an ancient Greek astronomical/geared device.",
                    "Introduces no facts absent from the passage."],
            notes="faithfulness matters more than style", source="self-contained passage",
        ),
    ]


def language() -> list[Question]:
    g = "lang"
    return [
        Question(
            question_id=f"{g}-00", group_id=g, category="language", subcategory="grammar",
            skill="subject_verb_agreement", difficulty="medium", question_type="computation",
            prompt=("Correct the grammatical error and output only the corrected sentence:\n"
                    "'The list of items are on the desk.'"),
            expected_capability="writing", expected_complexity="simple",
            evaluation_method="REFERENCE", reference_facts=["list of items is"],
            notes="the subject is 'list' (singular), not 'items'", source=SRC,
        ),
        Question(
            question_id=f"{g}-01", group_id=g, category="language", subcategory="semantics",
            skill="word_choice", difficulty="medium", question_type="computation",
            prompt=("Choose the correct word and output only the completed sentence:\n"
                    "'The medicine had a noticeable (affect/effect) on her recovery.'"),
            expected_capability="writing", expected_complexity="simple",
            evaluation_method="REFERENCE", reference_facts=["effect"],
            must_not_contain=["affect on"],
            notes="noun position requires 'effect'", source=SRC,
        ),
        Question(
            question_id=f"{g}-02", group_id=g, category="language", subcategory="translation",
            skill="translation", difficulty="medium", question_type="computation",
            prompt="Translate into French, output only the translation: 'The book is on the table.'",
            expected_capability="writing", expected_complexity="simple",
            evaluation_method="REFERENCE",
            reference_facts=["livre", "table"],
            notes="accepts natural variants; checks the two content words survive", source=SRC,
        ),
    ]


def business() -> list[Question]:
    g = "biz"
    return [
        Question(
            question_id=f"{g}-00", group_id=f"{g}-margins", category="business",
            subcategory="unit_economics", skill="gross_margin", difficulty="medium",
            question_type="computation",
            prompt=("A product sells for 200 and costs 80 to make. What is the gross margin as a "
                    "percentage? Give only the number."),
            expected_capability="math", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=60.0, tolerance=1e-6, unit="percent",
            notes="(200-80)/200; the trap is dividing by cost instead of revenue", source="computed",
        ),
        Question(
            question_id=f"{g}-01", group_id=f"{g}-margins", category="business",
            subcategory="unit_economics", skill="markup_vs_margin", difficulty="hard",
            question_type="misconception",
            prompt=("A product costs 80 and sells for 200. What is the MARKUP as a percentage? "
                    "Give only the number."),
            expected_capability="math", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=150.0, tolerance=1e-6, unit="percent",
            adversarial_level=2,
            notes="markup is over COST (150%), margin is over REVENUE (60%) — deliberate minimal "
                  "pair with the previous item",
            source="computed",
        ),
        Question(
            question_id=f"{g}-02", group_id=f"{g}-breakeven", category="business",
            subcategory="break_even", skill="break_even_units", difficulty="hard",
            question_type="multi_step",
            prompt=("Fixed costs are 50,000 per month. Each unit sells for 25 and costs 15 to produce. "
                    "How many units must be sold monthly to break even? Give only the number."),
            expected_capability="math", expected_complexity="medium",
            evaluation_method="NUMERIC", gold_answer=5000.0, tolerance=1e-6, unit="units",
            notes="fixed / contribution margin (25-15)", source="computed",
        ),
        Question(
            question_id=f"{g}-03", group_id=f"{g}-ltv", category="business",
            subcategory="saas_metrics", skill="ltv_cac", difficulty="hard",
            question_type="multi_step",
            prompt=("A SaaS customer pays 50/month with 4% monthly churn, and costs 600 to acquire. "
                    "Using LTV = ARPU / churn rate, what is the LTV:CAC ratio? "
                    "Give only the number, to two decimal places."),
            expected_capability="math", expected_complexity="medium",
            evaluation_method="NUMERIC", gold_answer=(50 / 0.04) / 600, tolerance=0.01,
            notes="LTV = 1250, CAC = 600, ratio ~2.08", source="computed",
        ),
    ]


def latex() -> list[Question]:
    g = "latex"
    return [
        Question(
            question_id=f"{g}-00", group_id=g, category="latex", subcategory="formatting",
            skill="fraction_markup", difficulty="medium", question_type="computation",
            prompt=("Write the quadratic formula in LaTeX. Output only the LaTeX, no explanation."),
            expected_capability="math", expected_complexity="simple",
            evaluation_method="REFERENCE",
            reference_facts=["\\frac", "\\sqrt", "b^2", "4ac", "2a"],
            notes="checks the required structural elements; mathematical correctness is what is "
                  "scored, not stylistic choices",
            source=SRC,
        ),
        Question(
            question_id=f"{g}-01", group_id=g, category="latex", subcategory="formatting",
            skill="integral_markup", difficulty="medium", question_type="computation",
            prompt=("Write the definite integral of x squared from 0 to 1 in LaTeX. "
                    "Output only the LaTeX."),
            expected_capability="math", expected_complexity="simple",
            evaluation_method="REFERENCE",
            reference_facts=["\\int", "_0", "^1", "x^2", "dx"],
            notes="structural check on limits and integrand", source=SRC,
        ),
        Question(
            question_id=f"{g}-02", group_id=g, category="latex", subcategory="formatting",
            skill="summation_markup", difficulty="hard", question_type="computation",
            prompt=("Write the sum from i=1 to n of i squared in LaTeX. Output only the LaTeX."),
            expected_capability="math", expected_complexity="simple",
            evaluation_method="REFERENCE",
            reference_facts=["\\sum", "i=1", "^n", "i^2"],
            notes="structural check on summation bounds", source=SRC,
        ),
        Question(
            question_id=f"{g}-03", group_id=g, category="latex", subcategory="rendering",
            skill="raw_latex_leakage", difficulty="hard", question_type="instruction_following",
            prompt=("In PLAIN TEXT with no LaTeX markup at all, state the Pythagorean theorem as an "
                    "equation. Do not use backslashes, dollar signs, or \\frac."),
            expected_capability="general", expected_complexity="simple",
            evaluation_method="STRUCTURE",
            rubric=["Contains no backslash characters.", "Contains no dollar signs.",
                    "Still states the relationship (a^2 + b^2 = c^2 or in words)."],
            adversarial_level=1,
            notes="the inverse failure: leaking LaTeX when plain text was demanded", source=SRC,
        ),
    ]


def all_questions() -> list[Question]:
    return (chemistry() + biology() + earth_astronomy() + general_knowledge()
            + reading_comprehension() + language() + business() + latex())
