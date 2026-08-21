import type { FastifyInstance } from "fastify";
import { completeOnce, fetchGenerationCost, type ChatMessageParam } from "../openrouter/client.js";
import { isSafeExternalUrl, BLOCKED_FETCH_DOMAINS } from "./security.js";
import type { WebSearchResult } from "./types.js";

// Live testing caught the model citing a page titled "Bitcoin Price 2023"
// and reporting its embedded live-price snippet as "as of December 31,
// 2023" — a real page can mix a historical topic with an up-to-the-minute
// number, and without being told what "now" actually is, the model has no
// reliable way to tell which parts of a source are current. Giving it
// today's date directly, rather than leaving it to infer recency from
// context clues, is what actually closes that gap.
function searchSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You answer the user's question. Today's date is ${today}. You have a web_search tool available — use it when the question needs current, external, or verifiable information (news, prices, recent events, live status, anything your own knowledge might be outdated on or doesn't cover). Do not use it for questions your own knowledge already answers well (general concepts, how things work, math, writing help).

If you do search, ground your answer in what you found and cite it naturally. Some pages mix a historical topic with a live figure (e.g. a "2023 price history" page that also shows today's live price) — when reporting a time-sensitive value like a price, prefer the most recently-dated data point and say plainly that it's current as of today, not the page's own topic date. If you don't search, just answer normally — do not claim to have searched when you didn't.`;
}

const MAX_RESULTS_PER_SEARCH = 6;
const MAX_TOTAL_RESULTS = 15; // hard ceiling across every search call OpenRouter makes within this one request
const MAX_TOKENS = 1200;

// One synchronous, tool-enabled completion call — this is the entire
// implementation of ordinary web search and news. The model decides
// whether/how many times to search (bounded by MAX_TOTAL_RESULTS,
// enforced by OpenRouter itself, not policed here after the fact);
// OpenRouter executes the tool server-side and feeds results back into
// the same completion. See openrouter/client.ts's WebSearchTool doc
// comment for the wire contract this relies on.
export async function performWebSearch(
  fastify: FastifyInstance,
  model: string,
  query: string,
): Promise<WebSearchResult> {
  const messages: ChatMessageParam[] = [
    { role: "system", content: searchSystemPrompt() },
    { role: "user", content: query },
  ];

  const { content, generationId, citations } = await completeOnce({
    fastify,
    model,
    messages,
    maxTokens: MAX_TOKENS,
    tools: [
      {
        type: "openrouter:web_search",
        max_results: MAX_RESULTS_PER_SEARCH,
        max_total_results: MAX_TOTAL_RESULTS,
        excluded_domains: BLOCKED_FETCH_DOMAINS,
      },
    ],
  });

  // Filter here too (not just at the tool-config layer): excluded_domains
  // controls what OpenRouter's search will surface, but this is the last
  // point before a citation URL is handed to a caller that will render it
  // as a clickable link — never trust a single layer alone for something
  // that becomes an <a href>.
  const safeCitations = citations
    .filter((c) => isSafeExternalUrl(c.url))
    .map((c) => ({ url: c.url, title: c.title || c.url, snippet: c.content }));

  const costUsd = generationId ? await fetchGenerationCost(fastify, generationId) : 0;

  return {
    text: content,
    citations: safeCitations,
    costUsd,
    searched: safeCitations.length > 0,
  };
}
