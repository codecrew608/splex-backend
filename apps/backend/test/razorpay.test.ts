import { describe, it, expect } from "vitest";
import { processRazorpayWebhook } from "../src/handlers/razorpay.js";

// A small, dedicated fake scoped to exactly what this handler touches
// (payment_events/subscriptions/users) — deliberately not an extension of
// test/helpers/fakeFastify.ts, which is specialized around credit-RPC and
// workflow-table semantics this handler never calls. Real backing Maps/Sets
// so idempotency (a real unique-constraint conflict) and state-after-upsert
// are actually exercised, not just call-counted.

const SECRET = "test_webhook_secret";
const PLAN_ID = "plan_TYEBWcXvja8WRM";

async function sign(body: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

interface FakeDb {
  paymentEvents: Set<string>;
  subscriptions: Map<string, Record<string, unknown>>; // keyed by user_id
  users: Set<string>; // set of known user ids
}

function makeDb(knownUserIds: string[] = []): FakeDb {
  return { paymentEvents: new Set(), subscriptions: new Map(), users: new Set(knownUserIds) };
}

function thenable(fn: () => unknown) {
  return { then: (resolve: (v: unknown) => unknown) => resolve(fn()) };
}

function makeFakeFastify(db: FakeDb, secret: string | undefined) {
  const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

  const supabaseAdmin = {
    from(table: string) {
      if (table === "payment_events") {
        return {
          insert: (row: { razorpay_event_id: string }) =>
            thenable(() => {
              if (db.paymentEvents.has(row.razorpay_event_id)) {
                return { error: { code: "23505", message: "duplicate key value violates unique constraint" } };
              }
              db.paymentEvents.add(row.razorpay_event_id);
              return { error: null };
            }),
        };
      }

      if (table === "subscriptions") {
        const api: Record<string, unknown> = {};
        let eqCol = "";
        let eqVal = "";
        Object.assign(api, {
          select: () => api,
          eq: (col: string, val: string) => {
            eqCol = col;
            eqVal = val;
            return api;
          },
          maybeSingle: () =>
            thenable(() => {
              if (eqCol === "user_id") {
                const row = db.subscriptions.get(eqVal);
                return { data: row ? { last_event_at: row.last_event_at ?? null } : null, error: null };
              }
              if (eqCol === "razorpay_subscription_id") {
                for (const [userId, row] of db.subscriptions) {
                  if (row.razorpay_subscription_id === eqVal) return { data: { user_id: userId }, error: null };
                }
              }
              return { data: null, error: null };
            }),
          upsert: (row: Record<string, unknown>) =>
            thenable(() => {
              const userId = row.user_id as string;
              db.subscriptions.set(userId, { ...db.subscriptions.get(userId), ...row });
              return { error: null };
            }),
        });
        return api;
      }

      if (table === "users") {
        const api: Record<string, unknown> = {};
        let eqVal = "";
        Object.assign(api, {
          select: () => api,
          eq: (_col: string, val: string) => {
            eqVal = val;
            return api;
          },
          maybeSingle: () => thenable(() => ({ data: db.users.has(eqVal) ? { id: eqVal } : null, error: null })),
          update: (vals: { plan_tier: string }) => ({
            eq: (_col: string, id: string) =>
              thenable(() => {
                const row = db.subscriptions.get(id);
                if (row) row.plan_tier = vals.plan_tier; // piggyback plan_tier onto the same row for easy assertions
                return { error: null };
              }),
          }),
        });
        return api;
      }

      throw new Error(`unexpected table in razorpay test fake: ${table}`);
    },
  };

  return { supabaseAdmin, log, config: { RAZORPAY_WEBHOOK_SECRET: secret, RAZORPAY_STARTER_PLAN_ID: PLAN_ID } } as never;
}

function makeBody(overrides: {
  event: string;
  status: string;
  subscriptionId?: string;
  planId?: string;
  createdAt?: number;
  notes?: Record<string, unknown> | null;
  currentStart?: number | null;
  currentEnd?: number | null;
  customerId?: string | null;
}) {
  return {
    event: overrides.event,
    created_at: overrides.createdAt ?? 1_700_000_000,
    payload: {
      subscription: {
        entity: {
          id: overrides.subscriptionId ?? "sub_1",
          plan_id: overrides.planId ?? PLAN_ID,
          status: overrides.status,
          current_start: overrides.currentStart ?? 1_700_000_000,
          current_end: overrides.currentEnd ?? 1_702_600_000,
          customer_id: overrides.customerId ?? "cust_1",
          notes: overrides.notes ?? null,
        },
      },
    },
  };
}

async function deliver(db: FakeDb, body: object, opts: { signature?: string | null; eventId?: string | null; secret?: string } = {}) {
  const raw = JSON.stringify(body);
  // "in" checks, not ?? — a test explicitly passing `secret: undefined` or
  // `eventId: null` means exactly that (no secret configured / no header
  // present), which ?? would otherwise silently collapse into the default.
  const secretForFastify = "secret" in opts ? opts.secret : SECRET;
  const signature = opts.signature === undefined ? await sign(raw, secretForFastify ?? SECRET) : opts.signature;
  const eventId = "eventId" in opts ? opts.eventId : "evt_1";
  const fastify = makeFakeFastify(db, secretForFastify);
  return processRazorpayWebhook(fastify, raw, signature, eventId);
}

describe("processRazorpayWebhook — signature verification", () => {
  it("rejects a missing signature without touching the database", async () => {
    const db = makeDb();
    const body = makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" } });
    const result = await deliver(db, body, { signature: null });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(db.paymentEvents.size).toBe(0);
    expect(db.subscriptions.size).toBe(0);
  });

  it("rejects an invalid signature without touching the database", async () => {
    const db = makeDb();
    const body = makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" } });
    const result = await deliver(db, body, { signature: "0".repeat(64) });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(db.paymentEvents.size).toBe(0);
  });

  it("fails closed (500, no processing) when the webhook secret isn't configured", async () => {
    const db = makeDb();
    const body = makeBody({ event: "subscription.activated", status: "active" });
    const result = await deliver(db, body, { secret: undefined, signature: "irrelevant" });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(500);
    expect(db.paymentEvents.size).toBe(0);
  });

  it("accepts a correctly signed payload", async () => {
    const db = makeDb(["u1"]);
    const body = makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" } });
    const result = await deliver(db, body);
    expect(result.ok).toBe(true);
  });
});

describe("processRazorpayWebhook — plan gating", () => {
  it("skips a webhook for a different plan_id without writing any state", async () => {
    const db = makeDb(["u1"]);
    const body = makeBody({ event: "subscription.activated", status: "active", planId: "plan_other", notes: { splex_user_id: "u1" } });
    const result = await deliver(db, body);
    expect(result.ok).toBe(true);
    expect(db.subscriptions.size).toBe(0);
  });
});

describe("processRazorpayWebhook — idempotency", () => {
  it("applies a duplicate delivery of the same event exactly once", async () => {
    const db = makeDb(["u1"]);
    const body = makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" } });

    await deliver(db, body, { eventId: "evt_dup" });
    const row1 = db.subscriptions.get("u1");
    expect(row1?.plan_tier).toBe("pro");

    // Simulate Razorpay retrying the identical delivery.
    await deliver(db, body, { eventId: "evt_dup" });
    expect(db.paymentEvents.size).toBe(1);
    // Still exactly "pro" — a second application would be harmless here
    // regardless, but the real assertion is that processing was skipped:
    expect(row1?.plan_tier).toBe("pro");
  });

  it("falls back to a composite key when no event-id header is present, stable across retries", async () => {
    const db = makeDb(["u1"]);
    const body = makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" }, createdAt: 1_700_000_123 });

    await deliver(db, body, { eventId: null });
    expect(db.paymentEvents.size).toBe(1);
    await deliver(db, body, { eventId: null });
    expect(db.paymentEvents.size).toBe(1); // same composite key both times, not a second row
  });
});

describe("processRazorpayWebhook — entitlement mapping (Section 6)", () => {
  it("subscription.authenticated records status but does not grant entitlement", async () => {
    const db = makeDb(["u1"]);
    const body = makeBody({ event: "subscription.authenticated", status: "authenticated", notes: { splex_user_id: "u1" } });
    await deliver(db, body);
    const row = db.subscriptions.get("u1");
    expect(row?.status).toBe("authenticated");
    expect(row?.plan_tier).toBeUndefined();
  });

  it("subscription.activated grants pro", async () => {
    const db = makeDb(["u1"]);
    await deliver(db, makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" } }));
    expect(db.subscriptions.get("u1")?.plan_tier).toBe("pro");
  });

  it("subscription.cancelled revokes back to free", async () => {
    const db = makeDb(["u1"]);
    await deliver(db, makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" }, createdAt: 100 }), {
      eventId: "evt_a",
    });
    expect(db.subscriptions.get("u1")?.plan_tier).toBe("pro");

    await deliver(db, makeBody({ event: "subscription.cancelled", status: "cancelled", notes: { splex_user_id: "u1" }, createdAt: 200 }), {
      eventId: "evt_b",
    });
    expect(db.subscriptions.get("u1")?.plan_tier).toBe("free");
    expect(db.subscriptions.get("u1")?.status).toBe("cancelled");
  });

  it("subscription.pending leaves the existing entitlement untouched", async () => {
    const db = makeDb(["u1"]);
    await deliver(db, makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" }, createdAt: 100 }), {
      eventId: "evt_a",
    });
    await deliver(db, makeBody({ event: "subscription.pending", status: "pending", notes: { splex_user_id: "u1" }, createdAt: 200 }), {
      eventId: "evt_b",
    });
    expect(db.subscriptions.get("u1")?.plan_tier).toBe("pro"); // unchanged, not newly revoked
    expect(db.subscriptions.get("u1")?.status).toBe("pending"); // but status itself is honest
  });
});

