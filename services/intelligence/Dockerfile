# Build from this directory: docker build -t splex-intelligence services/intelligence
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
# torch's CPU-only wheel (see requirements.txt's "+cpu" version) is only
# published on PyTorch's own index, not the default PyPI.
RUN pip install --no-cache-dir -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu

# Pre-download the embedding model into the image so a cold container start
# doesn't pay a multi-second-plus HuggingFace Hub download (and doesn't
# depend on that egress being reachable/unblocked at request time).
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('BAAI/bge-small-en-v1.5')"

COPY main.py .

# HOST must be 0.0.0.0 here (unlike the local-dev default) so the platform
# can actually route to this container — see main.py's HOST env comment.
ENV HOST=0.0.0.0
EXPOSE 8100
CMD ["python", "main.py"]
