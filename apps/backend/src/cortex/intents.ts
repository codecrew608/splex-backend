// Intent taxonomy for the regex pre-filter. This is intent classification,
// not model routing — model_registry.category is the only thing that must
// stay DB-driven; the taxonomy of *what counts as* a category is allowed to
// live in code, and is explicitly meant to be extended over time by adding
// entries here.
//
// `category` must exactly match a value used in public.model_registry.category
// ('coding' | 'reasoning' | 'math' | 'writing' | 'vision' | 'documents' | 'general').

export interface IntentDefinition {
  id: string;
  category: string;
  capabilities: string[];
  strongKeywords: RegExp[];
  weakKeywords: RegExp[];
  /**
   * How much evidence a match here actually carries. 1 = a domain intent
   * (default); 0 = the catch-all.
   *
   * Used only to break ties between intents with an EQUAL number of weak
   * hits, where "general" losing to a domain intent is the right call.
   * It is deliberately not applied to strong hits: after the fix below,
   * general_qa has no strong keywords at all, so two competing strong hits
   * now genuinely mean two domains disagree — which is exactly when the
   * LLM classifier should be paid for.
   */
  specificity?: number;
}

// --- shared building blocks for the maths patterns -------------------------
//
// A measurement unit vocabulary, so "15 km in meters" is recognised as a
// conversion while "3 days in Paris" is not. Written once and reused: a unit
// list that drifts between two patterns is a bug waiting to happen.
const UNIT =
  "km|kilomet(?:er|re)s?|m|met(?:er|re)s?|cm|centimet(?:er|re)s?|mm|millimet(?:er|re)s?" +
  "|mi|miles?|ft|feet|foot|in|inch(?:es)?|yd|yards?" +
  "|kg|kilograms?|g|grams?|mg|milligrams?|lbs?|pounds?|oz|ounces?|tonnes?|tons?" +
  "|l|lit(?:er|re)s?|ml|millilit(?:er|re)s?|gal|gallons?|pints?|cups?" +
  "|s|secs?|seconds?|min|mins?|minutes?|h|hr|hrs?|hours?|days?|weeks?|months?|years?" +
  "|c|celsius|f|fahrenheit|k|kelvin|mph|kph|km\\/h|m\\/s" +
  "|bytes?|kb|mb|gb|tb|hz|khz|mhz|ghz|volts?|watts?|joules?|newtons?";

// Physical-measurement units only. Time words are excluded on purpose:
// "how many years did the war last" is a history question, not a sum.
const PHYSICAL_UNIT =
  "gram(?:me)?s?|kilogram(?:me)?s?|kg|mg|met(?:er|re)s?|kilomet(?:er|re)s?|km|cm|mm" +
  "|miles?|feet|foot|inch(?:es)?|yards?|lit(?:er|re)s?|ml|gallons?|ounces?|pounds?|lbs?" +
  "|bytes?|kb|mb|gb|tb";

