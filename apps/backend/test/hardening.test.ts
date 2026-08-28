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
    for (const f of ["handlers/chat.ts", "cortex/workflow/orchestrator.ts", "routes/mediaGeneration.ts", "research/handler.ts", "handlers/media.ts"]) {
      const src = read(f);
      const consumes = (src.match(/await consumeCredits\(/g) ?? []).length;
      const skips = (src.match(/skipDaily: true/g) ?? []).length;
      expect(skips, `${f}: every consumeCredits must skipDaily`).toBe(consumes);
    }
  });

  it("deepResearch does NOT skip daily — it takes no daily reservation", () => {
    const src = read("research/deepResearch.ts");
    expect(src).not.toContain("skipDaily");
    expect(src).toContain("monthlyOnly");
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
