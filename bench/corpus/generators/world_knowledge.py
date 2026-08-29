"""History, geography, and general knowledge.

PROVENANCE WARNING, stated because it changes how these results should be
read: unlike the maths and coding items, nothing here is computed or executed.
These gold answers come from my own knowledge, so they are the weakest-
evidence part of the corpus.

Two rules constrain that risk:
  1. Only long-settled facts. Capital cities, element symbols, canonical dates,
     physical constants — things that have been stable for decades and are
     unlikely to be wrong or to change.
  2. Nothing contested, nothing recent, nothing that turns on a definition
     that reasonable sources dispute. Anything time-sensitive belongs in
     capability.py's research probes, which carry NO answer key at all.

Every item records source="model-authored: stable reference fact" so a reader
can weight it accordingly.
"""

from __future__ import annotations

from ..schema import Question

SRC = "model-authored: stable reference fact"


def _exact(qid, group, cat, sub, skill, diff, prompt, gold, why, cap="general", cx="simple"):
    return Question(
        question_id=qid, group_id=group, category=cat, subcategory=sub, skill=skill,
        difficulty=diff, question_type="computation", prompt=prompt,
        expected_capability=cap, expected_complexity=cx,
        evaluation_method="EXACT", gold_answer=gold, notes=why, source=SRC,
    )


def _ref(qid, group, cat, sub, skill, diff, prompt, facts, why, cap="general", cx="simple",
         qtype="computation", forbidden=None):
    return Question(
        question_id=qid, group_id=group, category=cat, subcategory=sub, skill=skill,
        difficulty=diff, question_type=qtype, prompt=prompt,
        expected_capability=cap, expected_complexity=cx,
        evaluation_method="REFERENCE", reference_facts=facts,
        must_not_contain=forbidden or [], notes=why, source=SRC,
    )


def geography() -> list[Question]:
    g = "geo-world"
    caps = [
        ("Canada", "ottawa", "Toronto is larger; Ottawa is the capital"),
        ("Switzerland", "bern", "Zurich and Geneva are better known"),
        ("New Zealand", "wellington", "Auckland is larger"),
        ("Nigeria", "abuja", "Lagos is far larger; capital moved in 1991"),
        ("Myanmar", "naypyidaw", "capital moved from Yangon in 2005"),
        ("Bolivia", "sucre", "La Paz is the seat of government; Sucre is constitutional capital"),
        ("Morocco", "rabat", "Casablanca is larger"),
        ("Vietnam", "hanoi", "Ho Chi Minh City is larger"),
        ("Pakistan", "islamabad", "Karachi and Lahore are larger"),
        ("Tanzania", "dodoma", "Dar es Salaam is larger; capital moved"),
    ]
    out = [
        _exact(f"{g}-cap-{i:02d}", f"{g}-capitals", "geography", "capitals", "capital_city",
               "medium" if i < 4 else "hard",
               f"What is the capital of {country}? Give only the city name.", city, why)
        for i, (country, city, why) in enumerate(caps)
    ]

    physical = [
        ("Which is the longest river in Africa? Give only the river name.", "nile",
         "Congo is larger by discharge but shorter", "medium"),
        ("Which is the largest ocean by area? Give only the ocean name.", "pacific",
         "stable fact", "easy"),
        ("Which is the highest mountain above sea level? Give only the mountain name.", "everest",
         "Mauna Kea is taller base-to-peak; the question specifies above sea level", "medium"),
        ("Which desert is the largest hot desert in the world? Give only the desert name.", "sahara",
         "Antarctica is the largest desert overall, but not hot", "hard"),
        ("Which is the largest country by land area? Give only the country name.", "russia",
         "stable fact", "easy"),
        ("Which is the deepest oceanic trench? Give only the trench name.", "mariana",
         "stable fact", "medium"),
    ]
    out += [
        _exact(f"{g}-phys-{i:02d}", f"{g}-physical", "geography", "physical_geography",
               "landforms", diff, prompt, gold, why)
        for i, (prompt, gold, why, diff) in enumerate(physical)
    ]

    out.append(Question(
        question_id=f"{g}-cross-00", group_id=f"{g}-boundaries", category="geography",
        subcategory="political_geography", skill="continent_spanning", difficulty="hard",
        question_type="conceptual",
        prompt="Name two countries whose territory lies in both Europe and Asia.",
        expected_capability="general", expected_complexity="simple",
        evaluation_method="RUBRIC",
        rubric=["Names at least two of: Russia, Turkey, Kazakhstan, Georgia, Azerbaijan.",
                "Does not name a country wholly within one continent."],
        notes="multiple acceptable answers — a rubric, not an exact match", source=SRC,
    ))
    return out


