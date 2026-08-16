import io
import os

import pymupdf
import pytesseract
from fastapi import FastAPI, HTTPException, Request
from PIL import Image
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

app = FastAPI(title="SPLEX Intelligence Service")

# BAAI/bge-small-en-v1.5 -> 384 dims, matches the file_chunks.embedding
# pgvector column provisioned earlier this session. Loaded once at process
# start (not per-request) since model load is the expensive part (~1-2s
# import + weights) and this service is meant to stay resident.
_model = SentenceTransformer("BAAI/bge-small-en-v1.5")

MAX_OCR_PDF_PAGES = 25


BGE_QUERY_PREFIX = "Represent this sentence for searching relevant passages: "


class EmbedRequest(BaseModel):
    texts: list[str]
    is_query: bool = False


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]


class OcrResponse(BaseModel):
    text: str
    pages: int


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest):
    if not req.texts:
        raise HTTPException(400, "texts must be a non-empty array")
    # BGE's recommended instruction prefix boosts retrieval quality on the
    # query side only — stored passage chunks are embedded as plain text.
    texts = [BGE_QUERY_PREFIX + t for t in req.texts] if req.is_query else req.texts
    vectors = _model.encode(texts, normalize_embeddings=True)
    return {"embeddings": vectors.tolist()}


@app.post("/ocr/image", response_model=OcrResponse)
async def ocr_image(request: Request):
    file_bytes = await request.body()
    try:
        img = Image.open(io.BytesIO(file_bytes))
        text = pytesseract.image_to_string(img)
    except Exception as e:
        raise HTTPException(422, f"Could not OCR image: {e}")
    return {"text": text, "pages": 1}


@app.post("/ocr/pdf", response_model=OcrResponse)
async def ocr_pdf(request: Request):
    file_bytes = await request.body()
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
    # HOST=0.0.0.0, or the platform's networking has nothing to route to.
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 8100)))
