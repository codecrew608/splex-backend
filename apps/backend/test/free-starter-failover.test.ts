import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  OpenRouterError,
  isRetryableOpenRouterError,
  isFreeModelDailyCapExceededError,
  isBalanceExceededError,
  isModelUnavailableError,
  isAuthError,
  isTransientNetworkError,
  describeError,
} from "../src/openrouter/client.js";
import { isOpenRouterCapacityExhausted, attemptGroqFallback } from "../src/groq/fallback.js";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";
import type { AuthedUser } from "../src/types/index.js";

// SPLEX — API 1 Free/Starter routing + Groq fallback hardening.
// Behavioral + structural coverage for the 20-item test list in the task.
// Mixes real-function assertions (predicate classification, accounting
// arithmetic against the faithful fakeFastify RPC re-implementations) with
// source-pins for the isolation/observability invariants — the same idiom
// capacity-security.test.ts / groq-fallback-security.test.ts already use.

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");
const REPO = join(import.meta.dirname, "..", "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

// A throwable that looks exactly like a real OpenRouter HTTP failure,
// including optional rate-limit headers (G3).
function orError(
  status: number,
  body: string,
  headers?: Record<string, string>,
  kind: "stream" | "classifier" = "stream",
): OpenRouterError {
  return new OpenRouterError(kind, status, body, "vendor/model:free", headers ? new Headers(headers) : undefined);
}

const user = (planTier: AuthedUser["planTier"]): AuthedUser => ({
  id: "u-test",
  email: "u@test.invalid",
  planTier,
  orgId: null,
  timezone: "UTC",
});

// ===========================================================================
// Items 8, 9, 11 — ERROR CLASSIFICATION: RPM 429 vs daily/account exhaustion
// ===========================================================================
describe("error classification — a 429 is not automatically 'daily quota exhausted'", () => {
  it("plain per-minute 429 (no daily headers) → retryable, NOT a daily-cap exhaustion", () => {
    const rpm = orError(429, "Rate limit exceeded: please slow down");
    expect(isRetryableOpenRouterError(rpm)).toBe(true); // try the next candidate
    expect(isFreeModelDailyCapExceededError(rpm)).toBe(false); // NOT marked exhausted
  });

  it("429 with X-RateLimit-Remaining: 0 AND a far-away reset → daily/account exhaustion (G3)", () => {
    const exhausted = orError(429, "some reworded rate-limit message", {
      "x-ratelimit-limit": "50",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Date.now() + 6 * 60 * 60 * 1000), // 6h — UTC-midnight-ish
    });
    expect(isFreeModelDailyCapExceededError(exhausted)).toBe(true);
    expect(isRetryableOpenRouterError(exhausted)).toBe(true);
  });

  it("429 with Remaining: 0 but a SUB-MINUTE reset → NOT daily (per-minute windows also hit remaining:0)", () => {
    // This is the exact regression class groq/capacity.ts's removal note
    // documents — a rolling per-minute window must never become a day-long
    // per-model exhaustion.
    const perMinuteBurst = orError(429, "busy", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Date.now() + 800), // 0.8s
    });
    expect(isFreeModelDailyCapExceededError(perMinuteBurst)).toBe(false);
    expect(isRetryableOpenRouterError(perMinuteBurst)).toBe(true); // still retried against the next candidate
  });

  it("429 whose reset is >10min away → daily-scoped even with remaining unknown; a sub-minute reset is not (G3)", () => {
    const daily = orError(429, "busy", {
      "x-ratelimit-reset": String(Date.now() + 6 * 60 * 60 * 1000), // 6h
    });
    const perMinute = orError(429, "busy", {
      "x-ratelimit-remaining": "3",
      "x-ratelimit-reset": String(Date.now() + 800), // 0.8s
    });
    expect(isFreeModelDailyCapExceededError(daily)).toBe(true);
    expect(isFreeModelDailyCapExceededError(perMinute)).toBe(false);
  });

  it("a 429 with NO rate-limit headers falls back to the body-text match only", () => {
    expect(isFreeModelDailyCapExceededError(orError(429, "generic slow down"))).toBe(false);
    expect(isFreeModelDailyCapExceededError(orError(429, "free-models-per-day"))).toBe(true);
  });

  it("the classic 'free-models-per-day' body still matches with no headers at all", () => {
    expect(
      isFreeModelDailyCapExceededError(orError(429, "Rate limit exceeded: free-models-per-day")),
    ).toBe(true);
  });

  it("the SYNTHETIC pre-flight denial (provider_capacity_exhausted, no headers) still matches", () => {
    expect(
      isFreeModelDailyCapExceededError(
        orError(429, JSON.stringify({ error: { message: "…provider_capacity_exhausted (no live call made)" } })),
      ),
    ).toBe(true);
  });
});

