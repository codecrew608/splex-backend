import type { FastifyInstance } from "fastify";
import { embedTexts, isIntelligenceConfigured, IntelligenceNotConfiguredError } from "./client.js";

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
  // Retrieval needs embeddings, which need the sidecar. Without it every
  // call built the URL "undefined/embed", threw, and was logged as
  // "file context retrieval failed" — which reads like a runtime fault when
  // the truth is the capability is not deployed in this environment.
  // Checked first so the DB round-trip below is skipped too.
  if (!isIntelligenceConfigured(fastify)) return null;

  try {
    // Cheap existence check before paying for an embedding call. Every
    // chat turn used to call out to the intelligence sidecar (network +
    // real BGE inference) unconditionally, even for the large majority of
    // users who have never uploaded a file — that round trip sat on the
    // critical path before the model's response could even start
    // streaming, and was the single biggest fixed cost in Cortex's routing
    // latency. A user with zero files can have zero matching chunks by
    // construction, so skip straight to "no context" without ever calling
    // the embedding service.
    const { data: anyFile, error: fileCheckError } = await fastify.supabaseAdmin
      .from("files")
      .select("id")
      .eq("user_id", userId)
      .limit(1)
      .maybeSingle();
    if (fileCheckError) {
      fastify.log.warn({ err: fileCheckError }, "file existence check failed — skipping file context this turn");
      return null;
    }
    if (!anyFile) return null;

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
    // A configured-but-failing sidecar is a REAL fault and logged as an
    // error; an unconfigured one already returned above. Never collapse the
    // two into one bland "non-fatal" line again.
    if (err instanceof IntelligenceNotConfiguredError) {
      fastify.log.warn({ capability: "rag_retrieval" }, "file context skipped — intelligence service not configured");
      return null;
    }
    fastify.log.error(
      { errorName: err instanceof Error ? err.name : typeof err, errorMessage: err instanceof Error ? err.message : String(err) },
      "file context retrieval failed against a configured service",
    );
    return null;
  }
}
