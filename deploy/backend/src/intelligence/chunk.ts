const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;

// Caps how much of one file becomes searchable — independent of the
// smaller TEXT_EXTRACT_CAP used for direct-attachment inject in chat.ts,
// since RAG's whole point is surfacing content that doesn't fit inline.
export const RAG_TEXT_CAP = 200_000;

export function chunkText(text: string, chunkSize = CHUNK_SIZE, overlap = CHUNK_OVERLAP): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];

  const chunks: string[] = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(start + chunkSize, cleaned.length);
    chunks.push(cleaned.slice(start, end));
    if (end === cleaned.length) break;
    start = end - overlap;
  }
  return chunks;
}
