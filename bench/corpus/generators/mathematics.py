"""Programmatically generated mathematics questions with VERIFIED answers.

Every gold answer here is computed (exact rational / sympy), never recalled.
That matters: a benchmark whose answer key comes from the same kind of
system it is testing inherits the errors it is supposed to detect.

Design rule for this file: vary STRUCTURE, not just numbers. Each generator
emits a distinct problem shape, and where numbers do vary they are chosen to
probe a specific failure mode (sign handling, zero, precedence, a boundary),
which is recorded in `notes`. Bulk `a+b` permutations are deliberately absent.
"""

from __future__ import annotations

from fractions import Fraction
import random

import sympy as sp

from ..schema import Question

R = random.Random(20260829)  # fixed seed: the corpus must be reproducible


def _q(**kw) -> Question:
    return Question(**kw)


def _fmt(x: Fraction) -> str:
    return str(x.numerator) if x.denominator == 1 else f"{x.numerator}/{x.denominator}"


# --- arithmetic --------------------------------------------------------------

def arithmetic() -> list[Question]:
    out: list[Question] = []
    g = "arith"

    # Order of operations — the classic trap, several genuinely different shapes.
    precedence_cases = [
        ("8 - 3 * 2 + 1", "subtraction adjacent to multiplication"),
        ("(8 - 3) * (2 + 1)", "parentheses override precedence"),
        ("2 ** 3 ** 2", "exponentiation is right-associative (512, not 64)"),
        ("-3 ** 2", "unary minus binds looser than exponent (-9, not 9)"),
        ("(-3) ** 2", "explicit parentheses change the sign result"),
        ("100 / 10 / 2", "division is left-associative (5, not 20)"),
        ("100 - 10 - 2", "subtraction is left-associative (88, not 92)"),
        ("6 / 2 * (1 + 2)", "the viral ambiguity case, evaluated left-to-right"),
    ]
    for i, (expr, why) in enumerate(precedence_cases):
        val = sp.sympify(expr, evaluate=True)
        out.append(_q(
            question_id=f"{g}-prec-{i:02d}", group_id=f"{g}-precedence",
            category="arithmetic", subcategory="order_of_operations", skill="precedence",
            difficulty="medium" if i < 4 else "hard", question_type="computation",
            prompt=f"Evaluate exactly: {expr.replace('**', '^')}\nGive only the final numeric value.",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=float(val), tolerance=1e-9,
            notes=why, source="computed by sympy",
        ))

    # Negative numbers — sign handling is a common, checkable failure.
    sign_cases = [
        ("-7 + -5", "adding two negatives"),
        ("-7 - -5", "subtracting a negative"),
        ("(-6) * (-4)", "product of two negatives"),
        ("(-48) / 6", "negative dividend"),
        ("(-48) / (-6)", "both negative"),
        ("0 - (-15)", "subtracting a negative from zero"),
        ("(-2) ** 3", "odd power of a negative stays negative"),
        ("(-2) ** 4", "even power of a negative becomes positive"),
    ]
    # Some of these are deliberate minimal pairs: token-set duplicate
    # detection cannot see that "(-48)/6" and "(-48)/(-6)" differ, but the
    # sign of the divisor is exactly what is being probed.
    sign_pairs = {4: f"{g}-sign-03"}
    for i, (expr, why) in enumerate(sign_cases):
        out.append(_q(
            question_id=f"{g}-sign-{i:02d}", group_id=f"{g}-negatives",
            category="arithmetic", subcategory="negative_numbers", skill="sign_handling",
            difficulty="easy" if i < 4 else "medium", question_type="computation",
            prompt=f"Evaluate exactly: {expr.replace('**', '^')}\nGive only the final numeric value.",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=float(sp.sympify(expr)), tolerance=1e-9,
            notes=why, source="computed by sympy",
            minimal_pair_of=sign_pairs.get(i),
        ))

    # Rounding / precision boundaries.
    rounding = [
        (2.5, 0, "half-way value; banker's vs half-up rounding disagree"),
        (-2.5, 0, "negative half-way value"),
        (0.1 + 0.2, 2, "floating point representation trap"),
        (1.005, 2, "classic float representation edge (not exactly 1.005)"),
        (1234.5678, 2, "ordinary two-decimal rounding"),
        (0.000456, 4, "small magnitude"),
    ]
    for i, (val, dp, why) in enumerate(rounding):
        exact = round(Fraction(val).limit_denominator(10**12), dp)
        out.append(_q(
            question_id=f"{g}-round-{i:02d}", group_id=f"{g}-rounding",
            category="arithmetic", subcategory="rounding", skill="precision",
            difficulty="hard", question_type="boundary",
            prompt=f"Round {val!r} to {dp} decimal place(s). Give only the number.",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=float(exact), tolerance=5 * 10 ** (-dp - 1),
            notes=why, source="computed with Fraction",
            # 2.5 vs -2.5 at the same precision: whether the half-way rule is
            # applied symmetrically across zero is the whole experiment.
            minimal_pair_of=f"{g}-round-00" if i == 1 else None,
        ))

    # Division-by-zero awareness — the correct answer is "undefined", not a number.
    for i, expr in enumerate(["7 / 0", "0 / 0", "(5 - 5) / (3 - 3)"]):
        out.append(_q(
            question_id=f"{g}-divzero-{i:02d}", group_id=f"{g}-division-by-zero",
            category="arithmetic", subcategory="division_by_zero", skill="undefined_operations",
            difficulty="medium", question_type="false_premise",
            prompt=f"What is {expr}?",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="REFUSAL", adversarial_level=1,
            rubric=[
                "States the result is undefined (or that division by zero is not permitted).",
                "Does NOT produce a finite numeric answer.",
                "Does not claim the answer is 0, 1, or infinity without qualification.",
            ],
            must_not_contain=[],
            notes="a confident numeric answer here is a hallucination, not a miscalculation",
            source="definition: division by zero is undefined in the reals",
        ))

    # Scientific notation and magnitude.
    sci = [
        ("(3.2e8) * (2.5e-3)", "positive x negative exponent"),
        ("(6.02e23) / (3.01e11)", "large / large"),
        ("(1.5e-7) + (2.5e-8)", "addition requires exponent alignment"),
        ("(9e9) ** 0.5", "square root of a large power of ten"),
    ]
    for i, (expr, why) in enumerate(sci):
        out.append(_q(
            question_id=f"{g}-sci-{i:02d}", group_id=f"{g}-scientific-notation",
            category="arithmetic", subcategory="scientific_notation", skill="magnitude",
            difficulty="hard", question_type="computation",
            prompt=f"Evaluate and give the result in scientific notation: {expr.replace('**', '^')}",
            expected_capability="math", expected_complexity="medium",
            evaluation_method="NUMERIC", gold_answer=float(sp.sympify(expr)),
            tolerance=abs(float(sp.sympify(expr))) * 1e-6,
            notes=why, source="computed by sympy",
        ))

    # Percentage traps that are genuinely distinct problems.
    pct = [
        ("A price rises 20% then falls 20%. What is the net percentage change from the original?",
         -4.0, "successive percentages do not cancel"),
        ("A price falls 50% then rises 50%. What is the net percentage change from the original?",
         -25.0, "asymmetry of percentage decrease and increase"),
        ("What percentage of 250 is 40?", 16.0, "part/whole direction"),
        ("40 is 16% of what number?", 250.0, "reverse percentage"),
        ("A value increases from 80 to 100. What is the percentage increase?", 25.0, "base is the ORIGINAL value"),
        ("A value decreases from 100 to 80. What is the percentage decrease?", 20.0,
         "same absolute change, different base, therefore different percentage"),
    ]
    for i, (prompt, ans, why) in enumerate(pct):
        out.append(_q(
            question_id=f"{g}-pct-{i:02d}", group_id=f"{g}-percentages",
            category="arithmetic", subcategory="percentages", skill="percentage_reasoning",
            difficulty="medium" if i < 2 else "easy", question_type="computation",
            prompt=prompt + "\nGive only the number (percent).",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=ans, tolerance=1e-6,
            unit="percent", notes=why, source="hand-derived, arithmetic re-verified",
        ))

    # Averages / weighted averages — distinct shapes, not number swaps.
    out.append(_q(
        question_id=f"{g}-avg-00", group_id=f"{g}-averages",
        category="arithmetic", subcategory="averages", skill="mean",
        difficulty="medium", question_type="misconception",
        prompt=("A student averages 60% over 4 exams, then scores 100% on a 5th. "
                "What is the new average? Give only the number (percent)."),
        expected_capability="math", expected_complexity="simple",
        evaluation_method="NUMERIC", gold_answer=68.0, tolerance=1e-6, unit="percent",
        notes="tempts averaging 60 and 100 to get 80; correct is (4*60+100)/5",
        source="computed",
    ))
    out.append(_q(
        question_id=f"{g}-avg-01", group_id=f"{g}-averages",
        category="arithmetic", subcategory="averages", skill="harmonic_mean",
        difficulty="hard", question_type="misconception",
        prompt=("A car travels 60 km at 30 km/h, then the same 60 km at 60 km/h. "
                "What is the average speed for the whole trip, in km/h? Give only the number."),
        expected_capability="math", expected_complexity="medium",
        evaluation_method="NUMERIC", gold_answer=40.0, tolerance=1e-6, unit="km/h",
        notes="arithmetic mean (45) is wrong; total distance / total time gives 40",
        source="computed: 120 km / 3 h",
    ))
    return out


