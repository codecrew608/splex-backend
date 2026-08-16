#!/usr/bin/env bash
# Starts the SPLEX Intelligence sidecar (Tesseract OCR + BGE-small
# embeddings). Expects `tesseract` on PATH (apt package tesseract-ocr) and
# the local .venv set up via: python3 -m venv .venv && .venv/bin/pip install
# -r requirements.txt
#
# HOST defaults to 127.0.0.1 (loopback-only, matches local dev where the
# backend runs on the same machine). Production deploys where the backend
# reaches this service over a network must set HOST=0.0.0.0.
set -euo pipefail
cd "$(dirname "$0")"
exec ./.venv/bin/uvicorn main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8100}"
