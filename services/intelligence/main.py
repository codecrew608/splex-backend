import hmac
import io
import os

import pymupdf
import pytesseract
from fastapi import Depends, FastAPI, HTTPException, Request
from PIL import Image
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

app = FastAPI(title="SPLEX Intelligence Service")

MAX_OCR_PDF_PAGES = 25

# Every endpoint below buffers its whole request body before doing work, so
# without a ceiling one request can OOM the container. 25 MB comfortably
# exceeds the backend's own upload limit while staying far below the
# smallest plausible container memory.
MAX_BODY_BYTES = 25 * 1024 * 1024

# /embed is the cheapest endpoint to call and the most expensive to serve
# (a transformer forward pass per text), so it needs its own ceilings —
# MAX_BODY_BYTES alone would permit ~200k tiny strings in one request.
MAX_EMBED_TEXTS = 256
MAX_EMBED_CHARS = 200_000

BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

_HOST = os.environ.get("HOST", "127.0.0.1")
_TOKEN = os.environ.get("INTELLIGENCE_SERVICE_TOKEN") or None

# Fail closed on the dangerous configuration, at import, before serving.
#
# /embed and /ocr/* are unmetered CPU: a 25-page PDF is rasterised at 200
# DPI and OCR'd page by page. Exposed without auth, this is free compute
# for anyone who finds the URL.
#
# Binding to loopback is self-limiting (only this machine can connect), so
# local dev stays frictionless with no token. Anything else — and the
# Dockerfile MUST set HOST=0.0.0.0 for the platform to route to it — is
# reachable over a network and therefore requires a token. Refusing to
# start is deliberate: a service that silently came up unauthenticated is
# exactly the outcome this guard exists to prevent.
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}
if _HOST not in _LOOPBACK_HOSTS and _TOKEN is None:
    raise RuntimeError(
        f"Refusing to start: HOST={_HOST!r} is network-reachable but "
        "INTELLIGENCE_SERVICE_TOKEN is unset. Set the token (and the matching "
        "value on the backend) or bind to 127.0.0.1 for local-only use."
    )

# BAAI/bge-small-en-v1.5 -> 384 dims, matches the file_chunks.embedding
# pgvector column provisioned earlier this session. Loaded once at process
# start (not per-request) since model load is the expensive part (~1-2s
# import + weights) and this service is meant to stay resident.
_model = SentenceTransformer("BAAI/bge-small-en-v1.5")


def require_token(request: Request) -> None:
    """Shared-secret bearer auth. A no-op only in the loopback-bound local
    case the startup guard above already restricts."""
    if _TOKEN is None:
        return
    scheme, _, presented = request.headers.get("authorization", "").partition(" ")
    # compare_digest, not ==, so a wrong token can't be recovered byte by
    # byte from response timing.
    if scheme.lower() != "bearer" or not hmac.compare_digest(presented, _TOKEN):
        raise HTTPException(401, "Unauthorized")


async def read_capped_body(request: Request) -> bytes:
    """Read the body, refusing anything over MAX_BODY_BYTES.

    Streams rather than calling request.body(), because the latter has
    already buffered the whole payload by the time it returns — checking
    the size afterwards would be too late to prevent the memory spike.
    Content-Length is only a hint (chunked requests omit it), so the
    running total is what actually enforces the cap.
    """
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > MAX_BODY_BYTES:
        raise HTTPException(413, f"Body exceeds {MAX_BODY_BYTES} bytes")

    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > MAX_BODY_BYTES:
            raise HTTPException(413, f"Body exceeds {MAX_BODY_BYTES} bytes")
        chunks.append(chunk)
    return b"".join(chunks)


class EmbedRequest(BaseModel):
    texts: list[str]
    is_query: bool = False


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]


class OcrResponse(BaseModel):
    text: str
    pages: int


# Unauthenticated on purpose: platform health checks (Cloudflare containers,
# Docker HEALTHCHECK, any load balancer) run before they could hold a token,
# and this reveals nothing but liveness.
@app.get("/health")
def health():
    return {"status": "ok", "auth": "enabled" if _TOKEN else "disabled"}


@app.post("/embed", response_model=EmbedResponse, dependencies=[Depends(require_token)])
def embed(req: EmbedRequest):
    if not req.texts:
        raise HTTPException(400, "texts must be a non-empty array")
    if len(req.texts) > MAX_EMBED_TEXTS:
        raise HTTPException(413, f"texts has {len(req.texts)} entries, cap is {MAX_EMBED_TEXTS}")
    total_chars = sum(len(t) for t in req.texts)
    if total_chars > MAX_EMBED_CHARS:
        raise HTTPException(413, f"texts total {total_chars} chars, cap is {MAX_EMBED_CHARS}")
    # BGE's recommended instruction prefix boosts retrieval quality on the
    # query side only — stored passage chunks are embedded as plain text.
    texts = [BGE_QUERY_PREFIX + t for t in req.texts] if req.is_query else req.texts
    vectors = _model.encode(texts, normalize_embeddings=True)
    return {"embeddings": vectors.tolist()}


@app.post("/ocr/image", response_model=OcrResponse, dependencies=[Depends(require_token)])
async def ocr_image(request: Request):
    file_bytes = await read_capped_body(request)
    try:
        img = Image.open(io.BytesIO(file_bytes))
        text = pytesseract.image_to_string(img)
    except Exception as e:
        raise HTTPException(422, f"Could not OCR image: {e}")
    return {"text": text, "pages": 1}


@app.post("/ocr/pdf", response_model=OcrResponse, dependencies=[Depends(require_token)])
async def ocr_pdf(request: Request):
    file_bytes = await read_capped_body(request)
    try:
        doc = pymupdf.open(stream=file_bytes, filetype="pdf")
    except Exception as e:
        raise HTTPException(422, f"Could not open PDF: {e}")

    if doc.page_count > MAX_OCR_PDF_PAGES:
        doc.close()
        raise HTTPException(422, f"PDF has {doc.page_count} pages, OCR cap is {MAX_OCR_PDF_PAGES}.")

    parts = []
    for page in doc:
        pix = page.get_pixmap(dpi=200)
        img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        parts.append(pytesseract.image_to_string(img))
    page_count = doc.page_count
    doc.close()
    return {"text": "\n\n".join(parts), "pages": page_count}


if __name__ == "__main__":
    import uvicorn

    # 127.0.0.1 by default (unchanged local-dev behavior — the backend
    # talks to this over loopback). Production deploys where the backend
    # reaches this service over a network (not the same machine) must set
    # HOST=0.0.0.0, which the startup guard above then requires a token for.
    uvicorn.run(app, host=_HOST, port=int(os.environ.get("PORT", 8100)))