export const INTENTS: IntentDefinition[] = [
  {
    id: "code_generation",
    category: "coding",
    capabilities: ["code_generation", "technical_context"],
    strongKeywords: [
      // Tolerates an optional language/framework name between the article
      // and the noun ("write a PYTHON function", "build a REACT
      // component") — found live (routing_regression corpus, item
      // code-impl-07): "Write a Python function `merge(...)`..." matched
      // NOTHING here (the bare pattern requires "a function" with nothing
      // between them), so the whole message fell through to math_reasoning
      // on its coordinate-pair regex incidentally matching the example
      // tuples "(1,2)" and "(2,3)" in the spec — a coding request routed
      // to math because the coding pattern was too rigid, not because math
      // was a better fit. `[\w.#+]+\s+` (not `\w+`) so it also covers
      // "C++", "C#", ".NET" style names, capped at one word so it still
      // won't fire on an unrelated noun phrase far from "function".
      /\bwrite (a|an|some) (?:[\w.#+]+\s+)?(function|script|program|class|component|api|endpoint)\b/i,
      /\bimplement\b/i,
      /\bbuild (a|an) (function|app|api|component|script)\b/i,
      // `\bimplement\b` above only matches the bare verb — "write a Python
      // implementation" / "build an implementation of this algorithm" use
      // the noun form, which it never catches (confirmed live: a genuine
      // heavy-coding prompt fell all the way through to the LLM fallback
      // classifier for exactly this reason). Anchored to a coding-shaped
      // verb within a short span of "implementation" specifically so it
      // doesn't fire on an unrelated noun use ("the implementation of the
      // new policy") — those have no write/build/create/design verb
      // anywhere near "implementation" and correctly fall through to the
      // fallback classifier instead, same as before this change.
      /\b(write|build|create|design)\b[\s\S]{0,25}\bimplementation\b/i,
      /```[a-z]*\n/,
    ],
    weakKeywords: [/\bcode\b/i, /\bfunction\b/i, /\bscript\b/i, /\balgorithm\b/i, /\bdata structure\b/i],
  },
  {
    id: "debugging",
    category: "coding",
    capabilities: ["debugging", "reasoning", "technical_context"],
    strongKeywords: [
      /\bfix (this|my|the) (bug|error|code|issue)\b/i,
      /\bwhy (is|does) (this|my) .*(error|fail|break|crash)/i,
      /\bstack trace\b/i,
      /\btraceback\b/i,
    ],
    // Bare /\berror\b/i (removed — found live, routing_regression corpus,
    // item lang-00) caught "Correct the grammatical error..." as a
    // debugging weak hit, misrouting a plain grammar-fix request to coding.
    // Qualified to error TYPES that are unambiguously code-flavored — a
    // "grammatical"/"spelling"/"factual" error never matches any of these,
    // while "there's a null pointer error" still does.
    weakKeywords: [
      /\bbug\b/i,
      /\b(?:runtime|syntax|type|compile(?:r|ation)?|logic|null|undefined|reference|segmentation|fatal)\s+error\b/i,
      /\berror\s+(?:message|log|code|trace)\b/i,
      /\bexception\b/i,
      /\bcrash(es|ing)?\b/i,
    ],
  },
  {
    // Computer-science questions ("what is the time complexity of quicksort")
    // previously matched nothing but general_qa's question-form patterns, so
    // they were answered by a general model. They belong with coding, whose
    // pool is selected for technical reasoning.
    id: "cs_concepts",
    category: "coding",
    capabilities: ["technical_context", "reasoning"],
    strongKeywords: [
      /\b(?:time|space)\s+complexity\b/i,
      /\bbig[- ]?o\b/i,
      /\b(?:asymptotic|amortis?zed)\b/i,
      /\bhow does (?:the )?\w+ (?:algorithm|sort|search|protocol) work\b/i,
    ],
    // "complexity" alone is removed: it is an ordinary English word long
    // before it is a CS term, and it was pulling reading-comprehension
    // passages ("the complexity of the gearing") into the coding pool. The
    // strong patterns above already cover the real usage — time/space
    // complexity, big-O, asymptotic — without the collision.
    weakKeywords: [/\brecursion\b/i, /\bcompiler\b/i, /\btime complexity\b/i],
  },
  {
    id: "math_reasoning",
    category: "math",
    capabilities: ["math_reasoning", "reasoning"],
    strongKeywords: [
      /\bsolve for\b/i,
      /\bcalculate\b/i,
      /\bwhat is the (derivative|integral|probability)\b/i,
      /\bprove that\b/i,
      /\bequation\b/i,

      // --- arithmetic actually written down --------------------------------
      // The single largest routing gap measured by SIB v1.0: 97 of the
      // corpus's 125 maths items were routed to `general`, because the only
      // maths signals recognised were a handful of formal verbs. Most people
      // do not write "calculate 17 times 23"; they write "17 × 23".
      //
      // Unambiguous operators may be written tight ("48*7") or spaced.
      /\d\s*[+*/^×÷]\s*-?\d/,
      // Minus is the exception: it MUST be spaced on both sides, otherwise
      // "2026-09-07" and "pages 10-20" would read as subtraction.
      /\d\s+[-−]\s+\d/,
      /\d\s*\b(?:plus|minus|times|multiplied by|divided by)\b\s*\d/i,

      /\b\d+(?:\.\d+)?\s*(?:%|percent)\s+(?:of|off)\b/i,
      /\b(?:square|cube|cubed|nth)\s+roots?\b/i,
      /√/,
      /\b\d+\s*(?:squared|cubed)\b/i,

      // Unit conversion: a number, a unit, then another unit. Requiring a
      // unit on BOTH sides is what stops "3 days in Paris" matching.
      new RegExp(`\\b\\d+(?:\\.\\d+)?\\s*(?:${UNIT})\\b\\s+(?:in|to|into|as)\\s+(?:${UNIT})\\b`, "i"),
      new RegExp(`\\bhow many\\s+(?:${PHYSICAL_UNIT})\\b`, "i"),
      // "convert" needs a number so it cannot steal "convert this to speech",
      // which is an audio-generation request.
      /\bconvert\s+[\d.]/i,

      // Operate-on-an-expression verbs, each requiring something expression
      // shaped nearby so "expand on that idea" and "evaluate the candidate"
      // do not match.
      /\b(?:simplify|factor(?:i[sz]e)?|expand|evaluate|compute)\b[^.?!]{0,30}?(?:\d|\bx\b|\(|\bexpression\b|\bequation\b|\bintegral\b|\bderivative\b)/i,

      // Aggregates, but only over something numeric.
      /\b(?:average|mean|median|sum|product|total)\s+of\b[^.?!]{0,40}\d/i,
      /\b(?:average|constant)\s+(?:speed|velocity|acceleration|rate)\b/i,

      /\b(?:logarithm|factorial|permutations?|combinations?|standard deviation|gcd|lcm|hypotenuse|circumference|perimeter|quadratic)\b/i,

      // Percentage questions that are not written in the "N% of M" shape —
      // "what percentage of 250 is 40", "percentage increase", "margin as a
      // percentage". A digit is required nearby so the word alone does not
      // capture ordinary prose.
      /\bpercentage\b[^.?!]{0,60}\d|\d[^.?!]{0,60}\bpercentage\b/i,
      /\bpercent(?:age)?\s+(?:change|increase|decrease|difference|error)\b/i,
      /\baverages?\b[^.?!]{0,40}\d/i,

      // Analytic geometry: a coordinate pair is unmistakable on its own;
      // the named quantities need a number nearby.
      /\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/,
      /\b(?:slope|midpoint|intercept|radius|diameter|area|volume)\b[^.?!]{0,60}\d/i,
      /\bdistance between\b/i,

      /\blog(?:arithm)?\s+base\s+\d/i,
      /\b[CP]\(\s*\d+\s*,\s*\d+\s*\)/,
      /\bby what factor\b/i,

      // Mathematical function-call notation. sin(, ln(, sqrt( and friends
      // are unambiguous: no ordinary sentence writes them.
      /\b(?:sin|cos|tan|sec|csc|cot|asin|acos|atan|sinh|cosh|tanh|ln|log|exp|sqrt|abs|floor|ceil|mod)\s*\(/i,

      // Calculus and linear algebra, by name.
      /\b(?:differentiate|integrate|derivative|integral|antiderivative)\b/i,
      /\b(?:determinant|eigenvalue|eigenvector|matrix|matrices|vector|dot product|cross product|transpose)\b/i,
      /\bsolve the system\b/i,

      // Number theory, spelled out as well as abbreviated.
      /\b(?:greatest common divisor|least common multiple|highest common factor|prime factorisation|prime factorization|modulo)\b/i,
      /\b\d+\s+mod\s+-?\d+/i,

      // Presentation of a numeric result.
      /\bscientific notation\b/i,
      /\bround\b[^.?!]{0,40}\bdecimal places?\b/i,
      /\bto\s+\d+\s+(?:decimal places?|significant figures?|s\.?f\.?)\b/i,

      // Named physical/geometric quantities, in a message that also
      // carries a number. The quantity word alone is not enough — "the
      // area of France" is geography — but a quantity plus a figure is a
      // calculation in every ordinary reading.
      // Deliberately excludes energy, power, current, frequency and density.
      // Each is an ordinary English word before it is a physical quantity —
      // "renewable energy", "current events", "population density" — and the
      // labelled negatives caught exactly that: a 10-slide presentation about
      // renewable energy was pulled into maths. The unit nouns below carry
      // the same questions without the ambiguity ("what power, in watts").
      /(?=[^]*\d)[^]*\b(?:voltage|resistance|wattage|velocity|acceleration|momentum|wavelength|torque|resistor|ohms?|volts?|watts?|amperes?|amps?|joules?|newtons?|pascals?|hertz)\b/i,
      /(?=[^]*\d)[^]*\b(?:area|volume|perimeter|surface area|hypotenuse|radius|diameter)\s+of\b/i,

      // Business arithmetic.
      /(?=[^]*\d)[^]*\b(?:gross margin|profit margin|markup|break[- ]?even|compound interest|simple interest|roi|ltv|cagr|churn rate|depreciation)\b/i,

      // Word problems: a quantity question with a number in the SAME
      // sentence. Sentence-bounded on purpose — an earlier version looked
      // for two numbers anywhere in the message, which made every
      // long document containing digits match as soon as it ended in
      // "how many …?", dragging document-comprehension tasks into maths.
      /\bhow (?:much|many|long|far|fast)\b[\s\S]{0,100}\d/i,
      /\d[\s\S]{0,150}\bhow (?:much|many|long|far|fast)\b/i,
    ],
    // Content words only. "number" and "digit" were tried here and removed:
    // they are how people phrase INSTRUCTIONS ("give only the number",
    // "contains no digits", a JSON field of type number), not what a maths
    // question is about, and they pulled JSON-formatting and
    // instruction-following tasks into the maths pool.
    weakKeywords: [/\bmath(?:s|ematics)?\b/i, /\barithmetic\b/i, /\bsum\b/i, /\balgebra\b/i],
  },
  {
    id: "creative_writing",
    category: "writing",
    capabilities: ["creative_writing", "long_form_generation"],
    strongKeywords: [
      /\bwrite (a|an) (story|poem|essay|blog post|script|song)\b/i,
      /\bcompose (a|an)\b/i,
      /\bcreative writing\b/i,
      /\b(?:draft|write|compose|rewrite)\s+(?:me\s+)?(?:a|an)\s+(?:\w+\s+){0,2}(?:email|e-mail|letter|message|memo|reply|response|note)\b/i,
    ],
    weakKeywords: [/\bstory\b/i, /\bpoem\b/i, /\bessay\b/i],
  },
  {
    id: "summarization",
    category: "documents",
    capabilities: ["summarization", "long_context"],
    strongKeywords: [
      /\bsummari[sz]e\b/i,
      /\btl;?dr\b/i,
      /\bgive me (a|the) (summary|gist)\b/i,
      /\bkey (points|takeaways)\b/i,
    ],
    weakKeywords: [/\bsummary\b/i, /\bshorten\b/i],
  },
  {
    id: "translation",
    category: "writing",
    capabilities: ["translation"],
    strongKeywords: [
      /\btranslate\b.*\bto\b/i,
      /\bhow do (you|i) say\b/i,
      /\bin (spanish|french|german|hindi|japanese|chinese|tamil|telugu)\b/i,
    ],
    weakKeywords: [/\btranslate\b/i, /\blanguage\b/i],
  },
  {
    id: "data_analysis",
    category: "reasoning",
    capabilities: ["analysis", "reasoning", "technical_context"],
    strongKeywords: [
      /\banaly[sz]e (this|my) data\b/i,
      /\bfind (patterns|trends|insights)\b/i,
      // Explicit requests to show working. These name the KIND of answer
      // wanted rather than a subject, which is exactly what the reasoning
      // pool is selected for, and nothing else in the taxonomy claimed them.
      /\bexplain your (?:reasoning|thinking|working|logic)\b/i,
      /\bstep[- ]by[- ]step\b/i,
      /\bshow your work(?:ing)?\b/i,
      /\breason (?:through|about) (?:this|it)\b/i,
      /\bcsv\b/i,
      /\bdataset\b/i,
    ],
    weakKeywords: [/\bdata\b/i, /\banalysis\b/i, /\btrend\b/i],
  },
  {
    id: "deep_research",
    category: "deep_research",
    capabilities: ["deep_research", "web_search", "citation_synthesis"],
    strongKeywords: [
      /\bdeep research\b/i,
      /\b(do|write|conduct) a (deep|thorough|comprehensive) (dive|research|report)\b/i,
      /\bcomprehensive research (report )?(on|into)\b/i,
      /\bwrite (me )?a research report\b/i,
      /\bresearch .*(thoroughly|in depth|in-depth)\b/i,
    ],
    weakKeywords: [/\bresearch report\b/i, /\bin-?depth research\b/i],
  },
  {
    id: "news_search",
    category: "web_search",
    capabilities: ["web_search", "news"],
    strongKeywords: [
      /\b(latest|breaking|today'?s|recent) news\b/i,
      /\bnews (about|on|regarding)\b/i,
      /\bwhat'?s (in|happening in) the news\b/i,
      /\bcurrent events\b/i,
    ],
    weakKeywords: [/\bnews\b/i, /\bheadlines\b/i],
  },
  {
    id: "web_search",
    category: "web_search",
    capabilities: ["web_search"],
    strongKeywords: [
      /\bsearch (the web|online|the internet)( for)?\b/i,
      /\b(google|look up) (that|this|it|\w[\w\s]{2,40})\b/i,
      /\bwhat('| i)?s the (current|latest) (price|version|status|score)\b/i,
      /\b(as of|right now|currently)\b.*\?/i,
      /\bwhat'?s happening (with|to)\b/i,
      // Live testing caught "what is the price of btc now" being answered
      // confidently from stale training data instead of triggering a
      // search — general_qa's broad /\bwhat is\b/i matched as the ONLY
      // strong hit, so classifyIntent's single-strong-match branch never
      // even reached the LLM fallback that would have caught this. Doesn't
      // require a trailing "?" (casual chat messages routinely omit one)
      // or the word "current"/"latest" before the noun (the existing
      // pattern above already covers that phrasing) — this catches the
      // "...price of X now/today" shape specifically, since price/value/
      // rate/cost questions are inherently time-sensitive in a way most
      // other "now"-suffixed questions aren't.
      /\b(price|value|cost|rate|worth)\b[\s\S]*\b(now|today|currently|right now|at the moment)\b/i,
    ],
    weakKeywords: [/\blatest\b/i, /\bcurrent(ly)?\b/i, /\bright now\b/i],
  },
  {
    id: "presentation_generation",
    category: "ppt",
    capabilities: ["presentation_generation", "long_form_generation"],
    strongKeywords: [
      /\b(make|create|build|generate|design) (me |us )?(a|an) (\w+ )?(presentation|slide ?deck|powerpoint|pptx?|deck)\b/i,
      /\b(presentation|slide ?deck|powerpoint) (about|on|for)\b/i,
      /\bslides? (about|on|for)\b/i,
    ],
    weakKeywords: [/\bpresentation\b/i, /\bslide ?deck\b/i, /\bpowerpoint\b/i, /\bslides\b/i],
  },
  {
    id: "video_generation",
    category: "video",
    capabilities: ["video_generation"],
    strongKeywords: [
      /\b(generate|create|make) (me |us )?(a|an) (short )?video( of| clip| showing)?\b/i,
      /\bvideo of\b/i,
      /\banimate (this|that|it)\b/i,
      /\btext[- ]to[- ]video\b/i,
    ],
    weakKeywords: [/\bvideo\b/i, /\banimation\b/i, /\bclip\b/i],
  },
  {
    id: "audio_generation",
    category: "audio",
    capabilities: ["audio_generation", "text_to_speech"],
    strongKeywords: [
      /\b(?:read|say)\s+(?:this|that|it|the)\b[^.?!]{0,40}?\b(?:aloud|out loud)\b/i,
      /\btext[- ]to[- ]speech\b/i,
      /\bconvert (this|that|it) to (speech|audio|voice)\b/i,
      /\b(generate|create|make) (an? )?(audio|voiceover|narration)\b/i,
      /\bnarrate (this|that|it)\b/i,
    ],
    weakKeywords: [/\bspeech\b/i, /\bvoiceover\b/i, /\bnarration\b/i, /\btts\b/i],
  },
  {
    id: "image_generation",
    category: "image",
    capabilities: ["image_generation"],
    strongKeywords: [
      /\b(generate|create|draw|design|make|paint) (me |us )?(a|an) (image|picture|photo|illustration|drawing|painting|logo|icon|graphic|artwork)\b/i,
      /\b(image|picture|photo|illustration) of\b/i,
      /\btext[- ]to[- ]image\b/i,
    ],
    weakKeywords: [/\bdraw\b/i, /\billustrat/i, /\bartwork\b/i],
  },
  {
    id: "image_understanding",
    category: "vision",
    capabilities: ["vision", "image_understanding"],
    strongKeywords: [
      /\bwhat('| i)?s in this image\b/i,
      /\bdescribe this (image|photo|picture)\b/i,
      /\bread the text in (this|the) image\b/i,
    ],
    weakKeywords: [/\bimage\b/i, /\bphoto\b/i, /\bpicture\b/i, /\bscreenshot\b/i],
  },
  {
    id: "general_qa",
    category: "general",
    capabilities: ["general_knowledge"],

    // NO STRONG KEYWORDS — and this is the fix, not an oversight.
    //
    // This intent previously listed /\bwhat is\b/i, /\bwho (is|was)\b/i,
    // /\bexplain\b/i and /\bhow does .* work\b/i as STRONG. Those are
    // question-FORM patterns: they tell you the message is a question, not
    // what it is about. Because a single strong hit short-circuits
    // classification, "What is 17 × 23?" matched general_qa alone and was
    // routed to the general pool deterministically — never reaching the
    // maths model, and never even reaching the LLM classifier that would
    // have corrected it. SIB v1.0 measured the damage: 97 of 125 maths
    // items routed to `general`, and 57 of 62 live requests were served by
    // one general model.
    //
    // The same pattern was already known to misroute time-sensitive
    // questions — see the web_search intent's comment about
    // "what is the price of btc now" — and had been patched there case by
    // case. This removes the cause instead.
    //
    // As the catch-all, general_qa should win when nothing more specific
    // matches, which is exactly what weak keywords express.
    strongKeywords: [],
    weakKeywords: [
      /\bwhy\b/i, /\bhow\b/i, /\bwhat\b/i,
      // Open-ended prompts that name no domain at all. Without these the
      // classifier had zero signal for "tell me about X" and paid for an
      // LLM round-trip on one of the most ordinary things a user can type.
      /\btell me about\b/i, /\bwhat are\b/i, /\bwho are\b/i,
      /\bgive me an overview\b/i, /\bhistory of\b/i,
      // Demoted from strong, deliberately kept: they are still real
      // evidence that a message is a general question, just not evidence
      // strong enough to beat a domain match.
      /\bwhat is\b/i, /\bwho (is|was)\b/i, /\bexplain\b/i, /\bhow does .* work\b/i,
    ],
    specificity: 0,
  },
];

export const GENERAL_FALLBACK_INTENT: IntentDefinition = {
  id: "general_qa",
  category: "general",
  capabilities: ["general_knowledge"],
  strongKeywords: [],
  weakKeywords: [],
};
