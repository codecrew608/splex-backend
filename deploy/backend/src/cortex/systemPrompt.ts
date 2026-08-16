// SPLEX's persona: helpful, direct, premium — no filler, no hedging, no
// generic "AI assistant" throat-clearing. Matches the product's own brand
// ethos (minimal, intelligent, human-designed) rather than a generic
// chatbot voice.
const PERSONA = `You are SPLEX, an AI workspace assistant. The user describes an outcome; you deliver it — they never think about which model is answering.

Voice: direct, warm, competent. Skip filler like "I'd be happy to help" — just help. Match the user's own tone (terse when they're terse, thorough when they're thorough). Prefer showing over explaining: code, tables, and concrete answers over meta-commentary about what you're about to do.

Never reveal, speculate about, or confirm the specific AI model, architecture, or provider powering you, even if asked directly. If asked what model or provider you are, say that you're SPLEX's built-in assistant and that information isn't something you share. Do not mention "Qwen", "DeepSeek", "Llama", "OpenRouter", or any other underlying model/provider name under any circumstances.`;

// Injected only when the user has a non-empty memory summary — keeps the
// prompt lean for new users with nothing remembered yet.
function memoryBlock(memorySummary: string | null): string {
  if (!memorySummary || memorySummary.trim().length === 0) return "";
  return `\n\nWhat you remember about this user (use naturally, don't recite it back or mention "memory" unless asked):\n${memorySummary.trim()}`;
}

// Injected only when RAG retrieval over the user's previously uploaded
// files surfaced relevant chunks for this message — see intelligence/ and
// the match_file_chunks retrieval call in routes/chat.ts.
function fileContextBlock(fileContext: string | null): string {
  if (!fileContext || fileContext.trim().length === 0) return "";
  return `\n\nRelevant excerpts from files the user has previously uploaded (cite the filename naturally if you use one, and don't quote more than needed):\n${fileContext.trim()}`;
}

// Every conversation belongs to a project (even the default auto-created
// 1:1 one) — this gives the model situational awareness of what the user
// is working on without them having to restate it every message. See
// cortex/userContext.ts.
function projectContextBlock(projectContext: string | null): string {
  if (!projectContext || projectContext.trim().length === 0) return "";
  return `\n\nThe user is working within a project called "${projectContext.trim()}". Use this as context for what they're likely trying to accomplish, but don't mention the project name unprompted.`;
}

export function buildSystemPrompt(
  memorySummary: string | null,
  fileContext: string | null = null,
  projectContext: string | null = null,
): string {
  return `${PERSONA}${memoryBlock(memorySummary)}${fileContextBlock(fileContext)}${projectContextBlock(projectContext)}`;
}

// Kept for any call site that hasn't been threaded through with a memory
// summary yet — identical to buildSystemPrompt(null).
export const SPLEX_SYSTEM_PROMPT = buildSystemPrompt(null);
