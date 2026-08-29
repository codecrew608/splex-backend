import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { selectModelCandidates } from "../src/cortex/modelSelect.js";
import { checkAndReserveCredits, settleDailyReservation } from "../src/credits/checkCredits.js";
import { consumeCredits } from "../src/credits/consumeCredits.js";
import {
  OpenRouterError, isRetryableOpenRouterError, isModelUnavailableError,
  isBalanceExceededError, describeError,
} from "../src/openrouter/client.js";
import { validateOwnedStoragePath } from "../src/files/storagePath.js";
import { isIntelligenceConfigured, IntelligenceNotConfiguredError } from "../src/intelligence/client.js";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";

const SRC = join(import.meta.dirname, "..", "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");

// Every failure a Free request can hit, simulated WITHOUT touching a
// provider. The bar for each is the same: fail closed, charge nothing that
// wasn't earned, never escalate to a paid model, never corrupt state.

/** A registry whose model_registry query can be made to fail or come back empty. */
function registryFastify(opts: { error?: unknown; rows?: unknown[] }) {
  const logs: Array<{ level: string; msg: string }> = [];
  return {
    config: { CREDITS_PER_USD: 20000 },
    log: {
      error: (_o: unknown, m?: string) => logs.push({ level: "error", msg: m ?? "" }),
      warn: (_o: unknown, m?: string) => logs.push({ level: "warn", msg: m ?? "" }),
      info: () => {}, debug: () => {},
    },
    supabaseAdmin: {
      rpc: async () => ({ data: null, error: null }),
      from: (_t: string) => {
        const api: Record<string, unknown> = {};
        const chain = () => api;
        Object.assign(api, {
          select: chain, eq: chain, in: chain, order: chain, limit: chain, lt: chain, lte: chain,
          single: async () => ({ data: null, error: opts.error ?? null }),
          maybeSingle: async () => ({ data: null, error: opts.error ?? null }),
          then: (res: (v: unknown) => unknown) =>
            res({ data: opts.error ? null : (opts.rows ?? []), error: opts.error ?? null }),
        });
        return api;
      },
    },
    _logs: logs,
  } as never;
}

// ---------------------------------------------------------------------------
// Provider status codes
// ---------------------------------------------------------------------------

describe("provider status codes are each classified correctly", () => {
  const cases: Array<[number, string, { retryable: boolean; deactivates: boolean; balance: boolean }]> = [
    [429, "Provider returned error", { retryable: true, deactivates: false, balance: false }],
    [403, "only available on agentic harnesses", { retryable: true, deactivates: false, balance: false }],
    [500, "internal server error", { retryable: true, deactivates: false, balance: false }],
    [502, "bad gateway", { retryable: true, deactivates: false, balance: false }],
    [503, "service unavailable", { retryable: true, deactivates: false, balance: false }],
    [404, "No endpoints found", { retryable: true, deactivates: true, balance: false }],
    [400, "bad request", { retryable: false, deactivates: false, balance: false }],
    [401, "unauthorized", { retryable: false, deactivates: false, balance: false }],
    [422, "unprocessable", { retryable: false, deactivates: false, balance: false }],
    [402, "insufficient credits", { retryable: false, deactivates: false, balance: true }],
  ];

  for (const [status, body, want] of cases) {
    it(`${status} -> retryable=${want.retryable} deactivates=${want.deactivates}`, () => {
      const e = new OpenRouterError("stream", status, body, "some/model:free");
      expect(isRetryableOpenRouterError(e), `${status} retryable`).toBe(want.retryable);
      expect(isModelUnavailableError(e), `${status} deactivates`).toBe(want.deactivates);
      expect(isBalanceExceededError(e), `${status} balance`).toBe(want.balance);
    });
  }

  it("402 is never retried — retrying a balance failure only spends more", () => {
    const e = new OpenRouterError("stream", 402, "insufficient credits", "m");
    expect(isRetryableOpenRouterError(e)).toBe(false);
  });

  it("every classification survives JSON serialisation (the err:{} bug)", () => {
    const e = new OpenRouterError("stream", 429, "Provider returned error", "z-ai/glm-5.2:free");
    const s = JSON.parse(JSON.stringify(describeError(e)));
    expect(s.status).toBe(429);
    expect(s.providerBody).toContain("Provider returned error");
    expect(s.model).toBe("z-ai/glm-5.2:free");
  });
});

// ---------------------------------------------------------------------------
// Registry failures
// ---------------------------------------------------------------------------

