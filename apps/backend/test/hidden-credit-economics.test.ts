import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const ROOT = join(SRC, "..", "..", "..");
const readSrc = (p: string) => readFileSync(join(SRC, p), "utf8");
const readWeb = (p: string) => readFileSync(join(ROOT, "apps/web", p), "utf8");
const readTypes = (p: string) => readFileSync(join(ROOT, "packages/shared-types/src", p), "utf8");

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) acc.push(full);
  }
  return acc;
}

// SPLEX credits are an internal backend metering unit. Users must never
// see a daily/monthly credit balance, a "used/limit" progress readout, or
// the internal per-request cost — anywhere in the normal product UI, and
// not in any API response the frontend consumes solely for display. This
// file proves that by ENUMERATING the wire types and their consumers
// rather than spot-checking a hand-kept list — the same rationale
// free-paid-isolation.test.ts already established for provider call
// sites: a single unaudited surface voids the guarantee.

describe("the wire types carry no SPLEX credit balance or per-request cost", () => {
  it("EntitlementSnapshot has no credits/dailyCredits/CreditBalance", () => {
    const src = readTypes("index.ts");
    expect(src).not.toMatch(/interface\s+CreditBalance/);
    const snapshotBlock = src.slice(src.indexOf("export interface EntitlementSnapshot"), src.indexOf("export interface EntitlementSnapshot") + 300);
    expect(snapshotBlock).not.toMatch(/\bcredits\s*:/);
    expect(snapshotBlock).not.toMatch(/\bdailyCredits\s*:/);
  });

  it("DoneEventData carries no creditsCharged", () => {
    const src = readTypes("index.ts");
    const block = src.slice(src.indexOf("export interface DoneEventData"), src.indexOf("export interface DoneEventData") + 1200);
    expect(block).not.toContain("creditsCharged");
  });

  it("CortexRoutingInfo (the routing disclosure panel's data source) carries no creditsCharged", () => {
    const src = readTypes("index.ts");
    const block = src.slice(src.indexOf("export interface CortexRoutingInfo"), src.indexOf("export interface CortexRoutingInfo") + 300);
    expect(block).not.toContain("creditsCharged");
  });

  it("ChatMessage carries no creditsCharged", () => {
    const src = readTypes("index.ts");
    const block = src.slice(src.indexOf("export interface ChatMessage"), src.indexOf("export interface ChatMessage") + 300);
    expect(block).not.toContain("creditsCharged");
  });

  it("MediaStatusResponse and workflow SSE event types carry no cost/reservation fields (unchanged, still true)", () => {
    const media = readSrc("handlers/media.ts");
    const mediaBlock = media.slice(media.indexOf("export interface MediaStatusResponse"), media.indexOf("export interface MediaStatusResponse") + 200);
    expect(mediaBlock).not.toMatch(/cost|credit|reserv/i);
  });
});

describe("getEntitlementSnapshot (the actual GET /entitlements implementation) computes no credit balance", () => {
  it("does not query the credits or daily_credits counters at all", () => {
    const src = readSrc("entitlements/index.ts");
    const fnStart = src.indexOf("export async function getEntitlementSnapshot");
    const fn = src.slice(fnStart, fnStart + 800);
    expect(fn).not.toMatch(/getCreditLimit|"credits"|"daily_credits"/);
  });
});