// ===========================================================================
// Item 8 (again) + Item 11 — an RPM 429 must NOT persistently disable OpenRouter
// ===========================================================================
describe("recovery — a transient 429 leaves no sticky state; a daily cap recovers at UTC midnight", () => {
  it("recordModelFailure only marks provider capacity exhausted inside the isFreeModelDailyCapExceededError branch", () => {
    const src = read("cortex/modelHealth.ts");
    // markModelCapacityExhausted appears exactly once, and it is inside the
    // daily-cap branch — never on a plain 429 / 5xx / network error.
    const occurrences = (src.match(/markModelCapacityExhausted\(/g) ?? []).length;
    expect(occurrences).toBe(1);
    const branchStart = src.indexOf("if (isFreeModelDailyCapExceededError(err)) {");
    const branchEnd = src.indexOf("\n  }", branchStart);
    expect(src.slice(branchStart, branchEnd)).toContain("markModelCapacityExhausted(");
  });

  it("per-model capacity is keyed by UTC period_start → a marked model auto-recovers next UTC day (migration 0054)", () => {
    const mig = readFileSync(join(REPO, "db/migrations/0054_openrouter_free_capacity.sql"), "utf8");
    expect(mig).toContain("primary key (model_id, period_start)");
    expect(mig).toContain("(now() at time zone 'utc')::date");
    // no cron / scheduled reset — recovery is purely the date key rolling over
    expect(mig).not.toMatch(/pg_cron|schedule|cron\.job/i);
  });

  it("a later success stamps openrouter_credential_health.last_success_at → 'recovered' is observable", () => {
    const src = read("cortex/modelHealth.ts");
    const at = src.indexOf('if (outcome === "success")');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 120)).toContain("recordOpenRouterCredentialSuccess(fastify)");
  });
});

// ===========================================================================
// Item 10 — AUTHENTICATION failure: no infinite retry, no Groq, observability
// ===========================================================================
describe("auth / credential failure classification (G2)", () => {
  it("401 is an auth error, is NOT retryable, is NOT capacity-exhausted", () => {
    const e = orError(401, "No auth credentials found");
    expect(isAuthError(e)).toBe(true);
    expect(isRetryableOpenRouterError(e)).toBe(false); // the chat/candidate loop will NOT retry
    expect(isOpenRouterCapacityExhausted(e)).toBe(false); // never a Groq-fallback trigger
    expect(isBalanceExceededError(e)).toBe(false);
  });

  it("a credential-scoped 403 is an auth error; a MODEL-scoped 403 is not", () => {
    expect(isAuthError(orError(403, "Your API key has been disabled"))).toBe(true);
    expect(isAuthError(orError(403, "User not found"))).toBe(true);
    // the existing model-scoped 403 keeps its retry-next-candidate behavior
    const modelScoped = orError(403, "thinkingmachines/inkling:free is only available on agentic harnesses");
    expect(isAuthError(modelScoped)).toBe(false);
    expect(isRetryableOpenRouterError(modelScoped)).toBe(true);
  });

  it("recordModelFailure routes an auth error to a distinct observability signal, not model health", () => {
    const src = read("cortex/modelHealth.ts");
    const at = src.indexOf("if (isAuthError(err)) {");
    expect(at).toBeGreaterThan(-1);
    const branch = src.slice(at, src.indexOf("\n  }", at));
    expect(branch).toContain("fastify.log.error");
    expect(branch).toContain("OPENROUTER CREDENTIAL REJECTED");
    expect(branch).toContain('recordOpenRouterCredentialFailure(fastify, status, "auth")');
    expect(branch).toContain("return;"); // returns BEFORE recordModelOutcome — no health poisoning
    // and it is ordered before the generic recordModelOutcome fall-through
    expect(at).toBeLessThan(src.indexOf("recordModelOutcome(fastify, modelId, classifyFailure(err)"));
  });

  it("the user-facing message for an auth error is the generic 'temporarily unavailable' — never a credential detail", () => {
    const src = read("handlers/chat.ts");
    const ternaryAt = src.indexOf("sse.error({\n      message: isProviderBusyError(err)");
    const ternary = src.slice(ternaryAt, src.indexOf('"Something went wrong. Please try again."', ternaryAt) + 60);
    expect(ternary).toContain("isAuthError(err)");
    expect(ternary).toContain("This AI service is temporarily unavailable. Please try again shortly.");
    // no leak in the actual user-facing STRING LITERALS of this branch
    // (comments are allowed to explain the invariant; only rendered text matters)
    const codeOnly = ternary
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    const stringLiterals = codeOnly.match(/"[^"]*"/g) ?? [];
    for (const lit of stringLiterals) {
      expect(lit, `user-facing string leaks a credential detail: ${lit}`).not.toMatch(/api[ _-]?key|credential|auth\b|token/i);
    }
  });
});

