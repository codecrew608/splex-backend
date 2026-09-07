import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { reserveDailyRequest, releaseDailyRequest } from "../src/credits/checkCredits.js";
import { makeState, makeFastify } from "./helpers/fakeFastify.js";

const read = (rel: string) => readFileSync(join(import.meta.dirname, "..", "src", rel), "utf8");

// migration 0055's regression coverage. THE bug this fixes: check_credits()
// only ever READ daily_requests (never reserved it), and the only place it
// was ever incremented was inside consume_credits() — reachable only after
// a generation had already streamed a full response. N simultaneous
// requests near a user's message-count limit could all pass the read-only
// pre-check and all proceed to generate, over-admitting past the cap. This
// file proves reserve_daily_request() closes that race exactly the way
// credits.test.ts already proves reserve_daily_credits() does for the
// credits pool — same fake, same Promise.all idiom (see fakeFastify.ts's
// rpc mock: no internal await inside rpcImpl, so a batch of concurrent
// calls serializes on the fake exactly as production serializes on
// Postgres's own row lock).

describe("reserveDailyRequest / releaseDailyRequest — basic accounting", () => {
  it("reserves exactly 1 per call, up to the configured limit", async () => {
    const state = makeState({ dailyRequestsLimit: 50, dailyRequestsUsed: 0 });
    const f = makeFastify(state);
    expect(await reserveDailyRequest(f, "u1")).toBe(true);
    expect(state.dailyRequestsUsed).toBe(1);
  });

  it("rejects the request that would push used past the limit", async () => {
    const state = makeState({ dailyRequestsLimit: 50, dailyRequestsUsed: 50 });
    const f = makeFastify(state);
    expect(await reserveDailyRequest(f, "u1")).toBe(false);
    expect(state.dailyRequestsUsed).toBe(50); // nothing consumed on rejection
  });

  it("allows the exact request that fills the last slot (49 -> 50)", async () => {
    const state = makeState({ dailyRequestsLimit: 50, dailyRequestsUsed: 49 });
    const f = makeFastify(state);
    expect(await reserveDailyRequest(f, "u1")).toBe(true);
    expect(state.dailyRequestsUsed).toBe(50);
  });

  it("is uncapped when no limit is configured for the tier (NULL, not fail-closed)", async () => {
    // Distinct from the credits pool's fail-closed-on-NULL rule — daily
    // message caps have genuinely-unlimited tiers by design (dormant
    // 'starter' today), so NULL here must mean "no cap", not "deny".
    const state = makeState({ dailyRequestsLimit: null, dailyRequestsUsed: 999 });
    const f = makeFastify(state);
    expect(await reserveDailyRequest(f, "u1")).toBe(true);
    expect(state.dailyRequestsUsed).toBe(999); // no row touched — nothing to release either
  });

  it("releaseDailyRequest fully undoes a reservation on a failed generation", async () => {
    const state = makeState({ dailyRequestsLimit: 50, dailyRequestsUsed: 0 });
    const f = makeFastify(state);
    await reserveDailyRequest(f, "u1");
    expect(state.dailyRequestsUsed).toBe(1);
    await releaseDailyRequest(f, "u1");
    expect(state.dailyRequestsUsed).toBe(0);
  });

  it("release never drives the counter negative", async () => {
    const state = makeState({ dailyRequestsLimit: 50, dailyRequestsUsed: 0 });
    const f = makeFastify(state);
    await releaseDailyRequest(f, "u1"); // nothing was ever reserved
    expect(state.dailyRequestsUsed).toBe(0);
  });
});

