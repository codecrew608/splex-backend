import { vi } from "vitest";

// An in-memory stand-in for the parts of FastifyInstance the credit and
// routing code actually touches: supabaseAdmin (rpc / from / storage / auth),
// log, and config.
//
// Deliberately a hand-rolled fake rather than a mocking library: these tests
// are about ARITHMETIC and ORDERING (how many times the daily counter is
// moved, in what direction, under concurrency), and a fake that models the
// counter as real mutable state catches a double-charge that assertion-on-
// call-count alone would miss. The 2x daily overcharge that shipped would
// have been caught by this file's `dailyUsed` bookkeeping, not by a spy.

export interface FakeState {
  planTier: "free" | "pro";
  dailyLimit: number | null;
  monthlyLimit: number | null;
  dailyUsed: number;
  monthlyUsed: number;
  // media rows keyed by id
  media: Map<string, { user_id: string; credits_reserved: number; reservation_period: string | null; status: string }>;
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
  logs: Array<{ level: string; msg: string }>;
}

export function makeState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    planTier: "free",
    dailyLimit: 150,
    monthlyLimit: 3000,
    dailyUsed: 0,
    monthlyUsed: 0,
    media: new Map(),
    rpcCalls: [],
    logs: [],
    ...overrides,
  };
}

const PERIOD = "2026-08-28";

// Faithful re-implementations of the production RPCs' semantics, taken from
// their pg_get_functiondef output — including the details that matter:
// reserve is a conditional increment that CANNOT exceed the cap, settle is
// idempotent and guards against driving a counter negative, and a missing
// plan_limits row fails CLOSED rather than being treated as unlimited.
function rpcImpl(state: FakeState, name: string, p: Record<string, unknown>): unknown {
  switch (name) {
    case "check_credits": {
      if (state.monthlyLimit === null) return false; // fail closed
      return state.monthlyUsed + Number(p.p_credit_cost) <= state.monthlyLimit;
    }
    case "check_daily_credits": {
      if (state.dailyLimit === null) return false; // fail closed
      return state.dailyUsed + Number(p.p_credit_cost) <= state.dailyLimit;
    }
    case "reserve_daily_credits": {
      const amount = Number(p.p_reserve_amount);
      if (state.dailyLimit === null) return false;
      if (amount > state.dailyLimit) return false;
      if (state.dailyUsed + amount > state.dailyLimit) return false;
      state.dailyUsed += amount;
      return true;
    }
    case "consume_daily_credits": {
      state.dailyUsed += Number(p.p_credit_cost);
      return null;
    }
    case "consume_credits": {
      state.monthlyUsed += Number(p.p_credit_cost);
      return null;
    }
    case "reserve_media_credits": {
      const amount = Number(p.p_reserve_amount);
      const row = state.media.get(String(p.p_media_id));
      if (!row) return false;
      if (state.dailyLimit === null) return false;
      if (amount > state.dailyLimit) return false;
      if (state.dailyUsed + amount > state.dailyLimit) return false;
      state.dailyUsed += amount;
      row.credits_reserved = amount;
      row.reservation_period = PERIOD;
      return true;
    }
    case "settle_media_reservation": {
      const row = state.media.get(String(p.p_media_id));
      if (!row || row.credits_reserved === 0) return false; // idempotent no-op
      const delta = Number(p.p_actual_cost) - row.credits_reserved;
      if (delta !== 0 && row.reservation_period) {
        state.dailyUsed = Math.max(0, state.dailyUsed + delta);
      }
      row.credits_reserved = 0;
      return true;
    }
    case "release_stale_media_reservations":
      return 0;
    case "diagnose_credit_rejection":
      return { reason: "daily_exhausted" };
    default:
      return null;
  }
}

export function makeFastify(state: FakeState) {
  const log = {
    error: (o: unknown, m?: string) => state.logs.push({ level: "error", msg: m ?? String(o) }),
    warn: (o: unknown, m?: string) => state.logs.push({ level: "warn", msg: m ?? String(o) }),
    info: () => {},
    debug: () => {},
  };

  const supabaseAdmin = {
    rpc: vi.fn(async (name: string, params: Record<string, unknown> = {}) => {
      state.rpcCalls.push({ name, params });
      return { data: rpcImpl(state, name, params), error: null };
    }),
    from: (table: string) => {
      const api: Record<string, unknown> = {};
      const chain = () => api;
      Object.assign(api, {
        select: chain, eq: chain, in: chain, gte: chain, order: chain, limit: chain,
        update: (vals: Record<string, unknown>) => {
          if (table === "generated_media") {
            api.__pendingUpdate = vals;
          }
          return api;
        },
        insert: chain,
        upsert: chain,
        single: async () => ({ data: null, error: null }),
        maybeSingle: async () => ({ data: null, error: null }),
        then: (res: (v: unknown) => unknown) => res({ data: null, error: null }),
      });
      return api;
    },
  };

  return { supabaseAdmin, log, config: { CORTEX_CLASSIFIER_MODEL_ID: "stub", CREDITS_PER_USD: 20000 } } as never;
}

export function makeMedia(state: FakeState, userId = "u1"): string {
  const id = `media-${state.media.size + 1}`;
  state.media.set(id, { user_id: userId, credits_reserved: 0, reservation_period: null, status: "queued" });
  return id;
}