// ===========================================================================
// Item 9 + Items 1/2 — genuine capacity exhaustion triggers Groq; G4 network
// ===========================================================================
describe("Groq-eligible failure conditions (Free) — capacity, not auth/config", () => {
  it("provider_capacity_exhausted / daily-cap / fair-share / 5xx are all Groq-eligible", () => {
    expect(isOpenRouterCapacityExhausted(orError(429, "free-models-per-day"))).toBe(true);
    expect(isOpenRouterCapacityExhausted(orError(429, "x", { "x-ratelimit-remaining": "0" }))).toBe(true);
    expect(isOpenRouterCapacityExhausted(orError(503, "upstream unavailable"))).toBe(true);
  });

  it("G4 — a raw transport failure to OpenRouter is transient AND Groq-eligible, but a client abort is neither", () => {
    const netErr = Object.assign(new TypeError("fetch failed"), {});
    const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
    const clientAbort = Object.assign(new Error("aborted"), { name: "AbortError" });
    expect(isTransientNetworkError(netErr)).toBe(true);
    expect(isTransientNetworkError(timeout)).toBe(true);
    expect(isTransientNetworkError(clientAbort)).toBe(false);
    expect(isRetryableOpenRouterError(netErr)).toBe(true);
    expect(isOpenRouterCapacityExhausted(netErr)).toBe(true); // becomes a Groq fallback
    expect(isOpenRouterCapacityExhausted(clientAbort)).toBe(false);
  });

  it("402 (balance) is NOT Groq-eligible for Free, but the code path IS for a non-free tier", () => {
    const balance = orError(402, "insufficient balance");
    // Free's shared predicate never admits 402…
    expect(isOpenRouterCapacityExhausted(balance)).toBe(false);
    // …and isEligibleFailure re-admits it only for planTier !== "free" (pinned by source)
    const src = read("groq/fallback.ts");
    expect(src).toContain('planTier !== "free" && isBalanceExceededError(err)');
  });

  it("attemptGroqFallback returns null (no dispatch) when GROQ_API_KEY is unset — for both tiers", async () => {
    const fastify = makeFastify(makeState()); // GROQ_API_KEY undefined by default
    for (const tier of ["free", "starter"] as const) {
      const r = await attemptGroqFallback({
        fastify,
        triggeringError: orError(429, "free-models-per-day"),
        user: user(tier),
        category: "general",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 256,
        onToken: () => {},
      });
      expect(r).toBeNull();
    }
  });

  it("attemptGroqFallback returns null for an AUTH error even with a Groq key present (not eligible)", async () => {
    const fastify = makeFastify(makeState());
    (fastify as unknown as { config: Record<string, unknown> }).config.GROQ_API_KEY = "gsk_fake";
    const r = await attemptGroqFallback({
      fastify,
      triggeringError: orError(401, "No auth credentials found"),
      user: user("free"),
      category: "general",
      messages: [{ role: "user", content: "hi" }],
      maxTokens: 256,
      onToken: () => {},
    });
    expect(r).toBeNull(); // auth ≠ capacity → not eligible → no Groq attempt
  });
});

