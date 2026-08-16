import type { FastifyInstance } from "fastify";
import { chunkText, RAG_TEXT_CAP } from "./chunk.js";
import { embedTexts } from "./client.js";

const EMBED_BATCH_SIZE = 32;

// Chunks + embeds a file's full extracted text and replaces its file_chunks
// rows. Called after extraction succeeds; failures here are non-fatal to
// the upload — a file that fails to index is still usable as a direct
// chat attachment via files.extracted_text, it just won't surface via RAG.
export async function indexFileChunks(fastify: FastifyInstance, fileId: string, fullText: string): Promise<void> {
  const capped = fullText.length > RAG_TEXT_CAP ? fullText.slice(0, RAG_TEXT_CAP) : fullText;
  const chunks = chunkText(capped);
  if (chunks.length === 0) return;

  const embeddings: number[][] = [];
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const batchEmbeddings = await embedTexts(fastify, batch, false);
    embeddings.push(...batchEmbeddings);
  }

  await fastify.supabaseAdmin.from("file_chunks").delete().eq("file_id", fileId);

  const rows = chunks.map((chunk_text, index) => ({
    file_id: fileId,
    chunk_index: index,
    chunk_text,
    embedding: embeddings[index],
  }));

  const { error } = await fastify.supabaseAdmin.from("file_chunks").insert(rows);
  if (error) {
    throw new Error(`Failed to insert file_chunks: ${error.message}`);
  }
}