describe("reserveDailyRequest — concurrency, the actual race this migration closes", () => {
  it("a user at 49/50 firing 10 simultaneous requests admits exactly 1, not up to 59", async () => {
    // The master-prompt's own worked example, proven directly rather than
    // asserted in prose.
    const state = makeState({ dailyRequestsLimit: 50, dailyRequestsUsed: 49 });
    const f = makeFastify(state);
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveDailyRequest(f, "u1")));
    const admitted = results.filter(Boolean).length;
    expect(admitted).toBe(1);
    expect(state.dailyRequestsUsed).toBe(50);
  });

  it("a Paid user at 74/75 firing 10 simultaneous requests admits exactly 1", async () => {
    // Same worked example, Paid numbers — proves the fix is not
    // free-tier-specific (the old check_credits() gate was hardcoded to
    // v_tier = 'free' and would have let this race through unchecked).
    const state = makeState({ planTier: "pro", dailyRequestsLimit: 75, dailyRequestsUsed: 74 });
    const f = makeFastify(state);
    const results = await Promise.all(Array.from({ length: 10 }, () => reserveDailyRequest(f, "u1")));
    expect(results.filter(Boolean).length).toBe(1);
    expect(state.dailyRequestsUsed).toBe(75);
  });

  it("never lets the counter exceed the cap under heavy contention from a fresh count", async () => {
    const state = makeState({ dailyRequestsLimit: 50, dailyRequestsUsed: 0 });
    const f = makeFastify(state);
    const results = await Promise.all(Array.from({ length: 80 }, () => reserveDailyRequest(f, "u1")));
    expect(results.filter(Boolean).length).toBe(50);
    expect(state.dailyRequestsUsed).toBe(50);
    expect(state.dailyRequestsUsed).toBeLessThanOrEqual(50);
  });
});

// There is no full-chat-pipeline test harness in this repo (see the
// workflow-test design notes on chat.ts's own edit/regenerate branch for
// the same limitation) — chat.ts's admission wiring is pinned structurally
// instead, the same idiom capacity-security.test.ts already uses for the
// OpenRouter capacity gate. A test that reads the real file fails the
// moment the guarantee it pins stops holding; a comment does not.
describe("chat.ts wiring — the message-count reservation cannot leak a credits reservation", () => {
  it("reserveDailyRequest runs AFTER the credits gate, before generation begins", () => {
    const src = read("handlers/chat.ts");
    const creditsGateAt = src.indexOf("const gate = await checkAndReserveCredits(");
    const requestReserveAt = src.indexOf("const requestReserved = await reserveDailyRequest(");
    const streamAt = src.indexOf("generation = await streamCompletion(");
    expect(creditsGateAt).toBeGreaterThan(-1);
    expect(requestReserveAt).toBeGreaterThan(creditsGateAt);
    expect(streamAt).toBeGreaterThan(requestReserveAt);
  });

  it("a message-count rejection releases the just-made credits reservation (actualCost 0) before returning", () => {
    const src = read("handlers/chat.ts");
    const start = src.indexOf("if (!requestReserved) {");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 400);
    expect(block).toContain("await settleDailyReservation(fastify, user.id, gate.dailyReserved, 0);");
  });

  it("requestSucceeded is set only once generation genuinely completes (same statement block as dailyActualCost)", () => {
    const src = read("handlers/chat.ts");
    const costAt = src.indexOf("dailyActualCost = realCost.creditsCharged;");
    const succeededAt = src.indexOf("requestSucceeded = true;");
    expect(costAt).toBeGreaterThan(-1);
    expect(succeededAt).toBeGreaterThan(costAt);
    expect(succeededAt - costAt).toBeLessThan(500); // same small block, not some later unrelated assignment
  });

  it("consumeCredits is called with skipDailyRequest: true (reservation already owns the counter)", () => {
    const src = read("handlers/chat.ts");
    const callAt = src.indexOf("await consumeCredits(fastify, {");
    const nextParen = src.indexOf("});", callAt);
    const call = src.slice(callAt, nextParen);
    expect(call).toContain("skipDailyRequest: true");
  });

  it("the finally block releases the message reservation whenever requestSucceeded stayed false", () => {
    const src = read("handlers/chat.ts");
    const finallyAt = src.indexOf("} finally {");
    const block = src.slice(finallyAt, finallyAt + 800);
    expect(block).toContain("if (!requestSucceeded) {");
    expect(block).toContain("await releaseDailyRequest(fastify, user.id);");
  });
});
