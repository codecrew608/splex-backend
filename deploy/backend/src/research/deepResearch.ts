import type { FastifyInstance } from "fastify";
import type { AuthedUser } from "../types/index.js";
import type { ModelRegistryRow } from "../types/index.js";
import type { SSEWriter } from "../sse/writer.js";
import { selectModelCandidates, resolveCortexVersion } from "../cortex/index.js";
import { completeOnce, fetchGenerationCost, withDeadline, isBalanceExceededError } from "../openrouter/client.js";
import { computeMediaCreditsCharged } from "../credits/mediaCost.js";
import { resolveCreditGateEstimate } from "../credits/costBand.js";
import { consumeCredits } from "../credits/consumeCredits.js";
import { insertMessage, updateMessageResult } from "../persistence/messages.js";
import { insertCortexDecision } from "../persistence/cortexDecisions.js";
import { checkMediaQuota, recordMediaGeneration, updateGeneratedMediaStatus } from "../credits/mediaQuota.js";
import { checkCredits, checkAndReserveCredits, settleDailyReservation, resolveCreditRejectionMessage } from "../credits/checkCredits.js";
import { wrapUntrustedContent, isSafeExternalUrl, BLOCKED_FETCH_DOMAINS } from "./security.js";
import type { Citation } from "./types.js";

const RESEARCH_COMPLEXITY = "complex" as const; // same rationale as workflow's STEP_COMPLEXITY: substantial work by nature

// Same fix as research/search.ts's searchSystemPrompt — without an
// explicit "today is" anchor, a model has no reliable way to tell a page's
// own historical topic apart from a live figure embedded in it.
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

interface StageSource {
  url: string;
  title: string;
  snippet: string;
}
interface StageEvidence {
  url: string;
  title: string;
  keyFacts: string[];
}

export interface RunDeepResearchParams {
  fastify: FastifyInstance;
  sse: SSEWriter;
  user: AuthedUser;
  conversationId: string;
  userMessageId?: string;
  query: string;
  contextBlock: string; // memory/file/project context, same as the rest of chat.ts — folded into the planning prompt only
  // The request's own abort signal (client disconnected / navigated away).
  // Without this a run kept issuing PAID provider calls for the remainder
  // of its 8-minute budget after the user had already gone, charging for a
  // report nobody would ever see. Optional so existing non-HTTP callers
  // (none today) still compile, but chat.ts always supplies it.
  abortSignal?: AbortSignal;
}

interface ResearchLimits {
  maxSearches: number;
  maxPages: number;
  costCeilingCredits: number;
}

async function getResearchLimits(fastify: FastifyInstance, planTier: "free" | "starter" | "pro"): Promise<ResearchLimits> {
  const { data } = await fastify.supabaseAdmin
    .from("plan_limits")
    .select("counter_type, limit_amount")
    .eq("plan_tier", planTier)
    .in("counter_type", ["research_max_searches", "research_max_pages", "research_cost"]);

  const byType = Object.fromEntries(
    (data ?? []).map((r: { counter_type: string; limit_amount: number | null }) => [r.counter_type, r.limit_amount]),
  );
  // Conservative fallback if the lookup fails — matches getWorkflowLimits'
  // own "stay conservative, never accidentally grant more" precedent.
  return {
    maxSearches: byType.research_max_searches ?? 3,
    maxPages: byType.research_max_pages ?? 4,
    costCeilingCredits: byType.research_cost ?? 3000,
  };
}