describe("model registry failures fail CLOSED, never to a paid model", () => {
  it("registry ERROR yields zero candidates (not a paid borrow)", async () => {
    const f = registryFastify({ error: { message: "connection reset" } });
    const got = await selectModelCandidates(f, "math", "free", "v1");
    expect(got).toEqual([]);
  });

  it("registry EMPTY yields zero candidates for a media category", async () => {
    // image/audio/video/ppt must not fall through to the general text pool.
    const f = registryFastify({ rows: [] });
    for (const cat of ["image", "audio", "video", "ppt"]) {
      expect(await selectModelCandidates(f, cat, "free", "v1"), cat).toEqual([]);
    }
  });

  it("a registry error during classification skips the call rather than spending", () => {
    // resolveClassifierModel returns null on error; callers must not then
    // reach for the configured PAID model.
    const src = read("cortex/classifierModel.ts");
    const errBranch = src.slice(src.indexOf("if (error || !data?.openrouter_model_id)"));
    expect(errBranch.slice(0, errBranch.indexOf("return null;")))
      .not.toContain("CORTEX_CLASSIFIER_MODEL_ID");
  });

  it("a paid row that somehow reaches the ranked list is dropped by the final guard", async () => {
    // Simulates the registry returning a mislabelled/paid row despite the
    // query filters — the last line of defence must still hold.
    const paidRow = {
      id: "p1", category: "math", openrouter_model_id: "openai/gpt-4o", variant: "paid",
      capability_score: 99, context_length: 128000, cost_per_million_input: 5,
      cost_per_million_output: 15, is_active: true, priority: 1,
    };
    const f = registryFastify({ rows: [paidRow] });
    const got = await selectModelCandidates(f, "math", "free", "v1");
    expect(got.map((m) => m.openrouter_model_id)).not.toContain("openai/gpt-4o");
    expect(got).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Credit failures
// ---------------------------------------------------------------------------

describe("credit RPC failures fail closed and charge nothing", () => {
  it("check_credits RPC error -> request refused, zero reserved", async () => {
    const f = {
      config: {}, log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
      supabaseAdmin: { rpc: async () => ({ data: null, error: { message: "db down" } }) },
    } as never;
    const r = await checkAndReserveCredits(f, "u1", 100);
    expect(r.allowed).toBe(false);
    expect(r.dailyReserved).toBe(0);
  });

  it("reserve_daily_credits RPC error -> refused, and nothing left reserved", async () => {
    const calls: string[] = [];
    const f = {
      config: {}, log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
      supabaseAdmin: {
        rpc: async (name: string) => {
          calls.push(name);
          if (name === "check_credits") return { data: true, error: null };
          return { data: null, error: { message: "reserve failed" } };
        },
      },
    } as never;
    const r = await checkAndReserveCredits(f, "u1", 100);
    expect(r.allowed).toBe(false);
    expect(r.dailyReserved).toBe(0);
    expect(calls).toContain("reserve_daily_credits");
  });

  it("settlement failure is logged, never thrown into the user's request", async () => {
    const logs: string[] = [];
    const f = {
      config: {},
      log: { error: (_o: unknown, m?: string) => logs.push(m ?? ""), warn: () => {}, info: () => {}, debug: () => {} },
      supabaseAdmin: { rpc: async () => ({ data: null, error: { message: "settle failed" } }) },
    } as never;
    await expect(settleDailyReservation(f, "u1", 100, 50)).resolves.toBeUndefined();
    expect(logs.join(" ")).toContain("settleDailyReservation");
  });

  it("settling an amount equal to the reservation is a no-op (no spurious RPC)", async () => {
    const calls: string[] = [];
    const f = {
      config: {}, log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
      supabaseAdmin: { rpc: async (n: string) => { calls.push(n); return { data: null, error: null }; } },
    } as never;
    await settleDailyReservation(f, "u1", 100, 100);
    expect(calls).toEqual([]);
  });

  it("a zero reservation never settles (guards the monthlyOnly path)", async () => {
    const calls: string[] = [];
    const f = {
      config: {}, log: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
      supabaseAdmin: { rpc: async (n: string) => { calls.push(n); return { data: null, error: null }; } },
    } as never;
    await settleDailyReservation(f, "u1", 0, 50);
    expect(calls).toEqual([]);
  });

  it("a persistent consume failure never throws — billing bookkeeping cannot fail a request", async () => {
    const state = makeState();
    const f = makeFastify(state);
    // Force every rpc to fail.
    (f as unknown as { supabaseAdmin: { rpc: unknown } }).supabaseAdmin.rpc =
      async () => ({ data: null, error: { message: "down" } });
    await expect(consumeCredits(f, {
      userId: "u1", creditCost: 10, intent: "chat", complexity: "simple",
      openrouterModelId: "m", realCostEstimate: 0, skipDaily: true,
    })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Storage / file failures
// ---------------------------------------------------------------------------

describe("malformed and hostile storage paths are refused before any privileged read", () => {
  // Real signature: validateOwnedStoragePath(userId, fileId, storagePath)
  // and the only legal shape is `${userId}/${fileId}/objectName`.
  const owner = "11111111-1111-4111-8111-111111111111";
  const other = "22222222-2222-4222-8222-222222222222";
  const fileId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const otherFile = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const hostile: Array<[string, string | null | undefined]> = [
    ["traversal", `${owner}/${fileId}/../../${other}/secret.pdf`],
    ["encoded traversal", `${owner}/${fileId}/%2e%2e/secret.pdf`],
    ["double-encoded traversal", `${owner}/${fileId}/%252e%252e/secret.pdf`],
    ["backslash separator", `${owner}\\${fileId}\\file.pdf`],
    ["absolute path", `/${owner}/${fileId}/file.pdf`],
    ["NUL byte", `${owner}/${fileId}/file\u0000.pdf`],
    ["another user's namespace", `${other}/${fileId}/file.pdf`],
    ["another file's folder", `${owner}/${otherFile}/file.pdf`],
    ["prefix confusion", `${owner}extra/${fileId}/file.pdf`],
    ["nested below the file folder", `${owner}/${fileId}/sub/file.pdf`],
    ["missing object name", `${owner}/${fileId}/`],
    ["empty", ""],
    ["null", null],
    ["undefined", undefined],
    ["bare dots", "../.."],
  ];

  for (const [label, path] of hostile) {
    it(`refuses ${label}`, () => {
      const r = validateOwnedStoragePath(owner, fileId, path);
      expect(r.ok, `${label} must be refused`).toBe(false);
      expect(r.reason, `${label} must say why`).toBeTruthy();
    });
  }

  it("accepts a genuine own-file path", () => {
    expect(validateOwnedStoragePath(owner, fileId, `${owner}/${fileId}/report.pdf`).ok).toBe(true);
  });

  it("a malformed percent-encoding is itself grounds to refuse", () => {
    const r = validateOwnedStoragePath(owner, fileId, `${owner}/${fileId}/%zz.pdf`);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("percent-encoding");
  });
});

// ---------------------------------------------------------------------------
// Intelligence sidecar
// ---------------------------------------------------------------------------

describe("intelligence sidecar absence degrades, never fabricates", () => {
  const fake = (url?: string) => ({ config: { INTELLIGENCE_SERVICE_URL: url } }) as never;

  it("detects an unconfigured sidecar", () => {
    expect(isIntelligenceConfigured(fake(undefined))).toBe(false);
    expect(isIntelligenceConfigured(fake(""))).toBe(false);
    expect(isIntelligenceConfigured(fake("https://intel.example.com"))).toBe(true);
  });

  it("throws a TYPED error rather than fetching 'undefined/ocr/image'", () => {
    const e = new IntelligenceNotConfiguredError("OCR");
    expect(e.name).toBe("IntelligenceNotConfiguredError");
    expect(e.message).toContain("INTELLIGENCE_SERVICE_URL unset");
  });

  it("retrieval returns null (skip) rather than erroring the whole chat", () => {
    expect(read("intelligence/retrieve.ts"))
      .toContain("if (!isIntelligenceConfigured(fastify)) return null;");
  });

  it("both sidecar entry points are guarded, and OCR is time-bounded", () => {
    const src = read("intelligence/client.ts");
    expect((src.match(/if \(!isIntelligenceConfigured\(fastify\)\) throw new IntelligenceNotConfiguredError/g) ?? []).length).toBe(2);
    expect(src).toContain("OCR_TIMEOUT_MS");
    expect(src).toContain("AbortSignal.timeout(OCR_TIMEOUT_MS)");
  });
});

// ---------------------------------------------------------------------------
// Upload limits
// ---------------------------------------------------------------------------

describe("oversized and malformed uploads are rejected server-side", () => {
  it("the size limit is enforced from measured bytes, not a client claim", () => {
    const src = read("handlers/files.ts");
    expect(src).toMatch(/byteLength|\.length/);
    expect(src).not.toMatch(/body\.(fileSize|size)\b/);
  });
});

// ---------------------------------------------------------------------------
// Cancellation / duplicate handling
// ---------------------------------------------------------------------------

describe("cancellation and duplicates cannot corrupt state or double-charge", () => {
  it("a cancelled workflow cannot be overwritten by a completing run", () => {
    const src = read("cortex/workflow/orchestrator.ts");
    expect(src).toContain("isRunCancelled");
    // every terminal write is conditional on still being 'running'
    expect((src.match(/\.eq\("status", "running"\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("a duplicate resume cannot double-execute (atomic claim)", () => {
    const src = read("cortex/workflow/orchestrator.ts");
    expect(src).toContain('.eq("status", "awaiting_clarification")');
    expect(src).toContain("if (!claimed)");
  });

  it("async media settlement is idempotent", () => {
    const src = read("handlers/media.ts");
    expect((src.match(/settleMediaReservation\(fastify, media\.id, 0\)/g) ?? []).length).toBe(4);
    expect(src).toContain("skipDaily: true");
  });
});
