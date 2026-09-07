// Weighted evidence layer for intent classification.
//
// WHY THIS EXISTS, on top of the keyword table in intents.ts.
//
// That table is binary: a pattern is "strong" or "weak", exactly one strong
// hit decides, and anything else pays for an LLM classifier round trip. Two
// things follow from that shape, and both were measured rather than guessed:
//
//   1. It is brittle at the edges. Against 115 naturally-varied requests
//      (bench/routing/cases-v2.jsonl — conversational phrasing, terse
//      fragments, long narratives, eight languages, misspellings) it routed
//      48.7% correctly, against 77.5% on the more formally-phrased corpus.
//      Real users write like the first set.
//   2. 44 of its 59 misses were not WRONG answers — they were no answer at
//      all, falling through to the classifier. That round trip costs a
//      measured median 4,026 ms of time-to-first-token (p<0.0001), so a
//      fall-through is a latency bug as much as a routing one.
//
// The failure is therefore mostly missing CONFIDENCE, not missing
// correctness: several weak signals that together clearly indicate a domain
// were being discarded because none of them was individually "strong".
//
// This layer accumulates graded evidence instead. Each signal carries a
// weight; a domain's score is the sum of what matched; a domain wins only if
// it clears an absolute floor AND beats the runner-up by a margin. Below
// either threshold it declines to answer and the LLM classifier still runs —
// the point is to stop paying for that round trip when the evidence is
// actually clear, not to force a guess when it isn't.
//
// It is applied AFTER the existing table (see classify.ts), so it can only
// convert former fall-throughs into decisions. Nothing the old logic already
// routed correctly can regress through this file.

export interface WeightedSignal {
  re: RegExp;
  w: number;
}

export interface DomainProfile {
  category: string;
  /** Intent id borrowed for capability lookup, so this layer adds no new taxonomy. */
  intentId: string;
  signals: WeightedSignal[];
  /** A match here disqualifies the domain outright, whatever else scored. */
  vetoes?: RegExp[];
}

const s = (re: RegExp, w: number): WeightedSignal => ({ re, w });

// --- thresholds -------------------------------------------------------------
// Tuned against the shape of the evidence, not against the case list: FLOOR is
// "one decisive signal, or two corroborating ones", MARGIN is "the winner is
// not in a near-tie with a different domain". Both are deliberately
// conservative — a wrong confident answer is worse than a slow correct one.
export const SCORE_FLOOR = 3;
export const SCORE_MARGIN = 1.5;

