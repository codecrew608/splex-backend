"""Coding questions, graded by EXECUTING the model's code against hidden tests.

This is the only category where correctness can be established without any
judgement at all: the code either passes the tests or it does not. Hidden
tests are deliberately not shown in the prompt, so a model cannot special-case
them, and every set includes edge cases the naive implementation misses.
"""

from __future__ import annotations

from ..schema import Question


def _code(qid, group, sub, skill, diff, prompt, tests, why, qtype="code_implement",
          capability="coding", complexity="medium", diffculty_note=None, adv=0):
    return Question(
        question_id=qid, group_id=group, category="coding", subcategory=sub, skill=skill,
        difficulty=diff, question_type=qtype, prompt=prompt,
        expected_capability=capability, expected_complexity=complexity,
        evaluation_method="PROGRAMMATIC", hidden_tests=tests,
        adversarial_level=adv, notes=why, source="hidden tests written and self-verified",
    )


def implementations() -> list[Question]:
    g = "code-impl"
    out = [
        _code(
            f"{g}-00", g, "strings", "reverse_words", "easy",
            "Write a Python function `reverse_words(s: str) -> str` that reverses the ORDER of words in "
            "a string, collapsing runs of whitespace to a single space and stripping leading/trailing "
            "whitespace. Return only the function definition in a Python code block.",
            """
assert reverse_words("hello world") == "world hello"
assert reverse_words("  a  b   c  ") == "c b a"
assert reverse_words("single") == "single"
assert reverse_words("") == ""
assert reverse_words("   ") == ""
""",
            "empty and whitespace-only inputs are the usual misses",
        ),
        _code(
            f"{g}-01", g, "numbers", "fizzbuzz_variant", "easy",
            "Write a Python function `fb(n: int) -> str` returning 'Fizz' if n is divisible by 3, "
            "'Buzz' if by 5, 'FizzBuzz' if by both, otherwise str(n). "
            "Return only the function definition in a Python code block.",
            """
assert fb(3) == "Fizz"
assert fb(5) == "Buzz"
assert fb(15) == "FizzBuzz"
assert fb(7) == "7"
assert fb(0) == "FizzBuzz"      # 0 is divisible by both
assert fb(-15) == "FizzBuzz"    # negatives still divide
""",
            "0 and negatives are the edge cases; most implementations happen to pass",
        ),
        _code(
            f"{g}-02", g, "algorithms", "binary_search", "medium",
            "Write a Python function `bsearch(arr: list[int], target: int) -> int` performing binary "
            "search on a sorted ascending list, returning the index of target or -1 if absent. "
            "Return only the function definition in a Python code block.",
            """
assert bsearch([1,3,5,7,9], 7) == 3
assert bsearch([1,3,5,7,9], 1) == 0
assert bsearch([1,3,5,7,9], 9) == 4
assert bsearch([1,3,5,7,9], 4) == -1
assert bsearch([], 1) == -1
assert bsearch([5], 5) == 0
assert bsearch([5], 3) == -1
""",
            "empty list and single-element list are the classic off-by-one traps",
        ),
        _code(
            f"{g}-03", g, "algorithms", "two_sum", "medium",
            "Write a Python function `two_sum(nums: list[int], target: int) -> tuple[int, int] | None` "
            "returning the INDICES of two distinct elements summing to target, or None. "
            "Return only the function definition in a Python code block.",
            """
r = two_sum([2,7,11,15], 9)
assert r is not None and sorted(r) == [0,1]
r = two_sum([3,3], 6)
assert r is not None and sorted(r) == [0,1]      # duplicate values, distinct indices
assert two_sum([1,2,3], 100) is None
assert two_sum([], 0) is None
r = two_sum([0,0], 0)
assert r is not None and sorted(r) == [0,1]      # zeros
""",
            "duplicate values must map to distinct indices; naive dict overwrites lose this",
        ),
        _code(
            f"{g}-04", g, "data_structures", "group_anagrams", "hard",
            "Write a Python function `group_anagrams(words: list[str]) -> list[list[str]]` grouping "
            "anagrams together. Each group's words must keep their input order; groups may be in any "
            "order. Return only the function definition in a Python code block.",
            """
res = group_anagrams(["eat","tea","tan","ate","nat","bat"])
norm = sorted([sorted(gp) for gp in res])
assert norm == sorted([sorted(x) for x in [["eat","tea","ate"],["tan","nat"],["bat"]]])
assert group_anagrams([]) == []
res = group_anagrams(["a"])
assert res == [["a"]]
res = group_anagrams(["", ""])
assert len(res) == 1 and len(res[0]) == 2      # empty strings are anagrams of each other
""",
            "empty-string grouping is the edge case",
        ),
        _code(
            f"{g}-05", g, "algorithms", "roman_numerals", "hard",
            "Write a Python function `to_roman(n: int) -> str` converting an integer 1..3999 to a Roman "
            "numeral. Return only the function definition in a Python code block.",
            """
assert to_roman(1) == "I"
assert to_roman(4) == "IV"        # subtractive
assert to_roman(9) == "IX"
assert to_roman(40) == "XL"
assert to_roman(90) == "XC"
assert to_roman(400) == "CD"
assert to_roman(900) == "CM"
assert to_roman(1994) == "MCMXCIV"
assert to_roman(3999) == "MMMCMXCIX"
""",
            "all six subtractive forms must be handled, not just IV/IX",
        ),
        _code(
            f"{g}-06", g, "numbers", "safe_divide", "medium",
            "Write a Python function `safe_divide(a: float, b: float) -> float | None` returning a/b, "
            "or None if b is zero. It must not raise. "
            "Return only the function definition in a Python code block.",
            """
assert safe_divide(10, 2) == 5
assert safe_divide(10, 0) is None
assert safe_divide(0, 5) == 0
assert safe_divide(-10, 2) == -5
assert safe_divide(10, 0.0) is None
""",
            "0.0 vs 0 and the no-raise requirement",
        ),
        _code(
            f"{g}-07", g, "algorithms", "merge_intervals", "extreme",
            "Write a Python function `merge(intervals: list[tuple[int,int]]) -> list[tuple[int,int]]` "
            "merging overlapping intervals, returned sorted by start. Touching intervals such as "
            "(1,2) and (2,3) DO merge. Return only the function definition in a Python code block.",
            """
assert merge([(1,3),(2,6),(8,10),(15,18)]) == [(1,6),(8,10),(15,18)]
assert merge([(1,4),(4,5)]) == [(1,5)]            # touching merges
assert merge([]) == []
assert merge([(1,4),(0,4)]) == [(0,4)]            # unsorted input
assert merge([(1,4),(2,3)]) == [(1,4)]            # fully contained
""",
            "unsorted input and fully-contained intervals are the usual failures",
        ),
    ]
    return out