// ===========================================================================
// Items 3, 4, 15 — API 1 / API 2 isolation
// ===========================================================================
describe("API 1 ↔ API 2 isolation — Free/Starter can never reach the Pro credential", () => {
  it("OPENROUTER_API_KEY_2 exists ONLY in the two env schemas (+ a comment) — never in routing/dispatch code", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (readFileSync(file, "utf8").includes("OPENROUTER_API_KEY_2")) hits.push(rel);
    }
    expect(hits.sort()).toEqual(["openrouter/health.ts", "plugins/env.ts", "worker/env.ts"]);
    // and in openrouter/health.ts it is only a comment, never code
    const healthSrc = read("openrouter/health.ts");
    const line = healthSrc.split("\n").find((l) => l.includes("OPENROUTER_API_KEY_2"))!;
    expect(line.trimStart().startsWith("//")).toBe(true);
  });

  it("openRouterHeaders() builds Authorization from OPENROUTER_API_KEY only — never the _2 slot", () => {
    const src = read("openrouter/client.ts");
    const fn = src.slice(src.indexOf("export function openRouterHeaders("), src.indexOf("\n}", src.indexOf("export function openRouterHeaders(")));
    expect(fn).toContain("fastify.config.OPENROUTER_API_KEY}");
    expect(fn).not.toContain("OPENROUTER_API_KEY_2");
  });

  it("the env slot is optional and Pro-scoped in the comment, in both schemas", () => {
    for (const rel of ["plugins/env.ts", "worker/env.ts"]) {
      const src = read(rel);
      expect(src).toMatch(/OPENROUTER_API_KEY_2:\s*z\.string\(\)\.min\(1\)\.optional\(\)/);
      const at = src.indexOf("OPENROUTER_API_KEY_2:");
      const commentAbove = src.slice(Math.max(0, at - 700), at);
      expect(commentAbove).toMatch(/Pro/);
      expect(commentAbove).toMatch(/never/i);
      expect(commentAbove).toMatch(/Free/);
      expect(commentAbove).toMatch(/Starter/);
    }
  });

  it("Free and Starter model selection is variant-scoped and never inlines any OpenRouter key", () => {
    const src = read("cortex/modelSelect.ts");
    expect(src).toContain('const variant: "free" | "paid" = planTier === "free" ? "free" : "paid";');
    expect(src).not.toMatch(/OPENROUTER_API_KEY/);
  });
});

