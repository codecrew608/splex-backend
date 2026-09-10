import { describe, it, expect, vi, beforeEach } from "vitest";

// Same reasoning as optimizer-semantic.test.ts: completeOnceWithFallback
// is mocked directly (not completeOnce) because it calls completeOnce
// internally, within the same module — a same-module self-call vi.mock's
// spread-and-replace pattern does not reliably intercept.
vi.mock("../src/openrouter/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/openrouter/client.js")>();
  return { ...actual, completeOnceWithFallback: vi.fn() };
});

import { completeOnceWithFallback } from "../src/openrouter/client.js";
import { maybeOptimizePrompt } from "../src/optimizer/index.js";
import { makeOptimizerState, makeOptimizerFastify, type FakeOptimizerState } from "./helpers/fakeOptimizerFastify.js";
import type { ModelRegistryRow } from "../src/types/index.js";

const mockedComplete = vi.mocked(completeOnceWithFallback);

beforeEach(() => {
  mockedComplete.mockReset();
});

function completeResult(content: string, promptTokens = 100, completionTokens = 40) {
  return {
    content,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    generationId: "gen-test",
    citations: [],
  };
}

const TARGET_MODEL: ModelRegistryRow = {
  id: "model-1",
  category: "writing",
  openrouter_model_id: "test/target-model",
  variant: "paid",
  capability_score: 80,
  context_length: 32000,
  cost_per_million_input: 10, // deliberately expensive, so real token reductions produce clearly-positive net savings
  cost_per_million_output: 30,
  is_active: true,
  priority: 1,
};

// A verbose, genuinely compressible message — comfortably above
// MIN_TOKENS_FOR_SEMANTIC (80 tokens ~ 320 chars; this one is ~155 tokens
// / 620 chars, well clear of the boundary rather than sitting right next
// to it).
const VERBOSE_MESSAGE =
  "Can you please take a look at this code and basically figure out if there are any problems with it, " +
  "and if there are, tell me what they are and how I could potentially fix them, and also please let me " +
  "know if there are any security problems or performance issues that I should know about before I merge this. " +
  "I would really appreciate a thorough review since this is going into production soon and I want to make " +
  "sure everything is correct, well-tested, and follows our team's existing coding conventions and standards.";

function baseParams(overrides: Partial<Parameters<typeof maybeOptimizePrompt>[0]> = {}) {
  return {
    fastify: makeOptimizerFastify(makeOptimizerState()),
    planTier: "pro" as const,
    userId: "u1",
    messageId: "msg-1",
    text: VERBOSE_MESSAGE,
    targetModel: TARGET_MODEL,
    ...overrides,
  };
}

describe("maybeOptimizePrompt — the Pro-only gate, first and unconditional", () => {
  it("free tier: text unchanged, no telemetry row written at all", async () => {
    const state = makeOptimizerState();
    const fastify = makeOptimizerFastify(state);
    const outcome = await maybeOptimizePrompt(baseParams({ fastify, planTier: "free" }));

    expect(outcome.text).toBe(VERBOSE_MESSAGE);
    expect(outcome.wasOptimized).toBe(false);
    expect(outcome.bypassReason).toBe("not_eligible");
    await vi.waitFor(() => expect(state.optimizerOutcomeInserts.length).toBe(0));
    expect(mockedComplete).not.toHaveBeenCalled();
  });

  it("starter tier: also untouched — this is a Pro-only capability, not a Free-vs-paid split", async () => {
    const outcome = await maybeOptimizePrompt(baseParams({ planTier: "starter" }));
    expect(outcome.text).toBe(VERBOSE_MESSAGE);
    expect(outcome.bypassReason).toBe("not_eligible");
  });

  it("pro tier with SPLEX_PRO_ENABLED off: text unchanged, bypass reason recorded, telemetry DOES fire (a real, if rare, operational case worth seeing)", async () => {
    const state = makeOptimizerState({ config: { SPLEX_PRO_ENABLED: false, PROMPT_OPTIMIZER_MODEL_ID: "test/model" } });
    const fastify = makeOptimizerFastify(state);
    const outcome = await maybeOptimizePrompt(baseParams({ fastify }));

    expect(outcome.text).toBe(VERBOSE_MESSAGE);
    expect(outcome.bypassReason).toBe("flag_disabled");
    await vi.waitFor(() => expect(state.optimizerOutcomeInserts.length).toBe(1));
    expect(mockedComplete).not.toHaveBeenCalled();
  });
});

describe("maybeOptimizePrompt — size threshold (spec item 3)", () => {
  it("a short message never reaches the semantic layer, even for an eligible Pro request", async () => {
    const outcome = await maybeOptimizePrompt(baseParams({ text: "What is 2+2?" }));
    expect(outcome.text).toBe("What is 2+2?");
    expect(outcome.bypassReason).toBe("below_threshold");
    expect(mockedComplete).not.toHaveBeenCalled();
  });
});

describe("maybeOptimizePrompt — semantic layer failure falls back cleanly (spec item 11)", () => {
  it("model call fails -> falls back to deterministic-only text, never throws", async () => {
    mockedComplete.mockRejectedValue(new Error("upstream down"));
    const outcome = await maybeOptimizePrompt(baseParams());

    expect(outcome.wasOptimized).toBe(false);
    expect(outcome.bypassReason).toBe("semantic_call_failed");
    expect(outcome.text.length).toBeGreaterThan(0);
  });
});

