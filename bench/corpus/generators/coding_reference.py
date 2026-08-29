"""Reference solutions, used ONLY to prove the hidden tests are correct.

A hidden test with a bug in it silently marks correct model answers as wrong,
which is worse than having no test: it produces confident, inverted results.
So every PROGRAMMATIC question ships with a reference implementation here, and
build.py refuses to emit the corpus unless every reference passes its own
hidden tests. These solutions are never shown to a model.
"""

REFERENCE_SOLUTIONS: dict[str, str] = {
    "code-impl-00": '''
def reverse_words(s):
    return " ".join(s.split()[::-1])
''',
    "code-impl-01": '''
def fb(n):
    if n % 15 == 0: return "FizzBuzz"
    if n % 3 == 0: return "Fizz"
    if n % 5 == 0: return "Buzz"
    return str(n)
''',
    "code-impl-02": '''
def bsearch(arr, target):
    lo, hi = 0, len(arr) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if arr[mid] == target: return mid
        if arr[mid] < target: lo = mid + 1
        else: hi = mid - 1
    return -1
''',
    "code-impl-03": '''
def two_sum(nums, target):
    seen = {}
    for i, n in enumerate(nums):
        if target - n in seen:
            return (seen[target - n], i)
        seen.setdefault(n, i)
    return None
''',
    "code-impl-04": '''
def group_anagrams(words):
    buckets = {}
    for w in words:
        buckets.setdefault(tuple(sorted(w)), []).append(w)
    return list(buckets.values())
''',
    "code-impl-05": '''
def to_roman(n):
    table = [(1000,"M"),(900,"CM"),(500,"D"),(400,"CD"),(100,"C"),(90,"XC"),
             (50,"L"),(40,"XL"),(10,"X"),(9,"IX"),(5,"V"),(4,"IV"),(1,"I")]
    out = []
    for val, sym in table:
        while n >= val:
            out.append(sym); n -= val
    return "".join(out)
''',
    "code-impl-06": '''
def safe_divide(a, b):
    if b == 0: return None
    return a / b
''',
    "code-impl-07": '''
def merge(intervals):
    if not intervals: return []
    xs = sorted(intervals)
    out = [xs[0]]
    for s, e in xs[1:]:
        ls, le = out[-1]
        if s <= le:
            out[-1] = (ls, max(le, e))
        else:
            out.append((s, e))
    return out
''',
    "code-debug-00": '''
def last(xs):
    return xs[-1] if xs else None
''',
    "code-debug-01": '''
def add(item, target=None):
    if target is None: target = []
    target.append(item)
    return target
''',
    "code-debug-02": '''
def average(xs):
    if not xs: return 0.0
    return sum(xs) / len(xs)
''',
}
