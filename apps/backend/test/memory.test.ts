import { describe, it, expect } from "vitest";
import {
  shouldExtractMemory,
  looksLikeSecret,
  parseFactUpserts,
  parseFactDeletes,
  buildProjectMemorySummary,
} from "../src/memory/extractMemory.js";

describe("shouldExtractMemory — the gate deciding whether to spend an LLM call on this turn", () => {
  it("fires on an explicit 'remember' request", () => {
    expect(shouldExtractMemory("Remember that I like concise answers.", 3, 2)).toBe(true);
  });

  it("fires on an explicit 'forget' request — the gap this pass fixed (previously matched nothing)", () => {
    expect(shouldExtractMemory("Forget that I like concise answers.", 3, 2)).toBe(true);
    expect(shouldExtractMemory("Please don't remember my old job title anymore.", 5, 3)).toBe(true);
    expect(shouldExtractMemory("That's no longer true, I've moved on.", 5, 3)).toBe(true);
  });

  it("fires on a stated identity/preference fact even without a trigger word", () => {
    expect(shouldExtractMemory("My name is Alex.", 1, 0)).toBe(true);
    expect(shouldExtractMemory("I prefer short answers.", 1, 0)).toBe(true);
  });

  it("does not fire on an ordinary turn with no signal, off the periodic interval, for a new profile", () => {
    // EARLY_PROFILE_TURN_INTERVAL is 2 when factCount < 4 — turn 3 is not a multiple of 2.
    expect(shouldExtractMemory("What's the capital of France?", 3, 1)).toBe(false);
  });

  it("still fires periodically for a profile with no trigger words, more eagerly while the profile is small", () => {
    expect(shouldExtractMemory("ok thanks", 2, 1)).toBe(true); // turn 2 % 2 === 0, factCount 1 < 4
    expect(shouldExtractMemory("ok thanks", 4, 1)).toBe(true); // turn 4 % 2 === 0
    expect(shouldExtractMemory("ok thanks", 4, 5)).toBe(false); // established profile (factCount >= 4): interval becomes 5, 4 % 5 !== 0
    expect(shouldExtractMemory("ok thanks", 5, 5)).toBe(true); // 5 % 5 === 0
  });

  it("never fires on turn 0 (nothing to extract from yet) absent a trigger word", () => {
    expect(shouldExtractMemory("hi", 0, 0)).toBe(false);
  });
});

describe("looksLikeSecret — defense-in-depth backstop against the model extracting a credential anyway", () => {
  it("flags long opaque tokens (API keys, JWTs)", () => {
    expect(looksLikeSecret("Uses API key sk-proj-abcdefghijklmnopqrstuvwxyz123456")).toBe(true);
    expect(looksLikeSecret("Auth token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abcdefgh")).toBe(true);
  });

  it("flags card/account-number-length digit runs", () => {
    expect(looksLikeSecret("Card number 4111111111111111")).toBe(true);
  });

  it("flags explicit password/api-key labels", () => {
    expect(looksLikeSecret("password: hunter2hunter2")).toBe(true);
    expect(looksLikeSecret("api_key=abc123")).toBe(true);
  });

  it("does not flag an ordinary short factual sentence", () => {
    expect(looksLikeSecret("Prefers concise answers.")).toBe(false);
    expect(looksLikeSecret("The user's name is Alex.")).toBe(false);
    expect(looksLikeSecret("Is building SPLEX, an AI chat product.")).toBe(false);
  });
});

// parseFactUpserts/parseFactDeletes are the shared validation used for
// BOTH user facts and project facts (memory/extractMemory.ts) — a gap
// here is a gap in the project-memory feature's defense-in-depth too, not
// just the original per-user one.
describe("parseFactUpserts — shared upsert validation for user and project facts", () => {
  it("drops entries missing a non-empty key or fact", () => {
    const result = parseFactUpserts([{ key: "name", fact: "Alex" }, { key: "", fact: "x" }, { key: "y" }, { fact: "z" }, {}]);
    expect(result).toEqual([{ key: "name", fact: "Alex" }]);
  });

  it("drops a fact that looks like a secret even if the model labeled it as a real fact", () => {
    const result = parseFactUpserts([{ key: "api", fact: "Uses API key sk-proj-abcdefghijklmnopqrstuvwxyz123456" }]);
    expect(result).toEqual([]);
  });

  it("caps at 5 — a single exchange producing more is treated as a runaway response, not a memory dump", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ key: `k${i}`, fact: `fact ${i}` }));
    expect(parseFactUpserts(many)).toHaveLength(5);
  });

  it("returns [] for non-array input rather than throwing", () => {
    expect(parseFactUpserts(undefined)).toEqual([]);
    expect(parseFactUpserts(null)).toEqual([]);
    expect(parseFactUpserts("not an array")).toEqual([]);
  });
});

describe("parseFactDeletes", () => {
  it("keeps only non-empty strings", () => {
    expect(parseFactDeletes(["name", "", "  ", 5, null, "job"])).toEqual(["name", "job"]);
  });

  it("returns [] for non-array input rather than throwing", () => {
    expect(parseFactDeletes(undefined)).toEqual([]);
  });
});

describe("buildProjectMemorySummary — the block injected into every chat within the same project", () => {
  it("joins facts as bullet lines", () => {
    const summary = buildProjectMemorySummary([
      { fact_key: "goal", fact: "Ship the Q3 marketing site redesign." },
      { fact_key: "constraint", fact: "Must support IE11." },
    ]);
    expect(summary).toBe("- Ship the Q3 marketing site redesign.\n- Must support IE11.");
  });

  it("returns an empty string for no facts, which systemPrompt.ts treats as \"omit this block\"", () => {
    expect(buildProjectMemorySummary([])).toBe("");
  });
});
