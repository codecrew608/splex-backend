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

describe("final hardening pass", () => {
  it("signed URLs are short-lived, not year-long bearer capabilities", () => {
    const src = read("handlers/media.ts");
    expect(src).toContain("const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;");
    expect(src).not.toContain("60 * 60 * 24 * 365");
  });

  it("the Worker's top-level catch logs structured fields, and only the PATH", () => {
    const src = read("worker/index.ts");
    expect(src).toContain("...describeError(err)");
    // full URL would carry query strings into logs
    expect(src).toContain("path: new URL(request.url).pathname");
    expect(src).not.toContain("{ err, url: request.url }");
  });

  it("rate limiting is a single atomic upsert (migration 0030)", () => {
    const mig = readFileSync(join(ROOT, "db/migrations/0030_atomic_rate_limit_and_bucket_cleanup.sql"), "utf8");
    // Strip comments before asserting: the migration deliberately QUOTES the
    // old racy statement in its header to explain what it replaces, and a
    // naive match would flag that documentation as the defect.
    const sql = mig.replace(/^\s*--.*$/gm, "");
    expect(sql).not.toMatch(/select window_start, count into/);
    expect(mig).toContain("on conflict (user_id, route_name) do update");
    expect(mig).toContain("returning count into v_count");
    expect(mig).toContain("return v_count <= p_max;");
    // still service-role only
    expect(mig).toContain("grant execute on function public.check_and_increment_rate_limit");
    expect(mig).toMatch(/revoke execute on function public\.check_and_increment_rate_limit\([^)]*\) from public, anon, authenticated/);
  });

  it("entitlement polling skips ticks it cannot serve", () => {
    const src = readFileSync(join(SRC, "..", "..", "web", "state", "entitlementsStore.ts"), "utf8");
    expect(src).toContain('document.visibilityState === "visible" && navigator.onLine !== false');
    expect(src).toContain('addEventListener("online", load)');
  });

  it("the toolchain is pinned in exactly one place each", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(readFileSync(join(ROOT, ".nvmrc"), "utf8").trim()).toBe("22");
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).toContain("node-version-file: .nvmrc");
    // CI must not restate a pnpm version that could drift from packageManager
    expect(ci).not.toMatch(/pnpm\/action-setup@v4\s*\n\s*with:\s*\n\s*version:/);
  });

  it("both bundle scripts pin npm for lockfile determinism", () => {
    for (const f of ["scripts/bundle-backend.sh", "scripts/bundle-frontend.sh"]) {
      const src = readFileSync(join(ROOT, f), "utf8");
      expect(src).toMatch(/NPM_PIN="npm@\d+\.\d+\.\d+"/);
      expect(src).toContain('npx --yes "$NPM_PIN" install');
    }
  });

  it("deployment knowledge is documented, not tribal", () => {
    const doc = readFileSync(join(ROOT, "DEPLOYMENT.md"), "utf8");
    for (const section of ["Root Directory", "wrangler secret put", "Rotation", "Deploy order", "prune_stale_rate_limit_buckets"]) {
      expect(doc).toContain(section);
    }
    // must not contain an actual secret value
    expect(doc).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}\./);
    expect(doc).not.toMatch(/sk-[A-Za-z0-9-]{20,}/);
  });
});