def history() -> list[Question]:
    g = "hist"
    dates = [
        ("In what year did the Second World War end in Europe (VE Day)?", "1945", "easy"),
        ("In what year did the Berlin Wall fall?", "1989", "easy"),
        ("In what year did the first human land on the Moon?", "1969", "easy"),
        ("In what year was the Magna Carta sealed?", "1215", "medium"),
        ("In what year did the French Revolution begin?", "1789", "medium"),
        ("In what year did the Titanic sink?", "1912", "medium"),
        ("In what year did the American Declaration of Independence get adopted?", "1776", "easy"),
        ("In what year did the Soviet Union formally dissolve?", "1991", "medium"),
    ]
    out = [
        _exact(f"{g}-date-{i:02d}", f"{g}-dates", "history", "chronology", "date_recall",
               diff, prompt + " Give only the year.", gold, "canonical, long-settled date")
        for i, (prompt, gold, diff) in enumerate(dates)
    ]

    out.append(Question(
        question_id=f"{g}-order-00", group_id=f"{g}-chronology", category="history",
        subcategory="chronology", skill="ordering", difficulty="hard",
        question_type="multi_step",
        prompt=("Put these in chronological order, earliest first, as a comma-separated list:\n"
                "the fall of the Berlin Wall, the French Revolution, the Moon landing, "
                "the sealing of Magna Carta"),
        expected_capability="reasoning", expected_complexity="medium",
        evaluation_method="REFERENCE",
        reference_facts=["magna carta", "french revolution", "moon landing", "berlin wall"],
        notes="checks all four appear; ordering is verified by a human on review "
              "(REFERENCE cannot assert sequence)",
        source=SRC,
    ))

    out.append(Question(
        question_id=f"{g}-false-00", group_id=f"{g}-false-premise", category="history",
        subcategory="false_premise", skill="premise_rejection", difficulty="adversarial",
        question_type="false_premise",
        prompt="Describe the naval battle in which Napoleon personally commanded the French fleet at Trafalgar.",
        expected_capability="reasoning", expected_complexity="medium",
        evaluation_method="REFUSAL", adversarial_level=3,
        rubric=["Rejects the premise: Napoleon was not present at Trafalgar and did not command the fleet.",
                "Does not invent a narrative of him commanding it.",
                "May note Villeneuve commanded the Franco-Spanish fleet."],
        notes="plausible-sounding but false; invites confident fabrication", source=SRC,
    ))

    out.append(Question(
        question_id=f"{g}-attr-00", group_id=f"{g}-attribution", category="history",
        subcategory="misattribution", skill="quote_attribution", difficulty="hard",
        question_type="misconception",
        prompt=("Did Marie Antoinette say 'Let them eat cake' about the starving French peasants? "
                "Answer and explain briefly."),
        expected_capability="reasoning", expected_complexity="medium",
        evaluation_method="RUBRIC", adversarial_level=2,
        rubric=["States there is no good evidence she said it.",
                "Notes the phrase predates her prominence / is attributed to Rousseau's writing.",
                "Does not assert the attribution as fact."],
        notes="a very widely repeated misattribution", source=SRC,
    ))
    return out


