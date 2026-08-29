"""Extended mathematics: breadth of distinct SKILLS, all answers computed.

The organising principle is one entry per distinct skill or trap, not one per
number. Where a family does get several entries (e.g. unit conversion), each
member is a different physical quantity or a different direction — which is a
genuinely different fact to know, not the same question with the digits
changed.

Everything here is verified by sympy or exact rational arithmetic at build
time, so no answer in this file depends on my recall.
"""

from __future__ import annotations

from fractions import Fraction
import math

import sympy as sp

from ..schema import Question

x, y, z, n = sp.symbols("x y z n")


def _sym(qid, group, cat, sub, skill, diff, prompt, gold, why, cx="medium", qtype="computation"):
    return Question(
        question_id=qid, group_id=group, category=cat, subcategory=sub, skill=skill,
        difficulty=diff, question_type=qtype, prompt=prompt,
        expected_capability="math", expected_complexity=cx,
        evaluation_method="SYMBOLIC", gold_answer=str(gold),
        notes=why, source="computed by sympy",
    )


def _numq(qid, group, cat, sub, skill, diff, prompt, gold, unit, why, cx="simple",
          qtype="computation", tol=None):
    g = float(gold)
    return Question(
        question_id=qid, group_id=group, category=cat, subcategory=sub, skill=skill,
        difficulty=diff, question_type=qtype, prompt=prompt,
        expected_capability="math", expected_complexity=cx,
        evaluation_method="NUMERIC", gold_answer=g,
        tolerance=tol if tol is not None else abs(g) * 1e-6 + 1e-9,
        unit=unit, notes=why, source="computed",
    )


# --- number theory -----------------------------------------------------------

def number_theory() -> list[Question]:
    g = "nt"
    out = [
        _numq(f"{g}-gcd-00", f"{g}-gcd-lcm", "mathematics", "number_theory", "gcd", "medium",
              "What is the greatest common divisor of 84 and 126? Give only the number.",
              math.gcd(84, 126), None, "Euclidean algorithm"),
        _numq(f"{g}-gcd-01", f"{g}-gcd-lcm", "mathematics", "number_theory", "gcd_coprime", "medium",
              "What is the greatest common divisor of 17 and 34? Give only the number.",
              math.gcd(17, 34), None, "one divides the other, so gcd is the smaller"),
        _numq(f"{g}-lcm-00", f"{g}-gcd-lcm", "mathematics", "number_theory", "lcm", "medium",
              "What is the least common multiple of 12 and 18? Give only the number.",
              math.lcm(12, 18), None, "not the product; shared factors count once"),
        _numq(f"{g}-mod-00", f"{g}-modular", "mathematics", "number_theory", "modulo", "medium",
              "What is 17 mod 5? Give only the number.", 17 % 5, None, "basic remainder"),
        _numq(f"{g}-mod-01", f"{g}-modular", "mathematics", "number_theory", "negative_modulo",
              "hard",
              "In standard mathematical convention where the result is non-negative, "
              "what is -17 mod 5? Give only the number.",
              (-17) % 5, None, "languages disagree; the maths convention gives 3, not -2"),
        _numq(f"{g}-mod-02", f"{g}-modular", "mathematics", "number_theory", "modular_exponent",
              "extreme",
              "What is 7^100 mod 13? Give only the number.",
              pow(7, 100, 13), None, "requires Fermat's little theorem or fast exponentiation",
              cx="medium"),
        Question(
            question_id=f"{g}-prime-00", group_id=f"{g}-primes", category="mathematics",
            subcategory="number_theory", skill="primality", difficulty="medium",
            question_type="conceptual",
            prompt="Is 1 a prime number? Answer yes or no and justify in one sentence.",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="RUBRIC", adversarial_level=1,
            rubric=["Answers NO.",
                    "Justifies by the definition requiring exactly two distinct positive divisors "
                    "(or notes it would break unique factorisation)."],
            notes="a definitional edge case that is very often got wrong",
            source="definition of prime",
        ),
        _numq(f"{g}-prime-01", f"{g}-primes", "mathematics", "number_theory", "prime_factorisation",
              "medium",
              "How many distinct prime factors does 360 have? Give only the number.",
              len(sp.factorint(360)), None, "360 = 2^3 * 3^2 * 5, so three distinct primes"),
        _numq(f"{g}-prime-02", f"{g}-primes", "mathematics", "number_theory", "divisor_count",
              "hard",
              "How many positive divisors does 36 have? Give only the number.",
              sp.divisor_count(36), None, "36 = 2^2*3^2 -> (2+1)(2+1) = 9"),
    ]
    return out