// One completion call, one cost/credit charge. Every stage funnels through
// this so billing logic (real cost -> credits -> consumeCredits) exists in
// exactly one place rather than five near-identical copies.
async function runStage(
  fastify: FastifyInstance,
  user: AuthedUser,
  model: ModelRegistryRow,
  intent: string,
  messages: Parameters<typeof completeOnce>[0]["messages"],
  opts: {
    maxTokens?: number;
    tools?: Parameters<typeof completeOnce>[0]["tools"];
    // Whole-run deadline, shared by every stage. Each individual call
    // already has its own 60s ceiling in openrouter/client.ts, but five
    // sequential stages plus tool calls could still stack to many minutes
    // with nothing bounding the total. Passing one signal through every
    // stage means the run as a whole cannot outlive its budget.
    signal?: AbortSignal;
  } = {},
): Promise<{ content: string; costCredits: number; costUsd: number }> {
  const { content, generationId } = await completeOnce({
    fastify,
    model: model.openrouter_model_id,
    messages,
    maxTokens: opts.maxTokens ?? 1500,
    tools: opts.tools,
    signal: opts.signal,
  });

  const costUsd = generationId ? await fetchGenerationCost(fastify, generationId) : 0;
  const costCredits = computeMediaCreditsCharged(fastify, costUsd);

  // Internal cost telemetry — never exposed to any client, exists purely
  // to answer "how much does SPLEX actually spend serving each tier" from
  // server logs. Deliberately includes model variant and whether a
  // provider-billed tool (web_search/web_fetch) was used, since a
  // :free-variant model does NOT mean $0 real cost the moment a tool call
  // is attached to it (OpenRouter bills web_search/web_fetch per-call,
  // independent of the underlying model's own price) — this is the exact
  // distinction a plain "which model" log would silently hide.
  fastify.log.info(
    {
      event: "provider_tool_cost",
      planTier: user.planTier,
      stage: intent,
      modelVariant: model.variant,
      toolsUsed: (opts.tools ?? []).map((t) => t.type),
      costUsd,
      costCredits,
    },
    "deep research stage cost",
  );

  await consumeCredits(fastify, {
    userId: user.id,
    creditCost: costCredits,
    intent,
    complexity: RESEARCH_COMPLEXITY,
    openrouterModelId: model.openrouter_model_id,
    realCostEstimate: costUsd,
    // The whole run reserves an upfront estimate against the daily pool
    // once (see checkAndReserveCredits in runDeepResearch) and trues it up
    // ONCE, in a finally block, from the run's real total — not
    // stage-by-stage. Passing skipDaily here on every stage is what makes
    // that true-up additive instead of double-counted: without it, each of
    // the ~5 stages would ALSO unconditionally add to daily_credits via
    // consume_daily_credits (which has no limit check at all — see its SQL
    // definition), on top of the reservation, silently overcharging the
    // daily pool by the stage total every single run.
    skipDaily: true,
  });

  return { content, costCredits, costUsd };
}

const RAW_CONTENT_LOG_CHARS = 500;

// Falling back silently used to mean a stage's failure was genuinely
// invisible in production (this is exactly what live testing caught: the
// searching stage silently produced zero sources, and diagnosing why
// required manually replaying the same call outside the app entirely).
// Every fallback is now logged with a bounded, truncated sample of the raw
// model output — enough to tell "wrapped in prose", "truncated
// mid-object", and "didn't call the tool" apart from each other without
// logging anything close to a full response body.
function parseJsonObject<T>(fastify: FastifyInstance, stage: string, raw: string, fallback: T): T {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    fastify.log.warn({ stage, rawSample: raw.slice(0, RAW_CONTENT_LOG_CHARS) }, "deep research: no JSON object found in model output, using fallback");
    return fallback;
  }
  try {
    return JSON.parse(match[0]) as T;
  } catch (err) {
    fastify.log.warn(
      { stage, err: err instanceof Error ? err.message : String(err), rawSample: match[0].slice(0, RAW_CONTENT_LOG_CHARS) },
      "deep research: JSON.parse failed on extracted object, using fallback",
    );
    return fallback;
  }
}

async function pickStageModel(fastify: FastifyInstance, category: string, planTier: AuthedUser["planTier"]): Promise<ModelRegistryRow | null> {
  const cortexVersion = resolveCortexVersion(planTier);
  const [model] = await selectModelCandidates(fastify, category, planTier, cortexVersion, RESEARCH_COMPLEXITY, 1);
  return model ?? null;
}

// The full five-stage pipeline: Planning -> Searching -> Reading sources ->
// Cross-checking -> Writing report (see migration 0016 and
// research/security.ts for the quota/cost model and the untrusted-content
// handling this relies on). Runs synchronously within the caller's open
// SSE connection/HTTP request — deliberately NOT an async job like video:
// bounded by research_max_searches/research_max_pages, a real run
// completes in well under the timeframes that pattern exists for, so it
// doesn't need persistence/resume machinery a page reload would need to
// recover (see chat.ts's workflow orchestrator for what that machinery
// actually costs when a capability genuinely needs it).
// Deep research runs many sequential provider calls. Without a single
// overall budget, a run could sit open for many minutes — holding a credit
// reservation and an SSE connection — while each individual call stayed
// within its own limit. 8 minutes is generous for a legitimate multi-stage
// report and still bounded.
const DEEP_RESEARCH_RUN_BUDGET_MS = 8 * 60_000;

