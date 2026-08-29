import { describe, it, expect } from "vitest";
import {
  checkAndReserveCredits,
  settleDailyReservation,
  reserveMediaCredits,
  settleMediaReservation,
} from "../src/credits/checkCredits.js";
import { consumeCredits } from "../src/credits/consumeCredits.js";
import { makeState, makeFastify, makeMedia } from "./helpers/fakeFastify.js";

const charge = { intent: "chat", complexity: "medium" as const, openrouterModelId: "m", realCostEstimate: 0 };

describe("daily credit accounting — reserve/consume/settle", () => {
  // THE regression test. Reserve + consume + settle all move the daily
  // counter; running all three double-charged it, which shipped and showed
  // up in production as an exact 2.00 ratio between the daily counter and
  // credit_usage_logs. The counter must end at the REAL cost, once.
  it("charges the daily pool exactly once (estimate 10, actual 25)", async () => {
    const state = makeState();
    const f = makeFastify(state);

    const gate = await checkAndReserveCredits(f, "u1", 10);
    expect(gate.allowed).toBe(true);
    expect(state.dailyUsed).toBe(10); // reservation held

    await consumeCredits(f, { ...charge, userId: "u1", creditCost: 25, skipDaily: true });
    await settleDailyReservation(f, "u1", gate.dailyReserved, 25);

    expect(state.dailyUsed).toBe(25);
    expect(state.monthlyUsed).toBe(25);
  });

  it("would double-charge if skipDaily were omitted (guards the exact shipped bug)", async () => {
    const state = makeState();
    const f = makeFastify(state);
    const gate = await checkAndReserveCredits(f, "u1", 10);
    await consumeCredits(f, { ...charge, userId: "u1", creditCost: 25 }); // no skipDaily
    await settleDailyReservation(f, "u1", gate.dailyReserved, 25);
    expect(state.dailyUsed).toBe(50); // 2x — documents why skipDaily exists
  });

  it("refunds when the real cost lands UNDER the estimate", async () => {
    const state = makeState();
    const f = makeFastify(state);
    const gate = await checkAndReserveCredits(f, "u1", 40);
    await consumeCredits(f, { ...charge, userId: "u1", creditCost: 12, skipDaily: true });
    await settleDailyReservation(f, "u1", gate.dailyReserved, 12);
    expect(state.dailyUsed).toBe(12);
  });

  it("fully releases the reservation on a failed generation (actual 0)", async () => {
    const state = makeState();
    const f = makeFastify(state);
    const gate = await checkAndReserveCredits(f, "u1", 30);
    expect(state.dailyUsed).toBe(30);
    await settleDailyReservation(f, "u1", gate.dailyReserved, 0); // finally-path
    expect(state.dailyUsed).toBe(0);
  });

  it("settle is a no-op when nothing was reserved", async () => {
    const state = makeState({ dailyUsed: 7 });
    const f = makeFastify(state);
    await settleDailyReservation(f, "u1", 0, 99);
    expect(state.dailyUsed).toBe(7);
  });
});

describe("daily and monthly limits", () => {
  it("rejects when the reservation alone would exceed the daily cap", async () => {
    const state = makeState({ dailyLimit: 150, dailyUsed: 145 });
    const f = makeFastify(state);
    const gate = await checkAndReserveCredits(f, "u1", 10);
    expect(gate.allowed).toBe(false);
    expect(state.dailyUsed).toBe(145); // nothing consumed on rejection
  });

  it("rejects a single request larger than the whole daily cap", async () => {
    const state = makeState({ dailyLimit: 150 });
    const f = makeFastify(state);
    expect((await checkAndReserveCredits(f, "u1", 500)).allowed).toBe(false);
    expect(state.dailyUsed).toBe(0);
  });

  it("rejects on the MONTHLY pool before touching the daily one", async () => {
    const state = makeState({ monthlyLimit: 3000, monthlyUsed: 2999 });
    const f = makeFastify(state);
    const gate = await checkAndReserveCredits(f, "u1", 10);
    expect(gate.allowed).toBe(false);
    expect(state.dailyUsed).toBe(0); // monthly checked first — daily untouched
    expect(state.rpcCalls.some((c) => c.name === "reserve_daily_credits")).toBe(false);
  });

  it("fails CLOSED when a plan has no configured daily limit", async () => {
    const state = makeState({ dailyLimit: null });
    const f = makeFastify(state);
    expect((await checkAndReserveCredits(f, "u1", 1)).allowed).toBe(false);
  });

  it("allows a request that exactly fills the remaining daily pool", async () => {
    const state = makeState({ dailyLimit: 150, dailyUsed: 140 });
    const f = makeFastify(state);
    expect((await checkAndReserveCredits(f, "u1", 10)).allowed).toBe(true);
    expect(state.dailyUsed).toBe(150);
  });
});

