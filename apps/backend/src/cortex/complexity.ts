import type { ComplexityLevel } from "@splex/shared-types";

const SIMPLE_HINTS = [/\bquick(ly)?\b/i, /\bjust\b/i, /\bbriefly\b/i, /\bshort\b/i, /\bone[- ]liner\b/i];
const COMPLEX_HINTS = [
  /\bstep by step\b/i,
  /\bentire (project|app|codebase)\b/i,
  /\barchitecture\b/i,
  /\bin depth\b/i,
  /\bcomprehensive\b/i,
  /\bmulti[- ]?file\b/i,
  /\bend[- ]to[- ]end\b/i,
];

export function estimateComplexity(message: string): ComplexityLevel {
  const trimmed = message.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const codeBlockCount = (trimmed.match(/```/g) ?? []).length / 2;

  let score = 0;

  if (wordCount > 120) score += 2;
  else if (wordCount > 40) score += 1;

  if (codeBlockCount >= 1) score += 1;
  if (codeBlockCount >= 2) score += 1;

  if (COMPLEX_HINTS.some((re) => re.test(trimmed))) score += 2;
  if (SIMPLE_HINTS.some((re) => re.test(trimmed))) score -= 2;

  if (wordCount <= 8 && codeBlockCount === 0) score -= 1;

  if (score <= 0) return "simple";
  if (score <= 2) return "medium";
  return "complex";
}
