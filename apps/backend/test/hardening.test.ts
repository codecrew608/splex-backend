import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

// These assert on SOURCE rather than behaviour on purpose: each one guards a
// property that is invisible at runtime in a unit test (a static import that
// only crashes inside a Cloudflare isolate; a timeout that only manifests
// against a hung upstream; a double-charge that only shows up in aggregate
// production data). Cheap, and each maps to a defect that actually shipped.

describe("upstream call deadlines", () => {
  const client = read("openrouter/client.ts");

  it("streamCompletion combines the caller signal with a deadline", () => {
    expect(client).toContain("signal: withDeadline(signal, STREAM_TIMEOUT_MS)");
  });

  it("completeOnce has a deadline on BOTH fetches (incl. the reasoning retry)", () => {
    // Now also honours a caller-supplied signal — deep research passes its
    // whole-run budget so a multi-stage run cannot outlive it one 60s call
    // at a time. Whichever fires first wins.
    const hits = client.match(/withDeadline\(opts\.signal, COMPLETE_TIMEOUT_MS\)/g) ?? [];
    // The classifier runs on the critical path of every ambiguous message —
    // previously it had no timeout AND no signal at all.
    expect(hits.length).toBe(2);
  });

  it("no OpenRouter fetch is left without a signal", () => {
    const fetches = client.match(/await fetch\(`\$\{fastify\.config\.OPENROUTER_BASE_URL\}[\s\S]*?\}\);/g) ?? [];
    expect(fetches.length).toBeGreaterThan(0);
    for (const f of fetches) expect(f).toMatch(/signal:/);
  });
});

describe("Worker isolate safety", () => {
  it("no module reachable from the Worker statically imports pdf-parse", () => {
    // pdf-parse's PDF.js engine touches DOMMatrix at module-evaluation time
    // and crashes the isolate at BOOT — not at call time, so a dynamic
    // import would not save it. It must live only in the Node adapter.
    for (const f of ["handlers/files.ts", "worker/routes/files.ts", "handlers/chat.ts", "handlers/media.ts"]) {
      expect(read(f)).not.toMatch(/^\s*import .*["']pdf-parse["']/m);
    }
    expect(read("routes/files.ts")).toMatch(/import .*["']pdf-parse["']/);
  });

  it("Worker memory extraction uses waitUntil, not a floating promise", () => {
    // A bare `void fn()` let the runtime tear the isolate down mid-call,
    // which is why every user_memory row in production was empty.
    const worker = read("worker/routes/chat.ts");
    expect(worker).toContain("execCtx.waitUntil(");
    expect(read("handlers/chat.ts")).toContain("scheduleBackground(extractAndUpdateMemory");
  });
});

describe("credit charging invariants (source-level)", () => {
  it("every reserving call site skips the daily charge", () => {
    // reserve + consume + settle all move the daily counter; running all
    // three double-charged it (production showed an exact 2.00 ratio).
    for (const f of [
      "handlers/chat.ts",
      "cortex/workflow/orchestrator.ts",
      "routes/mediaGeneration.ts",
      "research/handler.ts",
      "handlers/media.ts",
      "research/deepResearch.ts",
    ]) {
      const src = read(f);
      const consumes = (src.match(/await consumeCredits\(/g) ?? []).length;
      const skips = (src.match(/skipDaily: true/g) ?? []).length;
      expect(skips, `${f}: every consumeCredits must skipDaily`).toBe(consumes);
    }
  });

  it("deepResearch DOES take an atomic daily reservation, sized as a normal per-request estimate, and settles it exactly once", () => {
    // FINDING (adversarial production-readiness audit, fixed same pass):
    // deepResearch previously had NO atomic backstop at all — only a
    // read-only monthlyOnly ceiling check (checkCredits) and a read-only
    // capability-count check (checkMediaQuota), both plain SELECTs with no
    // reservation. Concurrent requests could all read the same pre-charge
    // snapshot and all be admitted, each running up to 5 real provider
    // calls over up to an 8-minute budget with nothing enforcing the 3/day
    // cap or the daily credit pool in real time — a genuine unbounded-ish
    // provider-cost multiplier. Fixed by giving it the same
    // checkAndReserveCredits/settleDailyReservation shape every other
    // capability already uses.
    const src = read("research/deepResearch.ts");
    // Still checks the large, monthly-sized worst-case ceiling (unchanged,
    // guards a different thing: "can this account's whole month even
    // afford one worst-case run").
    expect(src).toContain("monthlyOnly");
    // AND now also atomically reserves a normal, daily-pool-sized estimate
    // before any provider call, and trues it up exactly once at the end.
    expect(src).toContain("checkAndReserveCredits(fastify, user.id, gateEstimate)");
    expect(src).toContain("resolveCreditGateEstimate(fastify, RESEARCH_COMPLEXITY, user.planTier)");
    expect((src.match(/settleDailyReservation\(fastify, user\.id, gate\.dailyReserved,/g) ?? []).length).toBe(2); // 0 on early bail-out, totalCreditsCharged in the finally
  });

  it("deepResearch creates its generated_media row BEFORE running any stage, closing the capability-count race", () => {
    // Companion fix to the reservation above: checkMediaQuota's 3/day count
    // only sees rows that already exist. Recording the row only at
    // completion (the previous behavior) meant N concurrent runs could all
    // see zero existing rows and all pass. Creating it status='processing'
    // up front — before stage 1 — means concurrent runs now count against
    // each other immediately, same fix as the video path's queued-row
    // pattern (checkConcurrentMediaLimit's own doc comment).
    const src = read("research/deepResearch.ts");
    const reserveIdx = src.indexOf("checkAndReserveCredits(fastify, user.id, gateEstimate)");
    const recordIdx = src.indexOf('recordMediaGeneration(fastify, { userId: user.id, messageId: null, kind: "deep_research", status: "processing"');
    const stage1Idx = src.indexOf('sse.researchStage({ stage: "planning" });');
    expect(reserveIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(reserveIdx);
    expect(stage1Idx).toBeGreaterThan(recordIdx);
    // The two completion sites and the failure site update that SAME row
    // rather than inserting a fresh one at the end.
    expect((src.match(/updateGeneratedMediaStatus\(fastify, mediaId,/g) ?? []).length).toBe(3);
  });

  it("async video releases its reservation on every failure path", () => {
    const media = read("handlers/media.ts");
    // terminal-failed, poll-failed, missing-content-url, download-failed
    expect((media.match(/settleMediaReservation\(fastify, media\.id, 0\)/g) ?? []).length).toBe(4);
    // and settles to the real charge exactly once on success
    expect(media).toContain("settleMediaReservation(fastify, media.id, creditsCharged)");
  });

  it("the submit path reserves atomically rather than reading credits", () => {
    const gen = read("routes/mediaGeneration.ts");
    expect(gen).toContain("reserveMediaCredits(fastify, mediaId, gateEstimate)");
    // the old read-only gate must be gone from the async path
    expect(gen).not.toMatch(/const creditsAllowed = await checkCredits\(/);
  });

  it("editing/regenerating always cancels an in-flight workflow; a bare resume only stashes it", () => {
    // Pins the exact branch workflow.test.ts's scenario-2 cases hand-reproduce
    // (there's no exported unit to import chat.ts's inline decision — see
    // that file's own comment) — so a refactor here can't silently drift
    // out of sync with what those runtime tests actually proved.
    const chat = read("handlers/chat.ts");
    expect(chat).toContain('if (body.regenerateMessageId || active.status !== "awaiting_clarification") {');
    expect(chat).toContain("await cancelActiveWorkflow(fastify, conversationId);");
    expect(chat).toContain("resumableWorkflow = active;");
  });
});

describe("file upload limits are enforced server-side", () => {
  it("measures the downloaded bytes, not the client-supplied size_bytes", () => {
    const src = read("handlers/files.ts");
    expect(src).toContain("buffer.byteLength > sizeLimit");
    // size_bytes is owner-writable via files_owner_all, so it cannot be the
    // basis of the check — only logged for comparison.
    expect(src).toMatch(/claimedBytes: file\.size_bytes/);
  });

  it("rejects with 413 and marks the row failed", () => {
    const src = read("handlers/files.ts");
    expect(src).toMatch(/return fail\(`File exceeds your plan's \$\{formatBytes\(sizeLimit\)\} limit\.`, 413\)/);
  });

  it("falls back to the FREE limit for an unknown tier (fail closed)", () => {
    const src = read("handlers/files.ts");
    expect(src).toContain("FILE_SIZE_LIMITS[planTier] ?? FILE_SIZE_LIMITS.free");
  });
});
