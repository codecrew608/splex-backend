// No tokenizer dependency exists in this codebase (verified: no tiktoken/
// gpt-tokenizer in package.json), and binding to one provider's exact
// tokenizer would be a poor fit anyway — the optimizer sits upstream of
// model selection and different candidates use different tokenizers. The
// standard ~4-chars-per-token heuristic for English text is accurate
// enough for a decision layer that only needs to answer "is this roughly
// big enough to bother", not for anything billed.
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}
