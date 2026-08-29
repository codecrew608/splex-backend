"""Executes candidate code against hidden tests in a separate process.

Model-generated code is untrusted input. It runs in a subprocess with a wall
clock limit and, where the platform supports it, address-space and CPU limits,
so a runaway or malicious generation cannot take the harness down with it.

This is isolation for ROBUSTNESS, not a security boundary: a subprocess is not
a sandbox in the security sense. The benchmark only ever executes code it
generated from its own corpus prompts, on a developer machine, never in
production. If that ever changes, this needs a real sandbox (container/VM).
"""

from __future__ import annotations

import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

DEFAULT_TIMEOUT_S = 10
MEMORY_LIMIT_BYTES = 512 * 1024 * 1024

_FENCE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL | re.IGNORECASE)


@dataclass
class ExecResult:
    passed: bool
    error: str | None = None
    stage: str = "ok"   # extract | compile | run | timeout | ok


def extract_code(response: str) -> str | None:
    """Pull the code out of a model response.

    Prefers a fenced block. Falls back to the raw text only if it already
    looks like a bare function definition — guessing beyond that produces
    confusing 'compile errors' that are really extraction failures.
    """
    blocks = _FENCE.findall(response)
    if blocks:
        return max(blocks, key=len).strip()
    stripped = response.strip()
    if stripped.startswith(("def ", "import ", "from ", "class ")):
        return stripped
    return None


_PRELUDE = f"""
import resource, sys
try:
    resource.setrlimit(resource.RLIMIT_AS, ({MEMORY_LIMIT_BYTES}, {MEMORY_LIMIT_BYTES}))
    resource.setrlimit(resource.RLIMIT_CPU, ({DEFAULT_TIMEOUT_S}, {DEFAULT_TIMEOUT_S}))
except Exception:
    pass  # not supported on this platform; the wall-clock timeout still applies
"""


def run_hidden_tests(code: str, tests: str, timeout_s: int = DEFAULT_TIMEOUT_S) -> ExecResult:
    """Run `code` then `tests`. Any assertion failure means the answer is wrong."""
    program = f"{_PRELUDE}\n{code}\n\n{tests}\nprint('__ALL_TESTS_PASSED__')\n"

    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "candidate.py"
        path.write_text(program)
        try:
            proc = subprocess.run(
                [sys.executable, "-I", str(path)],   # -I: isolated, ignores env/user site
                capture_output=True, text=True, timeout=timeout_s, cwd=tmp,
            )
        except subprocess.TimeoutExpired:
            return ExecResult(False, f"timed out after {timeout_s}s", "timeout")

    if "__ALL_TESTS_PASSED__" in proc.stdout:
        return ExecResult(True)

    err = (proc.stderr or "").strip()
    stage = "compile" if "SyntaxError" in err else "run"
    return ExecResult(False, err[-1500:] or "no output and no success marker", stage)


def grade_programmatic(response: str, tests: str, timeout_s: int = DEFAULT_TIMEOUT_S) -> ExecResult:
    code = extract_code(response)
    if code is None:
        # Distinguished from a wrong answer on purpose: the model may have
        # solved it and formatted the reply in a way we could not parse.
        return ExecResult(False, "no code block found in response", "extract")
    return run_hidden_tests(code, tests, timeout_s)