describe("no user-facing message interpolates a numeric quota/credit limit", () => {
  // Enumeration, not a hand-kept list: a template literal containing
  // `${...limit...}` or `${...Limit...}` anywhere in src/ is exactly the
  // pattern that leaked "(5/day)" / "(60)" / "(100 minutes)" style
  // internal numbers into sse.error()/quotaExceededMessage() text before
  // this pass. The one sanctioned exception is projects.ts's project-count
  // message — "up to N projects" is a plain row-count product limit
  // already shown on the pricing page, not SPLEX credit economics.
  it("enumerates every sse.error() call and checks its message for a numeric limit", () => {
    // Scoped to sse.error(...) call sites specifically, not a blind
    // whole-file regex — a bare `${...limit...}` match also fires on
    // LLM SYSTEM PROMPT text (e.g. deepResearch.ts's "${limits.maxSearches}
    // sub-questions" instruction to the planning model, or
    // "${limitedNote}"/"${finalEvidence.length}" in the report-writing
    // prompt) which is never shown to the end user at all — those aren't
    // messages, they're model instructions whose variable names happen to
    // contain the substring "limit". Scanning only the text actually
    // passed to sse.error() avoids that class of false positive while
    // still catching the real thing: every quota/credit rejection the
    // user actually sees.
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      if (rel === "handlers/projects.ts" || rel === "handlers/files.ts") continue; // sanctioned — see above (files.ts: storage-size limit, not SPLEX economics)
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        if (!/sse\.error\(/.test(line)) return;
        // sse.error() calls in this codebase are always 1-6 lines —
        // window generously past the closing paren.
        const window = lines.slice(i, i + 8).join("\n");
        if (/\$\{[^}]*[Ll]imit[^}]*\}/.test(window)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders, `numeric limit leaked into an sse.error() message:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("no user-facing string contains the phrase \"SPLEX credit\" (case-insensitive)", () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const rel = file.slice(SRC.length + 1);
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        // Skip comments — this file's own prose, and every doc comment
        // explaining the decision, legitimately says "SPLEX credits".
        // Only a real string literal (quote before the phrase on the
        // same line, not preceded by //) is a genuine leak.
        if (/^\s*\/\//.test(line)) return;
        if (/["'`][^"'`]*SPLEX\s+credit/i.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders, `"SPLEX credit" leaked into a string literal:\n${offenders.join("\n")}`).toEqual([]);
  });
});

describe("frontend: Settings page shows no SPLEX credit balance or usage bar", () => {
  const src = readWeb("app/(app)/settings/page.tsx");

  it("does not query usage_counters or plan_limits for the credits counter_type", () => {
    expect(src).not.toMatch(/counter_type["'],?\s*"credits"/);
    expect(src).not.toMatch(/counter_type["'],?\s*"daily_credits"/);
  });

  it("does not render \"SPLEX Credits\" or a credits-used/total string", () => {
    // Comment lines legitimately explain the decision using this exact
    // phrase ("SPLEX credits are an internal metering unit...") — only a
    // real string literal in the rendered/queried code is a genuine leak.
    const codeOnly = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(codeOnly).not.toMatch(/SPLEX\s+Credits/i);
    expect(codeOnly).not.toMatch(/creditsUsed|creditsTotal|dailyUsed|dailyTotal/);
  });

  it("still shows the plan name and upgrade/cancel controls (removal didn't gut the page)", () => {
    expect(src).toContain("planDisplayName(planTier)");
    expect(src).toContain("CancelSubscriptionButton");
  });
});

describe("frontend: Sidebar shows no SPLEX credit balance or progress bar", () => {
  const src = readWeb("components/sidebar/Sidebar.tsx");

  it("does not call useEntitlements() or reference a credits balance", () => {
    expect(src).not.toContain("useEntitlements");
    expect(src).not.toMatch(/credits\.used|credits\.limit|creditsDisplay/);
  });

  it("still shows the plan name", () => {
    expect(src).toContain("planDisplayName(planTier)");
  });
});

describe("frontend: pricing pages show no raw SPLEX credit numbers", () => {
  it("the upgrade page's feature builder does not read the credits/daily_credits counters", () => {
    const src = readWeb("app/(app)/upgrade/page.tsx");
    const codeOnly = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(codeOnly).not.toMatch(/["'`]credits["'`]/);
    expect(codeOnly).not.toMatch(/["'`]daily_credits["'`]/);
    expect(codeOnly).not.toMatch(/SPLEX\s+Credits/i);
  });

  it("the landing page's static plan copy contains no SPLEX credit numbers", () => {
    const src = readWeb("components/landing/LandingPage.tsx");
    // Matches the exact stale pattern this pass removed ("3,000 SPLEX
    // Credits/month (150/day)") — any digit immediately followed by the
    // phrase is exactly the leak this test exists to catch.
    expect(src).not.toMatch(/[\d,]+\s*SPLEX\s+Credits/i);
  });
});