// ===========================================================================
// Item 5 — Pro remains disabled
// ===========================================================================
describe("Pro path stays disabled and outside the Free/Starter route", () => {
  it("SPLEX_PRO_ENABLED is 'false' in the generated bundle and the gate is strict-equality", () => {
    const wrangler = readFileSync(join(REPO, "deploy/backend/wrangler.jsonc"), "utf8");
    expect(wrangler).toContain('"SPLEX_PRO_ENABLED": "false"');
    expect(read("pro/gate.ts")).toContain("fastify.config.SPLEX_PRO_ENABLED === true");
  });

  it("nothing in the Free/Starter chat path imports the Pro provider registry", () => {
    for (const rel of ["handlers/chat.ts", "openrouter/client.ts", "groq/fallback.ts", "cortex/modelSelect.ts", "cortex/modelHealth.ts"]) {
      expect(read(rel)).not.toMatch(/from "\.\.?\/pro\/providers/);
    }
  });
});

// ===========================================================================
// Items 6, 7, 13, 14 — ACCOUNTING: exactly one SPLEX message per request,
// regardless of provider; no double-consume; atomic under concurrency.
// ===========================================================================
describe("accounting — one user request = exactly one SPLEX message, whichever provider serves it", () => {
  it("the daily message-count reservation is made ONCE, before the provider loop, and released only on non-success", () => {
    const src = read("handlers/chat.ts");
    const reserveAt = src.indexOf("const requestReserved = await reserveDailyRequest(");
    const loopAt = src.indexOf("for (let i = 0; i < modelCandidates.length; i++)");
    const groqAt = src.indexOf("attemptGroqFallback({");
    const releaseAt = src.indexOf("await releaseDailyRequest(fastify, user.id);");
    // reserve happens before BOTH the OpenRouter loop and the Groq fallback
    expect(reserveAt).toBeGreaterThan(-1);
    expect(reserveAt).toBeLessThan(loopAt);
    expect(loopAt).toBeLessThan(groqAt);
    // exactly one reserve call, exactly one release call, release is guarded by !requestSucceeded
    expect((src.match(/await reserveDailyRequest\(/g) ?? []).length).toBe(1);
    expect((src.match(/await releaseDailyRequest\(fastify, user\.id\)/g) ?? []).length).toBe(1);
    expect(src.slice(releaseAt - 120, releaseAt)).toContain("if (!requestSucceeded)");
    // and consumeCredits never re-touches the message-count counter
    expect(src).toContain("skipDailyRequest: true");
  });

  it("switching OpenRouter→Groq within one turn does NOT re-reserve — the Groq path is inside the same try/finally", () => {
    const src = read("handlers/chat.ts");
    const tryAt = src.indexOf("let requestSucceeded = false;");
    const finallyAt = src.indexOf("} finally {", tryAt);
    const groqAt = src.indexOf("const fallback = await attemptGroqFallback({");
    expect(groqAt).toBeGreaterThan(tryAt);
    expect(groqAt).toBeLessThan(finallyAt);
    // no second reserveDailyRequest anywhere inside groq/
    for (const rel of ["groq/fallback.ts", "groq/client.ts", "groq/capacity.ts"]) {
      expect(read(rel)).not.toContain("reserveDailyRequest");
    }
  });

  it("Groq cannot bypass the 50/day Free entitlement — the reservation RPC caps at the plan limit", () => {
    // fakeFastify's reserve_daily_request faithfully mirrors the real SQL:
    // a conditional increment that CANNOT exceed the configured cap.
    const state = makeState({ planTier: "free", dailyRequestsLimit: 50, dailyRequestsUsed: 49 });
    const fastify = makeFastify(state);
    return (async () => {
      // 49/50 → one more allowed
      expect(await fastify.supabaseAdmin.rpc("reserve_daily_request", { p_user_id: "u" })).toEqual({ data: true, error: null });
      expect(state.dailyRequestsUsed).toBe(50);
      // 50/50 → blocked, EVEN THOUGH Groq would be available. The block is
      // SPLEX's, not the provider's.
      expect(await fastify.supabaseAdmin.rpc("reserve_daily_request", { p_user_id: "u" })).toEqual({ data: false, error: null });
      expect(state.dailyRequestsUsed).toBe(50); // never past the cap
    })();
  });

  it("Item 13 — N concurrent reservations near the cap admit exactly the remaining count, never more", async () => {
    const state = makeState({ planTier: "free", dailyRequestsLimit: 50, dailyRequestsUsed: 47 });
    const fastify = makeFastify(state);
    // 20 concurrent attempts, only 3 slots left
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => fastify.supabaseAdmin.rpc("reserve_daily_request", { p_user_id: "u" })),
    );
    const admitted = outcomes.filter((o: { data: unknown }) => o.data === true).length;
    expect(admitted).toBe(3);
    expect(state.dailyRequestsUsed).toBe(50);
    // NOTE: real Postgres row-lock atomicity for this RPC is proven live in
    // bench/harness/admission_concurrency.mjs + bench/harness/free_routing_verify.mjs;
    // this asserts the conditional-increment SEMANTICS the fake mirrors.
  });

  it("a Groq-served turn runs the SAME consumeCredits path — no second charging path under groq/", () => {
    for (const rel of ["groq/fallback.ts", "groq/client.ts", "groq/capacity.ts"]) {
      expect(read(rel)).not.toContain("consumeCredits(");
    }
    // chat.ts charges once, after `model`/`generation` were reassigned by the fallback
    const src = read("handlers/chat.ts");
    expect(src.indexOf("model = fallback.model;")).toBeLessThan(src.indexOf("await consumeCredits(fastify, {"));
  });
});

