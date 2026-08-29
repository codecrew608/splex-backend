"""Additional physics: optics, magnetism, circular motion, gases, radioactivity.

Same discipline as physics.py — one entry per distinct principle or trap, each
answer computed, constants stated in the prompt so the gold answer cannot drift
with the model's choice of g or c.
"""

from __future__ import annotations

import math

from ..schema import Question


def _n(qid, group, sub, skill, diff, prompt, ans, unit, why, qtype="computation",
       cx="medium", adv=0):
    a = float(ans)
    return Question(
        question_id=qid, group_id=group, category="physics", subcategory=sub, skill=skill,
        difficulty=diff, question_type=qtype, prompt=prompt,
        expected_capability="math", expected_complexity=cx,
        evaluation_method="NUMERIC", gold_answer=a, tolerance=abs(a) * 1e-3 + 1e-6,
        unit=unit, adversarial_level=adv, notes=why, source="computed",
    )


def _r(qid, group, sub, skill, diff, prompt, rubric, why, adv=0, qtype="conceptual"):
    return Question(
        question_id=qid, group_id=group, category="physics", subcategory=sub, skill=skill,
        difficulty=diff, question_type=qtype, prompt=prompt,
        expected_capability="reasoning", expected_complexity="medium",
        evaluation_method="RUBRIC", rubric=rubric, adversarial_level=adv,
        notes=why, source="authored",
    )


def circular_motion() -> list[Question]:
    g = "phys-circ"
    return [
        _n(f"{g}-00", g, "circular_motion", "centripetal_acceleration", "hard",
           "An object moves in a circle of radius 4 m at a constant speed of 6 m/s. "
           "What is its centripetal acceleration in m/s^2? Give only the number.",
           6 ** 2 / 4, "m/s^2", "a = v^2/r"),
        _n(f"{g}-01", g, "circular_motion", "centripetal_force", "hard",
           "A 2 kg object moves in a circle of radius 5 m at 10 m/s. "
           "What centripetal force acts on it, in newtons? Give only the number.",
           2 * 10 ** 2 / 5, "N", "F = mv^2/r"),
        _n(f"{g}-02", g, "circular_motion", "period_from_speed", "extreme",
           "An object completes a circular path of radius 3 m at a constant speed of 6 m/s. "
           "How long does one full revolution take, in seconds? Use pi = 3.14159. "
           "Give only the number.",
           2 * 3.14159 * 3 / 6, "s", "circumference / speed"),
        _r(f"{g}-03", g, "circular_motion", "constant_speed_changing_velocity", "hard",
           "An object travels in a circle at a constant speed. Is it accelerating? "
           "Answer yes or no and justify.",
           ["Answers YES.",
            "Explains that velocity is a vector and its DIRECTION changes continuously.",
            "Names the acceleration as centripetal, directed toward the centre."],
           "'constant speed' invites 'no acceleration'", adv=2),
        _r(f"{g}-04", g, "circular_motion", "centrifugal_misconception", "extreme",
           "A passenger in a car turning sharply left feels pushed to the right. "
           "What force pushes them right? Explain.",
           ["States there is no outward (centrifugal) force in an inertial frame.",
            "Explains the passenger's body continues in a straight line by inertia while the car "
            "turns beneath/around them.",
            "Identifies the real force as the inward (centripetal) one from the seat/door."],
           "the felt 'force' is inertia, not a real outward force", adv=3),
    ]


def optics() -> list[Question]:
    g = "phys-opt"
    return [
        _n(f"{g}-00", g, "optics", "reflection", "easy",
           "A light ray strikes a plane mirror at an angle of incidence of 35 degrees. "
           "What is the angle of reflection, in degrees? Give only the number.",
           35, "degrees", "law of reflection"),
        _n(f"{g}-01", g, "optics", "refractive_index", "hard",
           "Light travels at 3.0e8 m/s in vacuum and 2.0e8 m/s in a medium. "
           "What is the refractive index of that medium? Give only the number.",
           3.0e8 / 2.0e8, "dimensionless", "n = c/v"),
        _n(f"{g}-02", g, "optics", "lens_equation", "extreme",
           "An object is placed 30 cm from a converging lens of focal length 10 cm. "
           "Using 1/f = 1/u + 1/v, what is the image distance v, in cm? Give only the number.",
           1 / (1 / 10 - 1 / 30), "cm", "lens equation rearranged"),
        _n(f"{g}-03", g, "optics", "magnification", "hard",
           "An object 4 cm tall produces an image 12 cm tall. What is the magnification? "
           "Give only the number.",
           3.0, "dimensionless", "m = image height / object height"),
        _r(f"{g}-04", g, "optics", "total_internal_reflection", "hard",
           "Under what conditions does total internal reflection occur? State both conditions.",
           ["States light must travel from a denser to a less dense medium "
            "(higher to lower refractive index).",
            "States the angle of incidence must exceed the critical angle.",
            "Does not claim it occurs going from less dense to denser."],
           "both conditions are required; one alone is a common partial answer"),
    ]


