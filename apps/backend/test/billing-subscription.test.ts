import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSubscription } from "../src/handlers/billing.js";

// Small dedicated fake, same idiom as test/razorpay.test.ts — this handler
// touches subscriptions (a plain select + the claim_subscription_slot RPC)
// and Razorpay's REST API (mocked via global fetch), neither of which
// test/helpers/fakeFastify.ts models.

const PLAN_ID = "plan_TYEBWcXvja8WRM";
const KEY_ID = "rzp_test_key_id";
const KEY_SECRET = "test_key_secret";

interface SubRow {
  user_id: string;
  razorpay_subscription_id: string | null;
  razorpay_plan_id: string | null;
  status: string;
}

interface FakeDb {
  subscriptions: Map<string, SubRow>;
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
}

function makeDb(seed: Record<string, string> = {}): FakeDb {
  const subscriptions = new Map<string, SubRow>();
  for (const [userId, status] of Object.entries(seed)) {
    subscriptions.set(userId, { user_id: userId, razorpay_subscription_id: "sub_old", razorpay_plan_id: PLAN_ID, status });
  }
  return { subscriptions, rpcCalls: [] };
}

const TERMINAL = new Set(["cancelled", "completed", "expired", "halted"]);

// Faithful to the real migration 0048 function's semantics: insert if
// absent, reclaim if the existing row is terminal, otherwise refuse
// (return null) — see that file for the actual atomicity argument (a
// synchronous fake can't independently prove concurrent-request safety;
// this only proves the handler correctly respects whatever the RPC signals).
function claimSlot(db: FakeDb, p_user_id: string, p_razorpay_subscription_id: string, p_razorpay_plan_id: string): string | null {
  const existing = db.subscriptions.get(p_user_id);
  if (!existing || TERMINAL.has(existing.status)) {
    db.subscriptions.set(p_user_id, {
      user_id: p_user_id,
      razorpay_subscription_id: p_razorpay_subscription_id,
      razorpay_plan_id: p_razorpay_plan_id,
      status: "created",
    });
    return "created";
  }
  return null;
}

function makeFakeFastify(db: FakeDb, opts: { forceRpcNull?: boolean; keyId?: string | undefined; keySecret?: string | undefined } = {}) {
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  const supabaseAdmin = {
    from(table: string) {
      if (table !== "subscriptions") throw new Error(`unexpected table: ${table}`);
      const api: Record<string, unknown> = {};
      let eqVal = "";
      Object.assign(api, {
        select: () => api,
        eq: (_col: string, val: string) => {
          eqVal = val;
          return api;
        },
        maybeSingle: () => ({
          then: (resolve: (v: unknown) => unknown) => {
            const row = db.subscriptions.get(eqVal);
            return resolve({ data: row ? { status: row.status } : null, error: null });
          },
        }),
      });
      return api;
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      db.rpcCalls.push({ name, params });
      if (name !== "claim_subscription_slot") throw new Error(`unexpected rpc: ${name}`);
      if (opts.forceRpcNull) return { data: null, error: null };
      const claimed = claimSlot(
        db,
        params.p_user_id as string,
        params.p_razorpay_subscription_id as string,
        params.p_razorpay_plan_id as string,
      );
      return { data: claimed, error: null };
    },
  };

  return {
    supabaseAdmin,
    log,
    config: {
      RAZORPAY_STARTER_PLAN_ID: PLAN_ID,
      RAZORPAY_KEY_ID: "keyId" in opts ? opts.keyId : KEY_ID,
      RAZORPAY_KEY_SECRET: "keySecret" in opts ? opts.keySecret : KEY_SECRET,
    },
  } as never;
}

function mockFetchOnce(response: { ok: boolean; status?: number; body: unknown }) {
  const fn = vi.fn(async () => ({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 400),
    json: async () => response.body,
  }));
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSubscription — happy path", () => {
  it("creates a subscription for a user with no prior row", async () => {
    const db = makeDb();
    const fetchMock = mockFetchOnce({ ok: true, body: { id: "sub_new123", status: "created" } });
    const fastify = makeFakeFastify(db);

    const result = await createSubscription(fastify, "u1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toEqual({ subscriptionId: "sub_new123", keyId: KEY_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.subscriptions.get("u1")?.status).toBe("created");
    expect(db.subscriptions.get("u1")?.razorpay_subscription_id).toBe("sub_new123");
  });

  it("always sends the server-configured plan id, never anything client-influenced", async () => {
    const db = makeDb();
    const fetchMock = mockFetchOnce({ ok: true, body: { id: "sub_x", status: "created" } });
    await createSubscription(makeFakeFastify(db), "u1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.plan_id).toBe(PLAN_ID);
    expect(sentBody.notes).toEqual({ splex_user_id: "u1" });
    expect(String(init.headers && (init.headers as Record<string, string>)["Authorization"])).toMatch(/^Basic /);
  });

  it("allows a previously-cancelled user to resubscribe", async () => {
    const db = makeDb({ u1: "cancelled" });
    mockFetchOnce({ ok: true, body: { id: "sub_resub", status: "created" } });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(true);
    expect(db.subscriptions.get("u1")?.razorpay_subscription_id).toBe("sub_resub");
  });
});

describe("createSubscription — duplicate protection", () => {
  it.each(["created", "authenticated", "active", "pending"])("refuses when the existing subscription is %s, without calling Razorpay", async (status) => {
    const db = makeDb({ u1: status });
    const fetchMock = mockFetchOnce({ ok: true, body: { id: "should_not_be_used", status: "created" } });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still refuses if the atomic claim itself is lost (race the pre-check alone can't catch)", async () => {
    const db = makeDb(); // pre-check sees nothing
    mockFetchOnce({ ok: true, body: { id: "sub_raced", status: "created" } });
    const fastify = makeFakeFastify(db, { forceRpcNull: true }); // but the RPC refuses anyway

    const result = await createSubscription(fastify, "u1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });
});

describe("createSubscription — Razorpay API failure", () => {
  it("does not attempt a local claim when Razorpay rejects the request", async () => {
    const db = makeDb();
    mockFetchOnce({ ok: false, status: 400, body: { error: { description: "plan not found" } } });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(false);
    expect(db.rpcCalls.length).toBe(0);
    expect(db.subscriptions.has("u1")).toBe(false);
  });

  it("fails closed without calling fetch at all when Razorpay credentials aren't configured", async () => {
    const db = makeDb();
    const fetchMock = mockFetchOnce({ ok: true, body: { id: "unused", status: "created" } });
    const fastify = makeFakeFastify(db, { keyId: undefined, keySecret: undefined });

    const result = await createSubscription(fastify, "u1");

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when only one of KEY_ID/KEY_SECRET is configured", async () => {
    const db = makeDb();
    const fetchMock = mockFetchOnce({ ok: true, body: { id: "unused", status: "created" } });
    const fastify = makeFakeFastify(db, { keyId: undefined, keySecret: KEY_SECRET });

    const result = await createSubscription(fastify, "u1");

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
