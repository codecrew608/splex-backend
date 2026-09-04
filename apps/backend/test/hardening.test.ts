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
    const full = read("routes/mediaGeneration.ts");
    // Scoped to just this function's body — the file also contains
    // handleAsyncMediaGeneration (video), which has its own separate durable-
    // persistence pins below, and a whole-file count would conflate the two.
    const src = full.slice(0, full.indexOf("export interface AsyncMediaJob"));
    const insertIdx = src.indexOf('content: "",\n      intent: decision.intentId,\n      complexity: decision.complexity,\n      status: "streaming",');
    expect(insertIdx).toBeGreaterThan(-1);
    const generateLoopIdx = src.indexOf("result = await params.generate(");
    expect(generateLoopIdx).toBeGreaterThan(insertIdx);
    expect((src.match(/updateMessageResult\(fastify, assistantMessageId,/g) ?? []).length).toBe(4); // no-candidate failure, no-mediaGenId failure, success, outer catch
  });

  it("handleSyncMediaGeneration records generated_media BEFORE the provider call too, closing the capability-count race (revisited per this pass)", () => {
    // FINDING: the durable-persistence fix above moved the MESSAGE row
    // earlier, but checkMediaQuota's daily/monthly cap counts
    // generated_media rows specifically, and that row was still only
    // recorded after generation finished — two concurrent requests could
    // both pass the check before either had written a row, both generate,
    // and both exceed the advertised per-day cap. Same fix as video/deep
    // research: record status='processing' up front.
    const src = read("routes/mediaGeneration.ts");
    const insertMsgIdx = src.indexOf('status: "streaming",\n    });');
    const recordIdx = src.indexOf("mediaGenId = await recordMediaGeneration(fastify, {");
    const generateLoopIdx = src.indexOf("result = await params.generate(");
    expect(insertMsgIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(insertMsgIdx);
    expect(generateLoopIdx).toBeGreaterThan(recordIdx);
    // Finalized via updateGeneratedMediaStatus (the SAME row) on every
    // exit path, not a second recordMediaGeneration insert.
    expect((src.match(/updateGeneratedMediaStatus\(fastify, mediaGenId,/g) ?? []).length).toBe(3); // no-candidate failure, success, outer catch
  });

  it("handleWebSearch inserts the placeholder before the search call and finalizes on every exit", () => {
    const src = read("research/handler.ts");
    const insertIdx = src.indexOf('content: "",\n      intent: decision.intentId,\n      complexity: decision.complexity,\n      status: "streaming",');
    expect(insertIdx).toBeGreaterThan(-1);
    const searchLoopIdx = src.indexOf("result = await performWebSearch(");
    expect(searchLoopIdx).toBeGreaterThan(insertIdx);
    expect((src.match(/updateMessageResult\(fastify, assistantMessageId,/g) ?? []).length).toBe(4); // no-result failure, no-mediaGenId failure, success, outer catch
  });

  it("handleWebSearch records generated_media BEFORE the search call too, closing the capability-count race (revisited per this pass)", () => {
    const src = read("research/handler.ts");
    const insertMsgIdx = src.indexOf('status: "streaming",\n    });');
    const recordIdx = src.indexOf("mediaGenId =\n      (await recordMediaGeneration(fastify, {");
    const searchLoopIdx = src.indexOf("result = await performWebSearch(");
    expect(insertMsgIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(insertMsgIdx);
    expect(searchLoopIdx).toBeGreaterThan(recordIdx);
    expect((src.match(/updateGeneratedMediaStatus\(fastify, mediaGenId,/g) ?? []).length).toBe(3); // no-result failure, success, outer catch
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
    const media = read("handlers/media.ts");
    expect((media.match(/content: FAILED_MESSAGE, status: "failed" \}\);/g) ?? []).length).toBe(2);
    expect(media).toContain('status: "complete"');
  });

  it("handleAsyncMediaGeneration (video's submission step) inserts the placeholder before params.submit and finalizes on every exit — closing the same 'insert at the end' gap this pass revisited", () => {
    // FINDING (production completion pass, item 7): unlike every OTHER
    // generation path in this file, this row used to be inserted only
    // AFTER params.submit() succeeded — a process death (or genuinely
    // unexpected exception) between a real job submission and that insert
    // left a live, potentially billable provider job with nothing linking
    // it to the user's conversation at all. generated_media's own row
    // (mediaId) was already upfront; this closes the matching gap for the
    // user-visible `messages` row.
    const full = read("routes/mediaGeneration.ts");
    const src = full.slice(full.indexOf("export async function handleAsyncMediaGeneration"));
    const insertIdx = src.indexOf('content: params.placeholderContent,\n    intent: decision.intentId,\n    complexity: decision.complexity,\n    status: "streaming",');
    expect(insertIdx).toBeGreaterThan(-1);
    const submitLoopIdx = src.indexOf("job = await params.submit(");
    expect(submitLoopIdx).toBeGreaterThan(insertIdx);
    // no-job (all candidates failed), success (routedModel now attached
    // post-fallback), and the catch-all — three distinct finalize sites,
    // none of them a fresh insert.
    expect((src.match(/updateMessageResult\(fastify, assistantMessageId,/g) ?? []).length).toBe(3);
    // The old insert-at-the-end call site must be gone from this function.
    expect(src).not.toMatch(/insertMessage\(fastify, \{\s*conversationId,\s*role: "assistant",\s*content: params\.placeholderContent,\s*intent: decision\.intentId,\s*complexity: decision\.complexity,\s*routedModel:/);
  });

  it("updateMessageResult never silently nulls credits_charged/routed_model when a caller omits them", () => {
    // A failure finalize (content + status only) must not wipe fields a
    // success finalize set for a DIFFERENT row, or that insert-time
    // already set — only touch what the caller actually passed.
    const src = read("persistence/messages.ts");
    expect(src).toContain("if (params.creditsCharged !== undefined) update.credits_charged = params.creditsCharged;");
    expect(src).toContain("if (params.routedModel !== undefined) update.routed_model = params.routedModel;");
  });

  it("the workflow orchestrator's final step inserts the placeholder before it runs and finalizes the SAME row on every exit — no more insert-at-the-end", () => {
    // FINDING (final production completion pass): a workflow's final step
    // is the only step whose output becomes a real, user-visible `messages`
    // row (earlier steps stay internal to workflow_steps) — but that row
    // used to be inserted by runSteps only AFTER executeStep had already
    // fully succeeded, the exact same "insert at the end" bug already fixed
    // everywhere else in this describe block. workflow.test.ts's behavioral
    // scenario 6 (plus the updated FAILED-workflow case in its "displayed
    // charge integrity" block) proves this against the fake; these pins
    // assert the shape exists in source for the one exit path the fake
    // can't easily trigger (a genuinely unexpected exception after
    // generation succeeds, e.g. computeRealCost/consumeCredits throwing).
    const src = read("cortex/workflow/orchestrator.ts");
    const insertIdx = src.indexOf('finalAssistantMessageId = await insertMessage(fastify, {');
    expect(insertIdx).toBeGreaterThan(-1);
    const executeStepCallIdx = src.indexOf("const result = await executeStep(");
    expect(executeStepCallIdx).toBeGreaterThan(insertIdx);
    // executeStep finalizes THIS SAME row (via its assistantMessageId
    // parameter) on: no-candidates, credit-gate-rejected, generation
    // error, aborted/empty, success, and the catch-all for anything else
    // (six sites) — plus runSteps' own follow-up patch of the cumulative
    // total once every step's cost is known (one more) — seven distinct
    // call sites total, none of them a fresh insert.
    expect((src.match(/updateMessageResult\(fastify, assistantMessageId,/g) ?? []).length).toBe(7);
    // The catch-all specifically — the one exit path with no anticipated
    // inline handling — must still finalize as failed rather than leaving
    // the row at 'streaming' forever.
    const finalBranchCatchIdx = src.indexOf('fastify.log.error({ err, stepIndex }, "workflow final step failed after generation");');
    expect(finalBranchCatchIdx).toBeGreaterThan(-1);
    expect(src.indexOf('status: "failed",', finalBranchCatchIdx)).toBeGreaterThan(finalBranchCatchIdx);
    // The old insert-at-the-end call site (fresh insertMessage with the
    // final content already known) must be gone from runSteps.
    expect(src).not.toMatch(/insertMessage\(fastify, \{\s*conversationId,\s*role: "assistant",\s*content: result\.output/);
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

describe("feedback system (source-level)", () => {
  it("persists before scheduling the notification email — never the other way around", () => {
    // Order is the whole point: a feedback submission must succeed even
    // when email delivery is down, misconfigured, or unset. Pinning the
    // TEXT order in source is a reasonable proxy for the actual control
    // flow here (both statements are sequential awaits in the same
    // function, not branches), and catches a future refactor that
    // reorders them.
    const src = read("handlers/feedback.ts");
    const insertIdx = src.indexOf('.from("feedback")\n    .insert({');
    const scheduleIdx = src.indexOf("scheduleBackground(");
    expect(insertIdx).toBeGreaterThan(-1);
    expect(scheduleIdx).toBeGreaterThan(insertIdx);
  });

  it("re-verifies conversation/message ownership server-side rather than trusting the client's ids", () => {
    const src = read("handlers/feedback.ts");
    expect(src).toContain("async function verifyOwnership(");
    expect(src).toContain("project.user_id !== userId");
  });

  it("the recipient email is never returned to the client", () => {
    const src = read("handlers/feedback.ts");
    // ok()'s body is only { id } — FEEDBACK_NOTIFICATION_EMAIL never
    // appears inside the HandlerResult returned to the caller, only
    // inside the scheduleBackground(...) closure that runs server-side
    // after the response has already been decided.
    expect(src).toContain("return ok({ id: feedbackId }, 201);");
  });

  it("the email adapter never throws past its own boundary and no API key is hardcoded", () => {
    const src = read("email/sendEmail.ts");
    expect(src).toContain("try {");
    expect(src).toContain("catch (err) {");
    expect(src).not.toMatch(/RESEND_API_KEY\s*[:=]\s*["'][A-Za-z0-9]/); // no literal key value, only the env-config reference
  });

  it("client-facing feedback rows carry no provider/model identifiers", () => {
    const src = read("handlers/feedback.ts");
    expect(src).not.toMatch(/openrouter_model_id|routedModel|creditsCharged|costUsd/);
  });
});

describe("accuracy verification wiring (source-level)", () => {
  it("the verification block is appended AFTER decision.category is known, not baked into the parallel-with-classification buildSystemPrompt call", () => {
    const src = read("handlers/chat.ts");
    const buildIdx = src.indexOf("let systemPromptText = buildSystemPrompt(");
    const decisionIdx = src.indexOf("const decision = await classificationPromise;");
    const appendIdx = src.indexOf("systemPromptText += reasoningVerificationBlock(decision.category);");
    expect(buildIdx).toBeGreaterThan(-1);
    expect(decisionIdx).toBeGreaterThan(buildIdx);
    expect(appendIdx).toBeGreaterThan(decisionIdx);
    // Reaches the same completionMessages the model actually sees.
    const completionIdx = src.indexOf("const completionMessages:");
    expect(completionIdx).toBeGreaterThan(appendIdx);
  });
});
