import { describe, it, expect } from "vitest";
import { profileBodySchema } from "../src/handlers/account.js";
import { createProjectSchema } from "../src/handlers/projects.js";
import { RATE_LIMITS } from "../src/handlers/rateLimits.js";
import { ok, fail, noContent } from "../src/handlers/result.js";
import { sendResult } from "../src/routes/sendResult.js";
import { classifyIntent } from "../src/cortex/classify.js";
import { buildSystemPrompt, categoryBlock } from "../src/cortex/systemPrompt.js";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";

describe("shared handler validation (was duplicated in both stacks)", () => {
  it("rejects an under-13 date of birth", () => {
    expect(profileBodySchema.safeParse({ fullName: "A", dateOfBirth: "2020-01-01" }).success).toBe(false);
  });
  it("rejects a future date of birth", () => {
    expect(profileBodySchema.safeParse({ fullName: "A", dateOfBirth: "2099-01-01" }).success).toBe(false);
  });
  it("accepts a valid adult date of birth", () => {
    expect(profileBodySchema.safeParse({ fullName: "A", dateOfBirth: "1990-05-05" }).success).toBe(true);
  });
  it("rejects an empty name and a non-ISO date", () => {
    expect(profileBodySchema.safeParse({ fullName: "", dateOfBirth: "1990-05-05" }).success).toBe(false);
    expect(profileBodySchema.safeParse({ fullName: "A", dateOfBirth: "05/05/1990" }).success).toBe(false);
  });
  it("requires a project title and caps the description", () => {
    expect(createProjectSchema.safeParse({}).success).toBe(false);
    expect(createProjectSchema.safeParse({ title: "X" }).success).toBe(true);
    expect(createProjectSchema.safeParse({ title: "X", description: "y".repeat(2001) }).success).toBe(false);
  });
});

describe("rate limits are a single shared table", () => {
  it("matches the audited production values", () => {
    expect(RATE_LIMITS).toMatchObject({
      chat: { max: 20, windowMs: 60_000 },
      chat_truncate: { max: 30, windowMs: 60_000 },
      account_profile: { max: 5, windowMs: 60_000 },
      files_process: { max: 10, windowMs: 60_000 },
      projects_create: { max: 10, windowMs: 60_000 },
      billing_checkout: { max: 5, windowMs: 60_000 },
      billing_cancel: { max: 5, windowMs: 60_000 },
      media_status: { max: 30, windowMs: 60_000 },
    });
  });
});

describe("HandlerResult -> HTTP adapter mapping", () => {
  const reply = () => {
    const r = { s: 0, b: undefined as unknown, code(n: number) { r.s = n; return r; }, send(b?: unknown) { r.b = b; return r; } };
    return r;
  };
  it("maps a failure to its status plus a message body", () => {
    const r = reply(); sendResult(r as never, fail("nope", 403));
    expect(r.s).toBe(403);
    expect(r.b).toEqual({ message: "nope" });
  });
  it("maps 204 to no body", () => {
    const r = reply(); sendResult(r as never, noContent());
    expect(r.s).toBe(204);
    expect(r.b).toBeUndefined();
  });
  it("preserves a created status and body", () => {
    const r = reply(); sendResult(r as never, ok({ id: "x" }, 201));
    expect(r.s).toBe(201);
    expect(r.b).toEqual({ id: "x" });
  });
});

describe("classification fast paths (latency)", () => {
  const f = makeFastify(makeState());

  it("resolves greetings with NO classifier round-trip", async () => {
    for (const greeting of ["hi", "hello!", "Hey", "yo"]) {
      const r = await classifyIntent(f, greeting);
      expect(r.category).toBe("general");
      expect(r.usedFallback).toBe(false); // deterministic, no LLM
    }
  });

  it("routes a SHORT media request correctly instead of defaulting to general", async () => {
    // "draw cat" is 2 words — the old code sent it to the classifier before
    // scoring keywords at all. Defaulting short input to general would have
    // silently broken image generation.
    const r = await classifyIntent(f, "draw cat");
    expect(r.category).toBe("image");
    expect(r.usedFallback).toBe(false);
  });

  it("still resolves a clear coding request deterministically", async () => {
    const r = await classifyIntent(f, "write me a python function to reverse a list");
    expect(r.category).toBe("coding");
    expect(r.usedFallback).toBe(false);
  });
});

describe("system prompt grounding", () => {
  it("does not fabricate a project when none is supplied", () => {
    const p = buildSystemPrompt(null, null, null);
    expect(p).not.toContain("working within a project");
    expect(p).toContain("A greeting is just a greeting");
  });

  it("frames memory as cross-conversation and instructs direct recall", () => {
    const p = buildSystemPrompt("- The user's name is Steven.", null, null);
    expect(p).toContain("carried over from your previous conversations");
    expect(p).toContain("answer directly from it");
    expect(p).toContain("Steven");
  });

  it("still injects a REAL project (not over-filtered)", () => {
    expect(buildSystemPrompt(null, null, "Q3 Marketing Site")).toContain('"Q3 Marketing Site"');
  });

  it("never names the underlying provider, even though it now explains SPLEX/Cortex and may name the routing category", () => {
    const p = buildSystemPrompt(null, null, null);
    for (const banned of ["Qwen", "DeepSeek", "Llama", "OpenRouter"]) {
      // Named only in the instruction telling the model NOT to reveal them.
      expect(p).toContain('Do not say "Qwen"');
      expect(p.split('Do not say "Qwen"')[0]).not.toContain(banned);
    }
    // The identity gap a real user hit: asked "what is SPLEX/Cortex", the
    // old persona had nothing beyond "an AI workspace assistant". Now it
    // actually explains the routing premise.
    expect(p).toContain("Cortex");
    expect(p).toMatch(/routes it to whichever underlying model is best suited/i);
  });

  it("permits describing the routing CATEGORY if asked which model is answering, but not the model itself", () => {
    const p = buildSystemPrompt(null, null, null);
    expect(p).toMatch(/you may describe the category cortex routed this message to/i);
    expect(p).toMatch(/never go further than that/i);
  });
});

describe("categoryBlock — tells the model which category THIS message was routed as", () => {
  it("is empty for no category", () => {
    expect(categoryBlock(null)).toBe("");
    expect(categoryBlock("")).toBe("");
  });

  it("names the exact category label the routing-receipt UI already shows (categoryToLabel), so chat and the receipt never disagree", () => {
    expect(categoryBlock("coding")).toContain('"Software Development"');
    expect(categoryBlock("reasoning")).toContain('"Advanced Reasoning"');
    expect(categoryBlock("general")).toContain('"General Assistance"');
  });

  it("never names the underlying model, only the category", () => {
    const block = categoryBlock("coding");
    for (const banned of ["Qwen", "DeepSeek", "Llama", "OpenRouter"]) {
      expect(block).not.toContain(banned);
    }
  });
});