# --- fractions ---------------------------------------------------------------

def fractions_() -> list[Question]:
    out: list[Question] = []
    g = "frac"

    # Structurally different operations, each with an exact verified answer.
    ops = [
        (Fraction(3, 4), Fraction(5, 6), "+", "unlike denominators"),
        (Fraction(7, 8), Fraction(5, 12), "-", "subtraction, LCM 24"),
        (Fraction(-2, 3), Fraction(3, 5), "*", "negative times positive"),
        (Fraction(-5, 9), Fraction(-3, 7), "*", "two negatives"),
        (Fraction(4, 9), Fraction(2, 3), "/", "division by a fraction"),
        (Fraction(-7, 10), Fraction(14, 5), "/", "negative divided, result simplifies"),
        (Fraction(11, 6), Fraction(11, 6), "-", "identical operands give exactly zero"),
        (Fraction(1, 3), Fraction(2, 3), "+", "sums to exactly 1"),
    ]
    for i, (a, b, op, why) in enumerate(ops):
        val = {"+": a + b, "-": a - b, "*": a * b, "/": a / b}[op]
        out.append(_q(
            question_id=f"{g}-op-{i:02d}", group_id=f"{g}-operations",
            category="fractions", subcategory="arithmetic", skill=f"fraction_{op}",
            difficulty="easy" if i < 2 else "medium", question_type="computation",
            prompt=(f"Compute ({_fmt(a)}) {op} ({_fmt(b)}). "
                    "Give the answer as a fully simplified fraction."),
            expected_capability="math", expected_complexity="simple",
            evaluation_method="SYMBOLIC", gold_answer=_fmt(val),
            notes=why, source="computed with Fraction (exact)",
        ))

    # Comparison — including the trap where a bigger denominator looks smaller.
    comps = [
        (Fraction(3, 7), Fraction(4, 9), "close values, cross-multiplication needed"),
        (Fraction(-1, 2), Fraction(-1, 3), "negatives reverse the intuition"),
        (Fraction(5, 5), Fraction(7, 7), "both equal 1"),
        (Fraction(22, 7), Fraction(311, 99), "both approximate pi"),
    ]
    for i, (a, b, why) in enumerate(comps):
        gold = "equal" if a == b else ("first" if a > b else "second")
        out.append(_q(
            question_id=f"{g}-cmp-{i:02d}", group_id=f"{g}-comparison",
            category="fractions", subcategory="comparison", skill="ordering",
            difficulty="medium", question_type="computation",
            prompt=(f"Which is larger, {_fmt(a)} or {_fmt(b)}? "
                    "Answer exactly one word: 'first', 'second', or 'equal'."),
            expected_capability="math", expected_complexity="simple",
            evaluation_method="EXACT", gold_answer=gold,
            notes=why, source="computed with Fraction (exact)",
        ))

    # Nested / complex fractions.
    nested = [
        ("(1/2) / (3/4)", "simple complex fraction"),
        ("1 / (1 + 1/2)", "denominator is itself a sum"),
        ("1 / (1 + 1/(1 + 1/2))", "two levels of nesting"),
        ("(2/3 + 1/6) / (5/6 - 1/3)", "compound numerator and denominator"),
    ]
    for i, (expr, why) in enumerate(nested):
        val = sp.nsimplify(sp.sympify(expr))
        out.append(_q(
            question_id=f"{g}-nest-{i:02d}", group_id=f"{g}-nested",
            category="fractions", subcategory="complex_fractions", skill="nesting",
            difficulty="hard", question_type="computation",
            prompt=f"Simplify to a single fraction in lowest terms: {expr}",
            expected_capability="math", expected_complexity="medium",
            evaluation_method="SYMBOLIC", gold_answer=str(val),
            notes=why, source="computed by sympy",
            # One level of nesting vs two. A token SET cannot represent
            # nesting depth, so these look identical to the detector while
            # testing materially different work.
            minimal_pair_of=f"{g}-nest-01" if i == 2 else None,
        ))
    return out


