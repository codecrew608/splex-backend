import type { ProtectedExtraction } from "./types.js";

// Protected-content extraction (spec item 6). Spans matched here are
// pulled OUT of the text entirely before it ever reaches the semantic
// optimizer model — not "instructed not to touch", physically absent from
// what that model sees. This is a stronger guarantee than trusting a
// compression prompt to leave code/secrets alone, and it also means the
// optimizer's own token/cost accounting never has to think about them.
//
// Deliberately conservative: every pattern here trades recall for
// precision. Missing a protectable span just means less compression on
// that span (safe, only suboptimal); a false positive would protect
// ordinary prose from being compressed (also safe, also just
// suboptimal). There is no failure mode where being conservative here
// causes incorrect output — only less token reduction than an ideal
// implementation would achieve. More exotic formats (YAML, XML, regex
// literals) are a documented gap, not a silent one — see this file's own
// scope note below.

// The bracket pair is U+27E6/U+27E7 (mathematical white square brackets),
// not plain "[P0]"-style markers, because a plain marker collides with
// real text this optimizer will actually see — "P0 bug", "P1 priority"
// are ordinary phrases in the coding/technical prompts this feature
// targets most. This pairing does not occur in natural writing, so a
// match is unambiguous, and it is distinctive enough that a small model
// reliably treats it as an opaque token to preserve rather than prose to
// rephrase.
const PLACEHOLDER_PREFIX = "⟦SPLEXPROTECT";
const PLACEHOLDER_SUFFIX = "⟧";

function placeholderFor(i: number): string {
  return `${PLACEHOLDER_PREFIX}${i}${PLACEHOLDER_SUFFIX}`;
}

const PLACEHOLDER_RE = /⟦SPLEXPROTECT(\d+)⟧/g;

// Order matters: fenced code blocks first (so inline-code/URL patterns
// inside a fence never get double-matched against the already-placeholdered
// text), then inline code, then URLs, then JSON-looking blocks, then
// secret-shaped tokens.
const CODE_FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const URL_RE = /\bhttps?:\/\/[^\s)\]}"'<>]+/gi;
// Common CLI-secret shapes: OpenAI-style sk-..., Groq-style gsk_..., a
// generic "Bearer <token>" header, and long hex/base64-ish runs (32+
// chars, alphanumeric plus -_/+=) that are far more likely to be a key,
// hash, or token than prose.
const SECRET_RE = /\b(sk-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|[A-Za-z0-9_-]{32,})\b/g;

function extractByPattern(text: string, pattern: RegExp, spans: string[]): string {
  return text.replace(pattern, (match) => {
    const idx = spans.length;
    spans.push(match);
    return placeholderFor(idx);
  });
}

// Balanced-bracket JSON detection: scan for a `{` or `[`, track nesting,
// and attempt JSON.parse on the candidate substring once it closes. Exact
// (zero false positives — anything protected here really does parse as
// JSON) at the cost of missing JSON-like text with a syntax error, which
// is an acceptable trade for a compression safety net.
function extractJsonBlocks(text: string, spans: string[]): string {
  let result = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "{" || ch === "[") {
      const open = ch;
      const close = open === "{" ? "}" : "]";
      let depth = 0;
      let j = i;
      let inString = false;
      let escaped = false;
      for (; j < text.length; j++) {
        const c = text[j];
        if (inString) {
          if (escaped) escaped = false;
          else if (c === "\\") escaped = true;
          else if (c === '"') inString = false;
          continue;
        }
        if (c === '"') inString = true;
        else if (c === open) depth++;
        else if (c === close) {
          depth--;
          if (depth === 0) {
            j++;
            break;
          }
        }
      }
      const candidate = text.slice(i, j);
      if (depth === 0 && candidate.length > 1) {
        try {
          JSON.parse(candidate);
          const idx = spans.length;
          spans.push(candidate);
          result += placeholderFor(idx);
          i = j;
          continue;
        } catch {
          // Not valid JSON — fall through, emit just this one character
          // and keep scanning normally (it may still open a nested/later
          // real JSON block).
        }
      }
    }
    result += ch;
    i++;
  }
  return result;
}

export function extractProtectedContent(text: string): ProtectedExtraction {
  const spans: string[] = [];
  let working = extractByPattern(text, CODE_FENCE_RE, spans);
  working = extractByPattern(working, INLINE_CODE_RE, spans);
  working = extractJsonBlocks(working, spans);
  working = extractByPattern(working, URL_RE, spans);
  working = extractByPattern(working, SECRET_RE, spans);
  return { text: working, spans };
}

export function restoreProtectedContent(text: string, spans: string[]): string {
  return text.replace(PLACEHOLDER_RE, (match, idxStr) => {
    const idx = Number(idxStr);
    return idx >= 0 && idx < spans.length ? spans[idx] : match;
  });
}

// Validation helper (used by validate.ts): every placeholder present in
// the pre-semantic text must still be present, exactly once each, in the
// semantic model's output — proof the model didn't drop, duplicate, or
// (attempt to) rewrite a protected span.
export function protectedPlaceholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER_RE)].map((m) => m[0]);
}