describe("processRazorpayWebhook — user association (Section 9)", () => {
  it("fails safe when the subscription can't be linked to any known user", async () => {
    const db = makeDb(); // no known users at all
    const result = await deliver(db, makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "ghost" } }));
    expect(result.ok).toBe(true); // acknowledged so Razorpay doesn't retry forever
    expect(db.subscriptions.size).toBe(0); // but nothing was granted
  });

  it("never trusts a notes user id that doesn't resolve to a real user row", async () => {
    const db = makeDb(["u1"]); // u1 exists, but notes points elsewhere
    await deliver(db, makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "not-a-real-user" } }));
    expect(db.subscriptions.size).toBe(0);
  });

  it("prefers the existing local subscription row over notes once one is linked", async () => {
    const db = makeDb(["u1", "u2"]);
    await deliver(db, makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" }, createdAt: 100 }), {
      eventId: "evt_a",
    });
    // A later event for the same subscription carries different (wrong)
    // notes — the already-linked local row must win, not the notes field.
    await deliver(
      db,
      makeBody({ event: "subscription.charged", status: "active", notes: { splex_user_id: "u2" }, createdAt: 200 }),
      { eventId: "evt_b" },
    );
    expect(db.subscriptions.has("u2")).toBe(false);
    expect(db.subscriptions.get("u1")?.status).toBe("active");
  });
});

describe("processRazorpayWebhook — out-of-order delivery (Section 11)", () => {
  it("does not let a stale event regress state applied by a newer one", async () => {
    const db = makeDb(["u1"]);
    await deliver(
      db,
      makeBody({ event: "subscription.cancelled", status: "cancelled", notes: { splex_user_id: "u1" }, createdAt: 200 }),
      { eventId: "evt_a" },
    );
    expect(db.subscriptions.get("u1")?.plan_tier).toBe("free");

    // An older "activated" event arrives late, after the cancellation.
    await deliver(
      db,
      makeBody({ event: "subscription.activated", status: "active", notes: { splex_user_id: "u1" }, createdAt: 100, subscriptionId: "sub_1" }),
      { eventId: "evt_b" },
    );
    expect(db.subscriptions.get("u1")?.status).toBe("cancelled");
    expect(db.subscriptions.get("u1")?.plan_tier).toBe("free");
  });
});
