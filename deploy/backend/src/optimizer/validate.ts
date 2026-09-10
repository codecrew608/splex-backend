import { hasHardFormatConstraint } from "../cortex/systemPrompt.js";
import { protectedPlaceholdersIn } from "./protect.js";

// Quality guard (spec item 10). Deterministic only, by design — item 10
// explicitly permits a "cheap semantic validator" for high-risk cases, but
// every check this optimizer needs turns out to already be checkable
// without one (placeholder bookkeeping, substring presence, an existing
// regex-based detector reused from systemPrompt.ts). Adding a second AI
// call just to validate the first would double the latency/cost this
// whole feature exists to reduce, for a marginal precision gain over what
// deterministic checks already catch — reused only where a real gap shows
// up in practice, not before.

export interface ValidationResult {
  passed: boolean;
  failureReason: string | null;
}

function fail(reason: string): ValidationResult {
  return { passed: false, failureReason: reason };
}

const NUMBER_RE = /\b\d[\d,]*(?:\.\d+)?%?\b/g;

function extractNumbers(text: string): string[] {
  return [...text.matchAll(NUMBER_RE)].map((m) => m[0]);
}

const NEGATION_RE = /\b(don't|do not|never|without|except|excluding|not|shouldn't|should not|avoid|no\s)\b/gi;

function countNegationCues(text: string): number {
  return (text.match(NEGATION_RE) ?? []).length;
}

function multisetEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const counts = new Map<string, number>();
  for (const item of a) counts.set(item, (counts.get(item) ?? 0) + 1);
  for (const item of b) {
    const remaining = counts.get(item) ?? 0;
    if (remaining === 0) return false;
    counts.set(item, remaining - 1);
  }
  return true;
}

export function validateOptimizedOutput(params: {
  originalText: string;
  preSemanticText: string;
  semanticOutputRaw: string;
  restoredFinalText: string;
}): ValidationResult {
  const { originalText, preSemanticText, semanticOutputRaw, restoredFinalText } = params;

  if (restoredFinalText.trim().length === 0) {
    return fail("optimized output was empty");
  }

  // Every protected span (code, URLs, JSON, secret-shaped tokens) must
  // come back exactly as many times as it went in — proof the model
  // preserved each placeholder as an opaque token rather than dropping,
  // duplicating, or editing it.
  const sentPlaceholders = protectedPlaceholdersIn(preSemanticText);
  const returnedPlaceholders = protectedPlaceholdersIn(semanticOutputRaw);
  if (!multisetEqual(sentPlaceholders, returnedPlaceholders)) {
    return fail("protected content placeholder count changed");
  }

  // Every distinct number that appeared anywhere in the true original must
  // still appear somewhere in the final (placeholder-restored) text.
  // Exact-value substring match, not a semantic check — deliberately: a
  // number is one of the few things spec item 5 lists as NEVER safe to
  // approximate, so "close enough" is not an acceptable pass here.
  const originalNumbers = new Set(extractNumbers(originalText));
  const restoredNumbers = new Set(extractNumbers(restoredFinalText));
  for (const num of originalNumbers) {
    if (!restoredNumbers.has(num)) {
      return fail(`number "${num}" from the original is missing from the optimized text`);
    }
  }

  // An explicit format constraint ("reply in exactly 5 words", "only
  // JSON") must not have been compressed away — reuses the SAME detector
  // handlers/chat.ts already runs on every message (systemPrompt.ts),
  // rather than a second bespoke one.
  if (hasHardFormatConstraint(originalText) && !hasHardFormatConstraint(restoredFinalText)) {
    return fail("a stated format constraint was lost");
  }

  // Negative instructions ("don't include X", "without Y") are the
  // spec's other explicitly-named never-drop category. Cue-count is a
  // coarse proxy for "at least one negation survived", not a proof every
  // individual one did — but losing every negation cue entirely on a
  // message that had several is a strong, cheap signal something
  // important was compressed away.
  const originalNegations = countNegationCues(originalText);
  if (originalNegations > 0 && countNegationCues(restoredFinalText) === 0) {
    return fail("negative instructions/exclusions were lost");
  }

  return { passed: true, failureReason: null };
}
