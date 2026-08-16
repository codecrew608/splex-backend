import type { FastifyInstance } from "fastify";

interface EmbedResponse {
  embeddings: number[][];
}

interface OcrResponse {
  text: string;
  pages: number;
}

export async function embedTexts(fastify: FastifyInstance, texts: string[], isQuery = false): Promise<number[][]> {
  const res = await fetch(`${fastify.config.INTELLIGENCE_SERVICE_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ texts, is_query: isQuery }),
  });
  if (!res.ok) {
    throw new Error(`Intelligence service /embed failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as EmbedResponse;
  return data.embeddings;
}

async function ocr(fastify: FastifyInstance, path: "/ocr/image" | "/ocr/pdf", bytes: Buffer): Promise<string> {
  const res = await fetch(`${fastify.config.INTELLIGENCE_SERVICE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: bytes,
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