def debugging() -> list[Question]:
    g = "code-debug"
    out = [
        _code(
            f"{g}-00", g, "debugging", "off_by_one", "medium",
            "The following Python function is meant to return the LAST element of a list, or None if "
            "empty, but it is buggy. Fix it and return the corrected function `last(xs)` in a Python "
            "code block.\n\n"
            "```python\n"
            "def last(xs):\n"
            "    return xs[len(xs)]\n"
            "```",
            """
assert last([1,2,3]) == 3
assert last([42]) == 42
assert last([]) is None
""",
            "off-by-one plus an unhandled empty case",
            qtype="code_debug",
        ),
        _code(
            f"{g}-01", g, "debugging", "mutable_default", "hard",
            "The following Python function is supposed to return a NEW list with the item appended, "
            "leaving previous calls unaffected, but it has a subtle bug. Fix it and return the "
            "corrected function `add(item, target=None)` in a Python code block.\n\n"
            "```python\n"
            "def add(item, target=[]):\n"
            "    target.append(item)\n"
            "    return target\n"
            "```",
            """
a = add(1)
b = add(2)
assert a == [1], f"mutable default leaked: {a}"
assert b == [2], f"mutable default leaked: {b}"
""",
            "the mutable-default-argument trap; the bug only shows across calls",
            qtype="code_debug",
        ),
        _code(
            f"{g}-02", g, "debugging", "integer_division", "medium",
            "This function should return the average of a list of numbers as a float, or 0.0 for an "
            "empty list, but it is buggy. Fix it and return `average(xs)` in a Python code block.\n\n"
            "```python\n"
            "def average(xs):\n"
            "    return sum(xs) // len(xs)\n"
            "```",
            """
assert average([1,2,3,4]) == 2.5
assert average([]) == 0.0
assert average([5]) == 5.0
assert abs(average([1,2]) - 1.5) < 1e-9
""",
            "floor division plus division-by-zero on empty input",
            qtype="code_debug",
        ),
    ]
    return out


