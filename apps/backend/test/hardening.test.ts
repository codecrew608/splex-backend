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

describe("durable assistant-message persistence (source-level)", () => {
  // FINDING (production hardening pass): every generation path used to
  // call insertMessage() for the assistant's row exactly once, at the very
  // end, with the full final content already known. A client that
  // disconnected before that single insert ran — navigation, refresh, or
  // simply a slower response outliving how long the user stayed on the
  // page — left NO row at all for that turn: not partial content, a hole.
  // The fix is the same shape everywhere: insert a 'streaming' placeholder
  // BEFORE the risky provider call, finalize it via updateMessageResult on
  // every exit (success, partial/aborted, empty output, and an unexpected
  // exception) instead of inserting fresh. These pins assert the shape
  // exists in source, not just that tests pass against a fake — the
  // failure mode (a stuck 'streaming' row) is invisible to a unit test
  // that always runs a handler to completion.

  it("runChat (plain chat) inserts the placeholder before streamCompletion and finalizes on every exit", () => {
    const src = read("handlers/chat.ts");
    const insertIdx = src.indexOf('status: "streaming",\n    });\n\n    sse.cortexStatus({ stage: "executing"');
    expect(insertIdx).toBeGreaterThan(-1);
    const streamIdx = src.indexOf("generation = await streamCompletion(");
    expect(streamIdx).toBeGreaterThan(insertIdx);
    // Every exit path finalizes the SAME row via updateMessageResult —
    // none of them insert a second one.
    expect((src.match(/updateMessageResult\(fastify, assistantMessageId,/g) ?? []).length).toBe(4); // aborted, empty, success, outer catch
    // The old insert-at-the-end call sites must be gone.
    expect(src).not.toMatch(/insertMessage\(fastify, \{\s*conversationId, role: "assistant", content: fullText/);
  });

  it("handleSyncMediaGeneration (image/audio/ppt) inserts the placeholder before the provider call and finalizes on every exit", () => {
    const src = read("routes/mediaGeneration.ts");
    const insertIdx = src.indexOf('content: "",\n      intent: decision.intentId,\n      complexity: decision.complexity,\n      status: "streaming",');
    expect(insertIdx).toBeGreaterThan(-1);
    const generateLoopIdx = src.indexOf("result = await params.generate(");
    expect(generateLoopIdx).toBeGreaterThan(insertIdx);
    expect((src.match(/updateMessageResult\(fastify, assistantMessageId,/g) ?? []).length).toBe(3); // no-candidate failure, success, outer catch
  });

  it("handleWebSearch inserts the placeholder before the search call and finalizes on every exit", () => {
    const src = read("research/handler.ts");
    const insertIdx = src.indexOf('content: "",\n      intent: decision.intentId,\n      complexity: decision.complexity,\n      status: "streaming",');
    expect(insertIdx).toBeGreaterThan(-1);
    const searchLoopIdx = src.indexOf("result = await performWebSearch(");
    expect(searchLoopIdx).toBeGreaterThan(insertIdx);
    expect((src.match(/updateMessageResult\(fastify, assistantMessageId,/g) ?? []).length).toBe(3); // no-result failure, success, outer catch
  });

  it("runDeepResearch inserts the placeholder before stage 1 and finalizes on every exit, including an outright pipeline failure", () => {
    const src = read("research/deepResearch.ts");
    const insertIdx = src.indexOf('role: "assistant",\n    content: "",\n    intent: "deep_research"');
    expect(insertIdx).toBeGreaterThan(-1);
    const stage1Idx = src.indexOf('sse.researchStage({ stage: "planning" });');
    expect(stage1Idx).toBeGreaterThan(insertIdx);
    // zero-evidence branch, normal-completion branch, and the outer catch
    // (which previously finalized ONLY the generated_media row, never the
    // messages row — a real gap on outright failure, not just disconnect).
    expect((src.match(/updateMessageResult\(fastify, assistantMessageId,/g) ?? []).length).toBe(3);
  });

  it("video's placeholder message is inserted as 'streaming' and finalized to 'complete'/'failed', never left defaulting to 'complete'", () => {
    const gen = read("routes/mediaGeneration.ts");
    expect(gen).toContain('routedModel: model.openrouter_model_id,\n    status: "streaming",');
    const media = read("handlers/media.ts");
    expect((media.match(/content: FAILED_MESSAGE, status: "failed" \}\);/g) ?? []).length).toBe(2);
    expect(media).toContain('status: "complete"');
  });

  it("updateMessageResult never silently nulls credits_charged/routed_model when a caller omits them", () => {
    // A failure finalize (content + status only) must not wipe fields a
    // success finalize set for a DIFFERENT row, or that insert-time
    // already set — only touch what the caller actually passed.
    const src = read("persistence/messages.ts");
    expect(src).toContain("if (params.creditsCharged !== undefined) update.credits_charged = params.creditsCharged;");
    expect(src).toContain("if (params.routedModel !== undefined) update.routed_model = params.routedModel;");
  });
});

describe("attachment display (source-level)", () => {
  // FINDING (production hardening pass): the user's OWN persisted message
  // content used to be classifierInputMessage — the attachment text block
  // (up to 20,000 chars of a document's extracted text) PLUS whatever they
  // typed, as one string. Every reload, and every future turn's history
  // replay, rendered/re-sent that whole block as if the user had typed it.
  // Images were worse: never included in that block at all (by design —
  // they go to the model separately), so an image attachment left no
  // trace anywhere once the live SSE session ended. Fixed by persisting
  // only what the user typed, linking attached files to the message row
  // for display, and injecting the attachment text into the model's
  // CURRENT-turn request in memory instead of into persisted content.
  it("persists only what the user typed, not classifierInputMessage", () => {
    const src = read("handlers/chat.ts");
    expect(src).toContain('userMessageId = await insertMessage(fastify, { conversationId, role: "user", content: body.message as string });');
    expect(src).not.toMatch(/insertMessage\(fastify, \{ conversationId, role: "user", content: classifierInputMessage/);
  });

  it("links attached files to the user message for display, after re-scoping ownership", () => {
    const src = read("handlers/chat.ts");
    const fetchIdx = src.indexOf("const attachedFiles = await fetchOwnedFiles(");
    const linkIdx = src.indexOf("await linkFilesToMessage(fastify, attachedFiles.map((f) => f.id), userMessageId);");
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(linkIdx).toBeGreaterThan(fetchIdx);
  });

  it("injects attachmentTextBlock into the CURRENT turn's completion request only, never into what's persisted", () => {
    const src = read("handlers/chat.ts");
    const completionIdx = src.indexOf("const completionMessages:");
    const injectIdx = src.indexOf('lastMessage.content = `${attachmentTextBlock}${lastMessage.content}`;');
    expect(injectIdx).toBeGreaterThan(completionIdx);
  });

  it("linkFilesToMessage only ever writes message_id, never content the client could use to forge attribution", () => {
    const src = read("files/attachments.ts");
    expect(src).toContain('.update({ message_id: messageId })');
  });
});

describe("structured memory (source-level)", () => {
  it("memory_enabled gates BOTH context injection and extraction, not just one", () => {
    const src = read("handlers/chat.ts");
    expect(src).toContain("const memoryFacts = memoryEnabled ? rawMemoryFacts : [];");
    expect(src).toContain('const memorySummary = memoryEnabled ? await buildMemorySummary(');
    expect(src).toContain("if (memoryEnabled && shouldExtractMemory(");
  });

  it("date_of_birth is never fetched into chat context — only full_name", () => {
    const src = read("handlers/chat.ts");
    expect(src).toContain('.select("full_name, memory_enabled")');
    expect(src).not.toMatch(/\.select\([^)]*date_of_birth/);
  });

  it("extraction has an explicit no-secrets instruction AND a code-level backstop that doesn't just trust the model", () => {
    const src = read("memory/extractMemory.ts");
    expect(src).toMatch(/NEVER extract passwords, API keys, tokens/);
    expect(src).toContain(".filter((u) => !looksLikeSecret(u.fact))");
  });

  it("the client's only write path to user_memories is a DELETE — extraction always writes through supabaseAdmin (service role)", () => {
    const src = read("memory/extractMemory.ts");
    // Every actual upsert/delete against user_memories in this file must
    // be reached via fastify.supabaseAdmin.from(...), not a bare
    // .from(...) — a plain-client write path here would let anything
    // reusing this code run as the calling role instead of service_role.
    const fromCalls = [...src.matchAll(/(fastify\.supabaseAdmin\.)?from\("user_memories"\)\.(upsert|delete)\(/g)];
    expect(fromCalls.length).toBeGreaterThan(0);
    for (const m of fromCalls) expect(m[1]).toBe("fastify.supabaseAdmin.");
  });
});