# --- algebra -----------------------------------------------------------------

def algebra() -> list[Question]:
    out: list[Question] = []
    g = "alg"
    x, y = sp.symbols("x y")

    # Linear equations, each a different structural shape.
    linears = [
        ("3*x + 7 - 22", "one-step-after-transposition"),
        ("5*(x - 3) - 2*x - 6", "requires expansion first"),
        ("x/4 + x/6 - 5", "fractional coefficients"),
        ("2*(x + 1) - 2*x - 2", "identity: infinitely many solutions"),
        ("2*(x + 1) - 2*x - 5", "contradiction: no solution"),
    ]
    for i, (expr, why) in enumerate(linears):
        sols = sp.solve(sp.sympify(expr), x)
        if why.startswith("identity"):
            gold, method, qtype = "infinitely many solutions", "REFUSAL", "conceptual"
        elif why.startswith("contradiction"):
            gold, method, qtype = "no solution", "REFUSAL", "conceptual"
        else:
            gold, method, qtype = str(sols[0]), "SYMBOLIC", "computation"

        rec = dict(
            question_id=f"{g}-lin-{i:02d}", group_id=f"{g}-linear",
            category="algebra", subcategory="linear_equations", skill="solve_linear",
            difficulty="medium", question_type=qtype,
            prompt=f"Solve for x: {sp.sympify(expr)} = 0",
            expected_capability="math", expected_complexity="simple",
            evaluation_method=method, notes=why, source="solved by sympy",
        )
        if method == "SYMBOLIC":
            rec["gold_answer"] = gold
        else:
            rec["rubric"] = [
                f"Correctly identifies that the equation has {gold}.",
                "Does not report a single specific numeric solution.",
            ]
            rec["adversarial_level"] = 1
        out.append(_q(**rec))

    # Quadratics: real distinct, repeated, and complex roots.
    quads = [
        ("x**2 - 5*x + 6", "two distinct real roots"),
        ("x**2 - 4*x + 4", "repeated root"),
        ("x**2 + 1", "no real roots — complex only"),
        ("2*x**2 + 3*x - 2", "leading coefficient != 1"),
    ]
    for i, (expr, why) in enumerate(quads):
        roots = sp.solve(sp.sympify(expr), x)
        out.append(_q(
            question_id=f"{g}-quad-{i:02d}", group_id=f"{g}-quadratic",
            category="algebra", subcategory="quadratics", skill="solve_quadratic",
            difficulty="medium" if i < 2 else "hard", question_type="computation",
            prompt=(f"Solve for x: {sp.sympify(expr)} = 0. "
                    "List all solutions, real or complex."),
            expected_capability="math", expected_complexity="medium",
            evaluation_method="SYMBOLIC",
            gold_answer=", ".join(str(r) for r in roots),
            notes=why, source="solved by sympy",
        ))

    # Simultaneous systems: unique, none, infinite.
    systems = [
        (["x + y - 10", "x - y - 2"], "unique solution"),
        (["x + y - 10", "2*x + 2*y - 20"], "dependent: infinitely many solutions"),
        (["x + y - 10", "x + y - 12"], "inconsistent: no solution"),
    ]
    for i, (eqs, why) in enumerate(systems):
        sol = sp.solve([sp.sympify(e) for e in eqs], [x, y], dict=True)
        if "infinitely" in why:
            method, gold = "REFUSAL", "infinitely many solutions"
        elif "no solution" in why:
            method, gold = "REFUSAL", "no solution"
        else:
            method, gold = "SYMBOLIC", f"x={sol[0][x]}, y={sol[0][y]}"

        rec = dict(
            question_id=f"{g}-sys-{i:02d}", group_id=f"{g}-systems",
            category="algebra", subcategory="simultaneous_equations", skill="solve_system",
            difficulty="medium" if i == 0 else "hard",
            question_type="computation" if i == 0 else "conceptual",
            prompt=("Solve the system for x and y:\n"
                    + "\n".join(f"  {sp.sympify(e)} = 0" for e in eqs)),
            expected_capability="math", expected_complexity="medium",
            evaluation_method=method, notes=why, source="solved by sympy",
        )
        if method == "SYMBOLIC":
            rec["gold_answer"] = gold
        else:
            rec["rubric"] = [
                f"Correctly identifies the system has {gold}.",
                "Does not fabricate a single specific (x, y) pair.",
            ]
            rec["adversarial_level"] = 1
        out.append(_q(**rec))

    # Calculus: derivatives and integrals, verified symbolically.
    calc = [
        ("x**3 - 4*x", "diff", "polynomial derivative"),
        ("sin(x)*cos(x)", "diff", "product rule"),
        ("exp(2*x)", "diff", "chain rule"),
        ("1/x", "integrate", "logarithmic integral"),
        ("x**2", "integrate", "power rule integral"),
        ("cos(x)", "integrate", "trigonometric integral"),
    ]
    for i, (expr, op, why) in enumerate(calc):
        e = sp.sympify(expr)
        val = sp.diff(e, x) if op == "diff" else sp.integrate(e, x)
        verb = "Differentiate" if op == "diff" else "Find the indefinite integral of"
        suffix = "" if op == "diff" else " (omit the constant of integration)"
        out.append(_q(
            question_id=f"{g}-calc-{i:02d}", group_id=f"{g}-calculus",
            category="mathematics", subcategory="calculus", skill=op,
            difficulty="medium" if i < 3 else "hard", question_type="computation",
            prompt=f"{verb} {e} with respect to x{suffix}.",
            expected_capability="math", expected_complexity="medium",
            evaluation_method="SYMBOLIC", gold_answer=str(sp.simplify(val)),
            notes=why, source="computed by sympy",
        ))

    # Limits, including an indeterminate form that must be resolved.
    limits = [
        ("sin(x)/x", 0, "classic 0/0 indeterminate form, limit is 1"),
        ("(x**2 - 1)/(x - 1)", 1, "removable discontinuity, limit is 2"),
        ("(1 + 1/x)**x", sp.oo, "definition of e"),
    ]
    for i, (expr, pt, why) in enumerate(limits):
        val = sp.limit(sp.sympify(expr), x, pt)
        where = "infinity" if pt == sp.oo else str(pt)
        out.append(_q(
            question_id=f"{g}-lim-{i:02d}", group_id=f"{g}-limits",
            category="mathematics", subcategory="limits", skill="evaluate_limit",
            difficulty="hard", question_type="computation",
            prompt=f"Evaluate the limit of {sp.sympify(expr)} as x approaches {where}.",
            expected_capability="math", expected_complexity="medium",
            evaluation_method="SYMBOLIC", gold_answer=str(val),
            notes=why, source="computed by sympy",
        ))
    return out