def security() -> list[Question]:
    """Security questions are RUBRIC-scored: 'write vulnerable code' is not a
    thing this benchmark asks for. The task is always to identify or fix."""
    g = "code-sec"
    out = [
        Question(
            question_id=f"{g}-00", group_id=g, category="cybersecurity", subcategory="injection",
            skill="sql_injection", difficulty="hard", question_type="code_debug",
            prompt=("Identify the security vulnerability in this Python snippet and give a corrected "
                    "version.\n\n```python\n"
                    "def get_user(conn, username):\n"
                    "    q = \"SELECT * FROM users WHERE name = '\" + username + \"'\"\n"
                    "    return conn.execute(q).fetchall()\n```"),
            expected_capability="coding", expected_complexity="medium",
            evaluation_method="RUBRIC",
            rubric=[
                "Explicitly names SQL injection as the vulnerability.",
                "Corrected version uses a parameterised/prepared query (placeholder + parameter tuple).",
                "Does NOT propose string escaping or a blocklist as the primary fix.",
            ],
            notes="string-escaping answers are a common but wrong fix",
            source="standard secure-coding practice",
        ),
        Question(
            question_id=f"{g}-01", group_id=g, category="cybersecurity", subcategory="authentication",
            skill="password_storage", difficulty="hard", question_type="code_debug",
            prompt=("What is wrong with storing user passwords using this function, and what should be "
                    "used instead?\n\n```python\n"
                    "import hashlib\n"
                    "def store(pw): return hashlib.md5(pw.encode()).hexdigest()\n```"),
            expected_capability="coding", expected_complexity="medium",
            evaluation_method="RUBRIC",
            rubric=[
                "States MD5 is unsuitable for passwords (broken and/or far too fast).",
                "Notes the absence of a per-user salt.",
                "Recommends a slow, salted KDF — bcrypt, scrypt, or Argon2 (any one suffices).",
                "Does not recommend SHA-256 alone as the fix.",
            ],
            notes="'use SHA-256' is the common half-right answer and is still wrong",
            source="standard secure-coding practice",
        ),
        Question(
            question_id=f"{g}-02", group_id=g, category="cybersecurity", subcategory="authorization",
            skill="idor", difficulty="extreme", question_type="code_debug",
            prompt=("This endpoint lets any authenticated user fetch any invoice. Name the vulnerability "
                    "class and show the minimal fix.\n\n```python\n"
                    "@app.get('/invoice/<invoice_id>')\n"
                    "@require_login\n"
                    "def invoice(invoice_id):\n"
                    "    return db.query('SELECT * FROM invoices WHERE id = ?', [invoice_id])\n```"),
            expected_capability="coding", expected_complexity="complex",
            evaluation_method="RUBRIC",
            rubric=[
                "Names IDOR / broken object-level authorization (missing ownership check).",
                "Fix scopes the query to the authenticated user (e.g. AND owner_id = current_user.id).",
                "Recognises that authentication alone does not imply authorization.",
            ],
            notes="the @require_login decorator makes it LOOK protected; that is the trap",
            source="OWASP broken access control",
            adversarial_level=2,
        ),
    ]
    return out


def complexity_concepts() -> list[Question]:
    g = "code-complexity"
    specs = [
        ("What is the average-case time complexity of looking up a key in a Python dict? "
         "Answer with just the big-O expression.", "O(1)", "hash table average case"),
        ("What is the worst-case time complexity of quicksort? Answer with just the big-O expression.",
         "O(n^2)", "worst case, not the average O(n log n)"),
        ("What is the time complexity of appending n items one at a time to a Python list, in total? "
         "Answer with just the big-O expression.", "O(n)", "amortised; tempting wrong answer O(n^2)"),
        ("What is the space complexity of a recursive fibonacci implementation with no memoisation, "
         "in terms of the call stack depth for input n? Answer with just the big-O expression.",
         "O(n)", "stack depth is linear even though time is exponential"),
    ]
    out = []
    for i, (prompt, ans, why) in enumerate(specs):
        out.append(Question(
            question_id=f"{g}-{i:02d}", group_id=g, category="coding", subcategory="complexity",
            skill="big_o", difficulty="medium" if i < 2 else "hard", question_type="conceptual",
            prompt=prompt, expected_capability="coding", expected_complexity="simple",
            evaluation_method="EXACT", gold_answer=ans,
            notes=why, source="standard complexity analysis",
        ))
    return out


def sql() -> list[Question]:
    g = "code-sql"
    out = [
        Question(
            question_id=f"{g}-00", group_id=g, category="coding", subcategory="sql",
            skill="aggregation", difficulty="medium", question_type="code_implement",
            prompt=("Given a table `orders(id, customer_id, amount, created_at)`, write a SQL query "
                    "returning each customer_id and their total amount, for customers whose total "
                    "exceeds 1000, sorted by total descending."),
            expected_capability="coding", expected_complexity="medium",
            evaluation_method="RUBRIC",
            rubric=[
                "Uses GROUP BY customer_id.",
                "Uses SUM(amount) as the aggregate.",
                "Filters the aggregate with HAVING (not WHERE) on the summed total.",
                "Orders by the total descending.",
            ],
            notes="using WHERE instead of HAVING on an aggregate is the classic error",
            source="standard SQL semantics",
        ),
        Question(
            question_id=f"{g}-01", group_id=g, category="coding", subcategory="sql",
            skill="null_semantics", difficulty="hard", question_type="misconception",
            prompt=("In SQL, a column `status` contains some NULL values. Does the predicate "
                    "`status <> 'active'` match rows where status IS NULL? Answer yes or no, "
                    "and explain in one sentence."),
            expected_capability="coding", expected_complexity="simple",
            evaluation_method="RUBRIC", adversarial_level=1,
            rubric=[
                "Answers NO.",
                "Explains that comparisons with NULL yield UNKNOWN rather than TRUE.",
                "Does not claim NULL behaves as an ordinary value.",
            ],
            notes="three-valued logic; the intuitive answer is yes and it is wrong",
            source="SQL three-valued logic",
        ),
    ]
    return out


def all_questions() -> list[Question]:
    return implementations() + debugging() + security() + complexity_concepts() + sql()
