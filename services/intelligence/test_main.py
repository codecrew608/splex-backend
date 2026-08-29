"""Security tests for the intelligence sidecar.

Runnable two ways:
    .venv/bin/python test_main.py      # standalone, no pytest needed
    .venv/bin/python -m pytest test_main.py

The heavy ML dependencies (torch/sentence-transformers/tesseract/pymupdf)
are stubbed. Nothing here exercises model quality — these tests cover the
security boundary: who may call the service, and how much work one caller
can force it to do.
"""
import importlib
import sys
import types
from unittest import mock


def _stub_heavy_imports() -> None:
    """Replace the ML stack with inert doubles so the module under test can
    be imported in milliseconds and without a GPU, a model download, or a
    tesseract binary."""
    st = types.ModuleType("sentence_transformers")

    class _FakeModel:
        def __init__(self, *_a, **_kw): ...
        def encode(self, texts, **_kw):
            class _Vecs:
                def tolist(_self):
                    return [[0.0] * 384 for _ in texts]
            return _Vecs()

    st.SentenceTransformer = _FakeModel
    sys.modules["sentence_transformers"] = st

    pt = types.ModuleType("pytesseract")
    pt.image_to_string = lambda *_a, **_kw: "stub text"
    sys.modules["pytesseract"] = pt

    fitz = types.ModuleType("pymupdf")
    fitz.open = lambda *_a, **_kw: (_ for _ in ()).throw(RuntimeError("stub"))
    sys.modules["pymupdf"] = fitz

    pil = types.ModuleType("PIL")
    img = types.ModuleType("PIL.Image")
    img.open = lambda *_a, **_kw: object()
    img.frombytes = lambda *_a, **_kw: object()
    pil.Image = img
    sys.modules["PIL"] = pil
    sys.modules["PIL.Image"] = img


def _load(env: dict):
    """Import main.py fresh under a given environment."""
    for name in ("main",):
        sys.modules.pop(name, None)
    with mock.patch.dict("os.environ", env, clear=False):
        for k in ("HOST", "INTELLIGENCE_SERVICE_TOKEN"):
            if k not in env:
                sys.modules.pop(k, None)
        return importlib.import_module("main")


_stub_heavy_imports()


def test_refuses_to_start_network_bound_without_token():
    """The dangerous configuration must be impossible, not merely discouraged."""
    with mock.patch.dict("os.environ", {"HOST": "0.0.0.0"}, clear=False):
        import os
        os.environ.pop("INTELLIGENCE_SERVICE_TOKEN", None)
        sys.modules.pop("main", None)
        try:
            importlib.import_module("main")
        except RuntimeError as e:
            assert "INTELLIGENCE_SERVICE_TOKEN is unset" in str(e)
            return
        raise AssertionError("expected RuntimeError: started unauthenticated on 0.0.0.0")


def test_starts_network_bound_with_token():
    m = _load({"HOST": "0.0.0.0", "INTELLIGENCE_SERVICE_TOKEN": "s3cret"})
    assert m._TOKEN == "s3cret"


def test_starts_on_loopback_without_token():
    """Local dev stays frictionless — loopback is self-limiting."""
    import os
    with mock.patch.dict("os.environ", {"HOST": "127.0.0.1"}, clear=False):
        os.environ.pop("INTELLIGENCE_SERVICE_TOKEN", None)
        sys.modules.pop("main", None)
        m = importlib.import_module("main")
        assert m._TOKEN is None


def _client(token: str | None = "s3cret"):
    from fastapi.testclient import TestClient
    env = {"HOST": "0.0.0.0", "INTELLIGENCE_SERVICE_TOKEN": token} if token else {"HOST": "127.0.0.1"}
    m = _load(env)
    return TestClient(m.app), m


def test_health_is_open_but_reports_auth_state():
    client, _ = _client()
    r = client.get("/health")
    assert r.status_code == 200, r.text
    assert r.json() == {"status": "ok", "auth": "enabled"}


def test_protected_endpoints_reject_missing_and_wrong_tokens():
    client, _ = _client()
    for headers in (
        {},                                        # no header
        {"Authorization": "s3cret"},               # no scheme
        {"Authorization": "Basic s3cret"},         # wrong scheme
        {"Authorization": "Bearer wrong"},         # wrong token
        {"Authorization": "Bearer "},              # empty token
        {"Authorization": "Bearer s3cre"},         # prefix of the real token
        {"Authorization": "Bearer s3cretX"},       # real token plus a suffix
    ):
        r = client.post("/embed", json={"texts": ["hi"]}, headers=headers)
        assert r.status_code == 401, f"{headers} -> {r.status_code}, expected 401"
        r = client.post("/ocr/image", content=b"x", headers=headers)
        assert r.status_code == 401, f"{headers} -> {r.status_code} on /ocr/image"


def test_correct_token_is_accepted():
    client, _ = _client()
    r = client.post("/embed", json={"texts": ["hi"]}, headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 200, r.text
    assert len(r.json()["embeddings"][0]) == 384


def test_embed_caps_batch_and_total_size():
    client, m = _client()
    auth = {"Authorization": "Bearer s3cret"}
    r = client.post("/embed", json={"texts": ["x"] * (m.MAX_EMBED_TEXTS + 1)}, headers=auth)
    assert r.status_code == 413, r.status_code
    r = client.post("/embed", json={"texts": ["x" * (m.MAX_EMBED_CHARS + 1)]}, headers=auth)
    assert r.status_code == 413, r.status_code
    r = client.post("/embed", json={"texts": []}, headers=auth)
    assert r.status_code == 400, r.status_code


def test_oversized_body_is_refused_before_processing():
    client, m = _client()
    auth = {"Authorization": "Bearer s3cret"}
    r = client.post("/ocr/image", content=b"a" * (m.MAX_BODY_BYTES + 1), headers=auth)
    assert r.status_code == 413, r.status_code


def test_body_cap_holds_when_content_length_lies():
    """Content-Length is a hint; a chunked sender can omit or understate it,
    so the running total is what must enforce the cap."""
    client, m = _client()

    def chunks():
        sent = 0
        while sent <= m.MAX_BODY_BYTES:
            block = b"a" * 65536
            sent += len(block)
            yield block

    r = client.post("/ocr/image", content=chunks(), headers={"Authorization": "Bearer s3cret"})
    assert r.status_code == 413, r.status_code


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
        except Exception as e:
            failed += 1
            print(f"  FAIL  {t.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(tests) - failed}/{len(tests)} passed")
    sys.exit(1 if failed else 0)
