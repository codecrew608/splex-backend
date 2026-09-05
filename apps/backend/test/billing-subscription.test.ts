import { describe, it, expect, vi, afterEach } from "vitest";
import { createSubscription } from "../src/handlers/billing.js";

// Small dedicated fake, same idiom as test/razorpay.test.ts — this handler
// touches subscriptions (a select pre-check, the claim_subscription_slot
// RPC, and a later update) and Razorpay's REST API (mocked via global
// fetch), neither of which test/helpers/fakeFastify.ts models.

const PLAN_ID = "plan_TYEBWcXvja8WRM";
const KEY_ID = "rzp_test_key_id";
const KEY_SECRET = "test_key_secret";

interface SubRow {
  user_id: string;
  razorpay_subscription_id: string | null;
  razorpay_plan_id: string | null;
  status: string;
  updated_at: number; // epoch ms — simpler to control precisely in tests than ISO strings
}

interface FakeDb {
  subscriptions: Map<string, SubRow>;
  rpcCalls: Array<{ name: string; params: Record<string, unknown>; seq: number }>;
  fetchCalls: Array<{ seq: number }>;
  seq: number;
}

function makeDb(): FakeDb {
  return { subscriptions: new Map(), rpcCalls: [], fetchCalls: [], seq: 0 };
}

function seedRow(db: FakeDb, userId: string, overrides: Partial<SubRow>): void {
  db.subscriptions.set(userId, {
    user_id: userId,
    razorpay_subscription_id: "sub_old",
    razorpay_plan_id: PLAN_ID,
    status: "created",
    updated_at: Date.now(),
    ...overrides,
  });
}

const TERMINAL = new Set(["cancelled", "completed", "expired", "halted"]);
const TWO_MIN_MS = 2 * 60 * 1000;
const THIRTY_MIN_MS = 30 * 60 * 1000;

// Faithful to migration 0049's actual WHERE clause — see that file for the
// concurrency argument for each condition (in particular why a null id is
// NOT immediately reclaimable). A synchronous fake can't independently
// prove Postgres's own atomicity, but the ordering test below exercises
// the same interleaving this function's design has to be safe against.
function claimSlot(db: FakeDb, userId: string, now: number): boolean {
  const existing = db.subscriptions.get(userId);
  if (!existing) {
    seedRow(db, userId, { razorpay_subscription_id: null, razorpay_plan_id: null, status: "created", updated_at: now });
    return true;
  }
  const reclaimable =
    TERMINAL.has(existing.status) ||
    (existing.status === "created" && existing.razorpay_subscription_id === null && existing.updated_at < now - TWO_MIN_MS) ||
    (existing.status === "created" && existing.razorpay_subscription_id !== null && existing.updated_at < now - THIRTY_MIN_MS);
  if (!reclaimable) return false;
  Object.assign(existing, { status: "created", razorpay_subscription_id: null, razorpay_plan_id: null, updated_at: now });
  return true;
}

function makeSubscriptionsBuilder(db: FakeDb) {
  const api: Record<string, unknown> = {};
  let mode: "select" | "update" = "select";
  let updatePayload: Record<string, unknown> = {};
  const eqs: Array<[string, string]> = [];
  const getEq = (col: string) => eqs.find(([c]) => c === col)?.[1];

  Object.assign(api, {
    select: () => api,
    update: (vals: Record<string, unknown>) => {
      mode = "update";
      updatePayload = vals;
      return api;
    },
    eq: (col: string, val: string) => {
      eqs.push([col, val]);
      return api;
    },
    maybeSingle: () => api,
    then: (resolve: (v: unknown) => unknown) => {
      const userId = getEq("user_id");
      const row = userId ? db.subscriptions.get(userId) : undefined;
      if (mode === "update") {
        const statusFilter = getEq("status");
        if (row && (!statusFilter || row.status === statusFilter)) Object.assign(row, updatePayload);
        return resolve({ error: null });
      }
      return resolve({ data: row ? { status: row.status } : null, error: null });
    },
  });
  return api;
}