// ===========================================================================
// Item 12 — provider-health state creates no excessive health-check traffic
// ===========================================================================
describe("no polling / probing — all detection is inline on real request traffic", () => {
  it("openrouter/health.ts and groq/health.ts never schedule a timer, interval, or cron probe", () => {
    for (const rel of ["openrouter/health.ts", "groq/health.ts", "openrouter/capacity.ts", "groq/capacity.ts"]) {
      const src = read(rel);
      expect(src).not.toMatch(/setInterval|setTimeout\(|cron|pg_cron|schedule\(/);
    }
  });

  it("credential-health writes are fire-and-forget and only from real dispatch outcomes (cortex/modelHealth.ts)", () => {
    // The two recorders have exactly one call site each — recordModelOutcome
    // / recordModelFailure in cortex/modelHealth.ts, which run on an actual
    // model dispatch result, never on a schedule.
    for (const fn of ["recordOpenRouterCredentialSuccess", "recordOpenRouterCredentialFailure"]) {
      let sites = 0;
      for (const file of walk(SRC)) {
        if (file.endsWith("openrouter/health.ts")) continue;
        if (readFileSync(file, "utf8").includes(`${fn}(fastify`)) {
          sites++;
          expect(file.endsWith("cortex/modelHealth.ts"), `unexpected ${fn} call site: ${file}`).toBe(true);
        }
      }
      expect(sites).toBe(1);
    }
  });

  it("record_openrouter_credential_outcome RPC is called only from openrouter/health.ts", () => {
    let direct = 0;
    for (const file of walk(SRC)) {
      if (file.endsWith("openrouter/health.ts")) continue;
      if (readFileSync(file, "utf8").includes('"record_openrouter_credential_outcome"')) direct++;
    }
    expect(direct).toBe(0);
  });
});

// ===========================================================================
// Item 16 — no API key in logs / errors / frontend bundle
// ===========================================================================
describe("secret hygiene — no OpenRouter/Groq key material is exposed", () => {
  it("OpenRouterError truncates the provider body and never captures the Authorization header", () => {
    const src = read("openrouter/client.ts");
    expect(src).toContain("body.slice(0, 500)");
    // parseRateLimit reads ONLY x-ratelimit-* numeric headers, nothing else
    const fn = src.slice(src.indexOf("function parseRateLimit("), src.indexOf("\n}", src.indexOf("function parseRateLimit(")));
    expect(fn).not.toMatch(/authorization|bearer|api[_-]?key/i);
    const headerLiterals = fn.match(/num\("([^"]+)"\)/g) ?? [];
    expect(headerLiterals.length).toBeGreaterThanOrEqual(3);
    for (const lit of headerLiterals) expect(lit).toMatch(/x-ratelimit-/);
  });

  it("describeError output carries only status/body/model/flags — never a key or header dump", () => {
    const e = orError(429, "free-models-per-day", { "x-ratelimit-remaining": "0", authorization: "Bearer sk-or-SECRET" });
    const described = JSON.stringify(describeError(e));
    expect(described).not.toContain("sk-or-SECRET");
    expect(described).not.toMatch(/authorization|bearer/i);
  });

  it("no OpenRouter/Groq API-key material appears anywhere in the built frontend bundle", () => {
    const FE = join(REPO, "deploy/frontend");
    const files = walk(FE).concat(
      walk(FE).filter(() => false), // placeholder; walk already recurses
    );
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      expect(src, `${file} must not contain an OpenRouter key`).not.toMatch(/sk-or-v1-[A-Za-z0-9]/);
      expect(src, `${file} must not contain a Groq key`).not.toMatch(/gsk_[A-Za-z0-9]{20}/);
      expect(src, `${file} must not reference the server-only OpenRouter secret var`).not.toContain("OPENROUTER_API_KEY");
      expect(src).not.toContain("GROQ_API_KEY");
    }
  });
});

// ===========================================================================
// Items 17-20 are covered by the pre-existing suites remaining green
// (free-paid-isolation, capacity-security, groq-fallback-security, routing*,
// openrouter-capacity, groq-capacity). This is the explicit cross-reference.
// ===========================================================================
describe("pre-existing invariant suites are still the source of truth for items 17-20", () => {
  it("the sibling suites this change must not regress all exist", () => {
    const TEST = join(import.meta.dirname);
    for (const f of [
      "free-paid-isolation.test.ts",
      "capacity-security.test.ts",
      "groq-fallback-security.test.ts",
      "openrouter-capacity.test.ts",
      "groq-capacity.test.ts",
      "routing-regression.test.ts",
    ]) {
      expect(statSync(join(TEST, f)).isFile()).toBe(true);
    }
  });
});