# --- geometry & trigonometry -------------------------------------------------

def geometry() -> list[Question]:
    out: list[Question] = []
    g = "geo"

    shapes = [
        ("A circle has radius 7 cm. What is its area? Use pi = 3.14159. Give only the number.",
         3.14159 * 49, "cm^2", "area not circumference"),
        ("A circle has area 78.5 cm^2. What is its radius? Use pi = 3.14159. Give only the number.",
         float(sp.sqrt(78.5 / 3.14159)), "cm", "reverse calculation"),
        ("A triangle has sides 3, 4 and 5. What is its area? Give only the number.",
         6.0, "square units", "right triangle; Heron's formula also works"),
        ("A triangle has sides 5, 5 and 8. What is its area? Give only the number.",
         12.0, "square units", "isosceles, requires Heron or height"),
        ("A rectangle has perimeter 20 and area 24. What is its longer side? Give only the number.",
         6.0, "units", "system of equations disguised as geometry"),
        ("A cube has surface area 96 cm^2. What is its volume? Give only the number.",
         64.0, "cm^3", "two-step: area -> edge -> volume"),
    ]
    for i, (prompt, ans, unit, why) in enumerate(shapes):
        out.append(_q(
            question_id=f"{g}-shape-{i:02d}", group_id=f"{g}-plane-and-solid",
            category="geometry", subcategory="area_volume", skill="mensuration",
            difficulty="easy" if i == 0 else ("medium" if i < 4 else "hard"),
            question_type="reverse" if "reverse" in why else "computation",
            prompt=prompt, expected_capability="math", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=float(ans), tolerance=abs(float(ans)) * 1e-4 + 1e-6,
            unit=unit, notes=why, source="computed",
        ))

    # Trigonometry — exact values, plus a degree/radian trap.
    trig = [
        ("sin(30 degrees)", 0.5, "exact value"),
        ("cos(60 degrees)", 0.5, "exact value"),
        ("tan(45 degrees)", 1.0, "exact value"),
        ("sin(0 degrees)", 0.0, "boundary"),
        ("cos(90 degrees)", 0.0, "boundary"),
    ]
    for i, (desc, ans, why) in enumerate(trig):
        out.append(_q(
            question_id=f"{g}-trig-{i:02d}", group_id=f"{g}-trigonometry",
            category="trigonometry", subcategory="exact_values", skill="trig_values",
            difficulty="easy", question_type="computation",
            prompt=f"What is {desc}? Give only the numeric value.",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=ans, tolerance=1e-9,
            notes=why, source="exact trigonometric value",
        ))
    out.append(_q(
        question_id=f"{g}-trig-rad", group_id=f"{g}-trigonometry",
        category="trigonometry", subcategory="units", skill="degree_radian",
        difficulty="hard", question_type="misconception",
        prompt="What is sin(1)? Assume the argument is in RADIANS. Give only the numeric value.",
        expected_capability="math", expected_complexity="simple",
        evaluation_method="NUMERIC", gold_answer=float(sp.sin(1)), tolerance=1e-6,
        notes="sin(1 rad) = 0.8415, not sin(1 degree) = 0.01745",
        source="computed by sympy", adversarial_level=1,
    ))
    return out