export async function runDeepResearch(params: RunDeepResearchParams): Promise<void> {
  const { fastify, sse, user, conversationId, userMessageId, query, contextBlock } = params;

  // One deadline for the whole run, passed to every stage below — now
  // combined with the caller's own signal, so the run ends as soon as
  // EITHER the budget expires or the client goes away, whichever is first.
  // Each individual stage is separately capped at 60s inside
  // openrouter/client.ts; this bounds the total and honours cancellation.
  const runDeadline = withDeadline(params.abortSignal, DEEP_RESEARCH_RUN_BUDGET_MS);

  const quota = await checkMediaQuota(fastify, user.id, user.planTier, "deep_research");
  if (!quota.allowed) {
    const message =
      quota.blockedBy === "monthly"
        ? "Your current plan limit has been reached. Please try again later or upgrade your plan."
        : quota.limit === 0
          ? "Deep research is a Starter feature — upgrade to unlock it."
          : "Your current usage limit has been reached. Please try again later.";
    sse.error({ message });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  const limits = await getResearchLimits(fastify, user.planTier);

  // Pre-flight: can this user's pool even afford the worst case? Mirrors
  // every other capability's estimate-then-real-charge pattern — this is
  // a ceiling check, not what actually gets charged (see below).
  // monthlyOnly: costCeilingCredits (research_cost) is a large worst-case
  // number sized against the monthly pool, not a realistic single charge —
  // see checkCredits' own doc comment for the live-caught bug this avoids.
  const canAfford = await checkCredits(fastify, user.id, limits.costCeilingCredits, { monthlyOnly: true });
  if (!canAfford) {
    sse.error({ message: await resolveCreditRejectionMessage(fastify, user.id, limits.costCeilingCredits, { monthlyOnly: true }) });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  const [planningModel, searchModel, reasoningModel, writingModel] = await Promise.all([
    pickStageModel(fastify, "general", user.planTier),
    pickStageModel(fastify, "web_search", user.planTier),
    pickStageModel(fastify, "reasoning", user.planTier),
    pickStageModel(fastify, "writing", user.planTier),
  ]);

  if (!planningModel || !searchModel) {
    sse.error({ message: "Deep research is temporarily unavailable, please try again shortly." });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  // Atomic per-request reservation against the DAILY pool. The two checks
  // above (checkCredits monthlyOnly, checkMediaQuota) are both plain reads
  // with no reservation, so N concurrent runs could each read the same
  // pre-charge snapshot and all be admitted — the exact TOCTOU race
  // checkAndReserveCredits/reserve_daily_credits exists to close for every
  // other capability (image/ppt/audio/web_search all gate this way). Deep
  // research was the one capability still missing it, having only the
  // large, monthly-sized costCeilingCredits check above (deliberately NOT
  // sized to fit the daily pool — see its own comment on the live-caught
  // bug that shaped it). gateEstimate here is the same normal
  // per-unit-of-work size every other capability reserves, not the
  // worst-case ceiling, so this does not reproduce that bug.
  // settleDailyReservation() in the finally below trues it up to the real
  // total, which legitimately can exceed the estimate for a multi-stage
  // run — same "estimate now, true up later" shape as everywhere else.
  const gateEstimate = await resolveCreditGateEstimate(fastify, RESEARCH_COMPLEXITY, user.planTier);
  const gate = await checkAndReserveCredits(fastify, user.id, gateEstimate);
  if (!gate.allowed) {
    sse.error({ message: await resolveCreditRejectionMessage(fastify, user.id, gateEstimate) });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }

  // Row created (status='processing') BEFORE any provider call, not after
  // completion as this previously did — same fix as
  // handleAsyncMediaGeneration's video path, for the same reason:
  // checkMediaQuota's "3/day" count only sees rows that already exist, so
  // creating the row now (rather than only at completion) closes the
  // matching race on the CAPABILITY COUNT side — two concurrent runs now
  // both count against the cap immediately, instead of both racing a check
  // that saw zero rows because neither had finished yet.
  const mediaIdOrNull = await recordMediaGeneration(fastify, { userId: user.id, messageId: null, kind: "deep_research", status: "processing", prompt: query });
  if (!mediaIdOrNull) {
    await settleDailyReservation(fastify, user.id, gate.dailyReserved, 0);
    sse.error({ message: "Deep research is temporarily unavailable, please try again shortly." });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
    return;
  }
  // Rebound as a plain `string` (not `string | null`) so the closures
  // below (writeFinalReport/finishEarly) and the catch block, all defined
  // later in this function, don't need their own redundant null checks —
  // mediaIdOrNull's guard above already proved it, TS just can't see that
  // proof across a function-declaration boundary.
  const mediaId: string = mediaIdOrNull;

  // FIX (durable persistence — the "response disappears after
  // navigation" bug, at its highest-risk site): a deep research run can
  // legitimately take up to DEEP_RESEARCH_RUN_BUDGET_MS (8 minutes).
  // Previously the messages row was only ever inserted in writeFinalReport,
  // after all 5 stages finished — meaning for the entire run, however
  // long it took, there was NO row a page reload could find, even though
  // real provider cost was already being incurred stage by stage. Insert
  // it now, alongside the mediaId row above, and have writeFinalReport's
  // two branches (and the catch block below, which previously finalized
  // mediaId's row but never this one) update it in place instead of
  // inserting fresh.
  const assistantMessageId = await insertMessage(fastify, {
    conversationId,
    role: "assistant",
    content: "",
    intent: "deep_research",
    complexity: RESEARCH_COMPLEXITY,
    status: "streaming",
  });

  let totalCreditsCharged = 0;
  const seenUrls = new Set<string>();

  function overCostCeiling(): boolean {
    return totalCreditsCharged >= limits.costCeilingCredits;
  }

  try {
    // ---- Stage 1: Planning ----
    sse.researchStage({ stage: "planning" });
    const planningResult = await runStage(
      fastify,
      user,
      planningModel,
      "deep_research_planning",
      [
        {
          role: "system",
          content: `Break the user's research question into focused, independently-searchable sub-questions. Use between 1 and ${limits.maxSearches} sub-questions — fewer for a narrow question, more only if the topic genuinely has that many distinct facets. Respond with ONLY JSON: {"subQuestions": string[]}`,
        },
        { role: "user", content: contextBlock ? `${contextBlock}\n\nResearch question: ${query}` : query },
      ],
      { maxTokens: 400, signal: runDeadline },
    );
    totalCreditsCharged += planningResult.costCredits;

    const plan = parseJsonObject<{ subQuestions?: unknown }>(fastify, "planning", planningResult.content, {});
    const subQuestions = (Array.isArray(plan.subQuestions) ? plan.subQuestions : [query])
      .filter((q): q is string => typeof q === "string" && q.trim().length > 0)
      .slice(0, limits.maxSearches);
    if (subQuestions.length === 0) subQuestions.push(query);

    // ---- Stage 2: Searching ----
    sse.researchStage({ stage: "searching" });
    const searchResult = await runStage(
      fastify,
      user,
      searchModel,
      "deep_research_searching",
      [
        {
          role: "system",
          content:
            `Today's date is ${todayIso()}. Use the web_search tool to find relevant, authoritative sources for each sub-question below. Prefer primary/official sources over aggregators or blogs where possible, and prefer the most recently-dated results for anything time-sensitive. ` +
            "After using the tool, your FINAL message must be ONLY the JSON object below — no prose, no code fences, no commentary before or after it. " +
            "Keep each snippet under 200 characters, paraphrased in your own words rather than a long verbatim quote, and make sure every string value is valid JSON — properly escape any quotation marks, backslashes, or line breaks: " +
            '{"findings": [{"subQuestion": string, "sources": [{"url": string, "title": string, "snippet": string}]}]}',
        },
        { role: "user", content: subQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n") },
      ],
      {
        // Up to maxSearches sub-questions x several sources each, as JSON —
        // 2000 gave the model no headroom on a multi-sub-question run and
        // risked exactly the kind of truncated-JSON parse failure that
        // silently produced zero sources during live testing.
        maxTokens: 3000,
        tools: [{ type: "openrouter:web_search", max_results: 6, max_total_results: 20, excluded_domains: BLOCKED_FETCH_DOMAINS }],
        signal: runDeadline,
      },
    );
    totalCreditsCharged += searchResult.costCredits;

    const searchFindings = parseJsonObject<{ findings?: unknown }>(fastify, "searching", searchResult.content, {});
    const rawSources: StageSource[] = Array.isArray(searchFindings.findings)
      ? searchFindings.findings.flatMap((f) => (Array.isArray((f as { sources?: unknown }).sources) ? (f as { sources: StageSource[] }).sources : []))
      : [];

    // Client-side enforcement of the page-fetch ceiling — not left to the
    // model's own judgment. Dedup by URL and drop anything that fails the
    // same safety check citations get before it's ever handed to a tool
    // or rendered.
    const topSources: StageSource[] = [];
    for (const s of rawSources) {
      if (topSources.length >= limits.maxPages) break;
      if (typeof s?.url !== "string" || !isSafeExternalUrl(s.url) || seenUrls.has(s.url)) continue;
      seenUrls.add(s.url);
      topSources.push({ url: s.url, title: s.title || s.url, snippet: s.snippet ?? "" });
    }

    if (overCostCeiling() || topSources.length === 0) {
      return await finishEarly("Research was limited before source reading could complete.");
    }

    // ---- Stage 3: Reading sources ----
    sse.researchStage({ stage: "reading_sources" });
    const readResult = await runStage(
      fastify,
      user,
      searchModel,
      "deep_research_reading",
      [
        {
          role: "system",
          content:
            `Today's date is ${todayIso()}. Use the web_fetch tool to retrieve and extract key facts from each URL listed below, relevant to the research question. When a page mixes historical and current data (e.g. a "2023 price history" page that also shows today's live figure), extract which is which rather than treating the page's own topic date as "now". ` +
            "After using the tool, your FINAL message must be ONLY the JSON object below — no prose, no code fences, no commentary before or after it. " +
            "Keep each fact under 200 characters, paraphrased in your own words rather than a long verbatim quote, and make sure every string value is valid JSON — properly escape any quotation marks, backslashes, or line breaks: " +
            '{"evidence": [{"url": string, "title": string, "keyFacts": string[]}]}',
        },
        {
          role: "user",
          content: `Research question: ${query}\n\nFetch these URLs:\n${topSources.map((s) => `- ${s.url} (${s.title})`).join("\n")}`,
        },
      ],
      {
        // Same truncation-headroom reasoning as the searching stage — up to
        // maxPages URLs' worth of keyFacts arrays as JSON.
        maxTokens: 3200,
        tools: [{ type: "openrouter:web_fetch", max_content_tokens: 2000, blocked_domains: BLOCKED_FETCH_DOMAINS }],
        signal: runDeadline,
      },
    );
    totalCreditsCharged += readResult.costCredits;

    const readFindings = parseJsonObject<{ evidence?: unknown }>(fastify, "reading_sources", readResult.content, {});
    const evidence: StageEvidence[] = Array.isArray(readFindings.evidence)
      ? readFindings.evidence.filter((e): e is StageEvidence => typeof (e as StageEvidence)?.url === "string")
      : [];

    if (overCostCeiling() || evidence.length === 0) {
      return await finishEarly("Research was limited before cross-checking could complete.", evidence);
    }

    // ---- Stage 4: Cross-checking ----
    sse.researchStage({ stage: "cross_checking" });
    const evidenceBlock = wrapUntrustedContent(
      evidence.map((e) => ({ url: e.url, title: e.title, content: e.keyFacts.join("\n") })),
    );
    const crossCheckModel = reasoningModel ?? searchModel;
    const crossCheckResult = await runStage(
      fastify,
      user,
      crossCheckModel,
      "deep_research_cross_check",
      [
        {
          role: "system",
          content:
            'Review this evidence for agreements, conflicts, and gaps relevant to the research question. Respond with ONLY JSON: {"agreements": string[], "conflicts": string[], "uncertainties": string[]}',
        },
        { role: "user", content: `Research question: ${query}\n\n${evidenceBlock}` },
      ],
      { maxTokens: 800, signal: runDeadline },
    );
    totalCreditsCharged += crossCheckResult.costCredits;
    const crossCheck = parseJsonObject<{ agreements?: unknown; conflicts?: unknown; uncertainties?: unknown }>(fastify, "cross_checking", crossCheckResult.content, {});

    if (overCostCeiling()) {
      return await finishEarly("Research was limited before the final report could be written.", evidence, crossCheck);
    }

    // ---- Stage 5: Writing report ----
    await writeFinalReport(evidence, crossCheck);
    return;

    // Closures below share stage-local state (query, evidence collected so
    // far, citations, credits charged) — kept as inner functions rather
    // than threading a dozen params through a shared helper, since both
    // exit paths (normal completion and early-abort) need the exact same
    // "write whatever we have, charge nothing new beyond stage 5, persist,
    // respond" tail.
    async function writeFinalReport(
      finalEvidence: StageEvidence[],
      finalCrossCheck: { agreements?: unknown; conflicts?: unknown; uncertainties?: unknown },
      limitedNote?: string,
    ): Promise<void> {
      sse.researchStage({ stage: "writing_report" });

      // Citations sent to the client are derived from the exact same list,
      // in the exact same order, that the writing model is told to cite as
      // [1]/[2]/... — built from anything else (e.g. the broader set of
      // URLs the searching stage merely found, which can differ from what
      // reading-sources actually managed to fetch), the numbers in the
      // report body and the source chips rendered in the UI could point at
      // different URLs.
      const citations: Citation[] = finalEvidence.map((e) => ({
        url: e.url,
        title: e.title || e.url,
        snippet: e.keyFacts.join(" "),
      }));

      // Zero real evidence means there is nothing to ground a report in.
      // Calling the writing model anyway — even with an honest "note" in
      // the prompt — risks exactly what live testing caught: a model asked
      // to write a "research report" falls back on its own pretrained
      // knowledge and dresses it up with a plausible-looking but entirely
      // fabricated numbered reference list, which violates "every claim
      // traceable to a source" far more seriously than just returning a
      // plain, honest, uncited answer would. Skip the LLM call entirely in
      // this case — no stage-5 cost is incurred, matching "never charge
      // for work that didn't happen."
      if (finalEvidence.length === 0) {
        const content = [
          "I wasn't able to find and verify live web sources for this research question right now — OpenRouter's search tool didn't return usable results this time.",
          "Rather than guess, I'm not going to present unverified information as a sourced research report. You're welcome to try again, or ask me directly as a normal question if general background knowledge (not live-verified) would still be useful.",
        ].join(" ");

        // Finalizes the row inserted up front, rather than inserting a
        // fresh one — see its creation comment above.
        await updateMessageResult(fastify, assistantMessageId, {
          content,
          creditsCharged: totalCreditsCharged,
          status: "complete",
        });

        // Updates the row created up front (status='processing') rather
        // than inserting a fresh one — see its creation comment above.
        await updateGeneratedMediaStatus(fastify, mediaId, {
          status: "completed",
          messageId: assistantMessageId,
          creditsCharged: totalCreditsCharged,
        });

        await insertCortexDecision(fastify, {
          messageId: assistantMessageId,
          intent: "deep_research",
          complexity: RESEARCH_COMPLEXITY,
          capabilities: ["deep_research", "web_search"],
          category: "deep_research",
          reason: "Multi-step research workflow: planning, searching, reading sources, cross-checking, and synthesis.",
          modelSelected: "none — no usable sources found",
        });

        sse.token({ delta: content });
        // totalCreditsCharged is real, persisted (insertMessage above,
        // consumeCredits below) — never sent to the client; SPLEX credits
        // are an internal metering unit, not a product-facing number.
        sse.done({ messageId: assistantMessageId, conversationId, userMessageId });
        sse.end();
        return;
      }

      const evidenceBlock2 = wrapUntrustedContent(
        finalEvidence.map((e) => ({ url: e.url, title: e.title, content: e.keyFacts.join("\n") })),
      );
      const model = writingModel ?? planningModel;
      const writeResult = await runStage(
        fastify,
        user,
        model as ModelRegistryRow,
        "deep_research_writing",
        [
          {
            role: "system",
            content: [
              `Today's date is ${todayIso()}. Write a clear, well-organized research report answering the research question, grounded STRICTLY in the ${finalEvidence.length} numbered source(s) provided below.`,
              "If a source mixes historical data with a current figure, be explicit about which is which — never present an old, differently-dated figure as if it were current just because it appeared on a page about a past period.",
              `Use inline numeric references like [1], [2] that map exactly to those ${finalEvidence.length} source(s) — never invent, assume, or cite a source that is not one of them.`,
              "If the evidence doesn't fully answer some part of the question, say so plainly instead of filling the gap from general knowledge.",
              "Explicitly call out any conflicting information or genuine uncertainty rather than picking one claim arbitrarily.",
              limitedNote ? `Note: ${limitedNote} Write the best report possible from what was gathered, and be upfront that research depth was limited.` : "",
              "Plain markdown. Do not include a separate 'Sources' section — that is rendered separately by the client.",
            ]
              .filter(Boolean)
              .join(" "),
          },
          {
            role: "user",
            content: `Research question: ${query}\n\n${evidenceBlock2}\n\nCross-check findings:\nAgreements: ${JSON.stringify(finalCrossCheck.agreements ?? [])}\nConflicts: ${JSON.stringify(finalCrossCheck.conflicts ?? [])}\nUncertainties: ${JSON.stringify(finalCrossCheck.uncertainties ?? [])}`,
          },
        ],
        { maxTokens: 2000, signal: runDeadline },
      );
      totalCreditsCharged += writeResult.costCredits;

      // Finalizes the row inserted up front, rather than inserting a fresh
      // one — see its creation comment above.
      await updateMessageResult(fastify, assistantMessageId, {
        content: writeResult.content,
        creditsCharged: totalCreditsCharged,
        routedModel: model?.openrouter_model_id,
        status: "complete",
      });

      await updateGeneratedMediaStatus(fastify, mediaId, {
        status: "completed",
        messageId: assistantMessageId,
        creditsCharged: totalCreditsCharged,
      });

      await insertCortexDecision(fastify, {
        messageId: assistantMessageId,
        intent: "deep_research",
        complexity: RESEARCH_COMPLEXITY,
        capabilities: ["deep_research", "web_search"],
        category: "deep_research",
        reason: "Multi-step research workflow: planning, searching, reading sources, cross-checking, and synthesis.",
        modelSelected: model?.openrouter_model_id ?? "unknown",
      });

      sse.token({ delta: writeResult.content });
      // totalCreditsCharged is real, persisted — never sent to the client.
      sse.done({
        messageId: assistantMessageId,
        conversationId,
        userMessageId,
        citations,
      });
      sse.end();
    }

    async function finishEarly(note: string, ev: StageEvidence[] = [], cc: { agreements?: unknown; conflicts?: unknown; uncertainties?: unknown } = {}): Promise<void> {
      await writeFinalReport(ev, cc, note);
    }
  } catch (err) {
    fastify.log.error({ err }, "deep research failed");
    // Whatever real cost was actually incurred before the failure has
    // already been charged stage-by-stage above — this only records the
    // attempt for quota purposes (status='failed' -> excluded from the
    // daily count, matching every other capability's "a failure never
    // consumes a quota slot" rule) and tells the user plainly. Updates the
    // row created up front (status='processing') rather than inserting a
    // fresh one — see its creation comment above.
    await updateGeneratedMediaStatus(fastify, mediaId, { status: "failed", errorMessage: "research pipeline failed" });
    const failedMessage = isBalanceExceededError(err)
      ? "This AI service is temporarily unavailable. Please try again shortly."
      : "Deep research failed, please try again.";
    // Same fix as every other capability's catch block: previously this
    // path finalized mediaId's generated_media row but NEVER the messages
    // row — an outright pipeline failure (not just a disconnect) left the
    // conversation with no assistant row at all. Best-effort; never masks
    // the error above.
    await updateMessageResult(fastify, assistantMessageId, { content: failedMessage, status: "failed" }).catch(() => {});
    sse.error({ message: failedMessage });
    sse.done({ blocked: true, conversationId, userMessageId });
    sse.end();
  } finally {
    // Trues up the daily reservation taken above from the small upfront
    // estimate to the real total actually spent across every stage that
    // ran (0 if the very first stage threw before charging anything) —
    // runs on every exit path: normal completion, an early finishEarly()
    // exit, or the catch above. See checkAndReserveCredits' own doc
    // comment for why this exact shape (try/finally, not scattered at
    // each return) is required.
    await settleDailyReservation(fastify, user.id, gate.dailyReserved, totalCreditsCharged);
  }
}
