import type { FastifyInstance } from "fastify";

interface EmbedResponse {
  embeddings: number[][];
}

interface OcrResponse {
  text: string;
  pages: number;
}

// fetch() has no default timeout — without one, a stuck/overloaded
// intelligence sidecar would hang every chat turn that reaches this call
// indefinitely rather than failing fast into retrieveFileContext's
// existing "non-fatal, skip file context" catch.
const EMBED_TIMEOUT_MS = 8_000;

// OCR needs its own, much larger ceiling: a 25-page PDF is rasterised at
// 200 DPI and Tesseract'd page by page, which legitimately takes tens of
// seconds. The embed timeout would abort real work; having no timeout at
// all (the previous state) meant a wedged sidecar hung the upload path
// forever, which is the failure the comment above was written to prevent.
const OCR_TIMEOUT_MS = 120_000;

// The intelligence sidecar (OCR + embeddings) is OPTIONAL configuration —
// INTELLIGENCE_SERVICE_URL is `.optional()` in both env schemas and is
// deliberately absent from the Worker's wrangler.jsonc, because a Worker
// cannot reach a loopback address.
//
// Without this guard every call built the URL "undefined/ocr/image" and
// threw an opaque fetch error, which the call sites caught and logged as
// "image OCR failed" / "file context retrieval failed". Production logs
// were full of them and they read like runtime faults, when the truth is
// that the feature is simply not deployed. Two capabilities — image OCR
// and file-context RAG retrieval — are therefore inert in production.
//
// Reporting that accurately is the opposite of suppressing it: callers can
// now distinguish "not configured" (a deployment gap, actionable by an
// operator) from "the sidecar is up but failed" (a real runtime fault).
export class IntelligenceNotConfiguredError extends Error {
  constructor(operation: string) {
    super(`Intelligence service is not configured (INTELLIGENCE_SERVICE_URL unset) — ${operation} unavailable`);
    this.name = "IntelligenceNotConfiguredError";
  }
}

export function isIntelligenceConfigured(fastify: FastifyInstance): boolean {
  const url = fastify.config.INTELLIGENCE_SERVICE_URL;
  return typeof url === "string" && url.length > 0;
}

// The sidecar refuses to start network-bound without a token (see
// services/intelligence/main.py), so in any real deployment this header is
// required. It stays optional here for the loopback local-dev case, where
// the sidecar runs unauthenticated because only this machine can reach it.
function authHeaders(fastify: FastifyInstance): Record<string, string> {
  const token = fastify.config.INTELLIGENCE_SERVICE_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function embedTexts(fastify: FastifyInstance, texts: string[], isQuery = false): Promise<number[][]> {
  if (!isIntelligenceConfigured(fastify)) throw new IntelligenceNotConfiguredError("embeddings");
  const res = await fetch(`${fastify.config.INTELLIGENCE_SERVICE_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(fastify) },
    body: JSON.stringify({ texts, is_query: isQuery }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Intelligence service /embed failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as EmbedResponse;
  return data.embeddings;
}

async function ocr(fastify: FastifyInstance, path: "/ocr/image" | "/ocr/pdf", bytes: Buffer): Promise<string> {
  if (!isIntelligenceConfigured(fastify)) throw new IntelligenceNotConfiguredError(`OCR (${path})`);
  const res = await fetch(`${fastify.config.INTELLIGENCE_SERVICE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", ...authHeaders(fastify) },
    body: bytes,
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Intelligence service ${path} failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as OcrResponse;
  return data.text;
}

export function ocrImage(fastify: FastifyInstance, bytes: Buffer): Promise<string> {
  return ocr(fastify, "/ocr/image", bytes);
}

export function ocrPdf(fastify: FastifyInstance, bytes: Buffer): Promise<string> {
  return ocr(fastify, "/ocr/pdf", bytes);
}