// Language-agnostic evidence. These fire the same way whatever language the
// surrounding sentence is in, which is most of why this layer handles
// multilingual input at all: an arithmetic operator is an arithmetic operator
// in every script.
const CODE_FENCE = s(/```|\bdef \w+\(|\bfunction \w+\(|=>|;\s*$|\bimport \w+|\bclass \w+\b/m, 3);
const STACK_TRACE = s(/\b(?:Traceback|Exception|SyntaxError|TypeError|ValueError|NullPointer|segfault|panic:|errno|exit code \d+)\b/i, 4);
const FILE_EXT = s(/\.(?:py|js|ts|tsx|jsx|go|rs|java|rb|php|c|cpp|h|sh|sql|json|yaml|yml|toml)\b/i, 2);
const SHELL = s(/\b(?:npm|pip|cargo|docker|kubectl|git|apt|brew|yarn|pnpm)\s+\w+/i, 3);

export const DOMAINS: DomainProfile[] = [
  {
    category: "coding",
    intentId: "code_generation",
    signals: [
      CODE_FENCE, STACK_TRACE, FILE_EXT, SHELL,
      s(/\b(?:function|method|class|variable|array|list|dict|struct|interface|module|package|library|api|endpoint|database|query|schema|compiler|runtime|thread|async|await|pointer|closure|regex)\b/i, 2),
      // Weight 2, not 3, and deliberately below SCORE_FLOOR: naming a
      // language or framework is not by itself a coding task. "What is React
      // and why do people use it?" is a technology overview and belongs in
      // general; "the difference between a list and a tuple in Python" is a
      // coding question because a second coding noun corroborates it. This
      // signal therefore needs a partner to decide anything.
      s(/\b(?:python|javascript|typescript|java|golang|rust|ruby|php|swift|kotlin|scala|haskell|sql|bash|css|html|react|django|flask|node|numpy|pandas)\b/i, 2),
      s(/\b(?:debug|refactor|implement|compile|deploy|merge|commit|lint|unit test|stack ?trace)\b/i, 3),
      s(/\b(?:time|space)\s+complexity\b|\bbig[- ]?o\b|\bO\(n/i, 4),
      s(/\b(?:algorithm|data structure|recursion|iteration|memoi[sz]|concurrency|race condition|deadlock|mutex|thread-?safe)\b/i, 3),
      s(/\bcode\b/i, 2),
      s(/\b(?:bug|error|exception|crash(?:es|ing)?|fails?|broken)\b/i, 1),
      // Non-English cues. Deliberately narrow: high-signal domain nouns only,
      // never generic verbs, which collide across domains.
      s(/\b(?:código|codigo|função|funcao|función|funcion|fonction|Funktion|programmieren|programación)\b/i, 4),
      s(/代码|函数|编程|报错|कोड|फ़ंक्शन|код|функци|программ|برمج|كود|コード|関数/u, 4),
    ],
  },
  {
    category: "math",
    intentId: "math_reasoning",
    signals: [
      s(/\d\s*[+*/^×÷]\s*-?\d/, 4),
      s(/\d\s+[-−]\s+\d/, 4),
      s(/\b(?:sin|cos|tan|ln|log|sqrt|exp|mod)\s*\(/i, 4),
      s(/\b\d+(?:\.\d+)?\s*(?:%|percent|per cent)\b/i, 3),
      s(/\b(?:calculate|compute|solve|simplify|evaluate|factor(?:ise|ize)?|derivative|integral|equation|arithmetic|algebra|geometry|probability|permutation|combination)\b/i, 3),
      s(/\b(?:sum|total|average|mean|median|difference|product|quotient|remainder|ratio|proportion|percentage)\b/i, 2),
      s(/\b(?:how much|how many|how far|how fast|how long)\b/i, 2),
      s(/\b(?:km|kilomet|met(?:er|re)s?|cm|mm|miles?|feet|inch|kg|grams?|lbs?|litres?|liters?|ml|gallons?|celsius|fahrenheit|volts?|watts?|ohms?|amps?)\b/i, 2),
      s(/\b(?:cheaper|better deal|per unit|odds|interest|compound|churn|margin|markup|discount|profit|revenue|ltv|cac|arpu)\b/i, 2),
      // Geometry and mathematical constants. Weight 2 so a stray "area" or
      // "square" cannot decide alone — "the area of France" stays general —
      // but "the area of a circle" plus "pi" corroborate to a decision.
      s(/\b(?:pi|circle|triangle|rectangle|sphere|cylinder|polygon|angle|radius|diameter|circumference|perimeter|hypotenuse|area|volume)\b/i, 2),
      // Two or more standalone numbers in one message: on its own this is
      // weak (dates, counts, versions all look like this), which is exactly
      // what a weight of 1 is for.
      s(/(?:[^\d]|^)\d+(?:\.\d+)?(?:[^\d]|$).*(?:[^\d]|^)\d+(?:\.\d+)?(?:[^\d]|$)/, 1),
      s(/\b(?:cuánto|cuanto|combien|wie ?viel|quanto|quanti|ile|скольк|كم|कितन)\b/i, 3),
      s(/\b(?:más|mas|plus|mal|meno|menos|mais|geteilt|dividido)\b\s*\d|\d\s*\b(?:más|mas|plus|mal|menos|mais)\b/i, 3),
      s(/多少|等于|计算|कितना|जोड़|сколько будет|احسب/u, 3),
    ],
    vetoes: [
      // A bare year or a title is not arithmetic. Without this the
      // two-numbers signal turns "What is 1984 about?" into a sum.
      /^\s*what is \d{4} about/i,
    ],
  },
  {
    category: "writing",
    intentId: "creative_writing",
    signals: [
      s(/\b(?:write|draft|compose|rewrite|reword|rephrase|edit|polish|proofread)\b/i, 2),
      s(/\b(?:email|e-mail|letter|cover letter|poem|haiku|limerick|story|essay|blog ?post|article|newsletter|caption|tagline|subject lines?|headline|memo|speech|script|copy|bio|paragraph)\b/i, 3),
      s(/\b(?:tone|voice|style|formal|informal|casual|persuasive|concise|friendly)\b/i, 2),
      s(/\btranslate\b|\btranslation\b|\bin (?:spanish|french|german|hindi|japanese|chinese|italian|portuguese|russian|arabic)\b/i, 3),
      s(/\b(?:poema|poème|Gedicht|carta|lettre|Brief|redacta|écris|schreibe|escreva|напиши|اكتب)\b/i, 4),
    ],
    vetoes: [
      // "write a function" is coding, not prose, whatever else matched.
      /\bwrite\s+(?:a|an|some)?\s*(?:python|js|javascript|typescript|go|rust|sql)?\s*(?:function|script|program|class|component|api|endpoint|query|method)\b/i,
    ],
  },
  {
    category: "documents",
    intentId: "summarization",
    signals: [
      s(/\bsummari[sz]e\b|\bsummary\b|\btl;?dr\b|\bgist\b/i, 4),
      s(/\bkey (?:points|takeaways|findings)\b/i, 4),
      s(/\b(?:this|the|attached|uploaded|following)\s+(?:document|doc|pdf|file|report|contract|agreement|paper|csv|spreadsheet|transcript)\b/i, 4),
      s(/\b(?:extract|pull out|pull the|find in|according to the)\b/i, 2),
      s(/\b(?:resumen|résumé|resumo|Zusammenfassung|сводка|краткое|ملخص)\b/i, 4),
      s(/总结|概括|सारांश|दस्तावेज़/u, 4),
    ],
  },
  {
    category: "reasoning",
    intentId: "data_analysis",
    signals: [
      s(/\bexplain your (?:reasoning|thinking|working|logic)\b/i, 5),
      s(/\bstep[- ]by[- ]step\b/i, 3),
      s(/\b(?:logically|deduce|infer|follows? that|therefore|premise|conclusion|fallacy|contradiction|paradox|syllogism)\b/i, 3),
      s(/\bwhat(?:'s| is) wrong with (?:this|the) argument\b/i, 5),
      s(/\b(?:puzzle|riddle|brain ?teaser)\b/i, 3),
      s(/\b(?:trade[- ]?offs?|pros and cons|weigh up|which is better|should (?:i|we))\b/i, 2),
      s(/\banaly[sz]e (?:this|my) data\b|\b(?:dataset|csv)\b/i, 2),
    ],
  },
  {
    category: "web_search",
    intentId: "web_search",
    signals: [
      s(/\b(?:current|latest|today'?s|right now|at the moment|this week|recent(?:ly)?|breaking)\b/i, 3),
      s(/\b(?:news|headlines|price of|stock|score|weather|status|live)\b/i, 3),
      s(/\bsearch (?:the web|online|for)\b|\blook ?up\b|\bgoogle\b/i, 4),
      s(/\bwho won\b|\bwhat happened\b/i, 3),
      s(/\bresearch\b/i, 2),
    ],
  },
  {
    category: "vision",
    intentId: "image_understanding",
    signals: [
      s(/\b(?:in|on) this (?:image|photo|picture|screenshot|diagram|chart)\b/i, 5),
      s(/\b(?:describe|read|what'?s in|identify|caption)\b[^.?!]{0,24}\b(?:image|photo|picture|screenshot)\b/i, 5),
      s(/\bscreenshot\b/i, 3),
    ],
  },
];


/** Distinct surface forms a signal matched, case-folded. */
function distinctHits(re: RegExp, message: string): number {
  const global = re.flags.includes("g") ? re : new RegExp(re.source, re.flags + "g");
  const seen = new Set<string>();
  for (const m of message.matchAll(global)) {
    seen.add(m[0].toLowerCase());
    if (seen.size >= 2) break;   // the cap makes further counting pointless
  }
  return seen.size;
}

/** What the weighted layer concluded, or null when the evidence is thin. */
export interface WeightedDecision {
  category: string;
  intentId: string;
  score: number;
  runnerUp: number;
  matched: number;
}

/**
 * Score every domain and return a winner only when the evidence is genuinely
 * decisive.
 *
 * Returning null is a real answer, not a failure: it means the LLM classifier
 * should run. This layer exists to stop paying for that round trip when the
 * evidence is clear, never to manufacture a confident guess when it is not.
 */
export function classifyByEvidence(message: string): WeightedDecision | null {
  const scored = DOMAINS.map((d) => {
    if (d.vetoes?.some((v) => v.test(message))) {
      return { d, score: 0, matched: 0 };
    }
    let score = 0;
    let matched = 0;
    for (const sig of d.signals) {
      const hits = distinctHits(sig.re, message);
      if (hits > 0) {
        // Corroboration inside one signal counts. Several terms from the
        // same family are stronger evidence than one, and bundling them
        // into a single alternation was silently discarding that: "the area
        // of a circle ... pi" scored the same as "area" alone, because a
        // regex either matches or it does not.
        //
        // Capped at two so a word repeated through a long message cannot
        // dominate — the signal is "two different terms agree", not "this
        // word appears a lot".
        score += sig.w * Math.min(hits, 2);
        matched++;
      }
    }
    return { d, score, matched };
  }).sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  if (!best || best.score < SCORE_FLOOR) return null;
  const runnerUp = second?.score ?? 0;
  if (best.score - runnerUp < SCORE_MARGIN) return null;

  return {
    category: best.d.category,
    intentId: best.d.intentId,
    score: best.score,
    runnerUp,
    matched: best.matched,
  };
}

/**
 * Whether ANY domain signal fires at all, at any weight.
 *
 * Distinct from classifyByEvidence returning null, which means "signals
 * fired but not decisively". This answers the narrower question the
 * no-signal default in classify.ts depends on: is there literally nothing
 * here to go on? A message with even one weak media cue must not reach that
 * default, or "tts this" would silently become a general chat answer.
 */
export function hasAnyEvidence(message: string): boolean {
  return DOMAINS.some((d) => d.signals.some((sig) => sig.re.test(message)));
}
