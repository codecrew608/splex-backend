// Layer A (spec item 2): local, deterministic transforms only. Zero
// external calls, zero AI cost, and — the load-bearing property — every
// transform here is UNCONDITIONALLY safe. Nothing in this file rewrites,
// summarizes, or rephrases anything; it only removes whitespace and exact
// duplication that add no information. That's what lets index.ts treat
// this layer's output as a safe fallback baseline with no validation step
// of its own — validation (validate.ts) exists for the semantic layer,
// which is the one layer capable of actually changing meaning.

export interface DeterministicResult {
  text: string;
  // True if this pass changed anything at all — lets the decision layer
  // (decision.ts) and telemetry distinguish "ran but no-op" from "did
  // nothing was ever attempted".
  changed: boolean;
  duplicateLinesRemoved: number;
  duplicateSentencesRemoved: number;
}

const MIN_DEDUPE_LINE_LENGTH = 20;

function normalizeWhitespace(text: string): string {
  return text
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Exact-repeat lines only, and only above a minimum length — a short
// repeated line ("-", "1.", a lone word) is very often meaningful
// structure (a list marker, a deliberately repeated heading), not
// redundancy. A long line repeated verbatim is never adding new
// information the second time.
function removeDuplicateLines(text: string): { text: string; removed: number } {
  const lines = text.split("\n");
  const seen = new Set<string>();
  const kept: string[] = [];
  let removed = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < MIN_DEDUPE_LINE_LENGTH) {
      kept.push(line);
      continue;
    }
    if (seen.has(trimmed)) {
      removed++;
      continue;
    }
    seen.add(trimmed);
    kept.push(line);
  }

  return { text: kept.join("\n"), removed };
}

// Same idea at sentence granularity, run after line-dedup — catches a
// repeated instruction restated as its own sentence elsewhere in the
// paragraph, whole and verbatim (case-insensitively), not a phrase
// repeated inside a differently-worded sentence — that would need
// phrase-level matching, a fundamentally riskier transform (real
// potential for mangling a sentence that only partially overlaps another)
// that does not belong in an UNCONDITIONALLY-safe layer.
//
// Splits on sentence-ending punctuation with a CAPTURING group around the
// trailing whitespace, so String.split keeps every separator as its own
// array element instead of consuming it — critical, since a plain
// `.join(" ")` on a non-capturing split silently collapses every
// separator (including intentional "\n\n" paragraph breaks) down to a
// single space, corrupting structure that was never actually duplicated.
// Dropping a duplicate sentence also drops the ONE separator immediately
// following it, so no double-space/stray-newline is left behind; every
// kept element (sentence or separator) is concatenated with zero
// modification, so the result is exactly the original characters minus
// whole removed (sentence, separator) pairs.
function removeDuplicateSentences(text: string): { text: string; removed: number } {
  const parts = text.split(/(?<=[.!?])(\s+)/);
  const seen = new Set<string>();
  const kept: string[] = [];
  let removed = 0;
  let dropNextSeparator = false;

  for (let i = 0; i < parts.length; i++) {
    const isSeparator = i % 2 === 1; // split-with-capture alternates: sentence, sep, sentence, sep, ...
    const part = parts[i];

    if (isSeparator) {
      if (dropNextSeparator) {
        dropNextSeparator = false;
      } else {
        kept.push(part);
      }
      continue;
    }

    const trimmed = part.trim();
    if (trimmed.length < MIN_DEDUPE_LINE_LENGTH) {
      kept.push(part);
      continue;
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) {
      removed++;
      dropNextSeparator = true;
      continue;
    }
    seen.add(key);
    kept.push(part);
  }

  return { text: kept.join(""), removed };
}

export function applyDeterministicOptimization(text: string): DeterministicResult {
  const whitespaceNormalized = normalizeWhitespace(text);
  const { text: dedupedLines, removed: duplicateLinesRemoved } = removeDuplicateLines(whitespaceNormalized);
  const { text: dedupedSentences, removed: duplicateSentencesRemoved } = removeDuplicateSentences(dedupedLines);
  // Whitespace normalization can shift again after sentence-join collapses
  // spacing around removed segments.
  const finalText = normalizeWhitespace(dedupedSentences);

  return {
    text: finalText,
    changed: finalText !== text,
    duplicateLinesRemoved,
    duplicateSentencesRemoved,
  };
}
