import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const ROOT = join(SRC, "..", "..", "..");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const readRoot = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Worker background work is never a bare floating promise", () => {
  it("model health writes go through the runtime scheduler", () => {
    const src = read("cortex/modelHealth.ts");
    expect(src).toContain("function runBackground(");
    expect(src).toContain("fastify.scheduleBackground(scheduled)");
    // the pattern that silently lost every memory extraction must be gone
    expect(src).not.toContain("void fastify.supabaseAdmin");
  });

  it("model auto-deactivation uses it too", () => {
    const src = read("cortex/modelHealth.ts");
    const fn = src.slice(src.indexOf("function deactivateUnavailableModel"));
    expect(fn).toContain("runBackground(");
  });

  it("the scheduler is a PER-REQUEST copy, never a shared mutation", () => {
    // Mutating the shared ctx would hand one request's background work to
    // another request's (possibly finished) ExecutionContext.
    const src = read("worker/routes/chat.ts");
    expect(src).toContain("const requestCtx: WorkerCtx = { ...ctx, scheduleBackground:");
    expect(src).toContain("asFastifyInstance(requestCtx)");
  });

  it("is optional so the Node build is unaffected", () => {
    expect(read("worker/context.ts")).toContain("scheduleBackground?: (work: Promise<unknown>) => void;");
    expect(read("cortex/modelHealth.ts")).toContain("if (fastify.scheduleBackground)");
  });
});

describe("deep research is bounded", () => {
  it("has a whole-run deadline, not just per-call ceilings", () => {
    const src = read("research/deepResearch.ts");
    expect(src).toContain("DEEP_RESEARCH_RUN_BUDGET_MS");
    expect(src).toContain("const runDeadline = AbortSignal.timeout(DEEP_RESEARCH_RUN_BUDGET_MS)");
  });

  it("passes that deadline to EVERY stage", () => {
    const src = read("research/deepResearch.ts");
    const stages = (src.match(/await runStage\(/g) ?? []).length;
    const signalled = (src.match(/signal: runDeadline/g) ?? []).length;
    expect(stages).toBeGreaterThan(0);
    expect(signalled).toBe(stages);
  });

  it("completeOnce honours a caller signal alongside its own ceiling", () => {
    expect(read("openrouter/client.ts")).toContain("signal: withDeadline(opts.signal, COMPLETE_TIMEOUT_MS)");
  });
});

describe("a failed charge is durably recorded, not just logged", () => {
  it("writes to credit_charge_failures after retries are exhausted", () => {
    const src = read("credits/consumeCredits.ts");
    expect(src).toContain("recordChargeFailure(");
    expect(src).toContain('from("credit_charge_failures")');
  });

  it("distinguishes the monthly and daily pools", () => {
    const src = read("credits/consumeCredits.ts");
    expect(src).toContain('pool: "monthly"');
    expect(src).toContain('pool: "daily"');
  });

  it("does NOT auto-replay (that risks double-charging)", () => {
    const src = read("credits/consumeCredits.ts");
    expect(src).toMatch(/deliberately NOT an auto-retry/i);
  });

  it("escalates loudly if even the failure record cannot be written", () => {
    expect(read("credits/consumeCredits.ts")).toContain("CRITICAL: charge failed AND could not be recorded");
  });
});

describe("deployment bundle cannot silently diverge from source", () => {
  const ci = readRoot(".github/workflows/ci.yml");

  it("CI regenerates both bundles and fails on any difference", () => {
    expect(ci).toContain("bash scripts/bundle-backend.sh");
    expect(ci).toContain("bash scripts/bundle-frontend.sh");
    expect(ci).toContain("git diff --quiet -- deploy/");
    expect(ci).toContain("exit 1");
  });

  it("CI gates typechecks, tests and both builds", () => {
    for (const step of ["typecheck", "typecheck:worker", "test", "build"]) {
      expect(ci).toContain(step);
    }
    expect(ci).toContain("pnpm --filter @splex/web typecheck");
  });

  it("CI never injects a secret — only NEXT_PUBLIC placeholders", () => {
    expect(ci).not.toMatch(/SERVICE_ROLE|OPENROUTER_API_KEY|secrets\./);
    expect(ci).toContain("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });
});

describe("frontend resilience", () => {
  const web = (p: string) => readFileSync(join(SRC, "..", "..", "web", p), "utf8");

  it("has both a route-level and a root-level error boundary", () => {
    expect(web("app/error.tsx")).toContain('"use client"');
    expect(web("global-error.tsx".replace("global-error", "app/global-error"))).toContain("<html");
  });

  it("does not leak the raw error message to the user", () => {
    const err = web("app/error.tsx");
    expect(err).toContain("error.digest");
    expect(err).not.toContain("{error.message}");
  });

  it("entitlement polling pauses on a hidden tab", () => {
    expect(web("state/entitlementsStore.ts")).toContain('document.visibilityState === "visible"');
  });

  it("no non-public env var is read client-side", () => {
    for (const f of ["state/entitlementsStore.ts", "lib/backendUrl.ts", "components/chat/Composer.tsx"]) {
      const src = web(f);
      const envReads = src.match(/process\.env\.[A-Z_]+/g) ?? [];
      for (const r of envReads) expect(r).toMatch(/^process\.env\.NEXT_PUBLIC_/);
    }
  });
});