describe("maybeOptimizePrompt — quality guard rejects a bad compression (spec item 10)", () => {
  it("validation failure (a number got dropped) falls back to deterministic-only text, not the unsafe semantic output", async () => {
    // VERBOSE_MESSAGE has no numbers, so inject one to make this concrete.
    const withNumber = `Please review this PR (#4821) carefully. ${VERBOSE_MESSAGE}`;
    mockedComplete.mockResolvedValue(completeResult("Review the code for bugs, security issues, and performance problems."));

    const outcome = await maybeOptimizePrompt(baseParams({ text: withNumber }));

    expect(outcome.wasOptimized).toBe(false);
    expect(outcome.bypassReason).toBe("validation_failed");
    expect(outcome.validationPassed).toBe(false);
    expect(outcome.text).not.toContain("Review the code for bugs, security issues, and performance problems.");
    // The rejected semantic call still cost something real — that must be
    // recorded even though its output was discarded (spec item 12: "net
    // cost saving" needs the failed attempt's cost too, not just successes).
    expect(outcome.optimizerModel).not.toBeNull();
  });
});

describe("maybeOptimizePrompt — economic guard rejects a negligible-value compression (spec item 24)", () => {
  it("a technically-valid but barely-shorter compression is rejected as not worth its own cost", async () => {
    // Only a few characters shorter than the original — well under the 10%
    // meaningful-reduction floor.
    const trimmedByAFewChars = VERBOSE_MESSAGE.slice(0, VERBOSE_MESSAGE.length - 5);
    mockedComplete.mockResolvedValue(completeResult(trimmedByAFewChars));

    const outcome = await maybeOptimizePrompt(baseParams());

    expect(outcome.wasOptimized).toBe(false);
    expect(outcome.bypassReason).toBe("negligible_or_negative_savings");
    expect(outcome.validationPassed).toBe(true); // it WAS valid — just not worth it
  });
});

describe("maybeOptimizePrompt — the full success path", () => {
  it("a genuinely compressible message is optimized, validated, and judged worth it", async () => {
    mockedComplete.mockResolvedValue(
      completeResult("TASK: Review this code.\nREQUIREMENTS: Identify bugs, security issues, and performance problems."),
    );
    const outcome = await maybeOptimizePrompt(baseParams());

    expect(outcome.wasOptimized).toBe(true);
    expect(outcome.method).toBe("semantic");
    expect(outcome.bypassReason).toBeNull();
    expect(outcome.validationPassed).toBe(true);
    expect(outcome.text).toBe("TASK: Review this code.\nREQUIREMENTS: Identify bugs, security issues, and performance problems.");
    expect(outcome.optimizedTokensEst).toBeLessThan(outcome.originalTokensEst);
    expect(outcome.reductionPct).toBeGreaterThan(0);
    expect(outcome.netSavingsUsd).toBeGreaterThan(0);
  });

  it("protected content (a URL) survives the full round trip byte-for-byte", async () => {
    const withUrl = `${VERBOSE_MESSAGE} See https://example.com/style-guide for our conventions.`;
    mockedComplete.mockImplementation(async (_fastify, _candidates, params) => {
      // Echo back a shorter version that still contains whatever placeholder(s) were sent.
      const userMsg = params.messages.find((m: { role: string }) => m.role === "user");
      const content = typeof userMsg?.content === "string" ? userMsg.content : "";
      const placeholderMatch = content.match(/⟦SPLEXPROTECT\d+⟧/);
      return completeResult(`Review this code for issues. ${placeholderMatch?.[0] ?? ""}`);
    });

    const outcome = await maybeOptimizePrompt(baseParams({ text: withUrl }));
    expect(outcome.text).toContain("https://example.com/style-guide");
  });

  it("records a real telemetry row with the expected shape", async () => {
    mockedComplete.mockResolvedValue(completeResult("TASK: review this code for problems and report them."));
    const state = makeOptimizerState();
    const fastify = makeOptimizerFastify(state);

    const outcome = await maybeOptimizePrompt(baseParams({ fastify, userId: "u42", messageId: "msg-42" }));

    await vi.waitFor(() => expect(state.optimizerOutcomeInserts.length).toBe(1));
    const row = state.optimizerOutcomeInserts[0];
    expect(row.message_id).toBe("msg-42");
    expect(row.user_id).toBe("u42");
    expect(row.was_optimized).toBe(outcome.wasOptimized);
    expect(row.method).toBe(outcome.method);
    expect(typeof row.original_tokens_est).toBe("number");
    expect(typeof row.optimized_tokens_est).toBe("number");
  });
});

describe("maybeOptimizePrompt — never crashes the caller (spec item 11's 'never a single point of failure')", () => {
  it("an empty semantic response degrades to deterministic-only without throwing", async () => {
    mockedComplete.mockResolvedValue(completeResult(""));
    await expect(maybeOptimizePrompt(baseParams())).resolves.not.toThrow();
  });

  it("model_registry pricing lookup returning nothing still produces a usable outcome", async () => {
    mockedComplete.mockResolvedValue(completeResult("A short compressed version of the request."));
    const state: FakeOptimizerState = makeOptimizerState({ modelRegistryRows: [] });
    const fastify = makeOptimizerFastify(state);
    const outcome = await maybeOptimizePrompt(baseParams({ fastify }));
    expect(outcome).toBeDefined();
    expect(outcome.text.length).toBeGreaterThan(0);
  });
});