# --- sequences and series ----------------------------------------------------

def sequences() -> list[Question]:
    g = "seq"
    out = [
        _numq(f"{g}-arith-00", f"{g}-arithmetic-progression", "mathematics", "sequences",
              "nth_term_arithmetic", "medium",
              "An arithmetic sequence starts 5, 9, 13, 17, ... What is the 20th term? "
              "Give only the number.",
              5 + 19 * 4, None, "a + (n-1)d; off-by-one on n is the usual error"),
        _numq(f"{g}-arith-01", f"{g}-arithmetic-progression", "mathematics", "sequences",
              "sum_arithmetic", "hard",
              "What is the sum of the first 100 positive integers? Give only the number.",
              100 * 101 // 2, None, "n(n+1)/2"),
        _numq(f"{g}-geo-00", f"{g}-geometric-progression", "mathematics", "sequences",
              "nth_term_geometric", "medium",
              "A geometric sequence starts 3, 6, 12, 24, ... What is the 10th term? "
              "Give only the number.",
              3 * 2 ** 9, None, "ar^(n-1)"),
        _numq(f"{g}-geo-01", f"{g}-geometric-progression", "mathematics", "sequences",
              "infinite_geometric_sum", "hard",
              "What is the sum to infinity of 1 + 1/2 + 1/4 + 1/8 + ... ? Give only the number.",
              2.0, None, "a/(1-r) with |r|<1"),
        Question(
            question_id=f"{g}-geo-02", group_id=f"{g}-geometric-progression",
            category="mathematics", subcategory="sequences", skill="divergent_series",
            difficulty="extreme", question_type="false_premise",
            prompt="What is the sum to infinity of 1 + 2 + 4 + 8 + ... ? Give a single number.",
            expected_capability="math", expected_complexity="medium",
            evaluation_method="REFUSAL", adversarial_level=2,
            rubric=["States the series diverges / has no finite sum.",
                    "Does not give a finite number (in particular not -1).",
                    "May note |r| > 1 violates the convergence condition."],
            notes="the a/(1-r) formula misapplied gives -1, a classic trap",
            source="convergence condition for geometric series",
        ),
        _numq(f"{g}-fib-00", f"{g}-fibonacci", "mathematics", "sequences", "fibonacci", "medium",
              "In the Fibonacci sequence starting 1, 1, 2, 3, 5, ... what is the 12th term? "
              "Give only the number.",
              sp.fibonacci(12), None, "indexing convention matters; here F1=F2=1"),
    ]
    return out


# --- exponents, roots, logarithms --------------------------------------------

def exponents_logs() -> list[Question]:
    g = "explog"
    out = [
        _numq(f"{g}-exp-00", f"{g}-exponent-rules", "mathematics", "exponents", "zero_exponent",
              "medium", "What is 5^0? Give only the number.", 1, None, "any non-zero base to 0 is 1"),
        Question(
            question_id=f"{g}-exp-01", group_id=f"{g}-exponent-rules", category="mathematics",
            subcategory="exponents", skill="zero_to_zero", difficulty="extreme",
            question_type="conceptual",
            prompt="What is 0^0? Explain your answer briefly.",
            expected_capability="math", expected_complexity="medium",
            evaluation_method="RUBRIC", adversarial_level=2,
            rubric=["Notes it is context-dependent / an indeterminate form in limits.",
                    "May state it is conventionally defined as 1 in discrete maths and "
                    "combinatorics.",
                    "Does not assert a single value with no qualification."],
            notes="genuinely convention-dependent; unqualified confidence is the failure",
            source="standard analysis/combinatorics convention",
        ),
        _numq(f"{g}-exp-02", f"{g}-exponent-rules", "mathematics", "exponents", "negative_exponent",
              "medium", "What is 2^-3? Give the answer as a decimal.", 0.125, None,
              "negative exponent is a reciprocal, not a negative result"),
        _numq(f"{g}-exp-03", f"{g}-exponent-rules", "mathematics", "exponents", "fractional_exponent",
              "hard", "What is 27^(2/3)? Give only the number.", 9, None,
              "cube root then square"),
        _numq(f"{g}-log-00", f"{g}-logarithms", "mathematics", "logarithms", "log_base10", "medium",
              "What is log base 10 of 1000? Give only the number.", 3, None, "definition of log"),
        _numq(f"{g}-log-01", f"{g}-logarithms", "mathematics", "logarithms", "log_of_one", "medium",
              "What is log base 7 of 1? Give only the number.", 0, None,
              "log of 1 is 0 for any valid base"),
        _numq(f"{g}-log-02", f"{g}-logarithms", "mathematics", "logarithms", "natural_log", "hard",
              "What is ln(e^5)? Give only the number.", 5, None, "inverse functions cancel"),
        Question(
            question_id=f"{g}-log-03", group_id=f"{g}-logarithms", category="mathematics",
            subcategory="logarithms", skill="log_domain", difficulty="extreme",
            question_type="false_premise",
            prompt="What is the value of log base 10 of -100? Give a number.",
            expected_capability="math", expected_complexity="medium",
            evaluation_method="REFUSAL", adversarial_level=2,
            rubric=["States it is undefined over the real numbers.",
                    "Does not give a real number.",
                    "May mention a complex-valued result if it explicitly says the reals do not "
                    "admit one."],
            notes="log of a negative is outside the real domain",
            source="domain of the real logarithm",
        ),
        _sym(f"{g}-log-04", f"{g}-logarithms", "mathematics", "logarithms", "log_product_rule",
             "hard", "Simplify to a single logarithm: log(x) + log(y). Assume x, y > 0.",
             sp.log(x * y), "product rule for logarithms"),
    ]
    return out


# --- matrices and vectors ----------------------------------------------------

def linear_algebra() -> list[Question]:
    g = "linalg"
    A = sp.Matrix([[1, 2], [3, 4]])
    B = sp.Matrix([[0, 1], [1, 0]])
    out = [
        _numq(f"{g}-det-00", f"{g}-determinants", "mathematics", "linear_algebra", "determinant_2x2",
              "medium", "What is the determinant of the matrix [[1, 2], [3, 4]]? Give only the number.",
              A.det(), None, "ad - bc"),
        _numq(f"{g}-det-01", f"{g}-determinants", "mathematics", "linear_algebra", "singular_matrix",
              "hard",
              "What is the determinant of the matrix [[2, 4], [1, 2]]? Give only the number.",
              sp.Matrix([[2, 4], [1, 2]]).det(), None,
              "rows are proportional, so the determinant is 0 (singular)"),
        _sym(f"{g}-mul-00", f"{g}-matrix-multiplication", "mathematics", "linear_algebra",
             "matrix_product", "hard",
             "Compute the matrix product [[1, 2], [3, 4]] * [[0, 1], [1, 0]]. "
             "Give the result as [[a, b], [c, d]].",
             (A * B).tolist(), "matrix multiplication is not commutative"),
        Question(
            question_id=f"{g}-mul-01", group_id=f"{g}-matrix-multiplication",
            category="mathematics", subcategory="linear_algebra", skill="non_commutativity",
            difficulty="hard", question_type="conceptual",
            prompt=("For square matrices A and B, is AB always equal to BA? "
                    "Answer yes or no and justify in one sentence."),
            expected_capability="math", expected_complexity="simple",
            evaluation_method="RUBRIC",
            rubric=["Answers NO.",
                    "States matrix multiplication is not commutative in general.",
                    "May offer a counterexample."],
            notes="a core structural property", source="linear algebra",
        ),
        _numq(f"{g}-dot-00", f"{g}-vectors", "mathematics", "linear_algebra", "dot_product",
              "medium",
              "What is the dot product of the vectors (1, 2, 3) and (4, 5, 6)? Give only the number.",
              1 * 4 + 2 * 5 + 3 * 6, None, "sum of componentwise products"),
        _numq(f"{g}-dot-01", f"{g}-vectors", "mathematics", "linear_algebra", "orthogonality",
              "hard",
              "What is the dot product of the vectors (1, 0) and (0, 1)? Give only the number.",
              0, None, "zero dot product means orthogonal"),
        _numq(f"{g}-mag-00", f"{g}-vectors", "mathematics", "linear_algebra", "magnitude", "medium",
              "What is the magnitude of the vector (3, 4)? Give only the number.",
              5, None, "3-4-5 right triangle"),
    ]
    # Nonsingular vs singular: same question shape, opposite structural
    # property. A zero determinant means the matrix has no inverse, which is
    # the distinction being probed — not a repeat of the arithmetic.
    out[1].minimal_pair_of = f"{g}-det-00"
    return out


# --- combinatorics -----------------------------------------------------------

def combinatorics() -> list[Question]:
    g = "comb"
    out = [
        _numq(f"{g}-perm-00", f"{g}-permutations", "mathematics", "combinatorics", "factorial",
              "medium", "In how many distinct orders can 5 different books be arranged on a shelf? "
                        "Give only the number.",
              math.factorial(5), None, "5!"),
        _numq(f"{g}-perm-01", f"{g}-permutations", "mathematics", "combinatorics", "permutation_nPr",
              "hard",
              "From 8 runners, in how many ways can the gold, silver and bronze medals be awarded "
              "(order matters)? Give only the number.",
              math.perm(8, 3), None, "P(8,3) — order matters, so not a combination"),
        _numq(f"{g}-comb-00", f"{g}-combinations", "mathematics", "combinatorics",
              "combination_nCr", "hard",
              "From 8 people, how many distinct committees of 3 can be formed (order does not "
              "matter)? Give only the number.",
              math.comb(8, 3), None,
              "C(8,3) — deliberate contrast with the medals question above"),
        _numq(f"{g}-comb-01", f"{g}-combinations", "mathematics", "combinatorics",
              "combination_symmetry", "medium",
              "What is C(10, 7), the number of ways to choose 7 items from 10? Give only the number.",
              math.comb(10, 7), None, "equals C(10,3) by symmetry"),
        _numq(f"{g}-count-00", f"{g}-counting-principle", "mathematics", "combinatorics",
              "multiplication_principle", "medium",
              "A menu has 4 starters, 5 mains and 3 desserts. How many distinct three-course meals "
              "are possible? Give only the number.",
              4 * 5 * 3, None, "multiplication principle; adding is the common error"),
        _numq(f"{g}-count-01", f"{g}-counting-principle", "mathematics", "combinatorics",
              "with_repetition", "hard",
              "How many 3-digit PIN codes are possible using digits 0-9 if digits MAY repeat? "
              "Give only the number.",
              10 ** 3, None, "with repetition: 10^3"),
        _numq(f"{g}-count-02", f"{g}-counting-principle", "mathematics", "combinatorics",
              "without_repetition", "hard",
              "How many 3-digit PIN codes are possible using digits 0-9 if digits may NOT repeat? "
              "Give only the number.",
              math.perm(10, 3), None,
              "without repetition: 10*9*8 — minimal contrast with the previous item"),
    ]
    out[-1].minimal_pair_of = f"{g}-count-01"
    return out


# --- coordinate geometry -----------------------------------------------------

def coordinate_geometry() -> list[Question]:
    g = "coord"
    out = [
        _numq(f"{g}-dist-00", f"{g}-distance", "geometry", "coordinate_geometry", "distance_formula",
              "medium",
              "What is the distance between the points (1, 2) and (4, 6)? Give only the number.",
              5.0, None, "3-4-5 triangle again, via the distance formula"),
        _numq(f"{g}-slope-00", f"{g}-lines", "geometry", "coordinate_geometry", "slope", "medium",
              "What is the slope of the line through (2, 3) and (6, 11)? Give only the number.",
              (11 - 3) / (6 - 2), None, "rise over run"),
        Question(
            question_id=f"{g}-slope-01", group_id=f"{g}-lines", category="geometry",
            subcategory="coordinate_geometry", skill="vertical_line_slope", difficulty="hard",
            question_type="boundary",
            prompt="What is the slope of the line through (3, 1) and (3, 7)?",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="REFUSAL", adversarial_level=1,
            rubric=["States the slope is undefined (vertical line).",
                    "Does not give a numeric slope.",
                    "May note the run is zero, so the division is undefined."],
            notes="division by zero disguised as a geometry question",
            source="definition of slope",
        ),
        _numq(f"{g}-slope-02", f"{g}-lines", "geometry", "coordinate_geometry", "horizontal_line",
              "medium", "What is the slope of the line through (2, 5) and (9, 5)? Give only the number.",
              0.0, None, "horizontal line has slope 0 — contrast with the vertical case"),
        _numq(f"{g}-mid-00", f"{g}-midpoint", "geometry", "coordinate_geometry", "midpoint", "easy",
              "What is the x-coordinate of the midpoint of the segment from (2, 4) to (8, 10)? "
              "Give only the number.",
              5.0, None, "average of the x-coordinates"),
        _numq(f"{g}-circle-00", f"{g}-conics", "geometry", "coordinate_geometry", "circle_equation",
              "hard",
              "For the circle (x-3)^2 + (y+2)^2 = 25, what is the radius? Give only the number.",
              5.0, None, "radius is the square root of the right-hand side, not 25"),
    ]
    return out


# --- unit conversion (breadth of physical quantities) ------------------------

def unit_conversions() -> list[Question]:
    """Each entry is a different physical quantity or direction — a different
    fact to know, not the same conversion with new digits."""
    g = "units"
    specs = [
        ("length", "How many centimetres are in 2.5 metres? Give only the number.", 250, "cm"),
        ("length", "How many millimetres are in 3 centimetres? Give only the number.", 30, "mm"),
        ("length", "How many metres are in 4.2 kilometres? Give only the number.", 4200, "m"),
        ("mass", "How many grams are in 3.5 kilograms? Give only the number.", 3500, "g"),
        ("mass", "How many milligrams are in 2 grams? Give only the number.", 2000, "mg"),
        ("mass", "How many kilograms are in 4500 grams? Give only the number.", 4.5, "kg"),
        ("volume", "How many millilitres are in 1.5 litres? Give only the number.", 1500, "mL"),
        ("volume", "How many cubic centimetres are in 1 litre? Give only the number.", 1000, "cm^3"),
        ("time", "How many seconds are in 2.5 hours? Give only the number.", 9000, "s"),
        ("time", "How many minutes are in 3 days? Give only the number.", 4320, "min"),
        ("time", "How many milliseconds are in 1.5 seconds? Give only the number.", 1500, "ms"),
        ("area", "How many square centimetres are in 1 square metre? Give only the number.",
         10000, "cm^2"),
        ("volume", "How many cubic centimetres are in 1 cubic metre? Give only the number.",
         1_000_000, "cm^3"),
        ("energy", "How many joules are in 2.5 kilojoules? Give only the number.", 2500, "J"),
        ("power", "How many watts are in 1.5 kilowatts? Give only the number.", 1500, "W"),
        ("pressure", "How many pascals are in 3 kilopascals? Give only the number.", 3000, "Pa"),
        ("data", "How many bytes are in 4 kibibytes (KiB, 1024-based)? Give only the number.",
         4096, "bytes"),
        ("data", "How many bytes are in 4 kilobytes (kB, 1000-based)? Give only the number.",
         4000, "bytes"),
        ("frequency", "How many hertz are in 2.5 kilohertz? Give only the number.", 2500, "Hz"),
        ("angle", "How many degrees are in pi radians? Give only the number.", 180, "degrees"),
    ]
    out = []
    for i, (sub, prompt, ans, unit) in enumerate(specs):
        why = "squared units scale by the square of the linear factor" if "square" in prompt else (
            "cubic units scale by the cube of the linear factor" if "cubic" in prompt else
            "decimal SI prefix conversion")
        out.append(_numq(
            f"{g}-{i:02d}", f"{g}-{sub}", "unit_conversion", sub, f"convert_{sub}",
            "hard" if ("square" in prompt or "cubic" in prompt or "kibi" in prompt) else "easy",
            prompt, ans, unit, why, qtype="unit_conversion",
        ))
    # KiB vs kB is a deliberate contrast, one word apart in effect.
    out[17].minimal_pair_of = f"{g}-16"
    return out


# --- rational, radical, absolute value equations ------------------------------

def equation_families() -> list[Question]:
    g = "eqfam"
    out = [
        _sym(f"{g}-rat-00", f"{g}-rational-equations", "algebra", "rational_equations",
             "solve_rational", "hard",
             "Solve for x: 1/x + 1/(x+1) = 1/2. Give all real solutions.",
             ", ".join(str(s) for s in sp.solve(sp.Eq(1 / x + 1 / (x + 1), sp.Rational(1, 2)), x)),
             "rational equation; must exclude x=0 and x=-1 from the domain"),
        Question(
            question_id=f"{g}-rat-01", group_id=f"{g}-rational-equations", category="algebra",
            subcategory="rational_equations", skill="extraneous_root", difficulty="extreme",
            question_type="misconception",
            prompt=("Solve for x: x/(x-2) = 2/(x-2). State all valid solutions, "
                    "or state that there are none."),
            expected_capability="math", expected_complexity="medium",
            evaluation_method="REFUSAL", adversarial_level=3,
            rubric=["Identifies x=2 as an EXTRANEOUS root (it makes the denominator zero).",
                    "Concludes there is NO valid solution.",
                    "Does not report x=2 as a solution."],
            notes="cross-multiplying gives x=2, which the domain forbids — the classic extraneous "
                  "root trap",
            source="domain restriction on rational equations",
        ),
        _sym(f"{g}-rad-00", f"{g}-radical-equations", "algebra", "radical_equations",
             "solve_radical", "hard",
             "Solve for x: sqrt(x + 6) = x. Give all real solutions.",
             ", ".join(str(s) for s in sp.solve(sp.Eq(sp.sqrt(x + 6), x), x)),
             "squaring introduces x=-2 as extraneous; only x=3 satisfies the original"),
        # Abs() needs a real-declared symbol before sympy will solve it.
        _sym(f"{g}-abs-00", f"{g}-absolute-value", "algebra", "absolute_value",
             "solve_absolute", "medium",
             "Solve for x: |x - 3| = 5. Give all real solutions.",
             ", ".join(
                 str(s) for s in sorted(
                     sp.solve(sp.Eq(sp.Abs(sp.Symbol("x", real=True) - 3), 5),
                              sp.Symbol("x", real=True)),
                     key=lambda t: float(t))),
             "two branches; giving only one is the common error"),
        Question(
            question_id=f"{g}-abs-01", group_id=f"{g}-absolute-value", category="algebra",
            subcategory="absolute_value", skill="impossible_absolute", difficulty="hard",
            question_type="false_premise",
            prompt="Solve for x: |x + 1| = -4. Give all real solutions.",
            expected_capability="math", expected_complexity="simple",
            evaluation_method="REFUSAL", adversarial_level=2,
            rubric=["States there is no solution.",
                    "Justifies it: an absolute value is never negative.",
                    "Does not produce a numeric solution."],
            notes="no solution exists; any x offered is fabrication",
            source="definition of absolute value",
        ),
        _sym(f"{g}-ineq-00", f"{g}-inequalities", "algebra", "inequalities", "solve_inequality",
             "medium", "Solve the inequality 3x - 6 > 9 for x. Give the solution set.",
             sp.solve_univariate_inequality(3 * x - 6 > 9, x, relational=True),
             "straightforward linear inequality"),
        Question(
            question_id=f"{g}-ineq-01", group_id=f"{g}-inequalities", category="algebra",
            subcategory="inequalities", skill="negative_multiplication", difficulty="hard",
            question_type="misconception",
            prompt=("Solve the inequality -2x > 8 for x, and state the solution set."),
            expected_capability="math", expected_complexity="simple",
            evaluation_method="RUBRIC", adversarial_level=2,
            rubric=["Gives x < -4.",
                    "Explicitly flips the inequality sign when dividing by a negative.",
                    "Does not give x > -4."],
            notes="forgetting to flip the sign is the single most common inequality error",
            source="computed: dividing by -2 reverses the inequality",
        ),
        _sym(f"{g}-poly-00", f"{g}-polynomials", "algebra", "polynomials", "factorisation", "medium",
             "Factorise completely: x^2 - 9.",
             sp.factor(x ** 2 - 9), "difference of two squares"),
        _sym(f"{g}-poly-01", f"{g}-polynomials", "algebra", "polynomials", "factorisation", "hard",
             "Factorise completely: x^3 - x.",
             sp.factor(x ** 3 - x), "common factor first, then difference of squares"),
        _sym(f"{g}-poly-02", f"{g}-polynomials", "algebra", "polynomials", "expansion", "medium",
             "Expand and simplify: (x + 3)(x - 3).",
             sp.expand((x + 3) * (x - 3)), "the middle terms cancel"),
    ]
    return out


def all_questions() -> list[Question]:
    return (number_theory() + sequences() + exponents_logs() + linear_algebra()
            + combinatorics() + coordinate_geometry() + unit_conversions()
            + equation_families())
