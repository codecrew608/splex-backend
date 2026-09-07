import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dropOrphanedUserTurns, type HistoryMessage } from "../src/persistence/messages.js";

// REGRESSION — real production incident, 2026-09-07 (answer bleed).
//
// A user asked "what is the latest news about floods in nepal?" and was
// correctly refused: web search is not on the Free plan. That refusal went
// out over SSE, but nothing was persisted for the assistant turn — while
// the USER's message row had already been written. The next turn's history
// therefore read back as two consecutive user messages with no answer
// between them, and the model did the natural thing: it answered BOTH.
// The reply to "tell few oral histories about mahatma gandhi" opened with
// an unrequested "Floods in Nepal — current information" section, about a
// question the user had already been told could not be answered.
//
// Two independent fixes, both pinned here:
//   1. persistRefusal — refusals are now written as real assistant turns,
//      so history alternates properly AND the refusal survives a reload
//      (before, refreshing made the reply the user had just seen vanish).
//   2. dropOrphanedUserTurns — defence in depth at the history layer, so a
//      future refusal path that forgets step 1 still cannot cause bleed.

const SRC = join(import.meta.dirname, "..", "src");
const read = (rel: string) => readFileSync(join(SRC, rel), "utf8");

const u = (content: string): HistoryMessage => ({ role: "user", content });
const a = (content: string): HistoryMessage => ({ role: "assistant", content });

describe("dropOrphanedUserTurns — the exact production sequence", () => {
  it("collapses the orphaned question so only the turn actually being asked survives", () => {
    const history = [
      u("what is x if 3x=9"),
      a("x = 3"),
      u("what is the latest news about floods in nepal?"), // refused, nothing persisted
      u("tell few oral histories about mahatma gandhi"),
    ];
    const result = dropOrphanedUserTurns(history);
    expect(result).toHaveLength(3);
    expect(result[2].content).toBe("tell few oral histories about mahatma gandhi");
    expect(result.some((m) => m.content.includes("floods in nepal"))).toBe(false);
  });

  it("leaves a properly alternating history completely untouched", () => {
    const history = [u("q1"), a("a1"), u("q2"), a("a2"), u("q3")];
    expect(dropOrphanedUserTurns(history)).toEqual(history);
  });

  it("keeps the LAST of a run — the turn the user is actually waiting on", () => {
    // chat.ts relies on history's final entry being the current turn.
    const result = dropOrphanedUserTurns([u("first"), u("second"), u("third")]);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("third");
  });

  it("handles several separate orphan runs in one history", () => {
    const result = dropOrphanedUserTurns([
      u("orphan A"), u("real A"), a("answer A"), u("orphan B"), u("orphan B2"), u("real B"),
    ]);
    expect(result.map((m) => m.content)).toEqual(["real A", "answer A", "real B"]);
  });

  it("never drops assistant turns, and never reorders anything", () => {
    const result = dropOrphanedUserTurns([a("system-ish opener"), u("q"), a("ans")]);
    expect(result.map((m) => m.role)).toEqual(["assistant", "user", "assistant"]);
  });

  it("is safe on an empty history", () => {
    expect(dropOrphanedUserTurns([])).toEqual([]);
  });
});

describe("refusals are persisted so they cannot orphan a user turn (or vanish on reload)", () => {
  it("fetchRecentHistory routes its result through the orphan guard", () => {
    const src = read("persistence/messages.ts");
    const fnAt = src.indexOf("export async function fetchRecentHistory(");
    const body = src.slice(fnAt, src.indexOf("\n}", fnAt));
    expect(body).toContain("dropOrphanedUserTurns(");
  });

  it("the web-search refusal path — the one from the incident — persists its refusal", () => {
    const src = read("research/handler.ts");
    const at = src.indexOf('"Web search isn\'t available on your plan."');
    expect(at).toBeGreaterThan(-1);
    // The persistRefusal call sits in the same quota-blocked branch, right
    // after the sse.error that delivers the message to the client.
    const branch = src.slice(at, at + 900);
    expect(branch).toContain("persistRefusal(fastify, conversationId, message)");
  });

  it("chat.ts's credit and message-limit refusals persist too", () => {
    const src = read("handlers/chat.ts");
    expect(src).toContain("await persistRefusal(fastify, conversationId, refusal);");
    expect(src).toContain("await persistRefusal(fastify, conversationId, DAILY_REQUEST_LIMIT_MESSAGE);");
  });

  it("persistRefusal is best-effort — a bookkeeping failure never turns an already-delivered refusal into a 500", () => {
    const src = read("persistence/messages.ts");
    const fnAt = src.indexOf("export async function persistRefusal(");
    const body = src.slice(fnAt, src.indexOf("\n}", fnAt));
    expect(body).toContain("try {");
    expect(body).toContain("catch");
    expect(body).not.toMatch(/throw/);
  });
});