describe("concurrency — reservations must serialize", () => {
  it("admits only as many concurrent requests as the pool can cover", async () => {
    const state = makeState({ dailyLimit: 100 });
    const f = makeFastify(state);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => checkAndReserveCredits(f, "u1", 30)),
    );
    const allowed = results.filter((r) => r.allowed).length;
    expect(allowed).toBe(3); // 3x30=90 fits, 4th would be 120 > 100
    expect(state.dailyUsed).toBe(90);
    expect(state.dailyUsed).toBeLessThanOrEqual(100); // cap never breached
  });

  it("never lets the counter exceed the cap under heavy contention", async () => {
    const state = makeState({ dailyLimit: 150 });
    const f = makeFastify(state);
    await Promise.all(Array.from({ length: 50 }, () => checkAndReserveCredits(f, "u1", 7)));
    expect(state.dailyUsed).toBeLessThanOrEqual(150);
  });
});

describe("async media reservation (video) — spans two requests", () => {
  it("reserves at submit and settles to the real cost at completion", async () => {
    const state = makeState({ dailyLimit: 150 });
    const f = makeFastify(state);
    const mediaId = makeMedia(state);

    expect(await reserveMediaCredits(f, mediaId, 20)).toBe(true);
    expect(state.dailyUsed).toBe(20); // held across the gap between requests

    await settleMediaReservation(f, mediaId, 35); // real cost higher
    expect(state.dailyUsed).toBe(35);
    expect(state.media.get(mediaId)!.credits_reserved).toBe(0);
  });

  it("is IDEMPOTENT — repeated polls cannot settle twice", async () => {
    const state = makeState();
    const f = makeFastify(state);
    const mediaId = makeMedia(state);
    await reserveMediaCredits(f, mediaId, 20);

    await settleMediaReservation(f, mediaId, 35);
    await settleMediaReservation(f, mediaId, 35); // second poll
    await settleMediaReservation(f, mediaId, 35); // third poll

    expect(state.dailyUsed).toBe(35); // charged once, not 3x
  });

  it("fully releases on job failure", async () => {
    const state = makeState();
    const f = makeFastify(state);
    const mediaId = makeMedia(state);
    await reserveMediaCredits(f, mediaId, 25);
    expect(state.dailyUsed).toBe(25);
    await settleMediaReservation(f, mediaId, 0);
    expect(state.dailyUsed).toBe(0);
  });

  it("blocks a second video when the first job's reservation exhausts the pool", async () => {
    const state = makeState({ dailyLimit: 50 });
    const f = makeFastify(state);
    const first = makeMedia(state);
    const second = makeMedia(state);

    expect(await reserveMediaCredits(f, first, 40)).toBe(true);
    // Before this fix the submit gate was a read-only check, so this second
    // job would also have been admitted and both would have charged later.
    expect(await reserveMediaCredits(f, second, 40)).toBe(false);
    expect(state.dailyUsed).toBe(40);
  });

  it("release never drives the counter negative", async () => {
    const state = makeState();
    const f = makeFastify(state);
    const mediaId = makeMedia(state);
    await reserveMediaCredits(f, mediaId, 30);
    state.dailyUsed = 5; // simulate the counter having been reset under us
    await settleMediaReservation(f, mediaId, 0);
    expect(state.dailyUsed).toBe(0);
    expect(state.dailyUsed).toBeGreaterThanOrEqual(0);
  });

  it("does not charge the daily pool twice on the completion path", async () => {
    const state = makeState();
    const f = makeFastify(state);
    const mediaId = makeMedia(state);
    await reserveMediaCredits(f, mediaId, 20);
    await settleMediaReservation(f, mediaId, 45);
    await consumeCredits(f, { ...charge, userId: "u1", creditCost: 45, skipDaily: true });
    expect(state.dailyUsed).toBe(45);
    expect(state.monthlyUsed).toBe(45);
  });
});