function makeFakeFastify(db: FakeDb, opts: { forceRpcNull?: boolean; keyId?: string | undefined; keySecret?: string | undefined } = {}) {
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  const supabaseAdmin = {
    from(table: string) {
      if (table !== "subscriptions") throw new Error(`unexpected table: ${table}`);
      return makeSubscriptionsBuilder(db);
    },
    rpc: async (name: string, params: Record<string, unknown>) => {
      db.rpcCalls.push({ name, params, seq: db.seq++ });
      if (name !== "claim_subscription_slot") throw new Error(`unexpected rpc: ${name}`);
      if (opts.forceRpcNull) return { data: null, error: null };
      const claimed = claimSlot(db, params.p_user_id as string, Date.now());
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

function mockFetch(db: FakeDb, response: { ok: boolean; status?: number; body: unknown } | (() => { ok: boolean; status?: number; body: unknown })) {
  const fn = vi.fn(async () => {
    db.fetchCalls.push({ seq: db.seq++ });
    const r = typeof response === "function" ? response() : response;
    return { ok: r.ok, status: r.status ?? (r.ok ? 200 : 400), json: async () => r.body };
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createSubscription — happy path", () => {
  it("creates a subscription for a user with no prior row", async () => {
    const db = makeDb();
    const fetchMock = mockFetch(db, { ok: true, body: { id: "sub_new123", status: "created" } });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.body).toEqual({ subscriptionId: "sub_new123", keyId: KEY_ID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(db.subscriptions.get("u1")?.status).toBe("created");
    expect(db.subscriptions.get("u1")?.razorpay_subscription_id).toBe("sub_new123");
  });

  it("claims the local slot BEFORE calling Razorpay, not after", async () => {
    const db = makeDb();
    mockFetch(db, { ok: true, body: { id: "sub_x", status: "created" } });
    await createSubscription(makeFakeFastify(db), "u1");

    expect(db.rpcCalls).toHaveLength(1);
    expect(db.fetchCalls).toHaveLength(1);
    expect(db.rpcCalls[0].seq).toBeLessThan(db.fetchCalls[0].seq);
  });

  it("always sends the server-configured plan id, never anything client-influenced", async () => {
    const db = makeDb();
    const fetchMock = mockFetch(db, { ok: true, body: { id: "sub_x", status: "created" } });
    await createSubscription(makeFakeFastify(db), "u1");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.plan_id).toBe(PLAN_ID);
    expect(sentBody.notes).toEqual({ splex_user_id: "u1" });
    expect(String(init.headers && (init.headers as Record<string, string>)["Authorization"])).toMatch(/^Basic /);
  });

  it("allows a previously-cancelled user to resubscribe", async () => {
    const db = makeDb();
    seedRow(db, "u1", { status: "cancelled" });
    mockFetch(db, { ok: true, body: { id: "sub_resub", status: "created" } });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(true);
    expect(db.subscriptions.get("u1")?.razorpay_subscription_id).toBe("sub_resub");
  });
});

describe("createSubscription — duplicate protection", () => {
  it.each(["authenticated", "active", "pending"])("refuses when the existing subscription is %s, without calling Razorpay", async (status) => {
    const db = makeDb();
    seedRow(db, "u1", { status });
    const fetchMock = mockFetch(db, { ok: true, body: { id: "should_not_be_used", status: "created" } });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still refuses if the atomic claim itself is lost (race the pre-check alone can't catch)", async () => {
    const db = makeDb(); // pre-check sees nothing
    mockFetch(db, { ok: true, body: { id: "sub_raced", status: "created" } });
    const fastify = makeFakeFastify(db, { forceRpcNull: true }); // but the RPC refuses anyway

    const result = await createSubscription(fastify, "u1");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it("two simultaneous requests for the same user result in exactly one Razorpay API call", async () => {
    const db = makeDb();
    mockFetch(db, () => ({ ok: true, body: { id: `sub_${db.fetchCalls.length}`, status: "created" } }));
    const fastify = makeFakeFastify(db);

    const [a, b] = await Promise.all([createSubscription(fastify, "u1"), createSubscription(fastify, "u1")]);

    const outcomes = [a, b];
    expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
    expect(outcomes.filter((r) => !r.ok && r.status === 409)).toHaveLength(1);
    expect(db.fetchCalls).toHaveLength(1);
  });
});

describe("createSubscription — 'created' state: abandoned checkout is recoverable, in-flight is not", () => {
  it("refuses a fresh created+id row (checkout genuinely in progress)", async () => {
    const db = makeDb();
    seedRow(db, "u1", { status: "created", razorpay_subscription_id: "sub_inflight", updated_at: Date.now() });
    const fetchMock = mockFetch(db, { ok: true, body: { id: "unused", status: "created" } });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows reclaiming a created+id row older than 30 minutes (abandoned Checkout)", async () => {
    const db = makeDb();
    seedRow(db, "u1", { status: "created", razorpay_subscription_id: "sub_abandoned", updated_at: Date.now() - 31 * 60 * 1000 });
    mockFetch(db, { ok: true, body: { id: "sub_retry", status: "created" } });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(true);
    expect(db.subscriptions.get("u1")?.razorpay_subscription_id).toBe("sub_retry");
  });

  it("refuses a fresh created+null-id row rather than letting a concurrent request steal an in-flight claim", async () => {
    const db = makeDb();
    seedRow(db, "u1", { status: "created", razorpay_subscription_id: null, updated_at: Date.now() });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(false);
  });

  it("an immediate retry succeeds after Razorpay's API call fails on the first attempt", async () => {
    const db = makeDb();
    let call = 0;
    mockFetch(db, () => {
      call += 1;
      return call === 1 ? { ok: false, status: 400, body: { error: { description: "temporary failure" } } } : { ok: true, body: { id: "sub_second_try", status: "created" } };
    });
    const fastify = makeFakeFastify(db);

    const first = await createSubscription(fastify, "u1");
    expect(first.ok).toBe(false);
    expect(db.subscriptions.get("u1")?.razorpay_subscription_id).toBeNull();

    // Force the leftover null-id claim old enough to be reclaimable, since
    // a real retry seconds later would otherwise correctly be refused too
    // (see the in-flight-protection test above) — this test is about
    // proving the row ISN'T stuck forever, not about timing precision.
    const row = db.subscriptions.get("u1")!;
    row.updated_at = Date.now() - 3 * 60 * 1000;

    const second = await createSubscription(fastify, "u1");
    expect(second.ok).toBe(true);
    expect(db.subscriptions.get("u1")?.razorpay_subscription_id).toBe("sub_second_try");
  });
});

describe("createSubscription — Razorpay API failure", () => {
  it("leaves the claimed row at status=created with no subscription id, not deleted or half-written", async () => {
    const db = makeDb();
    mockFetch(db, { ok: false, status: 400, body: { error: { description: "plan not found" } } });

    const result = await createSubscription(makeFakeFastify(db), "u1");

    expect(result.ok).toBe(false);
    expect(db.rpcCalls).toHaveLength(1); // the claim DID happen — it's the ordering fix's whole point
    expect(db.subscriptions.get("u1")?.status).toBe("created");
    expect(db.subscriptions.get("u1")?.razorpay_subscription_id).toBeNull();
  });

  it("fails closed without calling fetch at all when Razorpay credentials aren't configured", async () => {
    const db = makeDb();
    const fetchMock = mockFetch(db, { ok: true, body: { id: "unused", status: "created" } });
    const fastify = makeFakeFastify(db, { keyId: undefined, keySecret: undefined });

    const result = await createSubscription(fastify, "u1");

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when only one of KEY_ID/KEY_SECRET is configured", async () => {
    const db = makeDb();
    const fetchMock = mockFetch(db, { ok: true, body: { id: "unused", status: "created" } });
    const fastify = makeFakeFastify(db, { keyId: undefined, keySecret: KEY_SECRET });

    const result = await createSubscription(fastify, "u1");

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