def magnetism_electric() -> list[Question]:
    g = "phys-mag"
    return [
        _n(f"{g}-00", g, "electricity", "charge_current", "medium",
           "A current of 3 A flows for 5 seconds. How much charge passes, in coulombs? "
           "Give only the number.",
           15, "C", "Q = It"),
        _n(f"{g}-01", g, "electricity", "energy_from_power", "hard",
           "A 60 W bulb runs for 2 hours. How much energy does it use, in joules? "
           "Give only the number.",
           60 * 2 * 3600, "J", "E = Pt with time converted to seconds"),
        _n(f"{g}-02", g, "electricity", "power_from_resistance", "hard",
           "A 12 ohm resistor carries 2 A. What power does it dissipate, in watts? "
           "Give only the number.",
           2 ** 2 * 12, "W", "P = I^2 R"),
        _r(f"{g}-03", g, "magnetism", "magnetic_monopole", "hard",
           "If you cut a bar magnet exactly in half, do you get one north pole piece and one "
           "south pole piece? Explain.",
           ["Answers NO.",
            "States each half becomes a complete magnet with both a north and a south pole.",
            "May note that isolated magnetic monopoles have not been observed."],
           "the intuitive 'split the poles' answer is wrong", adv=2),
        _r(f"{g}-04", g, "electricity", "series_vs_parallel", "hard",
           "Two identical bulbs are wired in series across a battery. One burns out. "
           "What happens to the other, and why?",
           ["States the other bulb also goes out.",
            "Explains that a series circuit has a single path, which is now broken.",
            "Contrasts with parallel wiring, where the other would stay lit (optional but good)."],
           "series/parallel behaviour under failure"),
    ]


def gases_radioactivity() -> list[Question]:
    g = "phys-gas"
    return [
        _n(f"{g}-00", g, "gas_laws", "boyles_law", "hard",
           "A gas at constant temperature occupies 4 L at 100 kPa. "
           "What volume does it occupy at 200 kPa, in litres? Give only the number.",
           4 * 100 / 200, "L", "P1V1 = P2V2 — inverse relationship"),
        _n(f"{g}-01", g, "gas_laws", "charles_law", "hard",
           "A gas at constant pressure occupies 3 L at 300 K. "
           "What volume does it occupy at 400 K, in litres? Give only the number.",
           3 * 400 / 300, "L", "V1/T1 = V2/T2 — must use absolute temperature"),
        _n(f"{g}-02", g, "radioactivity", "half_life", "hard",
           "A radioactive sample has a half-life of 5 years. Starting with 80 g, "
           "how many grams remain after 15 years? Give only the number.",
           80 / 2 ** 3, "g", "three half-lives"),
        _n(f"{g}-03", g, "radioactivity", "half_life_reverse", "extreme",
           "A sample decays from 64 g to 8 g. If the half-life is 3 days, "
           "how many days elapsed? Give only the number.",
           3 * 3, "days", "reverse: 64->8 is three halvings", qtype="reverse"),
        _r(f"{g}-04", g, "radioactivity", "half_life_misconception", "extreme",
           "If a substance has a half-life of 10 years, will it have completely decayed after "
           "20 years? Explain.",
           ["Answers NO.",
            "States a quarter of the original remains after 20 years.",
            "Explains decay is exponential, so it never reaches exactly zero.",
            "Does not claim two half-lives means complete decay."],
           "'two half-lives = all gone' is a very common misconception", adv=3),
    ]


def all_questions() -> list[Question]:
    return circular_motion() + optics() + magnetism_electric() + gases_radioactivity()