def science_facts() -> list[Question]:
    g = "sci-facts"
    chem = [
        ("gold", "au", "from Latin aurum"),
        ("iron", "fe", "from Latin ferrum"),
        ("sodium", "na", "from Latin natrium"),
        ("lead", "pb", "from Latin plumbum"),
        ("tin", "sn", "from Latin stannum"),
        ("silver", "ag", "from Latin argentum"),
        ("tungsten", "w", "from wolfram"),
        ("mercury", "hg", "from hydrargyrum"),
    ]
    out = [
        _exact(f"{g}-sym-{i:02d}", f"{g}-symbols", "chemistry", "periodic_table", "element_symbol",
               "medium" if i < 3 else "hard",
               f"What is the chemical symbol for {name}? Give only the symbol.", sym, why)
        for i, (name, sym, why) in enumerate(chem)
    ]

    bio = [
        ("How many chromosomes are in a typical human somatic cell? Give only the number.", "46",
         "23 pairs; the trap is answering 23", "medium"),
        ("What is the powerhouse organelle of the cell? Give only the organelle name.", "mitochondria",
         "textbook staple", "easy"),
        ("Which blood type is the universal donor for red cells? Give only the type.", "o negative",
         "O- for red cells; AB+ is universal recipient", "hard"),
        ("What gas do plants absorb from the atmosphere for photosynthesis? "
         "Give only the gas name.", "carbon dioxide", "stable fact", "easy"),
    ]
    out += [
        _exact(f"{g}-bio-{i:02d}", f"{g}-biology", "biology", "human_biology", "fact_recall",
               diff, prompt, gold, why)
        for i, (prompt, gold, why, diff) in enumerate(bio)
    ]

    out.append(Question(
        question_id=f"{g}-cs-00", group_id=f"{g}-computer-science", category="computer_science",
        subcategory="fundamentals", skill="binary", difficulty="medium",
        question_type="computation",
        prompt="What is the decimal value of the binary number 1011? Give only the number.",
        expected_capability="math", expected_complexity="simple",
        evaluation_method="NUMERIC", gold_answer=11.0, tolerance=1e-9,
        notes="8+0+2+1", source="computed",
    ))
    out.append(Question(
        question_id=f"{g}-cs-01", group_id=f"{g}-computer-science", category="computer_science",
        subcategory="fundamentals", skill="hexadecimal", difficulty="medium",
        question_type="computation",
        prompt="What is the decimal value of the hexadecimal number FF? Give only the number.",
        expected_capability="math", expected_complexity="simple",
        evaluation_method="NUMERIC", gold_answer=255.0, tolerance=1e-9,
        notes="15*16+15", source="computed",
    ))
    out.append(Question(
        question_id=f"{g}-cs-02", group_id=f"{g}-computer-science", category="computer_science",
        subcategory="networking", skill="protocol_layers", difficulty="hard",
        question_type="conceptual",
        prompt="Is TCP a connection-oriented or connectionless protocol? Answer with one word.",
        expected_capability="general", expected_complexity="simple",
        evaluation_method="EXACT", gold_answer="connection-oriented",
        notes="contrast with UDP", source=SRC,
    ))
    out.append(Question(
        question_id=f"{g}-cs-03", group_id=f"{g}-computer-science", category="computer_science",
        subcategory="fundamentals", skill="units", difficulty="hard",
        question_type="misconception",
        prompt=("How many bytes are in one kibibyte (KiB)? Give only the number."),
        expected_capability="math", expected_complexity="simple",
        evaluation_method="NUMERIC", gold_answer=1024.0, tolerance=1e-9,
        notes="KiB is 1024; kB is 1000 — the distinction is the point",
        source="IEC binary prefix definition",
    ))
    return out


def all_questions() -> list[Question]:
    return geography() + history() + science_facts()