# --- probability & statistics -------------------------------------------------

def probability() -> list[Question]:
    out: list[Question] = []
    g = "prob"

    cases = [
        ("A fair coin is flipped 3 times. What is the probability of exactly 2 heads?",
         Fraction(3, 8), "binomial, C(3,2)/8"),
        ("Two fair six-sided dice are rolled. What is the probability the sum is 7?",
         Fraction(6, 36), "6 favourable of 36"),
        ("Two fair six-sided dice are rolled. What is the probability the sum is 1?",
         Fraction(0, 1), "impossible event — minimum sum is 2"),
        ("A bag holds 3 red and 5 blue balls. Two are drawn WITHOUT replacement. "
         "What is the probability both are red?",
         Fraction(3, 8) * Fraction(2, 7), "dependent events"),
        ("A bag holds 3 red and 5 blue balls. Two are drawn WITH replacement. "
         "What is the probability both are red?",
         Fraction(3, 8) * Fraction(3, 8), "independent events — contrast with the previous"),
        ("A fair coin has landed heads 5 times in a row. What is the probability the next flip is heads?",
         Fraction(1, 2), "gambler's fallacy: past flips are irrelevant"),
    ]
    for i, (prompt, ans, why) in enumerate(cases):
        out.append(_q(
            question_id=f"{g}-p-{i:02d}", group_id=f"{g}-basic-probability",
            category="probability", subcategory="discrete", skill="probability_computation",
            difficulty="medium" if i < 3 else "hard",
            question_type="misconception" if "fallacy" in why else "computation",
            prompt=prompt + "\nGive the answer as a fraction in lowest terms.",
            expected_capability="math", expected_complexity="medium",
            evaluation_method="SYMBOLIC", gold_answer=_fmt(Fraction(ans)),
            adversarial_level=1 if "fallacy" in why else 0,
            notes=why, source="computed with Fraction (exact)",
            # WITHOUT vs WITH replacement — one word apart, and the single
            # most common source of confusion in elementary probability.
            minimal_pair_of=f"{g}-p-03" if i == 4 else None,
        ))

    # Statistics — mean/median/mode distinctions and an outlier effect.
    data = [2, 4, 4, 4, 5, 5, 7, 9]
    import statistics as st
    stats_cases = [
        ("mean", st.mean(data)), ("median", st.median(data)), ("mode", st.mode(data)),
        ("population standard deviation", st.pstdev(data)),
    ]
    for i, (name, ans) in enumerate(stats_cases):
        out.append(_q(
            question_id=f"{g}-stat-{i:02d}", group_id=f"{g}-descriptive-statistics",
            category="statistics", subcategory="central_tendency", skill=name.replace(" ", "_"),
            difficulty="medium", question_type="computation",
            prompt=f"For the data set {data}, what is the {name}? Give only the number.",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="NUMERIC", gold_answer=float(ans), tolerance=1e-6,
            notes="same data across four measures — tests distinguishing them, not recomputation",
            source="computed with python statistics",
        ))
    out.append(_q(
        question_id=f"{g}-stat-outlier", group_id=f"{g}-descriptive-statistics",
        category="statistics", subcategory="robustness", skill="outlier_effect",
        difficulty="hard", question_type="conceptual",
        prompt=("Nine people earn 30,000 each; one earns 1,000,000. "
                "Which better represents a typical salary here, the mean or the median, and why? "
                "State which one, then give both values."),
        expected_capability="math", expected_complexity="medium",
        evaluation_method="RUBRIC",
        rubric=[
            "Selects the MEDIAN as more representative.",
            "Gives the median as 30,000.",
            "Gives the mean as 127,000.",
            "Explains that the mean is distorted by the single extreme value.",
        ],
        notes="mean = (9*30000 + 1000000)/10 = 127000", source="computed",
    ))
    return out


def all_questions() -> list[Question]:
    return arithmetic() + fractions_() + algebra() + geometry() + probability()
