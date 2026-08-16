import type { FastifyInstance } from "fastify";
import { embedTexts } from "./client.js";

const MATCH_COUNT = 6;
// BGE-small cosine similarity on short chunks: genuinely relevant matches
// typically land 0.5-0.8, unrelated content usually falls under ~0.4.
// Conservative floor — false negatives (missing a relevant file) are worse
// here than the occasional low-value chunk slipping through.
const SIMILARITY_FLOOR = 0.45;

interface MatchedChunk {
  file_id: string;
  filename: string;
  chunk_index: number;
  chunk_text: string;
  similarity: number;
}

// Best-effort RAG retrieval over the user's own previously uploaded files.
// Returns null (not empty string) on any failure so the caller can tell
// "nothing relevant" apart from "retrieval broke" without extra plumbing —
// both result in the same behavior (skip the file-context block) but the
// distinction matters for logging.
export async function retrieveFileContext(
  fastify: FastifyInstance,
  userId: string,
  queryText: string,
  excludeFileIds: string[] = [],
): Promise<string | null> {
  try {
    const [queryEmbedding] = await embedTexts(fastify, [queryText], true);
    if (!queryEmbedding) return null;

    const { data, error } = await fastify.supabaseAdmin.rpc("match_file_chunks", {
      p_user_id: userId,
      p_query_embedding: queryEmbedding,
      p_match_count: MATCH_COUNT,
    });

    if (error) {
      fastify.log.warn({ err: error }, "match_file_chunks RPC failed — skipping file context this turn");
      return null;
    }

    // Files already attached directly to this message have their full text
    // injected inline (see buildAttachmentTextBlock) — exclude their chunks
    // here so the same content isn't sent to the model (and billed) twice.
    const excluded = new Set(excludeFileIds);
    const matches = ((data as MatchedChunk[] | null) ?? []).filter(
      (m) => m.similarity >= SIMILARITY_FLOOR && !excluded.has(m.file_id),
    );
    if (matches.length === 0) return null;

    return matches.map((m) => `[From "${m.filename}"]\n${m.chunk_text}`).join("\n\n");
  } catch (err) {
    fastify.log.warn({ err }, "file context retrieval failed — skipping, non-fatal");
    return null;
  }
}
